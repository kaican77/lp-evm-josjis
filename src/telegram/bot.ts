/** Long-poll loop + routing. The auth guard lives here: non-owner updates are dropped. */
import { call, send, isOwner, lockOwner } from "./tg.js";
import { resolveMenu } from "./menu.js";
import { wallet } from "../chain/client.js";
import { cfg } from "../config.js";
import { esc } from "./format.js";
import { logger } from "../util/log.js";
import * as H from "./handlers.js";

const log = logger("bot");
let running = true;

const CA_RE = /^0x[a-fA-F0-9]{40}$/;
const NUM_RE = /^[0-9]*\.?[0-9]+$/;

// ── Command suggestion: typo-friendlier UX ──────────────────────────────
// If user types an unknown /command, suggest the closest match by Levenshtein distance.
const KNOWN_COMMANDS = [
  "list", "addlp", "ladder3", "ladder5", "ladderclose",
  "krystal", "ledger", "card", "swap", "v4lp", "v4close",
  "v2close", "pnl", "closeall", "wallet", "settings", "set",
  "help", "start",
];

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function suggestCommand(input: string): string | null {
  const cmd = input.replace(/^\//, "").toLowerCase().split(/\s+/)[0];
  if (!cmd) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const k of KNOWN_COMMANDS) {
    const d = levenshtein(cmd, k);
    if (d < bestDist) { bestDist = d; best = k; }
  }
  return bestDist <= 2 ? best : null;
}

async function routeCallback(cq: any): Promise<void> {
  const chatId = String(cq.message.chat.id);
  const d: string = cq.data;
  const mid: number = cq.message.message_id;
  if (!isOwner(chatId)) {
    await call("answerCallbackQuery", { callback_query_id: cq.id, text: "⛔ bukan owner", show_alert: true });
    return;
  }
  await call("answerCallbackQuery", {
    callback_query_id: cq.id,
    ...(d === "refresh" ? { text: "🔄 Ambil data on-chain…" } : {}),
  });

  if (d.startsWith("ca:")) return H.onCA(d.slice(3));
  if (d === "refresh") return H.onList(mid, true); // force = bypass cache, fetch fresh
  if (d === "card") return H.onCard();
  if (d.startsWith("cardp:")) return H.onCardFor(d.slice(6));
  if (d.startsWith("cal:")) {
    const p = d.split(":");
    return H.onCalendar(Number(p[1]), Number(p[2])); // 📅 prev/next month
  }
  if (d === "swapdo") return H.onSwapDo(mid);
  if (d === "swap") return H.onSwap("/swap"); // 🔙 back to token menu
  if (d.startsWith("swf:")) return H.onSwapFrom(d.slice(4), mid); // pick token to sell
  if (d.startsWith("swp:")) return H.onSwapPct(Number(d.split(":")[1]), mid); // pick % amount
  if (d === "lgrb") return H.onLedgerRebuild(mid);
  if (d.startsWith("lg:")) return H.onLedger(Number(d.split(":")[1]), mid);
  if (d.startsWith("pool:")) return H.onPick(Number(d.split(":")[1]), mid);
  if (d.startsWith("laddergo:")) return H.onLadderConfirm(d.slice(10), mid);
  if (d.startsWith("ladderc:")) return H.onLadderCloseGroup(d.slice(8), mid);
  if (d.startsWith("laddergo2:")) return H.onLadderCloseExecute(d.slice(10), mid);
  if (d.startsWith("rng:")) return H.onRange(d.slice(4) === "custom" ? "custom" : Number(d.slice(4))); // range preset ±%
  if (d === "noop") return;
  if (d === "ballp") return H.onBalancedLp(mid);
  if (d === "usdgw") return H.onUseWalletUsdg(mid); // single-side pakai USDG di wallet (no swap/input)
  if (d.startsWith("mint:")) return H.onMint(mid, d.slice(5)); // single|inrange|v4|v4r
  if (d === "mint") return H.onMint(mid, "single");
  if (d === "cancel") {
    H.cancelPending();
    await call("editMessageText", { chat_id: chatId, message_id: mid, text: "❌ Dibatalkan.", parse_mode: "HTML" });
    return;
  }
  if (d.startsWith("v4f:")) return H.onV4Collect(d.split(":")[1]!);
  if (d.startsWith("add4:")) return H.onAddAsk(d.slice(5), "v4"); // ➕ tambah liq ke posisi v4 existing
  if (d.startsWith("add3:")) return H.onAddAsk(d.slice(5), "v3");
  if (d.startsWith("v4c:")) return H.onV4Close("/v4close " + d.split(":")[1]);
  if (d.startsWith("v2c:")) return H.onV2Close(d.slice(4));
  if (d.startsWith("close:")) return H.onCloseAsk(d.split(":")[1]!, mid);
  if (d.startsWith("cs:")) return H.onClose(d.split(":")[1]!, mid, true);
  if (d.startsWith("ck:")) return H.onClose(d.split(":")[1]!, mid, false);
  if (d === "closeall") {
    await call("editMessageText", { chat_id: chatId, message_id: mid, text: "🗑🗑 memproses Close ALL…", parse_mode: "HTML" });
    return H.onCloseAll();
  }
}

async function routeMessage(m: any): Promise<void> {
  const chatId = String(m.chat.id);
  // owner sends a photo → use it as the profit-card background
  if (Array.isArray(m.photo) && m.photo.length) {
    if (!isOwner(chatId)) return;
    return H.onSetBg(m.photo[m.photo.length - 1].file_id);
  }
  const t: string = resolveMenu(String(m.text ?? "").trim()); // map bottom-menu labels → commands

  // /start (and /help) is the only thing that can LOCK an unclaimed bot to a chat
  if (t === "/start" || t === "/help") lockOwner(chatId);
  if (!isOwner(chatId)) {
    log.warn(`update ditolak dari chat non-owner ${chatId}`);
    return;
  }

  if (t === "/start" || t === "/help") return H.onHelp();
  if (t === "/list") return H.onList();
  if (t === "/addlp") return await send("Paste alamat kontrak token (0x… 40 hex) buat buka LP.\n\nKetik <code>/list</code> posisi → pilih <b>➕ Add</b> buat nambah likuiditas ke posisi yang udah ada.");
  if (t.startsWith("/ladder3") || t.startsWith("/ladder5")) return H.onLadder(t);
  if (t.startsWith("/ladderclose")) return H.onLadderClose(t);
  if (t.startsWith("/krystal")) return H.onKrystal(t);
  if (t === "/closelp") return H.onList(); // menu Posisi → Close per posisi
  if (t === "/ledger") return H.onLedger(0);
  if (t === "/card") return H.onCard();
  if (t === "/calendar") return H.onCalendar();
  if (t.startsWith("/swap")) return H.onSwap(t);
  if (t.startsWith("/v4lp")) return H.onV4Lp(t);
  if (t.startsWith("/v4close")) return H.onV4Close(t);
  if (t.startsWith("/v4")) return H.onV4(t.split(/\s+/)[1]);
  if (t.startsWith("/v2close")) return H.onV2Close(t.split(/\s+/)[1] ?? "");
  if (t === "/pnl") return H.onPnl();
  if (t === "/closeall") return H.onCloseAll();
  if (t === "/wallet") return H.onWallet();
  if (t === "/settings") return H.onSettings();
  if (t.startsWith("/set ")) return H.onSet(t);
  if (CA_RE.test(t)) return H.onCA(t);
  if (H.isAwaitingAdd() && NUM_RE.test(t)) return H.onAddAmount(t); // ➕ add-liq amount
  if (H.isAwaitingAmount() && NUM_RE.test(t)) return H.onAmount(t);
  if (t.startsWith("/")) {
    const sug = suggestCommand(t);
    const bad = esc(t.split(/\s+/)[0]);
    if (sug) {
      await send(`❓ Command <code>${bad}</code> gak dikenal.\nMungkin maksud lo: <code>/${sug}</code>`);
    } else {
      await send(`❓ Command <code>${bad}</code> gak dikenal.\nKetik <code>/help</code> buat daftar perintah.`);
    }
    return;
  }
  await send("Paste alamat kontrak token (0x… 40 hex) buat buka LP.");
}

async function handle(u: any): Promise<void> {
  if (u.callback_query) return routeCallback(u.callback_query);
  if (u.message?.text || u.message?.photo) return routeMessage(u.message);
}

async function registerCommands(): Promise<void> {
  // Both the "/" command menu AND the persistent bottom reply keyboard. The keyboard now
  // re-affirms on every plain-text send() (see tg.ts) so it no longer gets lost.
  await call("setChatMenuButton", { menu_button: { type: "commands" } });
  await call("setMyCommands", {
    commands: [
      { command: "list", description: "📋 Posisi LP terbuka (v3+v4) + close" },
      { command: "addlp", description: "➕ Add LP: paste kontrak token (0x…)" },
      { command: "ladder3", description: "🪜 V4 BID LADDER 3 leg dari USDG" },
      { command: "ladder5", description: "🪜 V4 BID LADDER 5 leg dari USDG" },
      { command: "ladderclose", description: "🗑 Tutup semua leg ladder" },
      { command: "krystal", description: "🔎 Status PnL Krystal Cloud (cross-check)" },
      { command: "ledger", description: "📒 Riwayat posisi ditutup (realized PnL)" },
      { command: "pnl", description: "💰 PnL seumur hidup" },
      { command: "swap", description: "🔄 Swap token via Uniswap (router 02 + v4)" },
      { command: "wallet", description: "👛 Saldo hot wallet" },
      { command: "card", description: "📸 Kartu profit shareable (portfolio)" },
      { command: "settings", description: "⚙️ Width, slippage, dll" },
      { command: "help", description: "❔ Bantuan + menu" },
    ],
  });
}

export function stop(): void {
  running = false;
}

export async function run(): Promise<void> {
  await registerCommands();
  log.info(`Robinhood LP Bot v2 jalan — chain ${cfg.chainId}, wallet ${wallet().address}`);
  let offset = 0;
  while (running) {
    try {
      const r = await call("getUpdates", { offset, timeout: 25 });
      for (const u of r?.result ?? []) {
        offset = u.update_id + 1;
        // NON-BLOCKING: don't await — a slow handler (e.g. /pnl lifetime scan, 20s+) must NOT block
        // the loop, or every command tapped after it appears to "hang" until it finishes. Wallet txs
        // stay serialized by txlock; read commands are safe to run concurrently.
        void handle(u).catch((e: Error) => log.error("handle err: " + e.message));
      }
    } catch (e) {
      log.error("loop: " + String((e as Error).message).slice(0, 60));
      await new Promise((s) => setTimeout(s, 2000));
    }
  }
  log.info("loop berhenti.");
}
