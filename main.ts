// BTC Race 24h — "Deep-dip swing + micro-scalp" bot (btc-race-24h-20261117-0603)
//
// Long-only scalping bot for cbBTC/USDC 1-minute bars, protocol agent-fun/bars-replay/v1.
// Two sleeves share the single allowed position:
//
//   SWING — buys a deep drawdown: close >= 1.2% below the 360-bar (6h) high AND the
//           bar closed up (bounce confirmation). Size 50% of cash. Exits at +2.0% take
//           profit, a 0.5% trailing stop off the best close since entry, or a 0.5% hard stop.
//   SCALP — buys a shallow dip: close >= 0.12% below the 20-bar average AND the bar
//           closed up. Size 10% of cash. Exits at +0.6% take profit, a 0.2% trailing
//           stop, or a 0.2% hard stop.
//
// Why this shape: the dev window's 1-minute noise is ~0.06% per bar while a full-size
// round trip costs ~26-37 bps in fee + slippage + pool impact, so tight scalps alone
// bleed out and rare deep-dip buys alone never trade. The swing sleeve banks the rare
// 1-2% recoveries; the scalp sleeve keeps the bot trading (20+ trades) through flat
// stretches at small size, where impact is only ~1-3 bps a side. Everything is
// deterministic: no clock, no environment, no unseeded randomness — every decision is
// a pure function of the bars seen so far.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

// --- strategy parameters (fractions, not percent) ---
const SWING_DD = 0.012; // swing entry: drawdown from the 360-bar high
const SWING_SIZE_NUM = 50; // swing size: 50% of cash
const SWING_SIZE_DEN = 100;
const SWING_TP = 0.02; // swing take profit
const SWING_TRAIL = 0.005; // swing trailing stop off best close since entry
const SWING_SL = 0.005; // swing hard stop
const SCALP_DIP = 0.0012; // scalp entry: dip below the 20-bar average
const SCALP_SIZE_NUM = 10; // scalp size: 10% of cash
const SCALP_SIZE_DEN = 100;
const SCALP_TP = 0.006; // scalp take profit
const SCALP_TRAIL = 0.002; // scalp trailing stop
const SCALP_SL = 0.002; // scalp hard stop
const SMA_LEN = 20; // scalp reference average length (bars)
const HIGH_LEN = 360; // swing reference high lookback (bars)
const MAX_SLIPPAGE_BPS = 200; // 2%: fills move ~2 bps slip + ~1-13 bps impact
const MIN_BUY_USDC = 2_000_000n; // never send a buy under 2 USDC (dust guard)

// Prices arrive at price_scale 5 (raw = USD * 1e5).
const PRICE_SCALE = 100000;

type Mode = 'swing' | 'scalp';

// Rolling close history (USD, floats — deterministic: same input, same output).
const closes: number[] = [];
let entryPrice = 0; // fill price of the open position (USD)
let peakClose = 0; // best close since entry (USD)
let mode: Mode | null = null; // which sleeve opened the current position
let pendingBuyId: string | null = null; // client id of a buy awaiting its fill
let pendingMode: Mode | null = null;
let orderSeq = 1;

function averageLast(n: number): number {
  const start = closes.length - n > 0 ? closes.length - n : 0;
  let sum = 0;
  for (let i = start; i < closes.length; i++) sum += closes[i];
  return sum / (closes.length - start);
}

function highLast(n: number): number {
  const start = closes.length - n > 0 ? closes.length - n : 0;
  let hi = 0;
  for (let i = start; i < closes.length; i++) if (closes[i] > hi) hi = closes[i];
  return hi;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // 1) Fold in this batch's fills first: learn the fill price of our open position.
    for (const fill of batch.fills) {
      if (fill.client_id === pendingBuyId) {
        if (fill.status === 'filled') {
          entryPrice = Number(fill.price) / PRICE_SCALE;
          peakClose = entryPrice;
          mode = pendingMode;
        }
        pendingBuyId = null;
        pendingMode = null;
      }
    }

    // 2) Record this bar's close. One symbol (CBBTC) in this competition.
    const bar = batch.bars[0];
    if (bar === undefined) return [];
    const close = Number(bar.c) / PRICE_SCALE;
    closes.push(close);
    if (closes.length > HIGH_LEN + 1) closes.shift();

    // Never trade during warm-up; never trade while an order is still unfilled.
    if (state.warmingUp || pendingBuyId !== null) return [];

    const pos = state.positions.get('CBBTC');
    const heldQty = pos === undefined ? 0n : pos.qty;

    // 3) Flat: look for an entry. Swing first (deeper signal wins the single slot).
    if (heldQty === 0n) {
      mode = null;
      if (closes.length < 2) return [];
      const bounce = close > closes[closes.length - 2];
      if (!bounce) return [];

      const hi360 = closes.length >= HIGH_LEN ? highLast(HIGH_LEN) : 0;
      if (hi360 > 0 && (hi360 - close) / hi360 >= SWING_DD) {
        const notional = (state.cash * BigInt(SWING_SIZE_NUM)) / BigInt(SWING_SIZE_DEN);
        if (notional < MIN_BUY_USDC) return [];
        pendingBuyId = `sw${orderSeq}`;
        pendingMode = 'swing';
        orderSeq++;
        return [{ side: 'buy', symbol: 'CBBTC', notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: pendingBuyId }];
      }

      if (closes.length >= SMA_LEN) {
        const avg = averageLast(SMA_LEN);
        if ((avg - close) / avg >= SCALP_DIP) {
          const notional = (state.cash * BigInt(SCALP_SIZE_NUM)) / BigInt(SCALP_SIZE_DEN);
          if (notional < MIN_BUY_USDC) return [];
          pendingBuyId = `sc${orderSeq}`;
          pendingMode = 'scalp';
          orderSeq++;
          return [{ side: 'buy', symbol: 'CBBTC', notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: pendingBuyId }];
        }
      }
      return [];
    }

    // 4) Holding: update the trailing peak, then check exits for this sleeve.
    // Fallback: if the buy's fill was never observed (e.g. it landed on a batch with
    // no bar for our symbol), derive the entry price from the position's cost basis
    // instead of holding blindly until the final flatten.
    if ((entryPrice <= 0 || mode === null) && pos !== undefined) {
      const qtyNum = Number(pos.qty);
      if (qtyNum > 0) {
        // value = qty * price / 1e7 (qty_scale 8, price_scale 5, quote_scale 6);
        // cost_quote_units is the value at the fill price, fee included.
        entryPrice = (Number(pos.cost_quote_units) * 1e7) / qtyNum / PRICE_SCALE;
        peakClose = Math.max(peakClose, entryPrice);
        if (mode === null) mode = 'scalp';
      }
    }
    if (entryPrice <= 0 || mode === null) return [];
    if (close > peakClose) peakClose = close;
    const tp = mode === 'swing' ? SWING_TP : SCALP_TP;
    const trail = mode === 'swing' ? SWING_TRAIL : SCALP_TRAIL;
    const sl = mode === 'swing' ? SWING_SL : SCALP_SL;
    const takeProfit = close >= entryPrice * (1 + tp);
    const trailedOut = close <= peakClose * (1 - trail);
    const stoppedOut = close <= entryPrice * (1 - sl);
    if (takeProfit || trailedOut || stoppedOut) {
      const id = `x${orderSeq}`;
      orderSeq++;
      return [{ side: 'sell', symbol: 'CBBTC', qty: heldQty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id }];
    }
    return [];
  },
});
