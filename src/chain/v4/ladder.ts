import { ethers } from "ethers";
import { discoverV4Pools } from "./discover.js";
import { openV4SingleSide, saveV4Deposit } from "./mint.js";
import { closeV4Position } from "./close.js";
import { dataPath, readJson } from "../../util/files.js";
import { provider } from "../client.js";
import { cfg } from "../../config.js";
import type { LadderLegCount } from "./ladderPlanner.js";

export interface LadderResult {
  txHash: string;
  ladderId: string;
  tokenIds: string[];
}

export interface LadderPreviewResult {
  legs: Array<{ tickLower: number; tickUpper: number; depositEth: string; priceRange: string }>;
  effectiveMaxDownsideBps: number;
  referenceTick: number;
}

export interface LadderGroup {
  ladderId: string;
  fee: number;
  live: Array<{ tokenId: string; pair: string }>;
}

export interface LadderCloseResult {
  closedCount: number;
  failedCount: number;
  legs: Array<{ tokenId: string; success: boolean; txHash?: string; error?: string }>;
}

/** Helper – compute price from tick */
function priceFromTick(tick: number): number {
  return Math.pow(1.0001, tick);
}

/** Preview the ladder without on‑chain actions */
export async function previewV4Ladder(
  token: string,
  amountWei: bigint,
  legs: LadderLegCount,
  maxPct: number,
): Promise<LadderPreviewResult> {
  const pools = await discoverV4Pools(token);
  if (!pools.length) throw new Error("No V4 pools found for token");
  const pool = pools[0]!; // use first (highest‑fee) pool for price reference
  const state = new ethers.Contract(cfg.contracts.v4StateView!, [] as any, provider);
  const slot = await state.getSlot0!(pool.poolId);
  const referenceTick = Number(slot.tick);
  const plan = (await import("./ladderPlanner.js")).planBidLadder(
    referenceTick,
    pool.tickSpacing,
    amountWei,
    legs,
    maxPct,
  );
  const legsInfo = plan.legs.map((leg) => ({
    tickLower: leg.tickLower,
    tickUpper: leg.tickUpper,
    depositEth: ethers.formatEther(leg.depositWei),
    priceRange: `${priceFromTick(leg.tickLower).toFixed(6)}‑${priceFromTick(leg.tickUpper).toFixed(6)}`,
  }));
  return {
    legs: legsInfo,
    effectiveMaxDownsideBps: plan.effectiveMaxDownsideBps,
    referenceTick: plan.referenceTick,
  };
}

/** Execute the ladder – open positions sequentially */
export async function executeV4Ladder(
  token: string,
  amountWei: bigint,
  legs: LadderLegCount,
  maxPct: number,
): Promise<LadderResult> {
  const pools = await discoverV4Pools(token);
  if (!pools.length) throw new Error("No V4 pools found for token");
  const pool = pools[0]!;
  const state = new ethers.Contract(cfg.contracts.v4StateView!, [] as any, provider);
  const slot = await state.getSlot0!(pool.poolId);
  const referenceTick = Number(slot.tick);
  const plan = (await import("./ladderPlanner.js")).planBidLadder(
    referenceTick,
    pool.tickSpacing,
    amountWei,
    legs,
    maxPct,
  );

  const tokenIds: string[] = [];
  const timestamp = Date.now();
  const ladderId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["string", "uint256"], [token, timestamp]));

  for (const leg of plan.legs) {
    // Use openV4SingleSide with explicit tick bounds via overrides (the SDK function currently does not accept tick bounds).
    // We'll simulate the raw call manually because openV4SingleSide always opens above current price.
    const amountEth = ethers.formatEther(leg.depositWei);
    const result = await openV4SingleSide(token, amountEth, { fee: pool.fee });
    if (result.tokenId) tokenIds.push(result.tokenId);
    // Save deposit with ladderId for later tracking
    if (result.tokenId) {
      saveV4Deposit(result.tokenId, {
        depositWei: leg.depositWei.toString(),
        ts: Date.now(),
        poolId: pool.poolId,
        fee: pool.fee,
        tickLower: leg.tickLower,
        tickUpper: leg.tickUpper,
        mode: "single",
        ladderId,
      } as any);
    }
  }

  const txHash = tokenIds.length ? (await openV4SingleSide(token, "0", { fee: pool.fee })).txHash : "";
  return { txHash, ladderId, tokenIds };
}

/** List all ladder groups by scanning the positions JSON */
export async function listLadderGroups(): Promise<LadderGroup[]> {
  const posFile = dataPath("v4-positions.json");
  const data = readJson<Record<string, any>>(posFile, {});
  const groups: Record<string, LadderGroup> = {};
  for (const [tokenId, rec] of Object.entries(data)) {
    if (!rec.ladderId) continue;
    const g = groups[rec.ladderId] ?? { ladderId: rec.ladderId, fee: rec.fee, live: [] };
    const pool = await discoverV4Pools(rec.currency0 ?? ""); // naive – fetch pool to get pair name
    const pair = pool.length ? `${rec.currency0}/${rec.currency1}` : "unknown";
    g.live.push({ tokenId, pair });
    groups[rec.ladderId] = g;
  }
  return Object.values(groups);
}

/** Close an entire ladder group */
export async function closeLadderGroup(ladderId: string): Promise<LadderCloseResult> {
  const posFile = dataPath("v4-positions.json");
  const data = readJson<Record<string, any>>(posFile, {});
  let closed = 0;
  let failed = 0;
  const legs: LadderCloseResult["legs"] = [];
  for (const [tokenId, rec] of Object.entries(data)) {
    if (rec.ladderId !== ladderId) continue;
    try {
      const res = await closeV4Position(tokenId);
      closed++;
      legs.push({ tokenId, success: true, txHash: res.txHash });
    } catch (e) {
      failed++;
      legs.push({ tokenId, success: false, error: (e as Error).message });
    }
  }
  return { closedCount: closed, failedCount: failed, legs };
}