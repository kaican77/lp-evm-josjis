/**
 * V4 Bid Ladder Planner — ported from FUNI V1 strategy.
 *
 * Key differences from the old flat-split planner:
 *  1. WEIGHTED funding: deeper legs get more capital (8/12/18/25/37 BPS-weighted)
 *  2. CONTIGUOUS one-sided ranges: no gaps, no overlaps — every price point is covered
 *  3. All ranges BELOW current tick = true bid (limit buy) ladder
 *  4. Terminal depth is capped inward (never exceeds operator-selected maxDownside)
 */

export type LadderLegCount = 3 | 5;

// ── FUNI V1 normalized slices (5-leg) ────────────────────────────────
// Boundaries:  1% → 5% → 12% → 22% → 35% → 50%  (of maxDownsidePct)
// Weights:     8%  12%  18%   25%   37%
const BOUNDARIES_5 = [100, 500, 1200, 2200, 3500, 5000] as const;
const WEIGHTS_5    = [800, 1200, 1800, 2500, 3700] as const;
const WEIGHT_TOTAL = 10_000;

// 3-leg: reuse same weight distribution, fewer boundaries
const BOUNDARIES_3 = [100, 2200, 5000] as const;
const WEIGHTS_3    = [2500, 3500, 4000] as const;

// ── Types ────────────────────────────────────────────────────────────

export interface LadderPlanLeg {
  index: number;
  tickLower: number;
  tickUpper: number;
  depositWei: bigint;
  weightBps: number;
  upperDropBps: number;
  lowerDropBps: number;
}

export interface LadderPlan {
  legs: LadderPlanLeg[];
  referenceTick: number;
  effectiveMaxDownsideBps: number;
  totalDeposit: bigint;
}

// ── Helpers ──────────────────────────────────────────────────────────

const alignedFloor = (tick: number, sp: number) => Math.floor(tick / sp) * sp;

/**
 * Scale normalized BPS boundaries by the operator's max downside.
 * The terminal boundary is exactly maxDownside; inner ones are linearly interpolated.
 */
function scaleBoundaries(norm: readonly number[], maxBps: number): number[] {
  return norm.map((bps, i) =>
    i === norm.length - 1 ? maxBps : Math.floor(bps * maxBps / 5000),
  );
}

// ── Core planner ─────────────────────────────────────────────────────

/**
 * Compute a bid ladder plan.
 *
 * @param currentTick  Current on-chain tick (price = 1.0001^tick).
 * @param tickSpacing  Pool tick spacing.
 * @param totalDepositWei  Total funding (e.g. USDG or WETH in wei) to split across legs.
 * @param legCount  3 or 5 legs.
 * @param maxDownsidePct  Maximum downside % (e.g. 50 for 50%).
 * @returns LadderPlan with contiguous below-price ranges and weighted funding.
 */
export function planBidLadder(
  currentTick: number,
  tickSpacing: number,
  totalDepositWei: bigint,
  legCount: LadderLegCount,
  maxDownsidePct: number,
  targetIndex: 0 | 1 = 0,
): LadderPlan {
  if (maxDownsidePct <= 0 || maxDownsidePct >= 100) {
    throw new Error("maxDownsidePct harus 1–99");
  }

  const maxDownsideBps = maxDownsidePct * 100;
  const boundaries = scaleBoundaries(
    legCount === 5 ? BOUNDARIES_5 : BOUNDARIES_3,
    maxDownsideBps,
  );
  const weights = legCount === 5 ? WEIGHTS_5 : WEIGHTS_3;

  // Validate boundaries are monotonically increasing
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i]! <= boundaries[i - 1]!) {
      throw new Error("boundaries collapse — maxDownsidePct terlalu kecil");
    }
  }

  // ── Split funding by weight ──
  const amounts = splitFunding(totalDepositWei, weights);

  // FUNI geometry: target currency0 is a decreasing ladder; target currency1 is increasing.
  // Snap the terminal boundary inward and project every inner boundary onto an ordered grid.
  const rawTicks = boundaries.map(bps => currentTick + (targetIndex === 0 ? 1 : -1) * Math.log(1 - bps / 10_000) / Math.log(1.0001));
  const desired = rawTicks.map(t => targetIndex === 0 ? alignedFloor(t, tickSpacing) : Math.ceil(t / tickSpacing) * tickSpacing);
  const cap = targetIndex === 0
    ? Math.ceil(rawTicks[rawTicks.length - 1]! / tickSpacing) * tickSpacing
    : alignedFloor(rawTicks[rawTicks.length - 1]!, tickSpacing);
  const ticks: number[] = [desired[0]!];
  for (let i = 1; i < legCount; i++) {
    const lo = targetIndex === 0 ? cap + (legCount - i) * tickSpacing : ticks[i - 1]! + tickSpacing;
    const hi = targetIndex === 0 ? ticks[i - 1]! - tickSpacing : cap - (legCount - i) * tickSpacing;
    if (lo > hi) throw new Error("tick range collapse — spacing terlalu besar atau downside terlalu kecil");
    ticks.push(Math.max(lo, Math.min(hi, desired[i]!)));
  }
  ticks.push(cap);

  // Validate contiguity
  for (let i = 0; i < ticks.length - 1; i++) {
    const distance = targetIndex === 0 ? ticks[i]! - ticks[i + 1]! : ticks[i + 1]! - ticks[i]!;
    if (distance < tickSpacing) {
      throw new Error(`gap/overlap antara leg ${i} dan ${i + 1}`);
    }
  }

  // ── Build legs (contiguous, below-price, weighted) ──
  const legs: LadderPlanLeg[] = [];
  for (let i = 0; i < legCount; i++) {
    const tickLower = targetIndex === 0 ? ticks[i + 1]! : ticks[i]!;
    const tickUpper = targetIndex === 0 ? ticks[i]! : ticks[i + 1]!;
    legs.push({
      index: i,
      tickLower,
      tickUpper,
      depositWei: amounts[i]!,
      weightBps: weights[i]!,
      upperDropBps: boundaries[i]!,
      lowerDropBps: boundaries[i + 1]!,
    });
  }

  // ── Invariants ──
  const sumDeposit = legs.reduce((s, l) => s + l.depositWei, 0n);
  if (sumDeposit !== totalDepositWei) {
    throw new Error("funding conservation failed");
  }

  // Effective downside = terminal boundary
  const effectiveMaxDownsideBps = boundaries[boundaries.length - 1]!;

  return {
    legs,
    referenceTick: currentTick,
    effectiveMaxDownsideBps,
    totalDeposit: totalDepositWei,
  };
}

/**
 * Split total funding across legs by BPS weight.
 * Last leg gets the remainder to avoid rounding dust.
 */
function splitFunding(total: bigint, weights: readonly number[]): bigint[] {
  const first = weights.slice(0, -1).map(w =>
    total * BigInt(w) / BigInt(WEIGHT_TOTAL),
  );
  const remainder = total - first.reduce((s, a) => s + a, 0n);
  const amounts = [...first, remainder];
  if (amounts.some(a => a <= 0n)) {
    throw new Error("capital terlalu kecil — minimal 1 leg dapet > 0");
  }
  return amounts;
}
