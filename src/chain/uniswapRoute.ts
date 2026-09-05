/**
 * Uniswap-native routing — replaces the KyberSwap aggregator. Best quote across every
 * v3 fee tier (Quoter), executed via Router02 (exactInputSingle) for ERC20↔ERC20/WETH and
 * the UniversalRouter V4_SWAP command (src/chain/v4/swap.ts) for native-ETH pairs.
 *
 * No external aggregator, no HTTP quote — everything on-chain. Slippage floor always
 * derived from the on-chain quote (never 0), and approvals are EXACT-amount (never MaxUint).
 */
import { ethers } from "ethers";
import { cfg, C } from "../config.js";
import { wallet, provider, overrides, waitTx } from "./client.js";
import { ERC20_ABI, WETH_ABI, QUOTER_ABI, ROUTER_ABI } from "./abis.js";
import { swapEthToTokenV4 } from "./v4/swap.js";
import { logger } from "../util/log.js";

const log = logger("uroute");

export const NATIVE = "0x0000000000000000000000000000000000000000"; // native ETH sentinel (v4 keeps 0x0)

export interface UniSwapResult {
  tx: string;
  amountOut: bigint; // actual output received (balance delta)
}

/** Best v3 quote tokenIn→tokenOut (exact-in) across all fee tiers. { amountOut: 0 } = no pool. */
export async function quoteV3Best(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<{ amountOut: bigint; fee: number }> {
  const q = new ethers.Contract(C.quoter, QUOTER_ABI, provider);
  let best = { amountOut: 0n, fee: 0 };
  for (const fee of cfg.lp.feeTiers) {
    try {
      const r = await q.quoteExactInputSingle!.staticCall({
        tokenIn,
        tokenOut,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0n,
      });
      const out = r[0] as bigint;
      if (out > best.amountOut) best = { amountOut: out, fee };
    } catch {
      /* no pool on this tier */
    }
  }
  return best;
}

const minOutOf = (amountOut: bigint): bigint => {
  const bps = BigInt(Math.round((cfg.lp.slippagePct || 5) * 100));
  return (amountOut * (10_000n - bps)) / 10_000n;
};

/** ERC20→ERC20 exactInputSingle on Router02. Output is ALWAYS an ERC20 (WETH for native-out legs). */
async function swapRouter02(tokenIn: string, tokenOut: string, amountIn: bigint, fee: number): Promise<UniSwapResult> {
  const w = wallet();
  const q = await quoteV3Best(tokenIn, tokenOut, amountIn);
  if (q.amountOut <= 0n) throw new Error(`v3 nggak ada rute ${tokenIn.slice(0, 8)}→${tokenOut.slice(0, 8)}`);
  const min = minOutOf(q.amountOut);
  const erc = new ethers.Contract(tokenIn, ERC20_ABI, w);
  if ((await erc.allowance!(w.address, C.swapRouter02)) < amountIn) {
    await waitTx(await erc.approve!(C.swapRouter02, amountIn, await overrides()), "ur-approve");
  }
  const outErc = new ethers.Contract(tokenOut, ERC20_ABI, provider);
  const before: bigint = await outErc.balanceOf!(w.address).catch(() => 0n);
  const router = new ethers.Contract(C.swapRouter02, ROUTER_ABI, w);
  const tx = await router.exactInputSingle!(
    {
      tokenIn,
      tokenOut,
      fee,
      recipient: w.address,
      amountIn,
      amountOutMinimum: min, // slippage floor from the on-chain quote — never 0
      sqrtPriceLimitX96: 0n,
    },
    await overrides(),
  );
  await tx.wait();
  const after: bigint = await outErc.balanceOf!(w.address).catch(() => 0n);
  return { tx: tx.hash, amountOut: after > before ? after - before : 0n };
}

/**
 * Swap A → B with the best execution, Uniswap-only:
 *  - native-ETH pair   → UniversalRouter V4_SWAP on the deepest v4 pool (existing verified path)
 *  - otherwise         → Router02 exactInputSingle on the deepest v3 fee tier (WETH wrap/unwrap for native legs)
 * tokenIn/tokenOut may be the NATIVE sentinel (0x0…0). Returns null when unroutable.
 */
export async function uniswapSwap(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<UniSwapResult | null> {
  if (amountIn <= 0n) return null;
  const w = wallet();
  const inNative = tokenIn.toLowerCase() === NATIVE.toLowerCase();
  const outNative = tokenOut.toLowerCase() === NATIVE.toLowerCase();
  const inWeth = tokenIn.toLowerCase() === C.weth.toLowerCase();
  const outWeth = tokenOut.toLowerCase() === C.weth.toLowerCase();
  const weth = C.weth.toLowerCase();

  const ercOf = (a: string) => (!a || a.toLowerCase() === NATIVE.toLowerCase() || a.toLowerCase() === weth ? null : a);
  const inErc = ercOf(tokenIn);
  const outErc = ercOf(tokenOut);

  // ── NATIVE → token: UniversalRouter v4 (best pool), fallback WETH-wrap + Router02 ──
  if (inNative && outErc) {
    try {
      const { discoverV4Pools, pickV4Pool } = await import("./v4/discover.js");
      const pools = await discoverV4Pools(outErc);
      const pool = pools.length ? pickV4Pool(pools) : null;
      if (pool) {
        const sw = await swapEthToTokenV4(pool.poolKey, amountIn);
        if (sw.amountOut > 0n) return sw;
      }
      log.warn("v4 native→token tak ada pool / output 0 — fallback WETH-wrap + Router02");
    } catch (e) {
      log.warn(`v4 native swap gagal (${(e as Error).message.slice(0, 60)}) — fallback Router02`);
    }
  }

  // ── WETH / ERC20 input legs ──
  if (inErc && outErc) return swapRouter02(inErc, outErc, amountIn, (await quoteV3Best(inErc, outErc, amountIn)).fee);

  // token → native (or WETH): sell to WETH then unwrap if native
  if (inErc && (outNative || outWeth)) {
    const sw = await swapRouter02(inErc, C.weth, amountIn, (await quoteV3Best(inErc, C.weth, amountIn)).fee);
    if (!outNative) return sw;
    if (sw.amountOut <= 0n) return sw;
    const wc = new ethers.Contract(C.weth, WETH_ABI, w);
    const before: bigint = await provider.getBalance(w.address);
    await waitTx(await wc.withdraw!(sw.amountOut, await overrides()), "ur-unwrap");
    const after: bigint = await provider.getBalance(w.address);
    return { tx: sw.tx, amountOut: after > before ? after - before : 0n };
  }

  // native (or WETH) → token: wrap native to WETH if needed, then Router02
  if ((inNative || inWeth) && outErc) {
    const wc = new ethers.Contract(C.weth, WETH_ABI, w);
    if (inNative) {
      const wbal: bigint = await wc.balanceOf!(w.address);
      if (wbal < amountIn) await waitTx(await wc.deposit!({ value: amountIn - wbal, ...(await overrides()) }), "ur-wrap");
    }
    return swapRouter02(C.weth, outErc, amountIn, (await quoteV3Best(C.weth, outErc, amountIn)).fee);
  }

  log.warn(`uniswapSwap: kombinasi tak didukung ${tokenIn} → ${tokenOut}`);
  return null;
}

/** Force-wait: tiny exported helper so callers can wait on the wrap/approve txs if needed. */
export const waitTxEx = waitTx;