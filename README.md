# Aminoid Spot — independent crypto dashboard

A standalone, browser-side crypto-market dashboard based on the executable indicator and scoring logic in the uploaded `Aminoid Alpha v26.json` workflow. This project is separate from n8n. It does not import signals from n8n and does not require an n8n account, trigger, webhook, Supabase, or database.

## Architecture

- **Spot market data:** Binance Spot public REST loads closed candles; Binance Spot WebSocket streams update candles, live prices, and best-bid/best-ask quantities.
- **Futures confirmation data:** Binance USDⓈ-M Futures public REST supplies the settled funding-rate history and current open interest for the same watchlist symbols. Funding refreshes every 5 minutes; open interest is sampled every 15 minutes.
- **Calculations:** all spot indicators, layer scores, gates, tiers, confidence adjustments, entry window, stop, and take-profit levels are computed in the visitor's browser. Futures data is only used by the original Layer 5 funding vote and open-interest confirmation.
- **Memory:** `localStorage` stores signal cooldown keys, signals visible for the current UTC day, short BTC-dominance sampling history, and one open-interest comparison baseline per symbol. Candle history stays in RAM and reloads from Binance. No database is used.
- **Signals:** generated only while the website is open in a browser. Without a server process or database, the dashboard does not keep scanning in the background while every browser is closed; different browsers/devices have separate cooldowns and signal lists.
- **UTC-day filter:** the Signals table only shows signals timestamped from 00:00 UTC on the current UTC calendar day to the present. The visible list drops older signals at the next UTC midnight. Cooldown keys are retained separately for up to 48 hours so a UTC-day boundary does not reset a one-hour cooldown.
- **Telegram:** optional, using the included Vercel serverless endpoint. The bot token and chat ID are environment variables and are not exposed to browser JavaScript. No signal history is stored by the endpoint.

## Spot-first, Futures-confirmed data design

The website is fully independent of the Aminoid n8n workflow. It does not call n8n, use an n8n trigger, or rely on its 20-minute schedule. The chart and all candle-derived indicators use Binance Spot. For the original fifth layer only, the website requests public USDⓈ-M Futures funding history (`/fapi/v1/fundingRate`) and current open interest (`/fapi/v1/openInterest`). These are public market-data endpoints and do not require an API key. See the [official Binance USDⓈ-M Futures market-data documentation](https://developers.binance.info/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data).

- **Funding rate:** the latest returned settled funding-rate value is used. The previous three funding records are also summed for display context. The original thresholds are retained: below −0.0001 is a LONG vote; above +0.0001 is a SHORT vote; otherwise neutral. A missing or unsupported futures feed stays unavailable and is never reported as a zero rate.
- **Open interest:** the current value is sampled every 15 minutes. The prior sample is stored in browser-local memory. The comparison is only made when the prior sample is 14–30 minutes old, so a manual page refresh cannot continually reset the baseline. A rise greater than 1% adds the original +0.5 confirmation bonus only if the latest closed 4H **Spot** candle is higher than its predecessor. An OI rise while the 4H close is not rising, a decline in OI, a move of 1% or less, or an out-of-window sample adds no bonus. After a long gap, the first new value resets the baseline rather than comparing stale observations.
- **Spot order-book imbalance and spot-volume strength:** both are shown as informational context only. Neither replaces funding nor adds an original strategy score vote.
- **BTC dominance:** the dashboard reads the public global BTC-dominance figure from CoinGecko every five minutes and stores a short local sampling window to estimate the ~20-minute change. If this endpoint is unavailable, the veto is disabled and marked unavailable.

Market prices and indicators remain spot-based even though the fifth layer uses futures-specific context. A SHORT label is a bearish directional signal; this dashboard does not place futures or spot trades.

## Strategy rules represented

### Watchlist and candle intervals

The configured 15 symbols and tier assignments are carried over from `Set Watchlist` in the uploaded workflow: BTC, ETH, SOL, ZEC, NEAR, TAO, WLD, AAVE, LINK, PENDLE, INJ, UNI, AVAX, ARB, and HYPE, paired against USDT. Before loading data, the website checks current Binance Spot `exchangeInfo`; any pair that is not a currently tradable Spot USDT pair remains visible but is not scored. This avoids sending invalid requests for futures-only or unavailable symbols.

The dashboard loads closed 15-minute, 1-hour, and 4-hour Spot candles. It requests enough 4-hour history to calculate a real EMA 200. Indicators and signal decisions use confirmed/closed candles; the in-progress candle is drawn but is not used for scoring. The same 15-symbol USDT watchlist is requested from Futures endpoints where a matching USDⓈ-M contract exists; a missing contract only removes that particular futures input, not the spot chart.

### Layer 1 — Trend (4H)

- EMA 200 replaces EMA 180 (0.5 raw point; above = LONG, otherwise SHORT).
- Supertrend uses ATR period 10, multiplier 2.5, source `(high + low) / 2` (0.5 raw point).
- MACD histogram: rising or falling for the latest three confirmed values.
- Market structure: higher high + higher low, or lower high + lower low, over the 30-candle lookback.
- ADX > 25 is a non-directional confirmation bonus, not a directional vote.

### Layer 2 — Reversal

- RSI 14: below 30 votes LONG; above 70 votes SHORT.
- RSI divergence from the last 30 aligned RSI/candle pairs using 3-bar swing pivots.
- Bollinger (20, 2) squeeze touch/bounce.
- Hammer / bullish engulfing / shooting star / bearish engulfing candle pattern.
- Price within 0.8% of a recent 4H support or resistance level.

**Executable-code detail:** the source node's RSI, divergence, and candle pattern calculations use 1H candles, but its Bollinger bands and S/R scoring are calculated from 4H candles despite the layer comments describing the layer as 1H. This implementation follows those executable calculations rather than silently changing the timeframe to match the comments.

### Layer 3 — Momentum

- 1H volume surge: current confirmed volume divided by the preceding 20-bar mean is at least 1.8; candle direction determines the vote.
- 1H MACD histogram: two consecutive rises or falls (latest three histogram values).
- 1H Stochastic RSI cross with the workflow's overbought/oversold conditions.
- VWAP anchored to the current UTC day (fallback: last 24 1H bars); vote LONG above +0.3%, SHORT below −0.3%.
- 4H ATR-14 expansion over three consecutive ATR values is a non-directional confirmation bonus.

### Layer 4 — Entry timing (15M)

- Three-bar momentum: confirmed close clears all three previous highs/lows.
- RSI-7 crosses up through 30 or down through 70.
- Candle body/range is at least 70%, with candle direction determining the vote.
- Three consecutive green or red confirmed candles.

### Layer 5 — Futures microstructure (applied to spot signals)

- USDⓈ-M Futures funding rate: below −0.0001 votes LONG; above +0.0001 votes SHORT; between those thresholds is neutral.
- USDⓈ-M Futures open interest: when the sample increases by more than 1% over a comparable ~15-minute interval and the last closed 4H Spot close is higher than its predecessor, add a +0.5 non-directional confirmation bonus to the currently leading side. Other OI conditions add no bonus.
- Spot order-book imbalance and spot-volume strength remain informational only; they do not change scores.

### Context, scoring and gates

- Relative strength vs BTC: the coin's 12-hour change minus BTC's 12-hour change; more than +2 percentage points adds 1 raw point to LONG, less than −2 adds 1 raw point to SHORT.
- BTC shock: absolute BTC 2-hour close-to-close move above 4%; the workflow's confidence reduction is retained.
- BTC dominance veto: if BTC dominance rises by more than 0.3 percentage points over about 20 minutes, Tier 2/3 LONG setups lose 2 raw points.
- Each directional layer vote uses the original 0.5 raw-point weight. Relative strength vs BTC remains 1.0 raw point (an additional scoring context factor). ADX, ATR expansion, and qualifying futures open-interest increase can each add a 0.5 non-directional confirmation bonus to the currently leading side.
- The theoretical raw maximum is 11.5 after adding Supertrend. Display score is `adjusted raw total / 11.5 × 100`. Therefore a normal 0.5-point indicator contributes 4.3478 displayed points, and the 1.0-point RS-BTC factor contributes 8.6957. This normalizes the scale while preserving the strategy's existing relative weights; assigning 8.6956 to every indicator equally would change all relative weights and would not follow the original scoring logic.
- Base score gate: adjusted raw total ≥ 3.3.
- A signal must qualify through the original trend route (at least one winning L3 momentum hit) **or** reversal route (winning RSI divergence + one S/R/BB/RSI-extreme cue + a Stoch/RSI-7 trigger).
- At least 3 of 5 layers must contribute on the winning side; at most 3 losing-side hits may disagree.
- Strength tiers are retained from the executable score code: Tier A ≥ 5.0, Tier B ≥ 4.3, Tier C ≥ 3.8, otherwise Tier D. The confidence formula keeps its adjustments and 45–92 clamp, but its normalization denominator is 11.5 rather than the old 11.0.
- Futures leverage recommendations are intentionally omitted: this website uses Spot data and does not place trades. LONG/SHORT are directional signal labels; a SHORT signal is not itself a spot short-sale mechanism.

### Cooldown and duplicate suppression

The app reproduces the purpose of the workflow's price-aware cooldown in browser-local memory:

- Same symbol and direction: suppress repeats for one hour.
- After one hour, a new signal is allowed only if spot price moved by at least `max(TP1-distance percentage × 0.6, 1.5%)` since the last emitted signal.
- One emitted signal per symbol per 15-minute cycle bucket.
- Cooldown state is updated only when a signal is actually accepted/emitted. The executable n8n code updates its timestamp before downstream duplicate suppression, which can continually restart the cooldown while the same gate stays true; this client implementation avoids that ordering problem so the price-aware cooldown described in the node comments works as intended.

## Run locally

Requires Python 3 (no npm install or third-party frontend dependencies are required).

- Windows: double-click `run_local.bat`.
- macOS/Linux: run `./run_local.sh`.
- Open `http://localhost:5173`.

Do not double-click `index.html` directly: browser module and API CORS behavior requires a local HTTP server.

## Deploy as a website

1. Create a GitHub repository and upload this folder's contents (keep `index.html` at repository root).
2. Import the repository in Vercel. Use the **Other** framework preset; no frontend build command or output directory is required for the static files.
3. For optional Telegram delivery, add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as Vercel environment variables. Set `APP_ORIGIN` to the exact deployed origin (for example, `https://your-project.vercel.app`) for an extra origin check. Never add the bot token to any frontend file.
4. Redeploy after environment variables are set.

`api/telegram.js` sends alerts only; it has no database and does not persist market data or signal history. Serverless in-memory rate limiting is best-effort and may reset between instances.

## Tests

Run `npm test` (Node.js 18+ recommended). No npm dependencies are required.

## Limitations

- This is a standalone first implementation of the stated indicator engine and dashboard, not a pixel-perfect fork of the separate `Trading-AI` repository. Its optional AI analyst, paper trading, accuracy-report database, forex/stocks/commodities, and next-candle forecasting features are not included because this request specifies a crypto-only, database-free website.
- Without a backend scheduler or database, scans occur only while a browser instance is open. Signal history and cooldown are per browser profile/device.
- Public exchange APIs can be rate-limited or unavailable. The UI marks unavailable spot pairs/futures inputs instead of inventing indicator values. On first launch, OI only establishes a baseline; its confirmation can be evaluated after a comparable sample interval.
- Browser-local memory is per browser profile/device. Clearing browser storage resets cooldowns, visible signal history, and OI baselines. The website only generates signals while an open browser session is running.
- This is software for market analysis, not financial advice and not a guarantee of profitable signals.
