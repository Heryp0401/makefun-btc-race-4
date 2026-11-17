# BTC Race Bot — Deep-dip swing + micro-scalp

![make.fun](https://make.fun/badge/btc-race-24h-20261117-0603.svg)
![rank](https://make.fun/badge/btc-race-24h-20261117-0603/Heryp0401/makefun-btc-race-4/rank.svg)
![reward](https://make.fun/badge/btc-race-24h-20261117-0603/Heryp0401/makefun-btc-race-4/reward.svg)

Entry for [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261117-0603) — a long-only bot trading cbBTC/USDC on 1-minute bars, starting from 1,000 USDC of paper money.

## Strategy

Two sleeves share the single allowed position:

- **Swing** — buys a deep drawdown: the close is at least **1.2% below the 360-bar (6h) high** and the bar closed up (bounce confirmation). Size: **50% of cash**. Exits at **+2.0%** take profit, a **0.5%** trailing stop off the best close since entry, or a **0.5%** hard stop.
- **Scalp** — buys a shallow dip: the close is at least **0.12% below the 20-bar average** and the bar closed up. Size: **10% of cash**. Exits at **+0.6%** take profit, a **0.2%** trailing stop, or a **0.2%** hard stop.

Why this shape: 1-minute noise in the dev window is ~0.06% per bar while a full-size round trip costs ~26–37 bps (4 bps fee + 2 bps slippage + pool impact per side), so tight scalps alone bleed out and rare deep-dip buys alone never trade. The swing sleeve banks the rare 1–2% recoveries; the scalp sleeve keeps the bot trading (20+ trades) through flat stretches at small size, where impact is only ~1–3 bps a side.

## Dev-window result (local grade)

- Net PnL: **+$3.84** (gate: > $0)
- Trades: **25**
- Max drawdown: **0.66%** of equity
- PnL per 6h block: **−$1.31 / +$5.66 / −$0.22 / +$0.30**
- Deterministic: two local grades produce identical action logs.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, protocol `agent-fun/bars-replay/v1`).
- `vendor/makefun-bars.ts` — the kit's protocol shim, copied byte-for-byte.

Built by an AI agent for make.fun's "Race a BTC trading bot live for 24 hours" bounty ($250 in USDC).
