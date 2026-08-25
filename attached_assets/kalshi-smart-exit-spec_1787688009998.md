# Smart Exit System for 15-Minute Kalshi Binary Markets
### Technical Spec — hand this directly to your AI coder

---

## 1. The core reframe

Do **not** build a price stop-loss. Build a **probability stop-loss**.

A 15-minute Kalshi market is a digital (binary) option on the underlying (BTC, WTI, gold, silver, etc.) finishing above/below a strike `K` at expiry. The market price of the Kalshi contract is already the crowd's estimate of that probability. Your job is not to react to the underlying's price — it's to track how the *win probability* is evolving, and only exit when that decline is (a) large enough given time left, and (b) confirmed by real order flow, not noise.

This single reframe solves your "sells when it shouldn't" problem, because it makes tolerance for a pullback automatically scale with how much time is left to recover.

---

## 2. Data feeds required

| Feed | Purpose | Source |
|---|---|---|
| Underlying tick/trade stream | price, volume, aggressor side (buy/sell) | Binance/Coinbase WS for crypto; a futures tick feed (e.g. Databento, CME market data, or broker API) for WTI/gold/silver — free crypto feeds are easy, commodities usually need a paid feed |
| Underlying order book (L2) | bid/ask depth at top N levels | Same exchange/feed as above |
| Kalshi market data | your own position, current YES/NO price, strike, time-to-expiry | Kalshi API |

You need the **underlying's** order book and tape, not Kalshi's contract order book — Kalshi's book just reflects the same probability you're already trying to estimate, with less signal and less liquidity.

---

## 3. Core formulas — translating "chart reading" into numbers

**Distance to target (normalized):**
```
distance = S - K            # S = current underlying price, K = strike
```

**Realized volatility (per-minute), rolling window (e.g. last 5–10 min of 1s or 5s bars):**
```
returns = log(price[i] / price[i-1])
sigma_per_min = stdev(returns) * sqrt(bars_per_minute)
```

**Model-implied win probability** (random-walk / digital-option approximation — this is the key formula):
```
sigma_window = sigma_per_min * sqrt(T_remaining_minutes)
z = distance / sigma_window
P_win = NormalCDF(z)        # flip sign depending on whether you hold YES (above) or NO (below)
```
This is the same math behind Black-Scholes digital option pricing, simplified to a driftless random walk — appropriate for 15-min windows where drift is negligible relative to noise.

**Edge decay (your actual signal):**
```
edge_now   = P_win(now)
edge_entry = P_win(at entry)   # recompute at entry using entry price/time, or just use your fill probability
delta_P    = edge_now - edge_entry
```
`delta_P` going meaningfully negative is your real "something's wrong" signal — far more meaningful than "price moved $X."

**Momentum (short-term trend velocity):**
```
momentum = EMA_fast(price) - EMA_slow(price)     # e.g. 10s EMA vs 60s EMA
momentum_z = momentum / sigma_per_min             # normalize by current volatility
```

**Order flow imbalance (trade tape, trailing N seconds):**
```
flow_imbalance = (buy_volume - sell_volume) / (buy_volume + sell_volume)   # range -1 to +1
```

**Order book imbalance (top N levels, live snapshot):**
```
book_imbalance = (bid_depth - ask_depth) / (bid_depth + ask_depth)        # range -1 to +1
```

**Continuation score** (is the adverse move likely to keep going, or is it noise?):
```
continuation = w1*momentum_z + w2*flow_imbalance + w3*book_imbalance
```
Sign-align all three to "moving against your position" before summing. Start with equal weights (0.34/0.33/0.33) and tune via backtest.

---

## 4. Decision engine

Run this on every tick (or every 1–2 seconds):

```
threshold(T_remaining) = base_threshold * sqrt(T_remaining / T_total)
```
This is the important part: **threshold shrinks as time runs out.** Early in the window you tolerate a big probability dip because there's time to revert. In the last 60–90 seconds, even a small dip should trigger exit because there's no time left to recover. Tune `base_threshold` in backtest (start around 0.15–0.20, i.e. a 15–20 point probability drop tolerated with a full window remaining).

```
IF delta_P < -threshold(T_remaining):
    IF continuation_score exceeds confirmation_level 
       AND this has held for K consecutive samples (debounce, e.g. 3 reads over 3–6 sec):
           → EXIT
    ELSE:
           → HOLD (the dip isn't confirmed — likely noise/wick)

ALSO, independent of the above (catastrophic override):
IF delta_P drops more than -hard_stop_threshold within a very short window (e.g. -0.30 within 5 sec):
    → EXIT IMMEDIATELY, no confirmation needed (protects against real gaps/news shocks)
```

The debounce + continuation confirmation is what stops the bot from selling on a single wick that reverts a second later — which is the exact failure mode you described.

Add hysteresis: once you decide HOLD, don't re-evaluate an exit for at least a few seconds even if the raw numbers flicker, to avoid thrashing.

---

## 5. Parameters to expose and tune

- `base_threshold` — probability-drop tolerance at full time remaining
- `hard_stop_threshold` and its time window — catastrophic override
- `confirmation_level` — how strong continuation score must be
- `debounce_count` / debounce window (seconds)
- EMA fast/slow windows for momentum
- Order flow / book imbalance lookback window
- Weights `w1, w2, w3` in continuation score

None of these should be hardcoded guesses — they need to come out of backtesting against your logged tick data before going live.

---

## 6. Backtest plan (do this before touching real trades)

1. Log raw tick + order book + trade tape data for every market you trade, continuously, even while just running your current bot manually.
2. Replay historical sessions through the decision engine with different parameter sets.
3. Score each parameter set on: average loss size on losing trades, win rate, and total P&L — not just win rate alone, since your problem is loss *magnitude*, not frequency.
4. Only promote a parameter set to live trading once it demonstrably reduces average loss size without materially cutting win rate.

---

## 7. Pseudocode skeleton

```python
def on_tick(state):
    S, T_remaining = get_underlying_price(), get_time_remaining()
    sigma = rolling_vol(state.price_history)
    P_now = norm_cdf((S - state.K) / (sigma * sqrt(T_remaining)))
    delta_P = P_now - state.P_entry

    momentum_z = ema_fast(state) - ema_slow(state)
    flow_imb = trade_tape_imbalance(state.tape_window)
    book_imb = order_book_imbalance(state.book_snapshot)
    continuation = w1*momentum_z + w2*flow_imb + w3*book_imb

    threshold = base_threshold * sqrt(T_remaining / T_total)

    if delta_P < -hard_stop_threshold and fast_drop(state):
        return EXIT("hard stop")

    if delta_P < -threshold:
        state.dip_streak += 1
        if continuation_confirmed(continuation) and state.dip_streak >= debounce_count:
            return EXIT("confirmed adverse momentum")
        else:
            return HOLD("unconfirmed dip")
    else:
        state.dip_streak = 0
        return HOLD("within tolerance")
```

---

## 8. One caveat worth stating plainly

This isn't financial advice, and the formulas above (especially the driftless random-walk probability model) are a reasonable starting approximation, not a guarantee — real markets have fat tails and occasional drift that a simple normal-CDF model won't capture. Treat parameter values as things to be discovered from your own logged data, not numbers to trust out of the box.
