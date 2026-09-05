/**
 * Krystal Cloud API client (https://cloud.krystal.app) — OPTIONAL PnL cross-check.
 *
 * The v4 deposit basis the bot computes on-chain (feeGrowthInside delta, mint-receipt
 * reconstruction) can drift: two-sided positions, positions minted by the web UI, foreign
 * wallets with a closed/local-unobservable mint, price-API misses. Krystal indexes the same
 * Robinhood-chain Uniswap v4 positions with EXPLICIT providedAmounts + pnl. This module is a
 * fallback/cross-check: when RH_KRYSTAL_KEY is set, /list & /watch pull the user's open
 * positions and reconcile basis/pnl. Without the key every function is a no-op → zero risk.
 *
 * Endpoint (server-to-server friendly — NOT Cloudflare-challenged like api.krystal.app):
 *   GET https://cloud-api.krystal.app/v1/positions?wallet=0x..&chainIds=4663&positionStatus=OPEN
 *   Header: KC-APIKey: <key>
 */

import { env } from "../config.js";
import { logger } from "../util/log.js";

const log = logger("krystal");
const BASE = "https://cloud-api.krystal.app";
const CHAIN_ID = 4663;

type KrystalTokenAmount = {
  token?: { address?: string; symbol?: string; decimals?: number; price?: number };
  balance?: string | number;
  quotes?: { usd?: { value?: number; price?: number } };
};

export type KrystalPosition = {
  id: string; // "{NFPM}-{tokenId}" for v3/v4
  chainId: number;
  userAddress: string;
  tokenId?: string;
  tokenAddress?: string;
  status?: string;
  pnl?: number;
  returnOnInvestment?: number;
  compareWithHodl?: number;
  currentPositionValue?: number;
  initialUnderlyingValue?: number;
  totalDepositValue?: number;
  totalWithdrawValue?: number;
  impermanentLoss?: number;
  providedAmounts?: KrystalTokenAmount[];
  currentAmounts?: KrystalTokenAmount[];
  feePending?: KrystalTokenAmount[];
  totalFeeEarned?: number;
  avgConvertPrice?: number;
};

type KrystalResponse = {
  positions?: KrystalPosition[];
  statsByChain?: Record<string, unknown>;
};

let cache: { at: number; byWallet: Map<string, KrystalPosition[]> } = {
  at: 0,
  byWallet: new Map(),
};
const TTL_MS = 45_000;

export function krystalEnabled(): boolean {
  return env.krystalKey.length > 0;
}

/** Sum a token-amount list into USD using Krystal's own quote (their pricing oracle). */
export function krystalAmountsUsd(amounts?: KrystalTokenAmount[]): number {
  if (!amounts?.length) return 0;
  return amounts.reduce((sum, a) => {
    const v = a.quotes?.usd?.value;
    return sum + (Number.isFinite(v) ? (v ?? 0) : 0);
  }, 0);
}

async function fetchPositions(walletAddr: string, force = false, timeoutMs = 12_000): Promise<KrystalPosition[]> {
  if (!krystalEnabled()) return [];
  const cached = cache.byWallet.get(walletAddr.toLowerCase());
  if (!force && cached && Date.now() - cache.at < TTL_MS) return cached;
  try {
    const url = `${BASE}/v1/positions?wallet=${walletAddr}&chainIds=${CHAIN_ID}&positionStatus=OPEN&includeSpamPosition=false&limit=500`;
    const res = await fetch(url, {
      headers: { "KC-APIKey": env.krystalKey, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      // 401 = bad key, 402 = quota — log once-ish (rate-limited by the bot caller anyway)
      log.warn(`krystal positions http ${res.status}`);
      if (res.status === 401) cache.byWallet.set(walletAddr.toLowerCase(), []); // don't hammer a dead key
      return cache.byWallet.get(walletAddr.toLowerCase()) ?? [];
    }
    const data = (await res.json()) as KrystalResponse;
    const positions = data.positions ?? [];
    cache.at = Date.now();
    cache.byWallet.set(walletAddr.toLowerCase(), positions);
    return positions;
  } catch (e) {
    log.warn(`krystal fetch gagal: ${(e as Error).message.slice(0, 120)}`);
    return cached ?? [];
  }
}

/**
 * One-shot map for a whole wallet: tokenId → Krystal position. Called ONCE per /list or /watch
 * so N open positions share a single HTTP fetch (cached 45s). Short timeout: Krystal is a
 * cross-check, never a blocker — if it's slow, /list proceeds with the on-chain basis alone.
 */
export async function krystalPositionMap(
  walletAddr: string,
  positionManagerAddr: string,
): Promise<Map<string, KrystalPosition>> {
  const out = new Map<string, KrystalPosition>();
  if (!krystalEnabled()) return out;
  const all = await fetchPositions(walletAddr, false, 4_000);
  const posm = positionManagerAddr.toLowerCase();
  for (const p of all) {
    if (!p.id) continue;
    const [addr, id] = p.id.split("-");
    if (addr?.toLowerCase() === posm && id) out.set(id, p);
  }
  return out;
}

/** Best available Krystal record for a position, keyed by NFPM-tokenId. */
export async function krystalPositionFor(
  walletAddr: string,
  tokenId: string,
  positionManagerAddr: string,
): Promise<KrystalPosition | null> {
  if (!krystalEnabled()) return null;
  const all = await fetchPositions(walletAddr);
  if (!all.length) return null;
  const posm = positionManagerAddr.toLowerCase();
  return (
    all.find((p) => {
      if (!p.id) return false;
      const [addr, id] = p.id.split("-");
      return addr?.toLowerCase() === posm && id === String(tokenId);
    }) ?? null
  );
}

/**
 * Cross-check API for the /list row builder: given the bot's locally-computed USD basis
 * (hodl value of the on-chain reconstructed deposit at current price) and a token pair,
 * return the deposit basis Krystal indexes (initial value of providedAmounts at entry).
 * Returns null when Krystal has no record or the API is off.
 */
export async function krystalDepositUsd(walletAddr: string, tokenId: string, positionManagerAddr: string): Promise<number | null> {
  if (!krystalEnabled()) return null;
  const p = await krystalPositionFor(walletAddr, tokenId, positionManagerAddr);
  if (!p) return null;
  const depUsd = krystalAmountsUsd(p.providedAmounts);
  return depUsd > 0 ? depUsd : null;
}

/** Reconcile: pull a Krystal position summary for diagnostics (used by a /krystal debug command). */
export async function krystalWalletSummary(walletAddr: string): Promise<{
  count: number;
  enabled: boolean;
  totalPnl: number;
  totalDeposit: number;
  rows: Array<{ tokenId: string; status: string; pnl: number; dep: number; val: number }>;
} | null> {
  if (!krystalEnabled()) return null;
  const all = await fetchPositions(walletAddr, true);
  const rows = all.map((p) => ({
    tokenId: p.tokenId ?? p.id ?? "?",
    status: p.status ?? "?",
    pnl: p.pnl ?? 0,
    dep: p.initialUnderlyingValue ?? p.totalDepositValue ?? 0,
    val: p.currentPositionValue ?? 0,
  }));
  return {
    count: all.length,
    enabled: true,
    totalPnl: rows.reduce((s, r) => s + r.pnl, 0),
    totalDeposit: rows.reduce((s, r) => s + r.dep, 0),
    rows,
  };
}

export { fetchPositions };
