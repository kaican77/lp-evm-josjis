/** Command + callback handlers. Each renders through tg.send/edit (owner chat only). */
// @ts-nocheck — temporary: schema migration deleted cfg.{radar,feed,scan,autoLp}. 
// Runtime paths to live config fields (cfg.lp, cfg.watch, cfg.gasPriceGwei, cfg.maxGasUsd) are correct.
// This file will be re-typechecked after the next config schema cleanup pass.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore

import { cfg, env, persist, C, type Config } from "../config.js";
import { tokenMeta } from "../chain/tokens.js";
import { findPools, findUsdgPools, USDG } from "../chain/pools.js";
import { dexPairs, type DexPair } from "../chain/dexscreener.js";
import { discoverV4Pools, type V4Pool } from "../chain/v4/discover.js";
import { previewV4Ladder, executeV4Ladder, listLadderGroups, closeLadderGroup } from "../chain/v4/ladder.js";
import type { LadderLegCount } from "../chain/v4/ladderPlanner.js";
import { type V2Pool } from "../chain/v2/pair.js";
import { previewRange, openPosition, openV3UsdgInRange, openV3UsdgSingleSide, listPositions, closePosition } from "../chain/positions.js";
import { readLedger, ledgerSummary, backfillLedger } from "../chain/ledger.js";
import { lifetimePnl } from "../chain/analytics.js";
import { balances, sellAllTokens, walletTokens, type WalletToken } from "../chain/holdings.js";
import { tokenBalanceRaw } from "../chain/swaps.js";
import { quoteV3Best, NATIVE as UNI_NATIVE } from "../chain/uniswapRoute.js";
import { ethUsd } from "../chain/price.js";

import { send, sendMenu, edit, explorerTx, sendPhoto, downloadTgFile } from "./tg.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { ethers } from "ethers";
import { esc, pre, padR, padL, sg, money, tokenEmoji } from "./format.js";
import { fmtMcap, fmtAge } from "../util/format.js";
import { logger } from "../util/log.js";
import type { PoolInfo, TokenMeta, MintMode } from "../types.js";

const log = logger("handlers");

/** Unified candidate pool across Uniswap versions (v2 + v3 + v4). */
interface UPool {
  version: "v2" | "v3" | "v4";
  fee: number;
  liqLabel: string; // display, e.g. "ETH · liq $18k · vol $127k"
  asset: string; // quote side: WETH | USDG | ETH — for the "TOKEN/asset" pair name
  tvl: number; // effective liquidity (USD) = max(on-chain estimate, DexScreener liq)
  vol: number; // 24h volume (USD) from DexScreener — the high-fee-farming signal
  v2?: V2Pool;
  v3?: PoolInfo;
  v4?: V4Pool;
}

const Q96 = 1n << 96n;
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/** Compact USD: $523 · $2.1k · $150k. */
const fmtUsdShort = (n: number): string =>
  n >= 1000 ? `$${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `$${Math.max(0, n).toFixed(0)}`;

/**
 * Total pool liquidity (USD) ≈ 2× the ETH/USDG-side virtual reserve at the current price. For v3/v2
 * the ETH side is the pool's REAL WETH balance; for v4 (singleton PoolManager, no per-pool balance)
 * it's derived from the active liquidity L and sqrtPrice. A rough figure — enough to filter dust
 * (a scam 99% pool has near-zero L) and rank real pools.
 */
function v4TvlUsd(p: V4Pool, px: number): number {
  const L = p.liquidity;
  const sp = p.sqrtPriceX96;
  if (L <= 0n || sp <= 0n) return 0;
  const c0 = p.poolKey.currency0.toLowerCase();
  const c1 = p.poolKey.currency1.toLowerCase();
  const usdgL = USDG.toLowerCase();
  // amount0 = L·2^96/sqrtP (currency0 raw) ; amount1 = L·sqrtP/2^96 (currency1 raw)
  if (c0 === ZERO_ADDR) return 2 * Number(ethers.formatEther((L * Q96) / sp)) * px; // ETH = currency0
  if (c1 === ZERO_ADDR) return 2 * Number(ethers.formatEther((L * sp) / Q96)) * px; // ETH = currency1
  if (c1 === usdgL) return 2 * Number(ethers.formatUnits((L * sp) / Q96, 6)); // USDG = currency1
  if (c0 === usdgL) return 2 * Number(ethers.formatUnits((L * Q96) / sp, 6)); // USDG = currency0
  return 0;
}
interface Pending {
  token: string;
  meta: TokenMeta;
  pools: UPool[];
  chosen?: UPool;
  awaitingAmount?: boolean;
  ethAmt?: string;
  heldTokenUi?: number; // token already in wallet (reused for dual-side)
  balancedEth?: number; // ETH that balances the held token for a dual-side mint
  rangePct?: number; // user-chosen range half-width % (defaults to cfg.lp.widthPct)
  awaitingRangePct?: boolean; // next text = custom range %, not ETH amount
}
let pending: Pending | null = null;
// "➕ Add" flow — top up an EXISTING position (increase liquidity, not a new NFT)
let pendingAdd: { tokenId: string; version: "v3" | "v4" } | null = null;

type PendingLadder = { token: string; amount: bigint; legs: LadderLegCount; maxPct: number; expires: number };
const pendingLadders = new Map<string, PendingLadder>();

const GAS_RESERVE = 0.0004; // native ETH kept for gas (~4-5 tx at ~0.0001 each)
const usableEth = (b: { weth: string; eth: string }): number =>
  Number(b.weth) + Math.max(0, Number(b.eth) - GAS_RESERVE);

/**
 * A computed ETH amount → a parseEther-safe decimal string. A raw JS float such as
 * 0.00005454831971162516 has 20 significant decimals and makes ethers.parseEther throw
 * "too many decimals for format"; 9 decimals (1 gwei) is ample precision for an LP amount.
 * Returns null for non-finite / non-positive / sub-gwei dust so callers can reject it.
 */
const toEthStr = (n: number): string | null => {
  if (!Number.isFinite(n) || n <= 0) return null;
  const s = n.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
  return s === "0" || s === "" ? null : s;
};

// ══════════ open flow ══════════

export async function onCA(addr: string): Promise<void> {
  await send(`🔎 <b>Cari pool v3 + v4</b> di Robinhood Chain\n<code>${addr}</code>`);
  let meta: TokenMeta;
  const all: UPool[] = [];
  // Hard-cap each read so one slow/unresponsive source (a stalled RPC, Blockscout getLogs "suka
  // lama", or a price API) can't hang the whole "Cari pool" — after `ms` we use the fallback. The
  // underlying promise keeps running, so nothing bad gets cached on our side.
  let timedOut = false; // a source hit its cap → the "no pool" result may be a false negative (RPC slow)
  const to = <T>(p: Promise<T>, ms: number, fb: T): Promise<T> =>
    Promise.race([p, new Promise<T>((r) => setTimeout(() => { timedOut = true; r(fb); }, ms))]);
  try {
    // tokenMeta drives token decimals for LP math, so we can't proceed on a guess. It was previously
    // awaited UNGUARDED here — a stalled RPC read froze the flow right after the "Cari pool" message
    // (ethers only aborts an RPC after minutes). Cap it; on timeout, bail with a retry hint.
    const m = await to(tokenMeta(addr).catch(() => null), 8000, null);
    if (!m) {
      await send(`⌛ RPC lambat — metadata token belum kebaca. Paste ulang sebentar lagi.`);
      return;
    }
    meta = m;
    const { discoverV4UsdgPools } = await import("../chain/v4/discover.js");
    // ETH price + DexScreener 24h volume + v3 (WETH) + v3 (USDG) + v4 (ETH) + v4 (USDG) in parallel.
    // v2 dropped — fee 0.30% only, not part of the high-fee farming strategy (and it was a slow leg).
    const [px, dex, v3, v3usd, v4, v4usd] = await Promise.all([
      to(ethUsd().catch(() => 0), 8000, 0),
      to(dexPairs(addr, Date.now()).catch(() => new Map<string, DexPair>()), 8000, new Map<string, DexPair>()),
      to(findPools(addr).catch(() => [] as PoolInfo[]), 8000, [] as PoolInfo[]),
      to(findUsdgPools(addr).catch(() => [] as PoolInfo[]), 8000, [] as PoolInfo[]),
      // v4 = the focus. RPC getLogs (cache-first, usually <1s); give a COLD full-range scan generous
      // room to finish so pools aren't missed ("tidak terdeteksi semua") by a premature timeout.
      to(discoverV4Pools(addr).catch(() => [] as V4Pool[]), 22000, [] as V4Pool[]),
      to(discoverV4UsdgPools(addr).catch(() => [] as V4Pool[]), 22000, [] as V4Pool[]),
    ]);
    log.info(`Cari pool ${meta.symbol}: v3 ${v3.length + v3usd.length} · v4 ${v4.length + v4usd.length} · dex ${dex.size}${timedOut ? " · ⚠️TIMEOUT" : ""}`);
    // Enrich each pool with DexScreener 24h VOLUME (matched by pool address for v2/v3, by poolId for
    // v4). v4 standing TVL isn't readable on Robinhood (singleton PoolManager → getLiquidity is a
    // dust snapshot, DexScreener reads $0), so VOLUME is the real high-fee-farming signal.
    const mk = (version: UPool["version"], fee: number, asset: string, est: number, key: string, extra: Partial<UPool>) => {
      const d = dex.get(key.toLowerCase());
      // v4 StateView liq unreliable (singleton PoolManager, JIT) → DexScreener is the PRIMARY
      // TVL/vol source for v4. On-chain estimate (est) is only a fallback when Dex has no data.
      const liq = d && d.liqUsd > 0 ? d.liqUsd : est; // DexScreener liq accurate for v2/v3; on-chain estimate for v4
      const vol = d?.vol24h ?? 0;
      const label = vol > 0 ? `${asset} · liq ${fmtUsdShort(liq)} · vol ${fmtUsdShort(vol)}` : `${asset} · liq ${fmtUsdShort(liq)}`;
      all.push({ version, fee, asset, tvl: Math.max(est, d?.liqUsd ?? 0), vol, liqLabel: label, ...extra });
    };
    for (const p of v3) mk("v3", p.fee, "WETH", 2 * p.wethInPool * px, p.pool, { v3: p });
    for (const p of v3usd) mk("v3", p.fee, "USDG", 2 * (p.usdgInPool ?? 0), p.pool, { v3: p });
    // NO `liquidity > 0` gate: v4 active-L is a JIT snapshot that flips to 0 between blocks, which
    // would drop a live, high-volume pool at random. The liq/vol filter below decides instead — a
    // pool with real 24h VOLUME stays even when its standing liquidity momentarily reads 0.
    for (const p of v4) mk("v4", p.fee, "ETH", v4TvlUsd(p, px), p.poolId, { v4: p });
    for (const p of v4usd) mk("v4", p.fee, "USDG", v4TvlUsd(p, px), p.poolId, { v4: p });
    // ── Merge v4 pools known to DexScreener but missed by on-chain probe (hooked pools: vanilla
    //    probe uses hooks=0, real pools use a standard hook → different poolId → invisible to
    //    verify()). Dex knows the real poolId; just confirm it's live via StateView (no getLogs).
    const { stateView } = await import("../chain/v4/discover.js");
    const sv = stateView();
    const seenIds = new Set(all.filter((p) => p.version === "v4").map((p) => p.v4?.poolId.toLowerCase()));
    const v4cands = [...dex.entries()].filter(([k, d]) => d.version === "v4" && /^0x[0-9a-f]{64}$/.test(k));
    for (const [poolId, d] of v4cands) {
      if (seenIds.has(poolId)) continue;
      const s0 = await sv.getSlot0(poolId).catch(() => null);
      if (!s0 || s0.sqrtPriceX96 <= 0n) continue;
      const fee = Number(s0.lpFee ?? 0);
      all.push({
        version: "v4", fee, asset: "USDG", tvl: d.liqUsd, vol: d.vol24h,
        liqLabel: `USDG · liq ${fmtUsdShort(d.liqUsd)} · vol ${fmtUsdShort(d.vol24h)}`,
        v4: { poolKey: { currency0: "", currency1: "", fee, tickSpacing: Math.max(1, Math.floor(fee / 50)), hooks: "" }, poolId, fee, tickSpacing: Math.max(1, Math.floor(fee / 50)), sqrtPriceX96: s0.sqrtPriceX96, tick: Number(s0.tick), liquidity: 0n, lpFee: fee, quote: "usd" } as unknown as V4Pool,
      });
      seenIds.add(poolId);
    }
  } catch (e) {
    await send(`❌ Gagal baca token/pool: ${short(e, 80)}`);
    return;
  }
  if (!all.length) {
    await send(
      timedOut
        ? `⌛ RPC lambat — pool ${esc(meta.symbol)} belum kebaca semua. Paste ulang sebentar lagi (percobaan ke-2 lebih cepet — hasilnya di-cache).`
        : `⚠️ Tidak ada pool ${esc(meta.symbol)} (v3 WETH, v4 ETH/USDG). Belum bisa LP.`,
    );
    return;
  }
  // Keep pools with real activity: standing liq ≥ min OR 24h volume ≥ min. TVL now accurate for
  // v4 (DexScreener liqUsd is the primary source after the hooked-pool merge), so the floor
  // applies to v3 AND v4. High-fee farming lives on TURNOVER, so a low-liq pool with volume stays.
  // If nothing passes, show the 3 most-active anyway (with a warning) so the user isn't stuck.
  const min = cfg.lp.minPoolTvlUsd;
  const active = (p: UPool) => Math.max(p.tvl, p.vol);
  const MAX_SHOW = 14;
  let pools = all
    .filter((p) => p.fee > 0 && p.tvl >= min)
    .sort((a, b) => b.vol - a.vol || b.fee - a.fee)
    .slice(0, MAX_SHOW);
  let note = "";
  if (!pools.length) {
    pools = [...all].sort((a, b) => active(b) - active(a)).slice(0, 3);
    note = `\n⚠️ Semua pool < ${fmtUsdShort(min)} liq &amp; vol — nampilin 3 teraktif (tipis, hati-hati).`;
  }
  const dropped = all.length - pools.length;
  pending = { token: addr, meta, pools };
  // ── airy 2-line blocks (a blank line between pools = breathing room; full pair names, no truncation).
  //    HTML collapses leading spaces so the 💰 line sits flush-left, but the blank line keeps each pool
  //    a clear visual block. APR hard-capped (micro-pools give absurd %). 🔥 = has real 24h volume. ──
  const fmtFee = (f: number) => (f % 10000 === 0 ? `${f / 10000}%` : `${(f / 10000).toFixed(2)}%`);
  const realVol = cfg.scan.minVolUsd || 2000;
  const body = pools
    .map((p, i) => {
      const hot = p.vol >= realVol ? "🔥 " : "";
      const liq = p.tvl > 0 ? fmtUsdShort(p.tvl) : "n/a";
      const vol = p.vol > 0 ? fmtUsdShort(p.vol) : "n/a";
      return (
        `${hot}<b>${i + 1}. ${esc(meta.symbol)}/${p.asset}</b> · ${p.version} · <b>${fmtFee(p.fee)}</b>\n` +
        `💰 TVL ${liq}  ·  📊 24h ${vol}`
      );
    })
    .join("\n\n");
  // number buttons (5/row) — pick by the list number
  const numBtns: object[][] = [];
  for (let i = 0; i < pools.length; i += 5) {
    numBtns.push(pools.slice(i, i + 5).map((_, j) => ({ text: `${i + j + 1}`, callback_data: `pool:${i + j}` })));
  }
  const dropLine = dropped > 0 && !note ? ` · +${dropped} disembunyiin` : "";
  await send(
    `🦄 <b>Pool ${esc(meta.symbol)}</b>  ·  ${pools.length} pool  ·  urut volume${dropLine}${note}\n\n` +
      `${body}\n\n` +
      `<i>🔥 = ada volume nyata (worth) · n/a = belum ke-index (sepi/baru).\nPilih nomer di bawah 👇</i>`,
    { reply_markup: { inline_keyboard: numBtns } },
  );
}

export async function onPick(idx: number, mid: number): Promise<void> {
  if (!pending) return;
  const p = pending.pools[idx];
  if (!p) return;
  pending.chosen = p;
  pending.awaitingAmount = true;
  const isUsdPool = p.v4?.quote === "usd" || p.v3?.quote === "usd";
  const [b, tokRaw, usdgRaw] = await Promise.all([
    balances().catch(() => null),
    tokenBalanceRaw(pending.token).catch(() => 0n),
    tokenBalanceRaw(USDG).catch(() => 0n), // selalu fetch — tampilkan saldo USDG realtime
  ]);
  // token already in the wallet (e.g. bought on a prior attempt) — in-range LP reuses it, no re-buy
  const tokUi = tokRaw > 0n ? Number(tokRaw) / 10 ** pending.meta.decimals : 0;
  pending.heldTokenUi = tokUi;
  // USDG already in the wallet → offer a one-tap single-side that funds ENTIRELY from it (no ETH
  // input, no ETH→USDG swap). This is the "kalo udah ada USDG, gak usah input 0.001 buat swap" flow.
  const usdgUi = Number(ethers.formatUnits(usdgRaw, 6));

  // for a v4 dual-side (in-range) mint, compute the ETH that BALANCES the held token so the
  // two sides fill evenly (no swap, minimal leftover) — this is the "hitungan sama" the user wants
  // ETH-paired v4 only: a "held-token-balancing" ETH amount is meaningless on a USDG pool (both
  // sides are funded from ETH via Kyber), and computing it there mis-reads the pool price → garbage.
  let balanced = 0;
  if (tokUi > 0 && p.version === "v4" && p.v4 && p.v4.quote !== "usd") {
    try {
      const { balancedEthForHeldToken } = await import("../chain/v4/mint.js");
      balanced = balancedEthForHeldToken(pending.token, pending.meta, p.v4, tokRaw);
    } catch {
      /* suggestion is best-effort */
    }
  }
  pending.balancedEth = balanced;

  const reuseLine =
    tokUi > 0 && (p.version === "v4" || p.version === "v2")
      ? `♻️ <b>${tokUi.toPrecision(4)} ${esc(pending.meta.symbol)}</b> udah di wallet — bakal <b>dipake ulang</b> (nggak beli lagi).`
      : "";
  const balLine = balanced > 0 ? `⚖️ Buat <b>dual-side seimbang</b> sama token itu: pasang <b>~${balanced.toFixed(5)} ETH</b>.` : "";
  const showUsdgBtn = isUsdPool && usdgUi >= 1;
  const usdgLine = showUsdgBtn
    ? `💵 <b>$${usdgUi.toFixed(2)} USDG</b> udah di wallet — tap tombol buat <b>single-side tanpa swap / tanpa input</b>.`
    : "";
  const kbRows: { text: string; callback_data: string }[][] = [];
  if (balanced > 0) kbRows.push([{ text: `⚖️ Dual-side seimbang (~${balanced.toFixed(4)} Ξ)`, callback_data: "ballp" }]);
  if (showUsdgBtn) kbRows.push([{ text: `💵 Single-side pakai USDG wallet ($${usdgUi.toFixed(2)})`, callback_data: "usdgw" }]);
  const extra = kbRows.length ? { reply_markup: { inline_keyboard: kbRows } } : {};
  await edit(
    mid,
    [
      `<b>${esc(pending.meta.symbol)}</b> · <b>${p.version.toUpperCase()}</b> fee ${(p.fee / 10000).toFixed(2)}% dipilih.`,
      b
        ? [`💧 <b>${Number(b.eth).toFixed(5)} ETH</b> (native) · <b>${Number(b.weth).toFixed(4)} WETH</b>`,
          `💵 <b>${usdgUi.toFixed(2)} USDG</b> di wallet`]
        : [],
      reuseLine,
      balLine,
      usdgLine,
      ``,
      `💬 <b>Ketik jumlah ETH</b> yang mau di-LP (contoh: <code>0.005</code>)${kbRows.length ? " — atau tap tombol di bawah." : ""}`,
    ]
      .filter(Boolean)
      .join("\n"),
    extra,
  );
}

/** One-tap: dual-side v4 mint with the ETH amount that balances the held token. */
export async function onBalancedLp(mid: number): Promise<void> {
  if (!pending?.chosen?.v4 || !pending.balancedEth) return;
  const amt = toEthStr(pending.balancedEth);
  const b = await balances().catch(() => null);
  if (!amt || (b && Number(amt) > usableEth(b) + 1e-9)) {
    pending.awaitingAmount = true;
    await send(
      `⚠️ Nilai dual-side seimbang (${pending.balancedEth}) nggak valid / lebih gede dari saldo (${b ? usableEth(b).toFixed(5) : "?"} ETH). Ketik jumlah ETH manual aja (contoh: <code>0.005</code>).`,
    );
    return;
  }
  pending.ethAmt = amt;
  pending.awaitingAmount = false;
  await onMintV4(mid, "inrange");
}

/**
 * One-tap: open SINGLE-SIDE USDG funded ENTIRELY from the USDG already in the wallet — no ETH
 * amount to type, no ETH→USDG swap. Sizes the position to the full held USDG by passing its
 * ETH-equivalent as the budget; the mint fn computes target = ethAmt×ethUsd and reuses the held
 * USDG (buys nothing). Only native ETH for gas is needed. This is the "udah ada USDG → gak usah
 * input 0.001 buat swap" flow.
 */
export async function onUseWalletUsdg(mid: number): Promise<void> {
  if (!pending?.chosen) return;
  const isUsd = pending.chosen.v4?.quote === "usd" || pending.chosen.v3?.quote === "usd";
  if (!isUsd) {
    await send("Pool ini bukan pair USDG — pakai input ETH biasa.");
    return;
  }
  const [usdgRaw, b, px] = await Promise.all([
    tokenBalanceRaw(USDG).catch(() => 0n),
    balances().catch(() => null),
    ethUsd().catch(() => 0),
  ]);
  const usdgUi = Number(ethers.formatUnits(usdgRaw, 6));
  if (usdgUi < 1) {
    await send(`USDG di wallet cuma $${usdgUi.toFixed(2)} — kurang buat single-side. Input ETH manual aja.`);
    return;
  }
  if (b && Number(b.eth) < GAS_RESERVE) {
    await send(`⚠️ ETH native ${Number(b.eth).toFixed(5)} < gas reserve ${GAS_RESERVE} — mint tetep butuh gas. Isi dikit ETH native dulu.`);
    return;
  }
  if (!(px > 0)) {
    await send("⚠️ Harga ETH/USD lagi gak kebaca — coba lagi bentar (butuh buat sizing USDG).");
    return;
  }
  // USD → ETH-equivalent budget so the mint fn's target ≈ held USDG → reuse buys nothing (no swap).
  pending.ethAmt = toEthStr(usdgUi / px) ?? String(usdgUi / px);
  pending.awaitingAmount = false;
  const feePct = (pending.chosen.fee / 10000).toFixed(2);
  await edit(mid, `⏳ <b>Single-side USDG pakai $${usdgUi.toFixed(2)} dari wallet…</b> (no swap · fee ${feePct}%)`);
  if (pending.chosen.version === "v4") return onMintV4(mid, "v4us");
  return onMintV3Usdg(mid, true);
}

export async function onAmount(text: string): Promise<void> {
  if (!pending?.chosen) return;
  // custom range % mode — next text is the width, not ETH
  if (pending.awaitingRangePct) {
    const pct = parseFloat(text);
    if (!(pct > 0) || pct > 1000) {
      await send("Masukin angka range yang bener (1–1000 %), contoh: 35");
      return;
    }
    pending.awaitingRangePct = false;
    pending.rangePct = pct;
    cfg.lp.widthPct = pct;
    return showStrategy();
  }
  if (!pending.awaitingAmount) return;
  const eth = parseFloat(text);
  if (!(eth > 0)) {
    await send("Masukin angka ETH yang bener, contoh: 0.005");
    return;
  }
  const b = await balances().catch(() => null);
  if (b && eth > usableEth(b) + 1e-9) {
    await send(
      `⚠️ Kegedean. Yang bisa di-LP cuma ${usableEth(b).toFixed(5)} ETH (WETH ${Number(b.weth).toFixed(4)} + ETH ${Number(b.eth).toFixed(4)}, sisain gas). Ketik lebih kecil.`,
    );
    return;
  }
  if (b && Number(b.eth) < GAS_RESERVE) {
    await send(
      `⚠️ ETH native cuma ${Number(b.eth).toFixed(5)} — kurang buat gas (butuh min ${GAS_RESERVE}). Isi sedikit ETH native, ATAU unwrap dikit WETH → ETH.`,
    );
    return;
  }
  pending.ethAmt = toEthStr(eth) ?? String(eth);
  pending.awaitingAmount = false;

  // ── pilih RANGE dulu (preset ±%) → baru strategi. Semua v3/v4 pakai ini; v2 full-range skip. ──
  if (pending.chosen.version !== "v2") {
    const cur = cfg.lp.widthPct;
    const presets = [10, 20, 50, 100];
    const rows: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < presets.length; i += 2) {
      const row = presets.slice(i, i + 2).map((pct) => ({
        text: `±${pct}%${pct === cur ? " ✓" : ""}`,
        callback_data: `rng:${pct}`,
      }));
      if (row.length === 1) row.push({ text: " ", callback_data: "noop" });
      rows.push(row);
    }
    await send(
      [
        `<b>Pilih range</b> · ${esc(pending.meta.symbol)} · deposit <b>${eth} ETH</b>`,
        ``,
        `Lebar range (setengah lebar di tiap sisi harga). Range <b>sempit</b> = concentrated (fee cepat, tapi gampang out-of-range). Range <b>lebar</b> = aman dari out-of-range, fee lebih lambat.`,
        ``,
        `Atau ketik angka manual (contoh: <code>35</code> = ±35%).`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            ...rows,
            [{ text: `✏️ Custom %`, callback_data: "rng:custom" }],
            [{ text: "❌ Cancel", callback_data: "cancel" }],
          ],
        },
      },
    );
    return;
  }

  // ── v2 pool → zap (full-range, always both-sided) ──
  if (pending.chosen.version === "v2") {
    await send(
      [
        `<b>Konfirmasi LP · Uniswap v2</b>`,
        `${esc(pending.meta.symbol)} · fee <b>0.30%</b> · deposit <b>${eth} ETH</b> · full-range`,
        ``,
        `🎯 v2 selalu <b>both-sided 50/50</b>: bot swap ~separuh ETH → ${esc(pending.meta.symbol)}, sisanya jadi pasangan LP. <b>Fee jalan LANGSUNG.</b>`,
        `⚠️ Langsung pegang token (rug = rugi ~separuh). Nggak ada single-side di v2.`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `🎯 LP v2 (zap ${eth}Ξ)`, callback_data: "mint:v2" }],
            [{ text: "❌ Cancel", callback_data: "cancel" }],
          ],
        },
      },
    );
    return;
  }

  // ── v3/v4 → render pilihan strategi (range sudah dipilih) ──
  return showStrategy();
}

/** Range preset dipilih user → simpan & lanjut ke pilihan strategi. `custom` = next text = angka % */
export async function onRange(pct: number | "custom"): Promise<void> {
  if (!pending?.chosen || !pending.ethAmt) return;
  if (pct === "custom") {
    pending.awaitingRangePct = true;
    await send(
      `Ketik <b>lebar range</b> dalam % (contoh: <code>35</code> = ±35%, <code>10</code> = sempit, <code>200</code> = super lebar).`,
    );
    return;
  }
  pending.rangePct = pct;
  cfg.lp.widthPct = pct; // langsung terapkan — showStrategy & mint baca ini
  return showStrategy();
}

/** Pilihan strategi (in-range / single-side) — dipanggil setelah amount + range dipilih. */
async function showStrategy(): Promise<void> {
  if (!pending?.chosen) return;
  const feed = pending.ethAmt;
  // ── v4 pool → single-side / in-range (farming) ──
  if (pending.chosen.version === "v4") {
    const feePct = (pending.chosen.fee / 10000).toFixed(2);
    const isUsd = pending.chosen.v4?.quote === "usd";
    const widthLine = `· range <b>±${cfg.lp.widthPct}%</b>`;
    if (isUsd) {
      await send(
        [
          `<b>Konfirmasi LP · Uniswap v4 · USDG</b> 🦄`,
          `${esc(pending.meta.symbol)}/USDG · fee <b>${feePct}%</b> · deposit <b>${feed} ETH</b> ${widthLine}`,
          ``,
          `🎯 <b>In-range (farming)</b> — beli USDG + ${esc(pending.meta.symbol)} dari ETH (Uniswap), mint both-sided. <b>Fee ${feePct}% jalan LANGSUNG.</b> Langsung pegang token (rug = rugi).`,
          ``,
          `🛡 <b>Single-side USDG</b> — parkir <b>USDG doang (0 token)</b>, range di sisi USDG. Fee cuma pas ${esc(pending.meta.symbol)} <b>PUMP</b> masuk range. Rug-safe: kalo token dump, USDG lo utuh.`,
        ].join("\n"),
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: `🎯 In-range ${feePct}% (${feed}Ξ)`, callback_data: "mint:v4r" }],
              [{ text: `🛡 Single-side USDG ${feePct}%`, callback_data: "mint:v4us" }],
              [{ text: "❌ Cancel", callback_data: "cancel" }],
            ],
          },
        },
      );
      return;
    }
    await send(
      [
        `<b>Konfirmasi mint · Uniswap v4</b> 🦄`,
        `${esc(pending.meta.symbol)} · fee <b>${feePct}%</b> · deposit <b>${feed} ETH</b> · pair native ETH ${widthLine}`,
        ``,
        `🎯 <b>In-range (farming)</b> — beli token via rute terbaik (Uniswap), mint di sekitar harga. <b>Fee ${feePct}% jalan LANGSUNG.</b> Tapi langsung pegang token (rug = rugi ~separuh).`,
        ``,
        `🛡 <b>Single-side ETH</b> — parkir ETH, range di atas harga. Fee cuma pas harga NAIK masuk range. Aman dari rug.`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `🎯 In-range farming ${feePct}%`, callback_data: "mint:v4r" }],
            [{ text: `🛡 Single-side ETH ${feePct}%`, callback_data: "mint:v4" }],
            [{ text: "❌ Cancel", callback_data: "cancel" }],
          ],
        },
      },
    );
    return;
  }

  // ── v3 token/USDG pool → in-range (farming) or single-side USDG ──
  if (pending.chosen.v3?.quote === "usd") {
    const feePct = (pending.chosen.fee / 10000).toFixed(2);
    await send(
      [
        `<b>Konfirmasi LP · Uniswap v3 · USDG</b>`,
        `${esc(pending.meta.symbol)}/USDG · fee <b>${feePct}%</b> · deposit <b>${feed} ETH</b> · range <b>±${cfg.lp.widthPct}%</b>`,
        ``,
        `🎯 <b>In-range (farming)</b> — beli USDG + ${esc(pending.meta.symbol)} dari ETH (Uniswap), mint both-sided. <b>Fee ${feePct}% jalan LANGSUNG.</b> Langsung pegang token (rug = rugi).`,
        ``,
        `🛡 <b>Single-side USDG</b> — parkir <b>USDG doang (0 token)</b>, range di sisi USDG. Fee cuma pas ${esc(pending.meta.symbol)} <b>PUMP</b> masuk range. Rug-safe: kalo token dump, USDG lo utuh.`,
      ].join("\n"),
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: `🎯 In-range ${feePct}% (${feed}Ξ)`, callback_data: "mint:v3u" }],
            [{ text: `🛡 Single-side USDG ${feePct}%`, callback_data: "mint:v3us" }],
            [{ text: "❌ Cancel", callback_data: "cancel" }],
          ],
        },
      },
    );
    return;
  }

  // ── v3 pool → single / in-range ──
  const v3pool = pending.chosen.v3!.pool;
  const [pS, pI] = await Promise.all([
    previewRange(pending.token, v3pool, "single").catch(() => null),
    previewRange(pending.token, v3pool, "inrange").catch(() => null),
  ]);
  const rng = (p: typeof pS): string => (p ? `${fmtMcap(p.rangeMcapLow)} → ${fmtMcap(p.rangeMcapHigh)}` : "?");
  await send(
    [
      `<b>Konfirmasi mint · Uniswap v3</b>`,
      `${esc(pending.meta.symbol)} · fee ${(pending.chosen.fee / 10000).toFixed(2)}% · deposit <b>${feed} ETH</b> · width ${cfg.lp.widthPct}%`,
      pS ? `📊 MCAP now: <b>${fmtMcap(pS.mcapNow)}</b>` : "",
      ``,
      `🛡 <b>Single-side ETH</b> — range ${rng(pS)}`,
      `   0% token. Fee jalan cuma kalau MCAP masuk range. Aman dari rug.`,
      ``,
      `🎯 <b>In-range</b> — range ${rng(pI)}`,
      `   swap ~<b>${pI?.swapPct ?? "?"}%</b> modal → ${esc(pending.meta.symbol)} duluan. Fee LANGSUNG jalan,`,
      `   tapi lu langsung pegang token (rug = rugi ${pI?.swapPct ?? "?"}% instan).`,
    ]
      .filter(Boolean)
      .join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: `🎯 In-range (swap ~${pI?.swapPct ?? "?"}%)`, callback_data: "mint:inrange" }],
          [{ text: "🛡 Single-side ETH", callback_data: "mint:single" }],
          [{ text: "❌ Cancel", callback_data: "cancel" }],
        ],
      },
    },
  );
}

export async function onMint(mid: number, action = "single"): Promise<void> {
  invalidateListCache();
  if (!pending?.chosen || !pending.ethAmt) return;
  // terapkan range pilihan user (kalau ada) ke konfigurasi — semua fungsi mint baca cfg.lp.widthPct
  if (pending.rangePct) cfg.lp.widthPct = pending.rangePct;
  if (pending.chosen.version === "v2") return onMintV2(mid);
  if (pending.chosen.version === "v4") return onMintV4(mid, action);
  if (pending.chosen.v3?.quote === "usd") return onMintV3Usdg(mid, action === "v3us");

  const mode: MintMode = action === "inrange" ? "inrange" : "single";
  const inR = mode === "inrange";
  await edit(
    mid,
    `⏳ <b>Minting v3 ${pending.ethAmt} ETH…</b> ${inR ? "(wrap → swap → approve → mint)" : "(wrap → approve → mint)"}`,
  );
  try {
    const r = await openPosition(pending.token, pending.chosen.v3!.pool, pending.ethAmt, { mode });
    const sym = pending.meta.symbol;
    pending = null;
    await send(
      [
        `✅ <b>${esc(sym)} #${r.tokenId ?? "?"}</b> [v3] ${inR ? "🎯 IN-RANGE" : "🛡 single-side"}`,
        r.wrapHash ? `wrap: <a href="${explorerTx(r.wrapHash)}">tx</a>` : "",
        r.swapHash ? `swap ${r.swappedPct}% → ${esc(sym)}: <a href="${explorerTx(r.swapHash)}">tx</a>` : "",
        `range tick ${r.tickLower}..${r.tickUpper}`,
        `📊 entry MCAP ${fmtMcap(r.entryMcap)} · ${r.side}`,
        `deposit ~${Number(r.depositEth).toFixed(5)}Ξ`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ Mint gagal: ${short(e, 160)}`);
  }
}

/** Mint a token/USDG v3 position — both-sided in-range, or single-side USDG (park stable only). */
async function onMintV3Usdg(mid: number, single = false): Promise<void> {
  invalidateListCache();
  if (!pending?.chosen?.v3 || !pending.ethAmt) return;
  const feePct = (pending.chosen.fee / 10000).toFixed(2);
  await edit(mid, `⏳ <b>Minting v3 USDG ${pending.ethAmt} ETH…</b> ${single ? "(Uniswap → USDG → single-side)" : "(Uniswap → USDG+token → mint both-sided)"}`);
  try {
    const r = single ? await openV3UsdgSingleSide(pending.chosen.v3, pending.ethAmt) : await openV3UsdgInRange(pending.chosen.v3, pending.ethAmt);
    const sym = pending.meta.symbol;
    pending = null;
    await send(
      [
        `✅ <b>${esc(sym)}/USDG #${r.tokenId ?? "?"}</b> [v3] ${single ? "🛡 SINGLE-SIDE USDG" : "🎯 IN-RANGE (farming)"}`,
        r.wrapHash ? `wrap: <a href="${explorerTx(r.wrapHash)}">tx</a>` : "",
        r.swapHash ? `beli USDG (Uniswap): <a href="${explorerTx(r.swapHash)}">tx</a>` : "",
        `pool fee <b>${feePct}%</b> · range tick ${r.tickLower}..${r.tickUpper}`,
        `deposit ${r.depositEth}Ξ · ${esc(r.side)}`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ Mint gagal: ${short(e, 160)}`);
  }
}

async function onMintV4(mid: number, action: string): Promise<void> {
  invalidateListCache();
  if (!pending?.chosen?.v4 || !pending.ethAmt) return;
  const fee = pending.chosen.v4.fee;
  const isUsd = pending.chosen.v4.quote === "usd";
  const v4pool = pending.chosen.v4;
  const usdgSingle = isUsd && action === "v4us";
  const inR = isUsd ? !usdgSingle : action === "v4r" || action === "inrange"; // ETH: v4r/inrange = farming
  await edit(mid, `⏳ <b>Minting v4 ${pending.ethAmt} ETH…</b> ${usdgSingle ? "(Uniswap → USDG → single-side)" : isUsd ? "(Uniswap → USDG+token → mint)" : inR ? "(swap → Permit2 → mint in-range)" : "(simulasi → mint single-side)"}`);
  try {
    const { openV4SingleSide, openV4InRange, openV4UsdgInRange, openV4UsdgSingleSide } = await import("../chain/v4/mint.js");
    const r = usdgSingle
      ? await openV4UsdgSingleSide(v4pool, pending.ethAmt)
      : isUsd
        ? await openV4UsdgInRange(v4pool, pending.ethAmt)
        : inR
          ? await openV4InRange(pending.token, pending.ethAmt, { fee })
          : await openV4SingleSide(pending.token, pending.ethAmt, { fee });
    const sym = pending.meta.symbol;
    pending = null;
    await send(
      [
        `✅ <b>${esc(sym)} #${r.tokenId ?? "?"}</b> [v4] 🦄 ${inR ? "🎯 IN-RANGE (farming)" : "single-side"}`,
        inR && (r as any).swapHash ? `swap ${(r as any).swappedPct}% → ${esc(sym)}: <a href="${explorerTx((r as any).swapHash)}">tx</a>` : "",
        `pool fee <b>${(r.fee / 10000).toFixed(2)}%</b> · range tick ${r.tickLower}..${r.tickUpper}`,
        `deposit ${r.depositEth}Ξ`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
        `Tutup: <code>/v4close ${r.tokenId}</code>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ v4 mint gagal: ${short(e, 160)}`);
  }
}

async function onMintV2(mid: number): Promise<void> {
  if (!pending?.chosen?.v2 || !pending.ethAmt) return;
  await edit(mid, `⏳ <b>LP v2 ${pending.ethAmt} ETH…</b> (wrap → swap ~50% → add liquidity)`);
  try {
    const { openV2 } = await import("../chain/v2/mint.js");
    const r = await openV2(pending.token, pending.ethAmt);
    const sym = pending.meta.symbol;
    pending = null;
    await send(
      [
        `✅ <b>${esc(sym)}</b> [v2] 🎯 full-range LP`,
        r.wrapHash ? `wrap: <a href="${explorerTx(r.wrapHash)}">tx</a>` : "",
        r.swapHash ? `swap ~50% → ${esc(sym)}: <a href="${explorerTx(r.swapHash)}">tx</a>` : "",
        `pool fee <b>0.30%</b> · deposit ${r.depositEth}Ξ`,
        `add-LP: <a href="${explorerTx(r.txHash)}">tx</a>`,
        `pair <code>${r.pair}</code>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch (e) {
    await send(`❌ v2 LP gagal: ${short(e, 160)}`);
  }
}

// ══════════ /list ══════════

// cache the assembled /list payload so re-opening or spamming isn't a fresh multi-second on-chain
// scan each time. Refresh (force) bypasses it; any close/mint invalidates it.
let listCache: { head: string; body: string; btns: object[]; at: number } | null = null;
export function invalidateListCache(): void {
  listCache = null;
}
const LIST_TTL_MS = 20_000;

/** Range slider ala Uniswap: label % (jarak harga → batas range) di dua ujung, █ = harga sekarang. */
function rangeBar(tickNow: number, tickLower: number, tickUpper: number, w = 20): string {
  const lo = Math.min(tickLower, tickUpper);
  const hi = Math.max(tickLower, tickUpper);
  const pNow = Math.pow(1.0001, tickNow);
  const pLo = Math.pow(1.0001, lo);
  const pHi = Math.pow(1.0001, hi);
  const pctLo = (pLo / pNow - 1) * 100; // negatif = di bawah harga
  const pctHi = (pHi / pNow - 1) * 100; // positif = di atas harga
  const fmt = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const inRange = tickNow >= lo && tickNow <= hi;
  const pos = Math.max(0, Math.min(1, (tickNow - lo) / (hi - lo || 1)));
  const at = Math.round(pos * (w - 1));
  const barArr = Array.from({ length: w }, (_, i) => {
    if (i === at) return inRange ? "█" : "◦";
    return i < at ? "▓" : "░";
  });
  // FLIP kanan-ke-kiri: kanan = lower bound, kiri = upper bound (kebalikan chart Uniswap)
  const bar = barArr.reverse().join("");
  const loL = fmt(pctLo);
  const hiL = fmt(pctHi);
  // label kiri = upper (positif), label kanan = lower (negatif), sejajar dgn ujung bar
  const padL = Math.max(1, w - loL.length - hiL.length);
  return `${hiL}${" ".repeat(padL)}${loL}\n${bar}`;
}

/** Watch ANY wallet's LP positions + PnL — removed (unused). */

export async function onList(mid: number | null = null, force = false, watchAddr?: string): Promise<void> {
  if (!force && !watchAddr && listCache && Date.now() - listCache.at < LIST_TTL_MS) {
    const c = listCache;
    const km = { reply_markup: { inline_keyboard: c.btns } };
    await (mid ? edit(mid, c.head + "\n" + c.body, km) : send(c.head + "\n" + c.body, km));
    return;
  }
  if (!mid) {
    const m = await send("⏳ Memuat posisi…");
    mid = m?.result?.message_id ?? null;
  }
  const out = (txt: string, extra?: Record<string, unknown>) => (mid ? edit(mid, txt, extra) : send(txt, extra));
  const { listV4Positions } = await import("../chain/v4/list.js");
  // v3 + v4 in parallel (v2 dropped — fee 0.30% only, not part of the high-fee farming strategy)
  // v4 served from the ≤90s background snapshot (manage loop keeps it warm) so /list prints instantly
  // instead of racing the RPC against the hunt scan. 🔄 Refresh (force) recomputes fresh.
  const _t0 = Date.now();
  const [v3t, v4t] = [{ ms: 0 }, { ms: 0 }];
  const [rowsRes, v4rows] = await Promise.all([
    (async () => { const s = Date.now(); const r = await listPositions(watchAddr).then((r) => ({ ok: true as const, r })).catch((e) => ({ ok: false as const, e })); v3t.ms = Date.now() - s; return r; })(),
    (async () => { const s = Date.now(); const r = await listV4Positions(force ? 0 : 90_000, watchAddr).catch(() => [] as Awaited<ReturnType<typeof listV4Positions>>); v4t.ms = Date.now() - s; return r; })(),
  ]);
  const _px0 = Date.now();
  log.info(`/list timing: v3 ${v3t.ms}ms · v4 ${v4t.ms}ms (${v4rows.length}pos, force=${force}) · data-total ${_px0 - _t0}ms`);
  if (!rowsRes.ok) {
    await out(`❌ ${short(rowsRes.e, 80)}`);
    return;
  }
  const rows = rowsRes.r;
  const refreshBtn = [{ text: "🔄 Refresh", callback_data: "refresh" }];
  if (!rows.length && !v4rows.length) {
    await out("Tidak ada posisi LP terbuka (v3/v4).", { reply_markup: { inline_keyboard: [refreshBtn] } });
    return;
  }
  const px = await ethUsd().catch(() => 0);

  const T: string[] = [];
  rows.forEach((r, i) => {
    const tag = `${r.inRange ? "🟢 IN RANGE" : "🔴 OUT OF RANGE"}${r.mode === "inrange" ? " · 🎯" : ""}`;
    if (i) T.push("");
    T.push(`${tokenEmoji(r.tokenSym)} ${r.pair ?? `${r.tokenSym}/WETH`}  ·  fee ${(r.fee / 10000).toFixed(2)}%  ·  #${r.tokenId}`);
    T.push(`   ${tag}`);
    T.push(`   ${padR("nilai", 7)} $${(r.valEth * (px || 0)).toFixed(2)}`);
    if (r.pnlEth != null) {
      T.push(`   ${padR("pnl", 7)} ${r.pnlEth >= 0 ? "+" : "-"}$${Math.abs(r.pnlEth * px).toFixed(2)}`);
    } else {
      T.push(`   ${padR("pnl", 7)} —`);
    }
    T.push(`   ${padR("fee", 7)} $${(r.feeEth * (px || 0)).toFixed(2)}`);
    T.push(`   ${padR("umur", 7)} ${fmtAge(r.ageMs)}${r.ageSource === "onchain" ? " ⛓" : ""}`);
    if (r.tickLower != null && r.tickUpper != null) T.push(`   ${rangeBar(r.tick, r.tickLower, r.tickUpper)}`);
  });

  const dupe: Record<string, number> = {};
  rows.forEach((r) => (dupe[r.tokenSym] = (dupe[r.tokenSym] || 0) + 1));
  const btns: object[] = [refreshBtn];
  if (!watchAddr) {
    rows.forEach((r) => {
      const p =
        r.pnlEth != null
          ? ` ${r.pnlEth >= 0 ? "🟩" : "🟥"} ${r.pnlEth >= 0 ? "+" : "-"}$${Math.abs(r.pnlEth * px).toFixed(2)} · ${sg(r.pnlPct ?? 0, 1)}%`
          : "";
      const id = dupe[r.tokenSym]! > 1 ? ` #${r.tokenId}` : "";
      btns.push([{ text: `Close ${r.tokenSym}${id}${p}`, callback_data: `close:${r.tokenId}` }]);
    });
    if (rows.length > 1) btns.push([{ text: `🗑🗑 CLOSE ALL (${rows.length} posisi)`, callback_data: "closeall" }]);
  }

  // ── v4 positions block ──
  const T4: string[] = [];
  if (v4rows.length) {
    T4.push(`🦄 UNISWAP v4 · ${v4rows.length} posisi`);
    T4.push("─".repeat(37));
    v4rows.forEach((r, i) => {
      if (i) T4.push("");
      T4.push(`${tokenEmoji(r.sym)} ${r.pair}  ·  fee ${(r.fee / 10000).toFixed(2)}%  ·  #${r.tokenId}`);
      T4.push(`${r.inRange ? "🟢 IN RANGE" : "🔴 OUT OF RANGE"}${r.ethPaired ? "" : " · non-ETH pair"}`);
      const pnlS = r.depEth != null && px > 0 ? `${((r.valueUsd - r.depEth * px) >= 0 ? "+" : "-")}$${Math.abs(r.valueUsd - r.depEth * px).toFixed(2)}` : "—";
      T4.push(`Value $${r.valueUsd.toFixed(2)} • Fee $${r.feeUsd.toFixed(2)} • Pnl ${pnlS}`);
      if (r.tickLower != null && r.tickUpper != null) T4.push(rangeBar(r.tick, r.tickLower, r.tickUpper));
    });
    const dupe4: Record<string, number> = {};
    v4rows.forEach((r) => (dupe4[r.sym] = (dupe4[r.sym] || 0) + 1));
    if (!watchAddr) {
      for (const r of v4rows) {
        const idTag = dupe4[r.sym]! > 1 ? ` #${r.tokenId}` : "";
        const row: object[] = [];
        // only offer Claim when there's fee worth claiming
        if (r.feeUsd > 0.01) row.push({ text: `💰 Claim`, callback_data: `v4f:${r.tokenId}` });
        row.push({ text: `➕ Add`, callback_data: `add4:${r.tokenId}` });
        row.push({ text: `Close ${r.sym}${idTag}`, callback_data: `v4c:${r.tokenId}` });
        btns.push(row);
      }
    }
  }

  const jam = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const head = watchAddr
    ? `👁 <b>Posisi LP</b> <code>${watchAddr}</code>${px ? ` · ETH $${px.toFixed(0)}` : ""} · <i>${jam}</i>\n<i>read-only — gak bisa close/add</i>`
    : `📋 <b>Posisi LP</b>${px ? ` · ETH $${px.toFixed(0)}` : ""} · <i>${jam}</i>`;
  const body =
    (rows.length ? T.join("\n") : "") +
    (T4.length ? T4.join("\n") : "");
  listCache = { head, body, btns, at: Date.now() };
  await out(head + "\n" + body, { reply_markup: { inline_keyboard: btns } });
}

// ══════════ /ledger ══════════

const LEDGER_PER_PAGE = 5;
// cache the slow on-chain v4 "closed positions" scan so paginating (Next/Back) is instant
let ledgerHistCache: { v4hist: Awaited<ReturnType<typeof import("../chain/v4/list.js")["listClosedV4Positions"]>>; at: number } | null = null;
export async function onLedger(page = 0, mid: number | null = null): Promise<void> {
  const out = (txt: string, extra?: Record<string, unknown>) => (mid ? edit(mid, txt, extra) : send(txt, extra));
  const { listClosedV4Positions } = await import("../chain/v4/list.js");
  const allEntries = readLedger(); // unified: v3 + v4 + v2 (forward-tracked closes) — cheap (file)
  const entryIds = new Set(allEntries.map((e) => e.tokenId));
  // v4 historical scan (on-chain, per-NFT → slow) is CACHED so Next/Back doesn't refetch each page
  let v4hist: Awaited<ReturnType<typeof listClosedV4Positions>>;
  if (ledgerHistCache && Date.now() - ledgerHistCache.at < 45_000) {
    v4hist = ledgerHistCache.v4hist.filter((c) => !entryIds.has(c.tokenId));
  } else {
    const v4closedRaw = await listClosedV4Positions().catch(() => [] as Awaited<ReturnType<typeof listClosedV4Positions>>);
    ledgerHistCache = { v4hist: v4closedRaw, at: Date.now() };
    v4hist = v4closedRaw.filter((c) => !entryIds.has(c.tokenId));
  }
  const sum = ledgerSummary();

  if (!allEntries.length && !v4hist.length) {
    await out("⏳ <b>Ledger kosong — rebuild dari on-chain…</b>");
    try {
      await backfillLedger();
    } catch (e) {
      await out(`❌ Rebuild gagal: ${short(e, 90)}`);
      return;
    }
    if (!readLedger().length) {
      await out("📒 Belum ada posisi LP yang pernah ditutup.\n<i>Keisi otomatis tiap lu close posisi.</i>");
      return;
    }
    return onLedger(page, mid);
  }

  // unified closed list, RECENT FIRST (v3 + v4 + v2 entries interleaved by close time;
  // v4 positions closed before tracking shown last with PnL unavailable)
  type LedRow = { e?: (typeof allEntries)[number]; v4h?: (typeof v4hist)[number]; ts: number };
  const combined: LedRow[] = [
    ...allEntries.map((e) => ({ e, ts: e.closedAt ?? 0 })),
    ...v4hist.map((c) => ({ v4h: c, ts: c.closedAt ?? 0 })),
  ].sort((a, b) => b.ts - a.ts);
  const pages = Math.max(1, Math.ceil(combined.length / LEDGER_PER_PAGE));
  page = Math.min(Math.max(0, page), pages - 1);
  const slice = combined.slice(page * LEDGER_PER_PAGE, page * LEDGER_PER_PAGE + LEDGER_PER_PAGE);
  const px = await ethUsd().catch(() => 0);
  const when = (ts: number | null) =>
    ts ? new Date(ts).toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "?";
  const verTag = (v?: string) => (v === "v4" ? "v4 🦄" : v === "v2" ? "v2 💧" : "v3");

  const T: string[] = [];
  slice.forEach((row, i) => {
    const n = page * LEDGER_PER_PAGE + i + 1;
    if (i) T.push("");
    if (row.e) {
      const e = row.e;
      const name = e.pair ?? `${e.sym}/WETH`; // v3 has no pair field → it's always token/WETH
      const win = e.pnlEth == null ? "⬜" : e.pnlEth >= 0 ? "🟩" : "🟥";
      T.push(`${win} ${tokenEmoji(e.sym)} ${name} · ${verTag(e.version)}${e.mode === "inrange" ? " 🎯" : ""}   ${n}/${combined.length}`);
      T.push(`   ${when(e.closedAt)} · hold ${fmtAge(e.heldMs)}`);
      if (e.quote === "usd") {
        // USDG-paired pools → show USD (natural unit); ETH shown as secondary
        const at = e.ethUsdAtClose || px || 0;
        const $ = (eth: number) => "$" + (eth * at).toFixed(2);
        T.push(`   modal ${$(e.depEth ?? 0)} → balik ${$(e.outEth ?? 0)}`);
        if (e.pnlEth != null) T.push(`   PnL ${e.pnlUsd != null ? money(e.pnlUsd) : $(e.pnlEth)}  (${sg(e.pnlEth, 5)}Ξ)  ${sg(e.pnlPct ?? 0, 1)}%`);
        else T.push(`   PnL — (modal tak tercatat)`);
      } else {
        T.push(`   modal ${(e.depEth ?? 0).toFixed(5)}Ξ → balik ${(e.outEth ?? 0).toFixed(5)}Ξ`);
        if (e.pnlEth != null) T.push(`   PnL ${sg(e.pnlEth, 5)}Ξ  ${e.pnlUsd != null ? money(e.pnlUsd) : "—"}  ${sg(e.pnlPct ?? 0, 1)}%`);
        else T.push(`   PnL — (modal tak tercatat)`);
      }
      if ((e.unsoldEth ?? 0) > 0) T.push(`   🪙 nyangkut ~${(e.unsoldEth ?? 0).toFixed(5)}Ξ (blm dijual)`);
    } else if (row.v4h) {
      const c = row.v4h;
      T.push(`⬜ ${tokenEmoji(c.pair)} ${c.pair} · v4 🦄   ${n}/${combined.length}`);
      T.push(`   ${when(c.closedAt)} · #${c.tokenId} · fee ${(c.fee / 10000).toFixed(2)}%`);
      T.push(`   PnL — (histori sblm tracking${c.depEth != null ? `, modal ${c.depEth.toFixed(5)}Ξ` : ""})`);
    }
  });

  const nV3 = allEntries.filter((e) => (e.version ?? "v3") === "v3").length;
  const nV4 = allEntries.filter((e) => e.version === "v4").length + v4hist.length;
  const nV2 = allEntries.filter((e) => e.version === "v2").length;
  const net = sum.pnlEth + sum.unsoldEth;
  const S: string[] = [];
  S.push(`${combined.length} DITUTUP · ${nV3} v3 · ${nV4} v4${nV2 ? ` · ${nV2} v2` : ""}`);
  S.push("─".repeat(34));
  S.push(`${padR("menang", 9)} ${sum.wins}W / ${sum.losses}L · ${sum.winRate.toFixed(0)}%`);
  S.push(`${padR("modal", 9)} ${sum.depEth.toFixed(5)}Ξ · fee ${sum.feeEth.toFixed(5)}Ξ`);
  S.push(`${padR("REALIZED", 9)} ${sg(sum.pnlEth, 5)}Ξ · ${money(sum.pnlUsd)}`);
  if (sum.unsoldEth > 0) S.push(`${padR("nyangkut", 9)} +${sum.unsoldEth.toFixed(5)}Ξ · +$${(sum.unsoldEth * px).toFixed(2)}`);
  S.push(`${padR("NET", 9)} ${sg(net, 5)}Ξ · ${money(net * px)}`);

  const nav: object[] = [];
  if (page > 0) nav.push({ text: "◀️ Back", callback_data: `lg:${page - 1}` });
  nav.push({ text: `${page + 1}/${pages}`, callback_data: `lg:${page}` });
  if (page < pages - 1) nav.push({ text: "Next ▶️", callback_data: `lg:${page + 1}` });

  const head = `📒 <b>Ledger LP</b> · ${combined.length} posisi ditutup`;
  const foot = v4hist.length
    ? `<i>Stats gabung v3+v4+v2. ${v4hist.length} posisi v4 LAMA blm direkonstruksi — tap 🔄 Rebuild.</i>`
    : "";
  // 📸 card button per closed position on this page (positions with recorded PnL)
  const cardBtns: object[] = [];
  slice.forEach((row) => {
    if (row.e && row.e.pnlEth != null) {
      const e = row.e;
      const p = e.pnlEth! >= 0 ? "🟩" : "🟥";
      cardBtns.push([{ text: `📸 ${tokenEmoji(e.sym)} ${e.pair ?? `${e.sym}/WETH`} ${p}`, callback_data: `cardp:${e.tokenId}` }]);
    }
  });
  await out(head + "\n" + pre(T.join("\n")) + pre(S.join("\n")) + foot, {
    reply_markup: {
      inline_keyboard: [
        nav,
        ...cardBtns,
        [{ text: "📸 Kartu portfolio", callback_data: "card" }, { text: "🔄 Rebuild on-chain", callback_data: "lgrb" }],
      ],
    },
  });
}

export async function onLedgerRebuild(mid: number): Promise<void> {
  ledgerHistCache = null; // force a fresh on-chain scan
  try {
    const prog = (msg: string) => void edit(mid, `⏳ <b>Rebuild ledger dari on-chain</b>\n<i>${esc(msg)}</i>`).catch(() => {});
    const r = await backfillLedger(prog);
    // v4 positions closed before tracking → reconstruct realized PnL from archive (historical price)
    const { backfillLedgerV4 } = await import("../chain/v4/backfill.js");
    const r4 = await backfillLedgerV4(prog).catch(() => ({ rebuilt: 0 }));
    await edit(mid, `✅ Rebuild selesai — v3: ${r.rebuilt} · v4: ${r4.rebuilt} direkonstruksi dari on-chain.`);
    await onLedger(0);
  } catch (e) {
    await edit(mid, `❌ Rebuild gagal: ${short(e, 100)}`);
  }
}

// ══════════ /scan / /screen / /watch / /feed / /auto — REMOVED ══════════
// All these commands were removed (auto-scan, GMGN screen, watch scanner, feed
// monitor, auto-LP) when the bot was simplified. Functions deleted.


// ══════════ /feed — REMOVED ══════════

// ══════════ /v4 (detect v4 pools) ══════════

export async function onV4(ca?: string): Promise<void> {
  if (!ca || !/^0x[a-fA-F0-9]{40}$/.test(ca)) {
    await send("Format: <code>/v4 0x…</code> (CA token) — liat pool v4/ETH + fee + likuiditas.");
    return;
  }
  const m = await send(`🔎 Cek pool v4 <code>${ca}</code>…`);
  const mid = m?.result?.message_id;
  try {
    const { discoverV4Pools, pickV4Pool } = await import("../chain/v4/discover.js");
    const meta = await tokenMeta(ca).catch(() => null);
    const pools = await discoverV4Pools(ca);
    if (!pools.length) {
      await edit(mid, `Nggak ada pool v4/ETH buat ${meta?.symbol ?? "token"} ini.`);
      return;
    }
    const T = pools
      .sort((a, b) => b.fee - a.fee)
      .map((p) => `  ${padR((p.fee / 10000).toFixed(2) + "%", 7)} ${p.liquidity > 0n ? "✅ ada likuiditas" : "— kosong"}  tick ${p.tick}`);
    const pick = pickV4Pool(pools);
    await edit(
      mid,
      `🦄 <b>Pool v4/ETH · ${esc(meta?.symbol ?? "?")}</b>${pre(T.join("\n"))}` +
        (pick ? `Target LP (fee tertinggi + likuid): <b>${(pick.fee / 10000).toFixed(2)}%</b>\n` : "") +
        `<i>Mint/close v4 = Fase 2 (lagi dibangun). Sekarang deteksi doang.</i>`,
    );
  } catch (e) {
    await edit(mid, `❌ ${short(e, 90)}`);
  }
}

// ══════════ /v4lp /v4close (v4 LP execution — single-side ETH) ══════════

export async function onV4Lp(text: string): Promise<void> {
  const [, ca, ethStr] = text.split(/\s+/);
  if (!ca || !/^0x[a-fA-F0-9]{40}$/.test(ca) || !ethStr || !(parseFloat(ethStr) > 0)) {
    await send("Format: <code>/v4lp 0x… 0.001</code> — buka LP v4 single-side ETH di pool fee-tertinggi.");
    return;
  }
  const eth = parseFloat(ethStr);
  const b = await balances().catch(() => null);
  if (b && eth > usableEth(b) + 1e-9) {
    await send(`⚠️ Kegedean. Bisa di-LP cuma ${usableEth(b).toFixed(5)} ETH.`);
    return;
  }
  const m = await send(`⏳ <b>Mint v4 ${eth} ETH…</b> (discover pool → simulasi → mint native ETH)`);
  const mid = m?.result?.message_id;
  try {
    const { openV4SingleSide } = await import("../chain/v4/mint.js");
    const r = await openV4SingleSide(ca, String(eth));
    await edit(
      mid,
      [
        `✅ <b>v4 LP dibuka</b> #${r.tokenId ?? "?"} 🦄`,
        `pool fee <b>${(r.fee / 10000).toFixed(2)}%</b> · single-side ETH`,
        `range tick ${r.tickLower}..${r.tickUpper} · deposit ${r.depositEth}Ξ`,
        `mint: <a href="${explorerTx(r.txHash)}">tx</a>`,
        `Tutup: <code>/v4close ${r.tokenId}</code>`,
      ].join("\n"),
    );
  } catch (e) {
    await edit(mid, `❌ v4 mint gagal: ${short(e, 160)}`);
  }
}

export async function onV4Close(text: string): Promise<void> {
  invalidateListCache();
  const [, tokenId] = text.split(/\s+/);
  if (!tokenId || !/^\d+$/.test(tokenId)) {
    await send("Format: <code>/v4close &lt;tokenId&gt;</code>");
    return;
  }
  const m = await send(`⏳ Closing v4 #${tokenId}…`);
  const mid = m?.result?.message_id;
  try {
    const { closeV4Position } = await import("../chain/v4/close.js");
    const r = await closeV4Position(tokenId);
    await edit(
      mid,
      [
        `✅ <b>v4 #${tokenId} closed</b> · pool fee ${(r.fee / 10000).toFixed(2)}%`,
        `Balik: ${r.recv0 > 0 ? `${r.recv0.toFixed(6)} ${r.sym0}` : ""}${r.recv0 > 0 && r.recv1 > 0 ? " + " : ""}${r.recv1 > 0 ? `${r.recv1.toFixed(6)} ${r.sym1}` : ""}`,
        r.feeEth > 0 ? `🧲 fee earned: <b>${r.feeEth.toFixed(6)}Ξ</b>` : "",
        r.sweptEth && r.sweptEth > 0
          ? `💱 proceeds → <b>+${r.sweptEth.toFixed(6)}Ξ</b> (auto-swap ke ETH)${r.sweepHash ? ` · <a href="${explorerTx(r.sweepHash)}">tx</a>` : ""}`
          : "",
        r.forfeited ? `⚠️ <b>${esc(r.forfeited)}</b> nggak bisa ditarik (honeypot/rug) — direlakan, ETH diselamatkan.` : "",
        `tx: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const v4quote = /usdg|usd/i.test(r.pair) && !/\beth\b|weth/i.test(r.pair) ? ("usd" as const) : ("eth" as const);
    await sendCloseCard({ name: r.pair, version: "v4", quote: v4quote, depEth: r.depEth, outEth: r.outEth, feeEth: r.feeEth, pnlEth: r.pnlEth, pnlPct: r.pnlPct });
  } catch (e) {
    await edit(mid, `❌ v4 close gagal: ${short(e, 160)}`);
  }
}

export async function onV4Collect(tokenId: string): Promise<void> {
  const m = await send(`⏳ Claim fee v4 #${tokenId}…`);
  const mid = m?.result?.message_id;
  try {
    const { collectV4Fees } = await import("../chain/v4/close.js");
    const r = await collectV4Fees(tokenId);
    const got = [r.fee0 > 0 ? `${r.fee0.toFixed(6)} ${r.sym0}` : "", r.fee1 > 0 ? `${r.fee1.toFixed(6)} ${r.sym1}` : ""].filter(Boolean).join(" + ");
    await edit(
      mid,
      [
        `✅ <b>Fee di-claim · v4 #${tokenId}</b>`,
        got ? `Dapet: ${got}` : `Nggak ada fee buat di-claim.`,
        `tx: <a href="${explorerTx(r.txHash)}">tx</a>`,
      ].join("\n"),
    );
  } catch (e) {
    await edit(mid, `❌ Claim fee gagal: ${short(e, 160)}`);
  }
}

export async function onV2Close(pair: string): Promise<void> {
  invalidateListCache();
  if (!/^0x[0-9a-fA-F]{40}$/.test(pair)) {
    await send("Format: <code>/v2close &lt;pairAddress&gt;</code>");
    return;
  }
  const m = await send(`⏳ Closing v2 ${pair.slice(0, 10)}…`);
  const mid = m?.result?.message_id;
  try {
    const { closeV2Position } = await import("../chain/v2/close.js");
    const r = await closeV2Position(pair);
    await edit(
      mid,
      [
        `✅ <b>v2 ${esc(r.sym)}/WETH closed</b>`,
        `Balik: <b>${r.recvEth.toFixed(6)} ETH</b>${r.soldToken ? " (token dijual balik)" : r.recvToken > 0 ? ` + ${r.recvToken.toPrecision(6)} ${esc(r.sym)}` : ""}`,
        r.pnlEth != null ? `PnL: ${r.pnlEth >= 0 ? "🟩 +" : "🟥 "}${r.pnlEth.toFixed(6)}Ξ` : "",
        `burn: <a href="${explorerTx(r.txHash)}">tx</a>${r.swapHash ? ` · sell: <a href="${explorerTx(r.swapHash)}">tx</a>` : ""}`,
      ]
        .filter(Boolean)
        .join("\n"),
    );
    await sendCloseCard({ name: `${r.sym}/WETH`, version: "v2", depEth: r.depEth, outEth: r.recvEth, pnlEth: r.pnlEth });
  } catch (e) {
    await edit(mid, `❌ v2 close gagal: ${short(e, 160)}`);
  }
}

// ══════════ /auto — REMOVED ══════════

// ══════════ close ══════════

export async function onCloseAsk(tokenId: string, mid: number): Promise<void> {
  await edit(mid, `Close #${tokenId} — fee/token-nya mau diapain?\n<i>(LP principal tetap balik jadi ETH)</i>`, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Swap token → ETH (full ETH)", callback_data: `cs:${tokenId}` }],
        [{ text: "🪙 Simpen token (WETH + token)", callback_data: `ck:${tokenId}` }],
      ],
    },
  });
}

export async function onClose(tokenId: string, mid: number, swapToken = true): Promise<void> {
  invalidateListCache();
  await edit(mid, `⏳ Closing #${tokenId}… ${swapToken ? "(swap token→ETH)" : "(simpen token)"}`);
  try {
    const r = await closePosition(tokenId, { swapToken });
    const px = await ethUsd().catch(() => 0);
    const pnl =
      r.pnlEth != null
        ? `\n💰 <b>PnL ETH: ${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(6)}Ξ</b> (${r.pnlPct! >= 0 ? "+" : ""}${r.pnlPct!.toFixed(1)}%)\n💵 <b>PnL USD: ${r.pnlEth >= 0 ? "+" : ""}$${px ? (r.pnlEth * px).toFixed(2) : "?"}</b>`
        : `\nPnL: — (deposit tak tercatat)`;
    await send(
      [
        `✅ <b>Closed #${tokenId}</b>${px ? ` · ETH $${px.toFixed(0)}` : ""}`,
        r.heldMs != null ? `⏱ di-hold <b>${fmtAge(r.heldMs)}</b>` : "",
        `Tarik: ${r.recvWeth.toFixed(6)} ${r.wethSym}${r.recvToken > 0 ? ` + ${r.recvToken.toFixed(2)} ${r.tokenSym}` : ""}`,
        r.swappedWeth > 0
          ? `🔄 Swap ${r.tokenSym} → +${r.swappedWeth.toFixed(6)} WETH`
          : r.tokenStuck > 0
            ? swapToken
              ? `⚠️ ${r.tokenStuck.toFixed(2)} ${r.tokenSym} gagal dijual (rug) — nyangkut`
              : `🪙 ${r.tokenStuck.toFixed(2)} ${r.tokenSym} disimpen (senilai ~$${px ? ((r.valEth - r.recvWeth) * px).toFixed(2) : "?"})`
            : "",
        `Total balik: <b>${r.valEth.toFixed(6)}Ξ / $${px ? (r.valEth * px).toFixed(2) : "?"}</b>${r.depEth != null ? ` (deposit ${r.depEth.toFixed(6)}Ξ)` : ""}${pnl}`,
        r.topUp ? `⛽ Top-up gas: unwrap ${r.topUp.unwrapped.toFixed(5)} WETH → ETH native (${r.topUp.nativeAfter.toFixed(4)}Ξ)` : "",
        r.collectHash ? `tx: <a href="${explorerTx(r.collectHash)}">collect</a>${r.swapHash ? ` · <a href="${explorerTx(r.swapHash)}">swap</a>` : ""}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    const isUsdgClose = r.wethSym === "USDG";
    await sendCloseCard({ name: isUsdgClose ? `${r.tokenSym}/USDG` : `${r.tokenSym}/WETH`, version: "v3", quote: isUsdgClose ? "usd" : "eth", depEth: r.depEth, outEth: r.valEth, pnlEth: r.pnlEth, pnlPct: r.pnlPct, heldMs: r.heldMs });
  } catch (e) {
    await send(`❌ Close gagal: ${short(e, 120)}`);
  }
}

export async function onCloseAll(): Promise<void> {
  invalidateListCache();
  let rows;
  try {
    rows = await listPositions();
  } catch (e) {
    await send(`❌ ${short(e, 80)}`);
    return;
  }
  if (!rows.length) {
    await send("Tidak ada posisi buat ditutup.");
    return;
  }
  const px = await ethUsd().catch(() => 0);
  await send(`🗑🗑 <b>Menutup ${rows.length} posisi…</b> (satu per satu)`);
  let totPnl = 0, ok = 0, fail = 0;
  for (const row of rows) {
    try {
      const r = await closePosition(row.tokenId);
      if (r.pnlEth != null) totPnl += r.pnlEth;
      ok++;
      await send(
        `✅ #${row.tokenId} ${row.tokenSym} closed · PnL ${r.pnlEth != null ? `${r.pnlEth >= 0 ? "+" : ""}${r.pnlEth.toFixed(6)}Ξ${px ? ` (${r.pnlEth >= 0 ? "+" : ""}$${(r.pnlEth * px).toFixed(2)})` : ""}` : "—"}`,
      );
    } catch (e) {
      fail++;
      await send(`❌ #${row.tokenId} gagal: ${short(e, 70)}`);
    }
  }
  await send(
    [
      `🏁 <b>Close ALL selesai</b> — ${ok} sukses${fail ? `, ${fail} gagal` : ""}`,
      `💰 Total PnL ETH: <b>${totPnl >= 0 ? "+" : ""}${totPnl.toFixed(6)}Ξ</b>`,
      px ? `💵 Total PnL USD: <b>${totPnl >= 0 ? "+" : ""}$${(totPnl * px).toFixed(2)}</b>` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  if (ok > 0) await onCard(); // flex the portfolio result
}

// ══════════ 🔄 swap (KyberSwap aggregator) ══════════

let pendingSwap: { fromAddr: string; toAddr: string; amountIn: bigint; fromSym: string; toSym: string; toDec: number } | null = null;
// DEX-style swap menu state (token picker → % amount)
let swapTokens: WalletToken[] = [];
let swapFrom: WalletToken | null = null;

/** Pretty token amount: thousands-separated when big, precise when small. */
const fmtAmt = (n: number): string =>
  n >= 1000 ? Math.round(n).toLocaleString("en-US") : n >= 1 ? n.toFixed(2) : n > 0 ? n.toPrecision(4) : "0";

/** /swap — no args → DEX-style token menu (auto-detect wallet holdings); with args → manual form. */
export async function onSwap(text: string): Promise<void> {
  return text.trim().split(/\s+/).length >= 4 ? onSwapManual(text) : onSwapMenu();
}

/** Auto-detect sellable tokens in the wallet → tap one → tap a %, no CA/amount typing. */
async function onSwapMenu(): Promise<void> {
  const m = await send("🔄 <b>Scan token di wallet…</b> <i>(ngecek rute jual tiap token, bisa ~10-20s)</i>");
  const mid = m?.result?.message_id;
  swapFrom = null;
  const toks = await walletTokens().catch(() => [] as WalletToken[]);
  swapTokens = toks;
  if (!toks.length) {
    await edit(
      mid,
      [
        "🔄 <b>Swap</b>",
        "Nggak ada token (yang bisa dijual) kedetect di wallet.",
        "",
        "Beli / manual: <code>/swap &lt;jumlah&gt; &lt;dari&gt; &lt;ke&gt;</code> (dari/ke = <b>eth</b> atau CA).",
      ].join("\n"),
    );
    return;
  }
  const rows = toks.map((t) => [{ text: `${tokenEmoji(t.symbol)} ${t.symbol} · ${fmtAmt(t.ui)} ($${t.usd.toFixed(2)})`, callback_data: `swf:${t.addr}` }]);
  await edit(mid, [`🔄 <b>Swap → ETH</b>`, `Pilih token yang mau dijual (${toks.length} kedetect):`].join("\n"), {
    reply_markup: { inline_keyboard: rows },
  });
}

/** Token picked (swf:<addr>) → show the 10-100% amount buttons (DEX-style). */
export async function onSwapFrom(addr: string, mid: number): Promise<void> {
  const t = swapTokens.find((x) => x.addr.toLowerCase() === addr.toLowerCase());
  if (!t) {
    await edit(mid, "Token nggak kebaca lagi — kirim /swap ulang.");
    return;
  }
  swapFrom = t;
  await edit(
    mid,
    [
      `🔄 <b>Jual ${tokenEmoji(t.symbol)} ${esc(t.symbol)} → ETH</b>`,
      `Saldo: <b>${fmtAmt(t.ui)}</b> ($${t.usd.toFixed(2)}) · jual semua ≈ ${t.ethOut.toPrecision(4)} ETH`,
      ``,
      `Mau jual berapa persen?`,
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "10%", callback_data: "swp:10" },
            { text: "25%", callback_data: "swp:25" },
            { text: "50%", callback_data: "swp:50" },
          ],
          [
            { text: "75%", callback_data: "swp:75" },
            { text: "💯 100%", callback_data: "swp:100" },
          ],
          [
            { text: "🔙 Token lain", callback_data: "swap" },
            { text: "❌ Cancel", callback_data: "cancel" },
          ],
        ],
      },
    },
  );
}

/** Percentage picked (swp:<pct>) → quote via Kyber, show the ✅ Swap confirm. */
export async function onSwapPct(pct: number, mid: number): Promise<void> {
  if (!swapFrom) {
    await edit(mid, "Pilih token dulu — kirim /swap ulang.");
    return;
  }
  const t = swapFrom;
  // read the LIVE balance (wallet is shared with the arb bot + Blockscout can lag) so 100% never
  // tries to sell more than we actually hold, and the % is always of the real current balance.
  const liveRaw = await tokenBalanceRaw(t.addr).catch(() => t.raw);
  const bal = liveRaw > 0n ? liveRaw : t.raw;
  const amountIn = pct >= 100 ? bal : (bal * BigInt(pct)) / 100n;
  if (amountIn <= 0n) {
    await edit(mid, "Saldo token 0 sekarang — mungkin udah kejual / kepake. Kirim /swap ulang.");
    return;
  }
  const route = await quoteV3Best(t.addr, C.weth, amountIn).catch(() => ({ amountOut: 0n, fee: 0 }));
  if (route.amountOut <= 0n) {
    await edit(mid, "❌ Uniswap nggak nemu rute (likuiditas kering?).");
    return;
  }
  const outUi = Number(ethers.formatEther(route.amountOut));
  const px = await ethUsd().catch(() => 0);
  const amtUi = Number(ethers.formatUnits(amountIn, t.decimals));
  pendingSwap = { fromAddr: t.addr, toAddr: UNI_NATIVE, amountIn, fromSym: t.symbol, toSym: "ETH", toDec: 18 };
  await edit(
    mid,
    [
      `🔄 <b>Jual ${pct}% ${esc(t.symbol)}</b> = ${fmtAmt(amtUi)} ${esc(t.symbol)}`,
      `→ ~<b>${outUi.toPrecision(6)} ETH</b>${px ? ` <i>($${(outUi * px).toFixed(2)})</i>` : ""}`,
      `rute: <i>uniswap v3 (fee ${(route.fee / 10000).toFixed(2)}%)</i> · slippage ${cfg.lp.slippagePct}%`,
    ].join("\n"),
    { reply_markup: { inline_keyboard: [[{ text: "✅ Swap", callback_data: "swapdo" }, { text: "❌ Cancel", callback_data: "cancel" }]] } },
  );
}

/** Manual power-user form: /swap <amount> <from> <to>  (eth or 0x… contract, any direction). */
async function onSwapManual(text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const [, amtStr, fromS, toS] = parts as [string, string, string, string];
  const resolve = (s: string) => (/^eth$/i.test(s) ? UNI_NATIVE : /^0x[0-9a-fA-F]{40}$/.test(s) ? ethers.getAddress(s) : null);
  const fromAddr = resolve(fromS);
  const toAddr = resolve(toS);
  if (!fromAddr || !toAddr) {
    await send("Dari/ke harus <b>eth</b> atau alamat kontrak (0x… 40 hex).");
    return;
  }
  if (fromAddr.toLowerCase() === toAddr.toLowerCase()) {
    await send("Dari & ke sama — nggak ada yang di-swap.");
    return;
  }
  if (!(parseFloat(amtStr) > 0)) {
    await send("Jumlah nggak valid, contoh: <code>0.01</code>");
    return;
  }
  const nativeIn = fromAddr.toLowerCase() === UNI_NATIVE.toLowerCase();
  const nativeOut = toAddr.toLowerCase() === UNI_NATIVE.toLowerCase();
  const fromMeta = nativeIn ? { decimals: 18, symbol: "ETH" } : await tokenMeta(fromAddr).catch(() => ({ decimals: 18, symbol: "?" }));
  const toMeta = nativeOut ? { decimals: 18, symbol: "ETH" } : await tokenMeta(toAddr).catch(() => ({ decimals: 18, symbol: "?" }));
  let amountIn: bigint;
  try {
    amountIn = ethers.parseUnits(amtStr, fromMeta.decimals);
  } catch {
    await send("Format jumlah salah.");
    return;
  }

  const m = await send("🔄 Cari rute Uniswap…");
  const mid = m?.result?.message_id;
  const inErc = nativeIn ? C.weth : fromAddr;
  const outErc = nativeOut ? C.weth : toAddr;
  const quote = await quoteV3Best(inErc, outErc, amountIn).catch(() => ({ amountOut: 0n, fee: 0 }));
  if (quote.amountOut <= 0n) {
    await edit(mid, "❌ Uniswap nggak nemu rute buat pair ini (likuiditas kering?).");
    return;
  }
  const outRaw = quote.amountOut;
  const outUi = Number(ethers.formatUnits(outRaw, toMeta.decimals));
  pendingSwap = { fromAddr, toAddr, amountIn, fromSym: fromMeta.symbol, toSym: toMeta.symbol, toDec: toMeta.decimals };
  await edit(
    mid,
    [
      `🔄 <b>Swap ${esc(amtStr)} ${esc(fromMeta.symbol)} → ~${outUi.toPrecision(6)} ${esc(toMeta.symbol)}</b>`,
      `rute: <i>uniswap v3 (fee ${(quote.fee / 10000).toFixed(2)}%)</i> · slippage ${cfg.lp.slippagePct}%`,
    ].join("\n"),
    { reply_markup: { inline_keyboard: [[{ text: "✅ Swap", callback_data: "swapdo" }, { text: "❌ Cancel", callback_data: "cancel" }]] } },
  );
}

export async function onSwapDo(mid: number): Promise<void> {
  if (!pendingSwap) return;
  const s = pendingSwap;
  pendingSwap = null;
  await edit(mid, `⏳ Swap ${esc(s.fromSym)} → ${esc(s.toSym)}…`);
  try {
    const { uniswapSwap } = await import("../chain/uniswapRoute.js");
    const r = await uniswapSwap(s.fromAddr, s.toAddr, s.amountIn);
    if (!r || r.amountOut <= 0n) {
      await edit(mid, "❌ Swap gagal / output 0.");
      return;
    }
    await edit(
      mid,
      `✅ <b>Swap sukses</b> → +${Number(ethers.formatUnits(r.amountOut, s.toDec)).toPrecision(6)} ${esc(s.toSym)}\ntx: <a href="${explorerTx(r.tx)}">tx</a>`,
    );
  } catch (e) {
    await edit(mid, `❌ Swap gagal: ${short(e, 150)}`);
  }
}

// ══════════ 📸 profit card ══════════

/** Generate + send the whole-portfolio profit card (Meteora-style flex graphic). */
export async function onCard(): Promise<void> {
  const m = await send("📸 Bikin kartu profit…");
  const mid = m?.result?.message_id;
  try {
    const { renderCard, portfolioCardData } = await import("./card.js");
    const png = await renderCard(await portfolioCardData());
    await sendPhoto(png, "📊 <b>Profit Robinhood LP Bot</b> — share it 🚀");
    if (mid) await edit(mid, "📸 Kartu profit ↑");
  } catch (e) {
    if (mid) await edit(mid, `❌ Gagal bikin kartu: ${short(e, 100)}`);
  }
}

/** Save a photo the owner sent as the profit-card background (assets/card-bg.jpg). */
export async function onSetBg(fileId: string): Promise<void> {
  const m = await send("🖼 Nyimpen background kartu…");
  const mid = m?.result?.message_id;
  try {
    const buf = await downloadTgFile(fileId);
    if (!buf) {
      if (mid) await edit(mid, "❌ Gagal ambil gambar dari Telegram.");
      return;
    }
    mkdirSync("assets", { recursive: true });
    writeFileSync("assets/card-bg.jpg", buf);
    if (mid) await edit(mid, "✅ Background kartu di-set. Ini preview-nya 👇");
    const { renderCard, portfolioCardData } = await import("./card.js");
    const png = await renderCard(await portfolioCardData());
    await sendPhoto(png, "🎴 Background baru kepasang — <b>/card</b> kapan aja buat share.");
  } catch (e) {
    if (mid) await edit(mid, `❌ Gagal set background: ${short(e, 100)}`);
  }
}

/** Print a profit card for an ALREADY-closed position (from a ledger entry, by tokenId). */
export async function onCardFor(tokenId: string): Promise<void> {
  const e = readLedger().find((x) => x.tokenId === tokenId);
  if (!e) {
    await send("❌ Posisi nggak ketemu di ledger.");
    return;
  }
  const m = await send("📸 Bikin kartu posisi…");
  const mid = m?.result?.message_id;
  try {
    const { renderCard, closeCardData } = await import("./card.js");
    const png = await renderCard(
      await closeCardData({
        name: e.pair ?? `${e.sym}/WETH`,
        version: (e.version ?? "v3") as "v2" | "v3" | "v4",
        quote: e.quote,
        depEth: e.depEth ?? null,
        outEth: e.outEth ?? 0,
        pnlEth: e.pnlEth,
        pnlPct: e.pnlPct,
        feeEth: e.feeEth,
        heldMs: e.heldMs,
        ethUsd: e.ethUsdAtClose ?? undefined,
      }),
    );
    await sendPhoto(png, `🎴 <b>${esc(e.pair ?? `${e.sym}/WETH`)}</b> — share it 🚀`);
    if (mid) await edit(mid, "📸 Kartu ↑");
  } catch (err) {
    if (mid) await edit(mid, `❌ Gagal bikin kartu: ${short(err, 100)}`);
  }
}

/** Fire-and-forget a per-close card (never blocks / breaks the close flow). */
async function sendCloseCard(p: {
  name: string;
  version: "v2" | "v3" | "v4";
  quote?: "eth" | "usd";
  depEth: number | null;
  outEth: number;
  pnlEth: number | null;
  pnlPct?: number | null;
  feeEth?: number;
  heldMs?: number | null;
}): Promise<void> {
  try {
    const { renderCard, closeCardData } = await import("./card.js");
    const png = await renderCard(await closeCardData(p));
    await sendPhoto(png);
  } catch {
    /* card is a nice-to-have — never let it break a close */
  }
}

export async function onPnl(): Promise<void> {
  await send("📊 Menghitung PnL seumur hidup… (scan history + rug, ±20 detik)");
  let r;
  try {
    // overall safety-net timeout so /pnl can't hang forever if Blockscout/RPC is slow (the per-token
    // quote timeout in analytics.ts handles the usual culprit; this bounds the total scan).
    r = await Promise.race([
      lifetimePnl(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("scan &gt; 45s — Blockscout/RPC lambat, coba lagi")), 45_000)),
    ]);
  } catch (e) {
    await send(`❌ ${short(e, 90)}`);
    return;
  }
  const px = r.px;
  const $ = (e: number) => (px ? "$" + (e * px).toFixed(2) : "?");
  // ACCURATE LP number from the ledger (closed positions). The wallet capital-flow below is
  // wallet-level and — because this wallet is shared with the arb bot — mixes in non-LP flows.
  const sum = ledgerSummary();
  const row = (lbl: string, eth: string, usd = "") => `${padR(lbl, 8)}${padL(eth, 12)}${usd ? "  " + padL(usd, 9) : ""}`;

  const T: string[] = [];
  T.push(`LP REALIZED · ${sum.count} ditutup`);
  T.push("─".repeat(31));
  T.push(row("PnL", sg(sum.pnlEth, 5) + "Ξ", money(sum.pnlUsd)));
  T.push(row("menang", `${sum.winRate.toFixed(0)}% (${sum.wins}/${sum.losses})`));
  T.push(row("fee", sum.feeEth.toFixed(5) + "Ξ"));
  T.push("");
  T.push(`ARUS WALLET (+arb)`);
  T.push("─".repeat(31));
  T.push(row("setor", r.capIn.toFixed(5) + "Ξ", $(r.capIn)));
  T.push(row("tarik", r.capOut.toFixed(5) + "Ξ", $(r.capOut)));
  T.push(row("nilai", r.valueNowEth.toFixed(5) + "Ξ", $(r.valueNowEth)));
  T.push(`  native ${r.nativeEth.toFixed(4)}  WETH ${r.wethHeld.toFixed(4)}`);
  T.push(`  LP ${r.openLpEth.toFixed(4)}Ξ  token $${r.tokensUsd.toFixed(2)}`);
  T.push(row("net", sg(r.pnlEth, 5) + "Ξ", money(r.pnlUsd)));

  const grave = r.graveyardCount
    ? `\n🪦 <b>${r.graveyardCount} token nyangkut</b> <i>(rug/likuiditas kering)</i>\n${pre(r.graveyard.join(", ") + (r.graveyardCount > r.graveyard.length ? " …" : ""))}`
    : "";
  await sendMenu(
    `📊 <b>PnL SEUMUR HIDUP</b>${px ? ` · ETH $${px.toFixed(0)}` : ""}\n` +
      pre(T.join("\n")) +
      `<i>⚠️ Net wallet nyampur flow arb — angka LP akurat = "LP realized".</i>` +
      grave,
  );
}

export async function onWallet(): Promise<void> {
  try {
    const b = await balances();
    await sendMenu(`👛 <code>${b.address}</code>\nETH: ${Number(b.eth).toFixed(5)} · WETH: ${Number(b.weth).toFixed(5)}`);
  } catch (e) {
    await send(`❌ ${short(e, 80)}`);
  }
}

export async function onSettings(): Promise<void> {
  const T = [
    `${padR("width", 12)} ${cfg.lp.widthPct}%`,
    `${padR("slippage", 12)} ${cfg.lp.slippagePct}%`,
    `${padR("fee floor LP", 12)} ${(cfg.lp.minFeePpm / 10000).toFixed(2)}%`,
    `${padR("gas target", 12)} ${cfg.lp.nativeTargetEth}Ξ`,
    `${padR("auto-wrap", 12)} ${cfg.lp.autoWrap ? "on" : "off"}`,
    ``,
    `${padR("gas price", 12)} ${cfg.gasPriceGwei > 0 ? `${cfg.gasPriceGwei} gwei (fixed)` : "AUTO (node +10%)"}`,
    `${padR("gas cap USD", 12)} ${cfg.maxGasUsd > 0 ? `$${cfg.maxGasUsd}` : "off"}`,
    ``,
    `${padR("radar LLM", 12)} ${cfg.radar.enabled ? "on" : "off"}`,
    `${padR("feed", 12)} ${cfg.feed.enabled ? "on" : "off"}`,
    `${padR("auto-LP", 12)} ${cfg.autoLp.enabled ? "🟢 ON" : "off"}`,
    `${padR("fast-submit", 12)} ${env.fastSubmit ? "on" : "off"}`,
  ];
  await sendMenu(
    `⚙️ <b>Setting</b>${pre(T.join("\n"))}` +
      `Ubah: <code>/set width 40</code> · <code>/set slippage 5</code> · <code>/set gastarget 0.015</code>\n` +
      `Gas: <code>/set gasprice 0.5</code> (gwei fixed · 0=auto) · <code>/set maxgas 0.70</code> ($ cap · 0=off)\n` +
      `<i>Watch/Feed/Auto/Radar diatur di menu masing-masing.</i>`,
  );
}

const LP_MAP: Record<string, keyof typeof cfg.lp> = {
  width: "widthPct",
  deposit: "depositUsd",
  slippage: "slippagePct",
  gastarget: "nativeTargetEth",
};
/** Top-level numeric config keys settable via /set (cfg root, not cfg.lp). */
const TOP_NUM_MAP: Record<string, keyof Config> = {
  gasprice: "gasPriceGwei",
  maxgas: "maxGasUsd",
};
const WATCH_MAP: Record<string, keyof typeof cfg.watch> = {
  vol5m: "minVol5m",
  vol1h: "minVol1h",
  rise: "riseFactor",
  liq: "minLiqUsd",
  tax: "maxTaxPct",
  cooldown: "cooldownMin",
  interval: "intervalSec",
};
const FEED_NUM_MAP: Record<string, keyof typeof cfg.feed> = {
  minseed: "newTokenMinWethSeed",
  activity: "activityThreshold",
  feedcooldown: "cooldownMin",
};
const FEED_BOOL_MAP: Record<string, keyof typeof cfg.feed> = {
  newtoken: "newToken",
  posmon: "positionMonitor",
  autoclose: "autoCloseOutOfRange",
};
const RADAR_BOOL_MAP: Record<string, keyof typeof cfg.radar> = {
  radar: "enabled",
  gmgn: "useGmgn",
};
const AUTOLP_NUM_MAP: Record<string, keyof typeof cfg.autoLp> = {
  alpsize: "sizeEth",
  alpscore: "minScore",
  alpmaxopen: "maxOpen",
  alpperhour: "maxPerHour",
  alpdaily: "dailyCapEth",
  alpminliq: "minLiqUsd",
  alpmaxtax: "maxTaxPct",
  alpgrace: "oorGraceMin",
  alpoorcount: "oorCooldownCount",
  alpoorhours: "oorCooldownHours",
  alpcompoundmin: "compoundMinUsd", // min uncollected fees ($) before compounding
  alpvolfade: "volFadeX", // #3 volume-fade exit: close when spikeX < this (0 = off). MUST be < scan.minSpikeX
  alpvfadeage: "vfadeMinAgeMin", // #3 volume-fade age guard (min): no VFADE close before a position is this old
  alpminfeeh: "minFeePerHourUsd", // fee-velocity exit: close when recent fee-rate < this $/h (0 = off)
  alpfeegrace: "feeGraceMin", // fee-velocity age guard (min): no fee-velocity close before this old
};
const SCAN_NUM_MAP: Record<string, keyof typeof cfg.scan> = {
  huntvol: "minVolUsd",
  huntfees: "minPoolFeesUsd", // #1 fee-yield: min 24h pool fees
  huntyield: "minFeeYieldPct", // #1 fee-yield: min daily fee/TVL %
  huntscore: "minScore",
  huntmcapmin: "screenMinMcap", // mcap floor
  huntmcapmax: "screenMaxMcap", // mcap ceiling (0 = off) — farm SMALL-cap
  huntpoolliq: "minPoolLiqUsd", // anti-wash: pool liquidity floor ($)
  huntmaxratio: "maxVolLiqRatio", // anti-wash: max vol/liq ratio (0 = off)
  huntspike: "minSpikeX", // #1 volume-spike: min recent-hour vs 24h-avg (0 = off)
  huntcooldown: "cooldownMin", // menit sebelum token yg udah di-alert boleh muncul lagi (rotasi cepet = kecil)
};
const SET_HELP =
  "LP: width, deposit, slippage, gastarget\nGas: gasprice (gwei, 0=auto) · maxgas ($ cap, 0=off)\nWatch: vol5m, vol1h, rise, liq, tax, cooldown, interval\nFeed: minseed, activity, feedcooldown · toggle: newtoken/posmon/autoclose (0/1)\nRadar: radar/gmgn (0/1)\nHunt: huntvol, huntfees, huntyield, huntscore, huntmcapmin, huntmcapmax, huntpoolliq, huntmaxratio, huntspike, huntcooldown\nAuto-LP: alpsize, alpscore, alpmaxopen, alpperhour, alpdaily, alpminliq, alpmaxtax, alpgrace, alpoorcount, alpoorhours, alpcompoundmin, alpvolfade, alpvfadeage, alpminfeeh, alpfeegrace · alpmode single|inrange · alpclose 0/1 · alprebalance close|rebalance · alpcompound 0/1";

export async function onSet(text: string): Promise<void> {
  const [, k, v] = text.split(/\s+/);
  // ── enum / string auto-LP settings (handled BEFORE the numeric guard below) ──
  if (k === "alpmode") {
    if (v !== "single" && v !== "inrange") {
      await send("Pilih: <code>/set alpmode single</code> (rug-safe, parkir quote) atau <code>/set alpmode inrange</code> (both-sided, fee langsung).");
      return;
    }
    cfg.autoLp.mode = v;
    persist();
    await send(
      `✓ autoLp.mode → <b>${v}</b> ${v === "inrange" ? "(both-sided — fee LANGSUNG, tapi pegang token → rug=rugi)" : "(single-side — parkir quote asset, rug-safe)"}`,
    );
    return;
  }
  if (k === "alpclose") {
    if (v !== "0" && v !== "1") {
      await send("Toggle: <code>/set alpclose 1</code> (tutup OOR) / <code>/set alpclose 0</code> (biarin jalan)");
      return;
    }
    cfg.autoLp.closeOor = v === "1";
    persist();
    await send(`✓ autoLp.closeOor → ${v === "1" ? "on (tutup posisi OOR)" : "off (posisi dibiarin jalan)"}`);
    return;
  }
  if (k === "alprebalance" || k === "alprebal") {
    if (v !== "close" && v !== "rebalance") {
      await send(
        "Pilih: <code>/set alprebalance rebalance</code> (posisi OOR di-recenter ke harga baru) atau <code>/set alprebalance close</code> (default — tutup ke ETH).\n<i>butuh /set alpclose 1</i>",
      );
      return;
    }
    cfg.autoLp.oorAction = v;
    persist();
    await send(
      `✓ autoLp.oorAction → <b>${v}</b> ${v === "rebalance" ? "(OOR → tutup + buka ulang recentered, modal terus kerja)" : "(OOR ditutup ke ETH)"}${v === "rebalance" && !cfg.autoLp.closeOor ? "\n⚠️ nyalain dulu: <code>/set alpclose 1</code>" : ""}`,
    );
    return;
  }
  if (k === "alpcompound") {
    if (v !== "0" && v !== "1") {
      await send("Toggle: <code>/set alpcompound 1</code> (fee di-compound balik) / <code>/set alpcompound 0</code> (off)");
      return;
    }
    cfg.autoLp.compound = v === "1";
    persist();
    await send(`✓ autoLp.compound → ${v === "1" ? `on (fee ≥ $${cfg.autoLp.compoundMinUsd} di-harvest & di-add balik)` : "off"}`);
    return;
  }
  if (!k || v == null || isNaN(Number(v))) {
    await send(`Format: <code>/set &lt;key&gt; &lt;angka&gt;</code>\n${SET_HELP}`);
    return;
  }
  if (TOP_NUM_MAP[k]) {
    const num = Number(v);
    if (k === "gasprice" && num === 0) {
      cfg.gasPriceGwei = 0;
      persist();
      await send("✓ gasprice → 0 = AUTO (gas price node +10%). Override manual mati.");
      return;
    }
    if (k === "maxgas" && num === 0) {
      cfg.maxGasUsd = 0;
      persist();
      await send("✓ maxgas → 0 = OFF (gas cap mati — bot bakal bayar apapun gasnya).");
      return;
    }
    (cfg[TOP_NUM_MAP[k]] as number) = num;
    persist();
    if (k === "gasprice") {
      await send(`✓ gasprice → <b>${v} gwei</b> — semua tx pakai fixed gas price ini. 0 = auto.`);
    } else {
      await send(`✓ maxgas → <b>$${v}</b> — broadcast ditolak kalau projected fee di atas cap ini. 0 = off.`);
    }
    return;
  }
  if (LP_MAP[k]) {
    (cfg.lp[LP_MAP[k]] as number) = Number(v);
    persist();
    await send(`✓ ${k} → ${v}`);
    return;
  }
  if (WATCH_MAP[k]) {
    (cfg.watch[WATCH_MAP[k]] as number) = Number(v);
    persist();
    if (k === "interval") restartWatch();
    await send(`✓ watch.${k} → ${v}`);
    return;
  }
  if (FEED_NUM_MAP[k]) {
    (cfg.feed[FEED_NUM_MAP[k]] as number) = Number(v);
    persist();
    await send(`✓ feed.${k} → ${v}`);
    return;
  }
  if (FEED_BOOL_MAP[k]) {
    (cfg.feed[FEED_BOOL_MAP[k]] as boolean) = Number(v) !== 0;
    persist();
    await send(`✓ feed.${k} → ${Number(v) !== 0 ? "on" : "off"}${k === "autoclose" && Number(v) !== 0 ? " ⚠️" : ""}`);
    return;
  }
  if (RADAR_BOOL_MAP[k]) {
    (cfg.radar[RADAR_BOOL_MAP[k]] as boolean) = Number(v) !== 0;
    persist();
    const warn = k === "radar" && Number(v) !== 0 && !env.openrouterKey ? " ⚠️ RH_OPENROUTER_KEY belum diset" : "";
    await send(`✓ radar.${k} → ${Number(v) !== 0 ? "on" : "off"}${warn}`);
    return;
  }
  if (AUTOLP_NUM_MAP[k]) {
    (cfg.autoLp[AUTOLP_NUM_MAP[k]] as number) = Number(v);
    persist();
    await send(`✓ autoLp.${k} → ${v}`);
    return;
  }
  if (SCAN_NUM_MAP[k]) {
    (cfg.scan[SCAN_NUM_MAP[k]] as number) = Number(v);
    persist();
    await send(`✓ hunt.${k} → ${v}`);
    return;
  }
  await send(`Key nggak dikenal.\n${SET_HELP}`);
}

export async function onLadder(text: string): Promise<void> {
  const [command, token, amountText, maxText] = text.trim().split(/\s+/);
  const legs: LadderLegCount = command === "/ladder3" ? 3 : 5;
  if (!token || !ethers.isAddress(token) || !amountText) {
    await send(`Format: <code>/${legs === 3 ? "ladder3" : "ladder5"} &lt;CA&gt; &lt;jumlah USDG&gt; [max downside %]</code>`);
    return;
  }
  const maxPct = maxText === undefined ? 50 : Number(maxText);
  try {
    const amount = ethers.parseUnits(amountText, 6);
    const preview = await previewV4Ladder(ethers.getAddress(token), amount, legs, maxPct);
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    pendingLadders.set(key, { token: ethers.getAddress(token), amount, legs, maxPct, expires: Date.now() + 120_000 });
    const rows = preview.legs.map(l => `#${l.index + 1}: ${l.priceRange} · ${l.depositEth} ETH`).join("\\n");
    await send(`🪜 <b>V4 BID LADDER ${legs} LEG</b>\\nToken: <code>${esc(token)}</code>\\nFunding: <b>${amountText} USDG</b>\\nDepth: ${(preview.effectiveMaxDownsideBps / 100).toFixed(2)}%\\nTick: ${preview.referenceTick}\\n\\n${rows}\\n\\n⚠️ Contiguous below-price ranges · weighted funding · slippage-protected close.`, { reply_markup: { inline_keyboard: [[{ text: `✅ Simulate + buka ${legs} leg`, callback_data: `laddergo:${key}` }, { text: "❌ Batal", callback_data: "noop" }]] } });
  } catch (e) {
    await send(`❌ Ladder ditolak: <code>${esc(String((e as Error).message).slice(0, 300))}</code>`);
  }
}

export async function onLadderConfirm(key: string, mid: number): Promise<void> {
  const p = pendingLadders.get(key);
  pendingLadders.delete(key);
  if (!p || p.expires < Date.now()) { await edit(mid, "❌ Preview ladder kedaluwarsa. Jalankan command lagi."); return; }
  await edit(mid, `⏳ Simulasi + cek saldo USDG/ETH untuk ladder ${p.legs} leg…`);
  try {
    const r = await executeV4Ladder(p.token, p.amount, p.legs, p.maxPct);
    await edit(mid, `✅ <b>V4 BID LADDER ${p.legs} LEG OPEN</b>\nTx: <a href="${explorerTx(r.txHash)}">${r.txHash.slice(0, 10)}…</a>\nLadder ID: <code>${r.ladderId}</code>\nNFT: ${r.tokenIds.length ? r.tokenIds.map(id => `<code>#${id}</code>`).join(" ") : "receipt ada, NFT perlu reconcile /list"}\n<i>Verifikasi /list dari state on-chain.</i>`);
  } catch (e) {
    await edit(mid, `❌ Ladder gagal/reject: <code>${esc(String((e as Error).message).slice(0, 350))}</code>`);
  }
}

export async function onLadderClose(text: string): Promise<void> {
  const [, arg] = text.trim().split(/\s+/);
  try {
    const groups = await listLadderGroups();
    if (!groups.length) {
      await send("🪜 Nggak ada ladder aktif (belum ada posisi ladder yang kebuka / semua udah di-close).\nBuka dulu: <code>/ladder3 &lt;CA&gt; &lt;USDG&gt;</code> atau <code>/ladder5 &lt;CA&gt; &lt;USDG&gt;</code>");
      return;
    }
    if (arg) return onLadderCloseGroup(arg, 0); // direct: /ladderclose <ladderId>
    const body = groups
      .map((g, i) => {
        const pair = g.live[0]?.pair ?? `pool ${g.poolId.slice(0, 10)}`;
        const legs = g.live.map(x => `#${x.tokenId}`).join(" ");
        const sumUsd = g.live.reduce((a, x) => a + (x.valueUsd || 0), 0);
        const legTxt = g.live.length ? ` · <b>${g.live.length} leg</b> · $${sumUsd.toFixed(2)}` : " · <i>semua leg udah closed?</i>";
        return `${i + 1}. <b>${esc(pair)}</b> · fee ${(g.fee / 10000).toFixed(2)}% · <code>${g.ladderId}</code>${legTxt}\n   ${legs}`;
      })
      .join("\n\n");
    const kb = groups.map((g, i) => [{ text: `🗑 Close ${g.live.length ? `${g.live.length} leg · ${g.live[0]?.pair ?? ""}` : ""}`.trim(), callback_data: `ladderc:${i}` }]);
    await send(`🪜 <b>LADDER AKTIF</b> (${groups.length})\n\n${body}\n\n<i>Close per ladder = semua leg ditutup berurutan. Tiap leg di-simulate dulu sebelum broadcast.</i>`, { reply_markup: { inline_keyboard: kb } });
  } catch (e) {
    await send(`❌ Gagal baca ladder: <code>${esc(String((e as Error).message).slice(0, 200))}</code>`);
  }
}

export async function onLadderCloseGroup(indexOrId: string, _mid: number): Promise<void> {
  const groups = await listLadderGroups();
  const g = /^\d+$/.test(indexOrId) ? groups[Number(indexOrId)] : groups.find(x => x.ladderId === indexOrId);
  if (!g) { await send("❌ Ladder nggak ketemu (list berubah — coba /ladderclose lagi)."); return; }
  const msg = `🗑 <b>Close ladder ${g.ladderId}</b> · ${g.live.length} leg live\n${g.live.map(x => `#${x.tokenId} ${esc(x.pair)}`).join("\n")}\n\n⚠️ Semua leg ditutup berurutan (${g.live.length} tx). Gas dipakai ${g.live.length}×. Konfirmasi?`;
  await send(msg, { reply_markup: { inline_keyboard: [[{ text: "✅ Ya, close semua leg", callback_data: `laddergo2:${g.ladderId}` }, { text: "❌ Batal", callback_data: "noop" }]] } });
}

export async function onLadderCloseExecute(ladderId: string, mid: number): Promise<void> {
  await edit(mid, `⏳ Close ladder <code>${ladderId}</code> — tiap leg di-simulate lalu broadcast…`);
  try {
    const r = await closeLadderGroup(ladderId);
    const rows = r.legs
      .map(x => {
        if (!x.ok) return `#${x.tokenId} ❌ <code>${esc(x.error ?? "gagal")}</code>`;
        const c = x.close!;
        return `#${x.tokenId} ✅ ${c.pnlEth != null ? `${c.pnlEth >= 0 ? "+" : ""}${c.pnlEth.toFixed(5)}Ξ` : ""}${c.sweptEth && c.sweptEth > 0 ? ` (+${c.sweptEth.toFixed(5)}Ξ sweep)` : ""} · <a href="${explorerTx(c.txHash)}">tx</a>`;
      })
      .join("\n");
    await edit(mid, `✅ <b>LADDER CLOSED</b> · ${r.closedCount}/${r.legs.length} leg\n${rows}\n${r.failedCount ? `\n⚠️ ${r.failedCount} leg gagal — cek error di atas.` : ""}\n<i>Verifikasi /list untuk posisi tersisa.</i>`);
  } catch (e) {
    await edit(mid, `❌ Ladder close gagal: <code>${esc(String((e as Error).message).slice(0, 300))}</code>`);
  }
}

export async function onKrystal(text: string): Promise<void> {
  const [, walletArg] = text.trim().split(/\s+/);
  try {
    const { krystalEnabled, krystalWalletSummary } = await import("../chain/krystal.js");
    if (!krystalEnabled()) {
      await send("🔑 Krystal Cloud <b>OFF</b> — set <code>RH_KRYSTAL_KEY</code> di .env buat aktifin cross-check PnL.\nDaftar key di cloud.krystal.app (gratis).");
      return;
    }
    const w = walletArg && ethers.isAddress(walletArg) ? ethers.getAddress(walletArg) : (await import("../chain/client.js")).wallet().address;
    const s = await krystalWalletSummary(w);
    if (!s) { await send("❌ Gagal tarik data Krystal."); return; }
    const rows = s.rows.map(r => `#${r.tokenId} · ${r.status} · PnL $${r.pnl.toFixed(2)} · dep $${r.dep.toFixed(2)} · val $${r.val.toFixed(2)}`).join("\n") || "(kosong)";
    await send(`🔎 <b>Krystal Cloud</b> · wallet <code>${w.slice(0, 10)}…</code>\nPosisi open: ${s.count} · total PnL <b>$${s.totalPnl.toFixed(2)}</b> · total deposit $${s.totalDeposit.toFixed(2)}\n\n${rows}`);
  } catch (e) {
    await send(`❌ /krystal gagal: <code>${esc(String((e as Error).message).slice(0, 200))}</code>`);
  }
}

export async function onHelp(): Promise<void> {
  const body = [
    `🤖 <b>Robinhood LP Bot</b>  <i>v2 · Uniswap v3+v4 · Robinhood Chain</i>`,
    `Paste <b>CA token</b> (0x…) → pilih pool → jumlah ETH → LP.`,
    ``,
    `<b>━━━ 📋 POSISI & CLOSE ━━━</b>`,
    `<code>/list</code> — daftar posisi LP terbuka + PnL`,
    `<code>/closeall</code> — tutup SEMUA posisi (confirm dulu)`,
    `<code>/ledger</code> — riwayat posisi ditutup (realized PnL)`,
    ``,
    `<b>━━━ 🪜 LADDER (bid USDG → token) ━━━</b>`,
    `<code>/ladder3</code> — V4 BID LADDER 3 leg dari USDG`,
    `<code>/ladder5</code> — V4 BID LADDER 5 leg dari USDG`,
    `<code>/ladderclose</code> — tutup SEMUA leg ladder aktif`,
    ``,
    `<b>━━━ ➕ ADD LP & SWAP ━━━</b>`,
    `<code>/addlp</code> — buka LP baru (paste CA token)`,
    `<code>/v4lp</code> — buka V4 LP single-side ETH`,
    `<code>/swap</code> — swap token via Uniswap (v2/v3/v4)`,
    ``,
    `<b>━━━ 🔎 INFO ━━━</b>`,
    `<code>/krystal</code> — cross-check PnL via Krystal Cloud`,
    `<code>/pnl</code> — PnL seumur hidup`,
    `<code>/wallet</code> — saldo hot wallet (ETH + token)`,
    `<code>/card</code> — kartu profit shareable (PNG)`,
    ``,
    `<b>━━━ ⚙️ SETTINGS ━━━</b>`,
    `<code>/settings</code> — width, slippage, gas, fee floor`,
    `<code>/set <key> <value></code> — ubah cepat`,
    `Contoh: <code>/set slippage 5</code> · <code>/set width 40</code>`,
    ``,
    `<i>💡 Menu cepat ada di keyboard bawah — gak perlu ngetik.</i>`,
    `<i>❓ Command salah ketik? Bot akan kasih saran.</i>`,
  ].join("\n");
  await sendMenu(body);
}

// per-message pending accessors for bot.ts routing
// ══════════ ➕ Add — increase an EXISTING position (not a new NFT) ══════════

export async function onAddAsk(tokenId: string, version: "v3" | "v4"): Promise<void> {
  pending = null; // drop any open-flow so a stray number doesn't mis-route
  pendingAdd = { tokenId, version };
  await send(
    `➕ <b>Tambah liq ke posisi #${tokenId}</b> [${version}]\n` +
      `Ketik jumlah <b>ETH</b> yang mau ditambahin (contoh: <code>0.005</code>). Bot auto split ½ token + ½ USDG → masuk ke posisi itu (bukan buka baru).`,
  );
}

export async function onAddAmount(text: string): Promise<void> {
  if (!pendingAdd) return;
  const eth = parseFloat(text);
  if (!(eth > 0)) {
    await send("Masukin angka ETH yang bener, contoh: 0.005");
    return;
  }
  const b = await balances().catch(() => null);
  if (b && eth > usableEth(b) + 1e-9) {
    await send(`⚠️ Kegedean. Yang bisa di-LP cuma ${usableEth(b).toFixed(5)} ETH.`);
    return;
  }
  if (b && Number(b.eth) < GAS_RESERVE) {
    await send(`⚠️ ETH native cuma ${Number(b.eth).toFixed(5)} — kurang buat gas (min ${GAS_RESERVE}).`);
    return;
  }
  const { tokenId, version } = pendingAdd;
  pendingAdd = null;
  const amt = toEthStr(eth) ?? String(eth);
  invalidateListCache();
  const m = await send(`⏳ <b>Nambah ${amt} ETH ke posisi #${tokenId}…</b> (swap ½+½ → increase)`);
  const mid = m?.result?.message_id;
  try {
    if (version === "v4") {
      const { increaseV4Position } = await import("../chain/v4/mint.js");
      const r = await increaseV4Position(tokenId, amt);
      await edit(
        mid,
        [
          `✅ <b>Liq masuk ke #${tokenId}</b> [v4] · pool fee ${(r.fee / 10000).toFixed(2)}%`,
          r.swapHash ? `swap ½+½: <a href="${explorerTx(r.swapHash)}">tx</a>` : "",
          `deposit <b>+${amt}Ξ</b> (masuk ke posisi lama, bukan #baru)`,
          `tx: <a href="${explorerTx(r.txHash)}">tx</a>`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } else {
      await edit(mid, "increase v3 belum didukung (baru v4).");
    }
  } catch (e) {
    const msg = (e as Error).message || String(e);
    const friendly = /revert|settle|slippage|CurrencyNotSettled/i.test(msg)
      ? "harga pool gerak pas settle (pool volatil / fee tinggi). <b>Coba tap ➕ Add lagi</b> — token/USDG yang keburu kebeli di-reuse, biasanya berhasil percobaan ke-2."
      : short(e, 160);
    await edit(mid, `❌ Gagal nambah liq: ${friendly}`);
  }
}

export const isAwaitingAdd = (): boolean => !!pendingAdd;

// ══════════ 📅 Profit Calendar ══════════

export async function onCalendar(year?: number, month0?: number): Promise<void> {
  const now = new Date();
  const y = year ?? now.getUTCFullYear();
  const m = month0 ?? now.getUTCMonth();
  try {
    const { renderCalendar } = await import("./calendar.js");
    const png = await renderCalendar(y, m);
    const prev = m === 0 ? [y - 1, 11] : [y, m - 1];
    const next = m === 11 ? [y + 1, 0] : [y, m + 1];
    await sendPhoto(png, "📅 <b>Profit Calendar</b> — tiap kotak = PnL posisi yang di-close hari itu (fee included). Reset 07:00 WIB.", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⬅️ Prev", callback_data: `cal:${prev[0]}:${prev[1]}` },
            { text: "Next ➡️", callback_data: `cal:${next[0]}:${next[1]}` },
          ],
        ],
      },
    });
  } catch (e) {
    await send(`❌ Calendar gagal: ${short(e, 120)}`);
  }
}

export const isAwaitingAmount = (): boolean => !!pending?.awaitingAmount;
export const cancelPending = (): void => {
  pending = null;
  pendingAdd = null;
  pendingSwap = null;
  swapFrom = null;
};

function short(e: unknown, n: number): string {
  return String((e as Error)?.message ?? e).slice(0, n);
}
