/**
 * List the wallet's v4 LP positions — ANY pair (token/ETH, token/USDG, token/token), not
 * just native-ETH. The v4 PositionManager isn't enumerable, so tokenIds come from Blockscout
 * NFT holdings (catches manual Uniswap positions too). Amounts are built from the REAL pool
 * currencies (earlier bug: forced native ETH → garbage $100M values). Unclaimed fees are
 * computed from feeGrowthInside deltas. Value is estimated in USD.
 */
import { ethers } from "ethers";
import * as sdkCore from "@uniswap/sdk-core";
import * as v4sdk from "@uniswap/v4-sdk";
import { C, cfg } from "../../config.js";
import { wallet, provider } from "../client.js";
import { tokenMeta } from "../tokens.js";
import { ethUsd } from "../price.js";
import { STATEVIEW_ABI, V4_POSM_ABI } from "./abis.js";
import { NATIVE } from "./poolkey.js";
import { bsFetch, mapLimit } from "../blockscout.js";
import { dataPath, readJson, writeJson } from "../../util/files.js";
import { krystalPositionMap, krystalAmountsUsd, type KrystalPosition } from "../krystal.js";
import { logger } from "../../util/log.js";

const { Ether, Token, CurrencyAmount } = sdkCore as any;
const { Pool, Position } = v4sdk as any;
const log = logger("v4list");

const WETH_L = C.weth.toLowerCase();
const STABLES = new Set(["0x5fc5360d0400a0fd4f2af552add042d716f1d168"]); // USDG
const MASK256 = (1n << 256n) - 1n;

export interface V4Row {
  tokenId: string;
  pair: string; // "WOLVES/USDG"
  sym: string; // primary (non-quote) symbol for the emoji/label
  fee: number;
  inRange: boolean;
  tick: number;
  tickLower: number;
  tickUpper: number;
  amount0: string;
  sym0: string;
  amount1: string;
  sym1: string;
  feeUsd: number;
  valueUsd: number;
  depEth: number | null;
  ethPaired: boolean; // true if one side is native ETH (bot-manageable close)
  ageMs: number | null;
  tokenAddr: string; // the volatile (non-ETH/non-USDG) side — for OOR-cooldown keying
  poolId: string; // v4 poolId — to match DexScreener volume for the #3 volume-fade check
}

const signed24 = (v: number): number => (v >= 0x800000 ? v - 0x1000000 : v);

/**
 * On-chain deposit reconstruction for positions we never minted (watch mode): the mint tx's
 * modifyLiquidities calldata carries the deposit amounts (amount0/1max per plan) even though
 * the PositionManager emits no amount event. Decode calldata → (dep0raw, dep1raw, ok).
 * NOTE: this is a best-effort — calldata layout is the Robinhood bottom-up encoding
 * (bytes actions, bytes[] params) seen in close.ts; the ADD plan (0x02) holds
 * (PoolKey, tickLower, tickUpper, amount0Max, amount1Max, salt, owner, hookDataLen, hookData).
 */
/** Public-chain RPC (RH_LOGS_RPC_URL) — Alchemy free tier caps eth_getLogs at ~10 blocks. */
const logsProvider = (() => {
  const url = process.env.RH_LOGS_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
  return new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
})();

async function mintDeposit(tokenId: string): Promise<{ dep0: bigint; dep1: bigint } | null> {
  try {
    const tf = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]);
    const sig = tf.getEvent("Transfer")!.topicHash;
    const tid = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
    // A transfer FROM zero (mint) can be very old — scan last 2M blocks, public RPC handles ~5s.
    const blk = await logsProvider.getBlockNumber().catch(() => 0n);
    const from = blk > 2_000_000n ? Number(blk) - 2_000_000 : 1;
    const logs = await logsProvider.getLogs({ address: C.v4PositionManager!, topics: [sig, null, null, tid], fromBlock: from, toBlock: "latest" }).catch(() => []);
    if (!logs.length) return null;
    const txh = logs[0].transactionHash;
    if (!txh) return null;
    const tx = await provider.getTransaction(txh).catch(() => null);
    if (!tx) return null;

    // DEPOSIT AKTUAL = dari Transfer events di receipt (amount yang masuk ke pool/posm),
    // BUKAN amount0Max di calldata (itu cuma slippage limit, bisa gede tak terbatas).
    const rc = await provider.getTransactionReceipt(txh).catch(() => null);
    if (rc) {
      const erc = new ethers.Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
      const tSig = erc.getEvent("Transfer")!.topicHash;
      const poolMgr = C.v4PoolManager!.toLowerCase();
      let dep0 = 0n, dep1 = 0n;
      for (const l of rc.logs) {
        if (l.topics[0] !== tSig || l.topics.length !== 3) continue; // ERC20 Transfer only (NFT Transfer has 4 topics)
        const ev = erc.parseLog({ topics: l.topics, data: l.data });
        if (!ev) continue;
        const to = (ev.args.to as string).toLowerCase();
        // Deposit masuk: token pindah dari user (atau settlement) ke PoolManager
        if (to === poolMgr) {
          dep0 += BigInt(ev.args.value);
        }
      }
      if (dep0 > 0n) return { dep0, dep1 };
    }
    return null;
  } catch {
    return null;
  }
}

/** Retry a flaky read a couple times before giving up (transient RPC errors dropped rows). */
async function retry<T>(fn: () => Promise<T>, n = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw last;
}

export interface V4ClosedRow {
  tokenId: string;
  pair: string;
  fee: number;
  depEth: number | null; // basis only if bot-minted
  closedAt: number | null; // latest NFT transfer ts (for recent-first sort)
}

/** v4 NFTs the wallet still holds but with 0 liquidity = closed positions (for /ledger). */
export async function listClosedV4Positions(): Promise<V4ClosedRow[]> {
  if (!C.v4PositionManager) return [];
  const w = wallet();
  const posmL = C.v4PositionManager.toLowerCase();
  const deps = readJson<Record<string, { depositWei?: string }>>(dataPath("v4-positions.json"), {});
  let ids: string[] = [];
  try {
    const nft = await bsFetch<{ items?: any[] }>(`/api/v2/addresses/${w.address}/nft?type=ERC-721`);
    ids = (nft?.items ?? []).filter((i) => (i.token?.address_hash || "").toLowerCase() === posmL).map((i) => String(i.id));
  } catch {
    /* */
  }
  if (!ids.length) return [];
  const posm = new ethers.Contract(C.v4PositionManager, V4_POSM_ABI, provider);
  const rows = await mapLimit(ids, 8, async (tokenId): Promise<V4ClosedRow | null> => {
    try {
      const liq: bigint = await posm.getPositionLiquidity!(tokenId).catch(() => 0n);
      if (liq > 0n) return null; // still open → shown in /list, not ledger
      const [pk] = await posm.getPoolAndPositionInfo!(tokenId);
      const [m0, m1] = await Promise.all([
        pk.currency0.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH" }) : tokenMeta(pk.currency0).catch(() => ({ symbol: "?" })),
        pk.currency1.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH" }) : tokenMeta(pk.currency1).catch(() => ({ symbol: "?" })),
      ]);
      const dep = deps[tokenId];
      // closedAt: use the bot's local deposit ts if we have it, else null. We DROPPED the per-NFT
      // Blockscout `transfers` lookup — that was 1 rate-limited round-trip PER closed NFT (35+),
      // which froze /ledger. Sorting falls back to tokenId order (higher = newer), good enough.
      const depTs = (deps[tokenId] as { ts?: number } | undefined)?.ts ?? null;
      return {
        tokenId,
        pair: `${m0.symbol}/${m1.symbol}`,
        fee: Number(pk.fee),
        depEth: dep?.depositWei ? Number(ethers.formatEther(dep.depositWei)) : null,
        closedAt: depTs,
      };
    } catch {
      return null;
    }
  });
  return rows.filter((r): r is V4ClosedRow => r !== null);
}

/**
 * Original mint timestamp of a v4 position NFT (for positions added manually on the web UI,
 * where we have no local deposit record → age showed "?"). Read from Blockscout's NFT
 * instance transfers (the Transfer from 0x0), cached back into v4-positions.json.
 */
const v4MintTsCache = new Map<string, number | null>();
export async function v4MintTs(tokenId: string): Promise<number | null> {
  const key = String(tokenId);
  if (v4MintTsCache.has(key)) return v4MintTsCache.get(key)!;
  const deps = readJson<Record<string, { mintTs?: number }>>(dataPath("v4-positions.json"), {});
  if (deps[key]?.mintTs) {
    v4MintTsCache.set(key, deps[key]!.mintTs!);
    return deps[key]!.mintTs!;
  }
  let ts: number | null = null;
  try {
    const r = await bsFetch<{ items?: any[] }>(`/api/v2/tokens/${C.v4PositionManager}/instances/${key}/transfers`, 10_000);
    const items = r?.items ?? [];
    const mint = items.filter((i) => /^0x0{40}$/i.test(i.from?.hash || "")).pop() ?? items[items.length - 1];
    ts = mint?.timestamp ? new Date(mint.timestamp).getTime() : null;
  } catch {
    /* leave null */
  }
  v4MintTsCache.set(key, ts);
  if (ts) {
    const d = readJson<Record<string, any>>(dataPath("v4-positions.json"), {});
    d[key] = { ...(d[key] ?? {}), mintTs: ts };
    writeJson(dataPath("v4-positions.json"), d);
  }
  return ts;
}

function sdkCurrency(addr: string, dec: number, sym: string): any {
  return addr.toLowerCase() === NATIVE ? Ether.onChain(cfg.chainId) : new Token(cfg.chainId, ethers.getAddress(addr), dec, sym);
}

/** USD per 1 unit of a currency, or null if unknown (then value via the pool's other side). */
function usdOfCurrency(addr: string, sym: string, px: number): number | null {
  const a = addr.toLowerCase();
  if (a === NATIVE || a === WETH_L) return px;
  if (STABLES.has(a) || /^usd|usd$/i.test(sym)) return 1;
  return null;
}

// Last computed position snapshot. /list serves this instantly (staleOkMs) instead of racing the RPC
// against the hunt scanner — the manage loop + autolp + hunt already refresh it every 90s-3m, so it's
// always warm. Callers that need FRESH state (manage TP/SL/OOR, autolp gate) pass staleOkMs=0 (default).
let posCache: { rows: V4Row[]; at: number; addr?: string } | null = null;

// Cache untuk fallback ownerOf enumeration (Blockscout CF-blocked): owner → tokenId[] .
// Scan 60k id = ~30-60s; cache 10 menit biar /watch berulang nggak nge-scan ulang tiap kali.
const enumCache = new Map<string, { ids: string[]; at: number }>();
const ENUM_TTL = 10 * 60_000;
const ENUM_FILE = dataPath("v4-enum-cache.json");

/** True when enumerating a foreign wallet (watch mode) — skip ledger-based closed pruning. */
function watchTargetOnly(owner: string): boolean {
  const w = wallet();
  return owner.toLowerCase() !== w.address.toLowerCase();
}

export async function listV4Positions(staleOkMs = 0, address?: string): Promise<V4Row[]> {
  if (!C.v4PositionManager || !C.v4StateView) return [];
  const w = wallet();
  const owner = address ?? w.address; // watch-only: any address (enumerasi via Blockscout, read-only)
  if (staleOkMs > 0 && posCache && Date.now() - posCache.at < staleOkMs && posCache.addr === owner) return posCache.rows;
  const posmL = C.v4PositionManager.toLowerCase();
  const deps = readJson<Record<string, { depositWei?: string; ts?: number; mintTs?: number }>>(dataPath("v4-positions.json"), {});
  let ids: string[] = [];
  const nft = await bsFetch<{ items?: any[] }>(`/api/v2/addresses/${owner}/nft?type=ERC-721`);
  if (nft?.items) {
    ids = nft.items.filter((i) => (i.token?.address_hash || "").toLowerCase() === posmL).map((i) => String(i.id));
  } else {
    // Blockscout enum failed (rate-limit/404). Fallback ON-CHAIN: this Robinhood v4 PositionManager is
    // NOT ERC721Enumerable (tokenOfOwnerByIndex reverts) — the only reliable enumeration is scanning
    // ownerOf(tokenId) for tokenId in 1..nextTokenId, filtered by == owner. 1.4M ids is too many for
    // a naive scan, so probe in sparse batches near the tip: most live v4 positions have RECENT ids
    // (minted in the last weeks), and getPositionLiquidity quickly drops closed ones.
    // Batching via Multicall3 keeps this to a handful of eth_calls, not thousands of RPC round-trips.
    try {
      const ck = `v4:${owner.toLowerCase()}`;
      // memory cache → disk cache → scan
      let ent = enumCache.get(ck);
      if (!ent || Date.now() - ent.at >= ENUM_TTL) {
        try {
          const disk = readJson<Record<string, { ids: string[]; at: number }>>(ENUM_FILE, {});
          const d = disk[ck];
          if (d && Date.now() - d.at < ENUM_TTL) { ent = d; enumCache.set(ck, d); }
        } catch { /* ignore */ }
      }
      if (ent && Date.now() - ent.at < ENUM_TTL) {
        ids = ent.ids;
        log.warn(`/list: enum NFT Blockscout gagal — pakai cache ownerOf (${ids.length} id, ${Math.round((Date.now() - ent.at) / 1000)}s lalu)`);
      } else {
        const nmc = new ethers.Contract(C.v4PositionManager, ["function nextTokenId() view returns (uint256)", "function ownerOf(uint256) view returns (address)", "function getPositionLiquidity(uint256) view returns (uint128)"], provider);
        const next = Number(await nmc.nextTokenId!().catch(() => 0n));
        const out: string[] = [];
        const WINDOW = Number(process.env.V4_ENUM_WINDOW || 15_000); // 15k terbaru ~ nmt 20 batch — cukup buat posisi live
        const lo = Math.max(1, next - WINDOW);
        const mc = new ethers.Contract("0xcA11bde05977b3631167028862bE2a173976CA11", ["function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])"], provider);
        const BATCH = 500; // sweet spot: B500=0.86s vs B2000=2.7s (response-size bound)
        const ownerL = owner.toLowerCase();
        const st = lo;
        const ranges: Array<[number, number]> = [];
        for (let s = st; s < next; s += BATCH) ranges.push([s, Math.min(next, s + BATCH)]);
        // 4 parallel workers — 30 batch / 4 ≈ 8 rounds ≈ 4-6s cold; RPC free-tier bound, concurrency nggak ngaruh banyak
        const CONC = 4;
        let cursor = 0;
        const worker = async () => {
          while (true) {
            const i = cursor++;
            if (i >= ranges.length) break;
            const [a, b] = ranges[i];
            const calls = [];
            for (let id = a; id < b; id++) calls.push({ target: C.v4PositionManager, allowFailure: true, callData: nmc.interface.encodeFunctionData("ownerOf", [id]) });
            const res: Array<{ success: boolean; returnData: string }> = await mc.aggregate3!(calls);
            for (let j = 0; j < res.length; j++) {
              if (!res[j]?.success) continue;
              try {
                const own = (nmc.interface.decodeFunctionResult("ownerOf", res[j].returnData)[0] as string).toLowerCase();
                if (own === ownerL) out.push(String(a + j));
              } catch { /* skip */ }
            }
          }
        };
        await Promise.all(Array.from({ length: CONC }, worker));
        if (!out.length && next > 0) {
          // Fallback2: window 15k cuma nyapu posisi baru. Kalau nggak nemu, scan lebih dalam (60k)
          // — wallet yang lama nggak aktif posisinya baru ketangkep di sini.
          const WINDOW2 = Number(process.env.V4_ENUM_WINDOW_DEEP || 60_000);
          const lo2 = Math.max(1, next - WINDOW2);
          for (let start = lo2; start < next; start += BATCH) {
            const end = Math.min(next, start + BATCH);
            const calls = [];
            for (let id = start; id < end; id++) calls.push({ target: C.v4PositionManager, allowFailure: true, callData: nmc.interface.encodeFunctionData("ownerOf", [id]) });
            const res: Array<{ success: boolean; returnData: string }> = await mc.aggregate3!(calls);
            for (let j = 0; j < res.length; j++) {
              if (!res[j]?.success) continue;
              try {
                const own = (nmc.interface.decodeFunctionResult("ownerOf", res[j].returnData)[0] as string).toLowerCase();
                if (own === ownerL) out.push(String(start + j));
              } catch { /* skip */ }
            }
          }
        }
        ids = out;
        enumCache.set(ck, { ids: out, at: Date.now() });
        try {
          const disk = readJson<Record<string, { ids: string[]; at: number }>>(ENUM_FILE, {});
          disk[ck] = { ids: out, at: Date.now() };
          writeJson(ENUM_FILE, disk);
        } catch { /* cache disk optional */ }
        log.warn(`/list: enum NFT Blockscout gagal — fallback ownerOf scan ${lo}..${next} → ${out.length} id v4`);
      }
    } catch (e) {
      log.warn(`/list: enum NFT Blockscout kosong/gagal (rate-limit?) — andalin deps lokal (posisi web-UI bisa ke-skip sementara)`);
    }
  }
  ids = [...new Set([...ids, ...Object.keys(deps)])];
  if (!watchTargetOnly(owner)) {
    // Drop tokenIds the ledger already knows are CLOSED — deps accumulates every historical mint
    // (incl. burned positions), so without this /list pays 2 RPC reads per dead position, every time.
    try {
      const { readLedger } = await import("../ledger.js");
      const closed = new Set(readLedger().filter((e) => e.version === "v4").map((e) => e.tokenId));
      if (closed.size) ids = ids.filter((id) => !closed.has(id));
    } catch {
      /* ledger optional — just skip the prune */
    }
  }
  if (!ids.length) return [];

  const posm = new ethers.Contract(C.v4PositionManager, V4_POSM_ABI, provider);
  const sv = new ethers.Contract(C.v4StateView, STATEVIEW_ABI, provider);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const px = await ethUsd().catch(() => 0);

  // Krystal Cloud cross-check (only when RH_KRYSTAL_KEY is set): one HTTP fetch for the whole
  // wallet, indexed providedAmounts are the ground-truth deposit basis. Used as a fallback +
  // sanity net for PnL below (never a blocker — 4s timeout, empty map on failure).
  const krystalByTokenId = await krystalPositionMap(owner, C.v4PositionManager).catch(() => new Map<string, KrystalPosition>());

  // Pre-filter via Multicall3: read getPositionLiquidity for ALL ids in ONE eth_call and drop the
  // CLOSED (0-liq) NFTs the wallet accumulates (30+). Otherwise /list pays 2 reads PER dead NFT — that
  // is what made "Memuat posisi" crawl. Only the surviving OPEN ids get the full per-position read below.
  let openIds = ids;
  try {
    const mc = new ethers.Contract("0xcA11bde05977b3631167028862bE2a173976CA11", ["function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])"], provider);
    const calls = ids.map((id) => ({ target: C.v4PositionManager, allowFailure: true, callData: posm.interface.encodeFunctionData("getPositionLiquidity", [id]) }));
    const res: Array<{ success: boolean; returnData: string }> = await mc.aggregate3!(calls);
    openIds = ids.filter((id, i) => {
      const r = res[i];
      if (!r?.success) return true; // couldn't read → keep, let the full read decide
      try {
        const liq = BigInt(posm.interface.decodeFunctionResult("getPositionLiquidity", r.returnData)[0]);
        const fresh = !!deps[id]?.ts && Date.now() - deps[id]!.ts! < 15 * 60_000;
        return liq > 0n || fresh; // keep open, or freshly-opened (liq may lag the mint block)
      } catch {
        return true;
      }
    });
  } catch {
    /* multicall unavailable → fall through with all ids (the per-position read still filters 0-liq) */
  }
  if (!openIds.length) return [];

  const rows = await mapLimit(openIds, 10, async (tokenId): Promise<V4Row | null> => {
    try {
      const [owner, liq0] = await Promise.all([
        retry(() => posm.ownerOf!(tokenId) as Promise<string>).catch(() => ethers.ZeroAddress),
        retry(() => posm.getPositionLiquidity!(tokenId) as Promise<bigint>).catch(() => 0n),
      ]);
      let liquidity = liq0;
      // A just-opened position can momentarily read liquidity 0 if the RPC node lags the mint block —
      // for RECENTLY-opened (local deposit ts < 15m) positions, re-read a few times before dropping so a
      // fresh manual open reliably appears in /list instead of intermittently vanishing.
      const freshTs = deps[tokenId]?.ts;
      const isFresh = !!freshTs && Date.now() - freshTs < 15 * 60_000;
      if (liquidity === 0n && isFresh) {
        for (let i = 0; i < 3 && liquidity === 0n; i++) {
          await new Promise((r) => setTimeout(r, 600));
          liquidity = await (posm.getPositionLiquidity!(tokenId) as Promise<bigint>).catch(() => 0n);
        }
      }
      if (liquidity === 0n || (address && owner.toLowerCase() !== address.toLowerCase())) {
        return null;
      }

      const [pk, infoRaw] = await retry(() => posm.getPoolAndPositionInfo!(tokenId));
      const info = BigInt(infoRaw);
      const tickLower = signed24(Number((info >> 8n) & 0xffffffn));
      const tickUpper = signed24(Number((info >> 32n) & 0xffffffn));
      const fee = Number(pk.fee);
      const tickSpacing = Number(pk.tickSpacing);
      const c0 = pk.currency0 as string;
      const c1 = pk.currency1 as string;

      const [m0, m1] = await Promise.all([
        c0.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH", decimals: 18 }) : tokenMeta(c0).catch(() => ({ symbol: "?", decimals: 18 })),
        c1.toLowerCase() === NATIVE ? Promise.resolve({ symbol: "ETH", decimals: 18 }) : tokenMeta(c1).catch(() => ({ symbol: "?", decimals: 18 })),
      ]);

      const poolId = ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [c0, c1, fee, tickSpacing, pk.hooks]));
      const positionId = ethers.solidityPackedKeccak256(
        ["address", "int24", "int24", "bytes32"],
        [C.v4PositionManager, tickLower, tickUpper, ethers.toBeHex(BigInt(tokenId), 32)],
      );
      const [s0, fgInside, posInfo] = await Promise.all([
        retry(() => sv.getSlot0!(poolId)),
        sv.getFeeGrowthInside!(poolId, tickLower, tickUpper).catch(() => [0n, 0n]),
        sv.getPositionInfo!(poolId, positionId).catch(() => [0n, 0n, 0n]),
      ]);
      const tick = Number(s0.tick);

      const cur0 = sdkCurrency(c0, m0.decimals, m0.symbol);
      const cur1 = sdkCurrency(c1, m1.decimals, m1.symbol);
      const pool = new Pool(cur0, cur1, fee, tickSpacing, pk.hooks, s0.sqrtPriceX96.toString(), "0", tick);
      const pos = new Position({ pool, liquidity: liquidity.toString(), tickLower, tickUpper });

      // unclaimed fees from feeGrowthInside delta (uint256 wrap-safe) × liquidity >> 128
      const fee0raw = (((BigInt(fgInside[0]) - BigInt(posInfo[1])) & MASK256) * liquidity) >> 128n;
      const fee1raw = (((BigInt(fgInside[1]) - BigInt(posInfo[2])) & MASK256) * liquidity) >> 128n;
      const fee0 = CurrencyAmount.fromRawAmount(cur0, fee0raw.toString());
      const fee1 = CurrencyAmount.fromRawAmount(cur1, fee1raw.toString());

      const u0 = usdOfCurrency(c0, m0.symbol, px);
      const u1 = usdOfCurrency(c1, m1.symbol, px);
      const sideUsd = (amt: any, thisUsd: number | null, otherUsd: number | null): number => {
        try {
          let v = 0;
          if (thisUsd != null) v = Number(amt.toExact()) * thisUsd;
          else if (otherUsd != null) v = Number(pool.priceOf(amt.currency).quote(amt).toExact()) * otherUsd;
          // SANITY: pool.priceOf on a thin / extreme-tick pool can explode to 1e50+, poisoning valueUsd
          // (→ automanage pnlPct → a spurious SL close) + feeUsd (→ compound) + the close ledger (pre).
          // No single farming-position leg is near $1M, so treat a blown-up value as unvaluable (0).
          return Number.isFinite(v) && Math.abs(v) < 1e6 ? v : 0;
        } catch {
          /* price edge */
        }
        return 0;
      };
      const total0 = pos.amount0.add(fee0);
      const total1 = pos.amount1.add(fee1);
      const valueUsd = sideUsd(total0, u0, u1) + sideUsd(total1, u1, u0);
      const feeUsd = sideUsd(fee0, u0, u1) + sideUsd(fee1, u1, u0);

      const ethPaired = c0.toLowerCase() === NATIVE || c1.toLowerCase() === NATIVE;
      const isQuote = (a: string) => a === NATIVE || a === WETH_L || STABLES.has(a);
      const tokenAddr = isQuote(c0.toLowerCase()) ? c1 : c0; // volatile side (non-ETH/non-USDG)
      const dep = deps[tokenId];
      // age: bot deposit ts, else the position's on-chain mint time (manual web adds)
      const openedAt = dep?.ts ?? dep?.mintTs ?? (await v4MintTs(tokenId).catch(() => null));
      // primary token = the non-stable / non-eth side (for the emoji/label)
      const primary = u0 != null && u1 == null ? m1.symbol : u1 != null && u0 == null ? m0.symbol : m0.symbol;

      // PnL basis = LP-vs-HODL (SAME as closeV4Position's ledger): value the DEPOSITED amounts
      // (dep0/dep1) at the CURRENT price. The old basis (gross ETH budget = depositWei) wrongly
      // counted the entry swap-fee + the leftover swept BACK to the wallet as "loss", so /list showed
      // a phantom minus that disagreed with the realized close PnL. Now they match.
      let basisEth = dep?.depositWei ? Number(ethers.formatEther(dep.depositWei)) : null;
      if (basisEth == null) {
        // Watch mode (foreign wallet): reconstruct the deposit from the mint calldata so PnL
        // is live for ANY wallet, not just bot-minted ones. Cache result in the v4 ledger so
        // repeated /watch doesn't re-scan.
        try {
          const depFile = readJson<Record<string, any>>(dataPath("v4-positions.json"), {});
          const cached = depFile[tokenId];
          if (cached?.mintDep0 && cached?.mintDep1) {
            const u0c = usdOfCurrency(c0, m0.symbol, px);
            const u1c = usdOfCurrency(c1, m1.symbol, px);
            const amt0n = Number(cached.mintDep0) / 10 ** (m0.decimals as number);
            const amt1n = Number(cached.mintDep1) / 10 ** (m1.decimals as number);
            const hodlUsd = (u0c != null ? amt0n * u0c : 0) + (u1c != null ? amt1n * u1c : 0);
            if (hodlUsd > 0 && px > 0) basisEth = hodlUsd / px;
          } else {
            const md = await mintDeposit(tokenId);
            if (md) {
              depFile[tokenId] = { ...(depFile[tokenId] ?? {}), mintDep0: md.dep0.toString(), mintDep1: md.dep1.toString() };
              writeJson(dataPath("v4-positions.json"), depFile);
              const u0 = usdOfCurrency(c0, m0.symbol, px);
              const u1 = usdOfCurrency(c1, m1.symbol, px);
              const amt0Num = Number(md.dep0) / 10 ** (m0.decimals as number);
              const amt1Num = Number(md.dep1) / 10 ** (m1.decimals as number);
              const hodlUsd = (u0 != null ? amt0Num * u0 : 0) + (u1 != null ? amt1Num * u1 : 0);
              if (hodlUsd > 0 && px > 0) basisEth = hodlUsd / px;
            }
          }
        } catch { /* keep null basis */ }
      }

      // ── Krystal Cloud cross-check (Option A: fallback / correction) ─────────────────────────
      // Krystal indexes each v4 position's REAL provided amounts + realized value. When its record
      // disagrees with the local on-chain reconstruction by a lot (>15%) — or local basis is null
      // (foreign position whose mint scan failed) — prefer Krystal's numbers. Local read stays the
      // default when Krystal is absent or agrees; a disagreement usually means the local deposit
      // reconstruction missed a side / mis-valued a volatile token at mint time.
      try {
        const kp = krystalByTokenId.get(tokenId);
        if (kp) {
          const depUsd = krystalAmountsUsd(kp.providedAmounts); // indexed provided value at entry
          const localUsd = basisEth != null && px > 0 ? basisEth * px : null;
          if (depUsd > 0) {
            const kEth = depUsd / (px > 0 ? px : 1);
            if (localUsd == null || (localUsd > 0 && Math.abs(localUsd - depUsd) / Math.max(localUsd, depUsd) > 0.15)) {
              if (localUsd != null) log.warn(`#${tokenId} ${m0.symbol}/${m1.symbol}: basis lokal $${localUsd.toFixed(2)} vs Krystal $${depUsd.toFixed(2)} — pakai Krystal`);
              basisEth = kEth;
            }
          }
          // also: prefer Krystal's unclaimed-fee value when ours reads 0 but the position clearly earned
          if ((feeUsd === 0 || Number.isNaN(feeUsd)) && kp.totalFeeEarned && kp.totalFeeEarned > 0) {
            log.warn(`#${tokenId}: fee lokal 0 tapi Krystal totalFeeEarned $${kp.totalFeeEarned.toFixed(2)}`);
          }
        }
      } catch { /* krystal is optional — never let it break /list */ }

      return {
        tokenId,
        pair: `${m0.symbol}/${m1.symbol}`,
        sym: primary,
        fee,
        inRange: tick >= tickLower && tick < tickUpper,
        tick,
        tickLower,
        tickUpper,
        amount0: pos.amount0.toSignificant(6),
        sym0: m0.symbol,
        amount1: pos.amount1.toSignificant(6),
        sym1: m1.symbol,
        feeUsd,
        valueUsd,
        depEth: basisEth,
        ethPaired,
        ageMs: openedAt ? Date.now() - openedAt : null,
        tokenAddr: ethers.getAddress(tokenAddr),
        poolId,
      };
    } catch (e) {
      log.warn(`skip v4 #${tokenId}: ${(e as Error).message.slice(0, 80)}`);
      return null;
    }
  });
  const out = rows.filter((r): r is V4Row => r !== null);
  posCache = { rows: out, at: Date.now(), addr: owner };
  return out;
}
