# Services Contract (verified 2026-04-25)

Verified by reading the four files directly in
`trading-bot/backend/app/services/`. Method signatures, return shapes, and
known gaps are recorded here so the snapshot pipeline can call them without
guessing.

## RegimeMatcherService

**File:** `app/services/regime_matcher.py`
**Singleton:** `regime_matcher_service = RegimeMatcherService()` (module bottom)

### Public surface (RegimeMatcherService)

- `compute_fingerprint(candles: list[Candle]) -> list[float]`
  - Returns a 6-element list of raw (unnormalized) feature values, in this
    fixed order (matches `RegimeFingerprint.FEATURE_NAMES`):
    1. `rsi_14` — 14-day RSI
    2. `atr_pct` — 14-day ATR / last close
    3. `bb_width` — Bollinger Band width: `(upper - lower) / middle`,
       length 20, std 2
    4. `macd_histogram` — MACD histogram (12/26/9) normalized by last close
    5. `sma_ratio` — 20-day SMA / 50-day SMA
    6. `realized_vol` — std of last 20 daily returns, annualized (`* sqrt(252)`)
  - Requires `len(candles) >= 60`, else raises `ValueError`.
  - Pure function — does not call out to any other service.
- `find_similar_periods(current_fingerprint, historical_candles, window_size=60, top_n=5, similarity_threshold=0.8) -> list[tuple[str, str, float]]`
  - Returns up to `top_n` `(start_date_iso, end_date_iso, cosine_similarity)`
    tuples. Used for regime-matched backtest selection, not for labeling.

### Helper (also defined)

- `RegimeFingerprint` — namespace class. Only exposes class attributes
  `FEATURE_NAMES: list[str]` and `NUM_FEATURES: int = 6`. No methods.

### Private (do not rely on from outside)

- `_candles_to_df(candles)` — DataFrame builder
- `_compute_fingerprint_from_df(df)` — internal sliding-window variant that
  returns `None` on insufficient data
- `_cosine_similarity(a, b)` — internal scoring

### For the snapshot pipeline

- **Recommended call:** `regime_matcher_service.compute_fingerprint(candles)`
  using SPY (or chosen benchmark) candles ending on the snapshot date.
  Requires at least 60 prior daily candles in the slice.
- **Adapter needed:** **Yes.** No public `regime_label` method exists. The
  service returns a 6-vector, never a string label.
- **regime_label derivation (proposed adapter):** classify on a small set of
  the 6 features. A workable heuristic the snapshot builder can own:
  - Risk-On: `realized_vol < 0.15` AND `sma_ratio > 1.0` AND `macd_histogram > 0`
  - Risk-Off: `realized_vol > 0.25` OR (`sma_ratio < 0.98` AND `rsi_14 < 45`)
  - Mixed: everything else
  Thresholds are illustrative — calibrate against historical SPY periods
  before treating these as canonical. Store both the raw 6-vector and the
  derived label in the snapshot so the label can be re-derived later
  without reloading candles.

## CalendarService

**File:** `app/services/calendar_service.py`
**Singleton:** `calendar_service = CalendarService()`
**Underlying provider:** `InvestingCalendarProvider` (Finnhub-backed; macro
events only — see `app/services/calendar_providers/investing_provider.py`)

### Public surface (CalendarService)

- `async get_relevant_events(symbol: str, days: int = 7, min_relevance: float = 0.5) -> RelevanceResponse`
  - Filters macro events (FOMC / CPI / NFP / GDP / etc.) by sector relevance
    for the symbol. Looks ahead `days` from `date.today()`.
- `async get_enhanced_context(symbol: str, days: int = 7) -> CalendarContextResponse`
  - LLM-formatted text block describing upcoming relevant macro events.
- `async get_enhanced_attribution(symbol: str = "SPY", days: int = 14) -> EnhancedAttributionResponse`
  - Volatility-on-event-days regime score (`macro_driven` /
    `fundamentals_driven` / `mixed`). Not the same construct as
    `RegimeMatcherService`.
- `async close() -> None` — closes underlying httpx client.

### What's missing for the snapshot pipeline

- **No `earnings_in_n_days`.** `CalendarService` exclusively serves macro
  events from Finnhub's economic calendar. Even though
  `EconomicEvent.event_type` is `Literal["macro", "earnings", "dividend",
  "options_expiry"]`, `InvestingCalendarProvider` never produces anything
  but `macro` events. Closest building block in this file: `_get_provider()`
  returns events between two dates, but they are all macro.
- **No `earnings_surprise_last`.** Neither this service nor the provider
  has surprise data. yfinance (used elsewhere) does expose
  `Ticker.earnings_dates` (next/prior earnings dates with surprise %), but
  that is not wired through any service today.
- **No per-ticker calendar query.** `get_relevant_events` takes a ticker
  but uses it only to look up sector relevance — the underlying event list
  is market-wide.

### For the snapshot pipeline

- **Recommended call:** none directly — for `earnings_in_n_days` and
  `earnings_surprise_last`, this service does not help.
- **Adapter needed:** **Yes — substantial.** Build an
  `EarningsCalendarProvider` (suggested home:
  `app/services/calendar_providers/yfinance_earnings_provider.py`) that
  wraps `yf.Ticker(symbol).earnings_dates` and:
  - Returns calendar-day distance from `as_of_date` to the next future
    earnings date in `earnings_dates.index`. Return `None` if the next
    date is `>90` days out or unavailable.
  - Returns the surprise % from the most recent past row of
    `earnings_dates` (column `Surprise(%)`). Return `None` if that column
    is missing or NaN.
  - Cache aggressively (per-ticker, 24h TTL) — yfinance is rate-limited.
- **regime_label derivation:** N/A for this service.

## FundamentalsService

**File:** `app/services/fundamentals_service.py`
**Singleton:** `fundamentals_service = FundamentalsService()`

### Public surface (FundamentalsService)

- `async get_fundamentals(symbol: str) -> FundamentalsData`
  - Cache-first; fetches yfinance `Ticker.info` on miss.
- `async get_fundamentals_batch(symbols: list[str]) -> dict[str, FundamentalsData]`
  - Concurrent batch wrapper around `get_fundamentals`. Failed symbols
    are dropped silently (warning logged).
- `async refresh_fundamentals(symbol: str) -> FundamentalsData` — bypass cache.
- `async close() -> None` — shuts down internal `ThreadPoolExecutor`.

### What `FundamentalsData` actually contains

Verified against `app/models/fundamentals.py`. All fields are
`float | None`:

- **valuation:** `pe_ratio`, `pb_ratio`, `ps_ratio`, `peg_ratio`, `ev_ebitda`
- **growth:** `revenue_growth`, `eps_growth`, `earnings_growth`
- **profitability:** `gross_margin`, `operating_margin`, `net_margin`,
  `roe`, `roa`
- **health:** `current_ratio`, `debt_to_equity`, `interest_coverage`
  (always `None` — yfinance doesn't provide it)
- **dividends:** `dividend_yield`, `payout_ratio`

### Notable gaps for the snapshot pipeline

- **No `market_cap`.** yfinance's `info` dict has `marketCap`, but
  `_fetch_from_yfinance` does not extract it.
- **No `sector` / `industry`.** Same situation — yfinance has
  `info["sector"]` and `info["industry"]`, but neither is captured.
  `CalendarService.SECTOR_MAP` is a hardcoded dict for ~50 large caps and
  is a separate, unrelated lookup.
- PE: present (`valuation.pe_ratio`, trailing).
- Dividend yield: present (`dividends.dividend_yield`, decimal form,
  e.g. `0.015` = 1.5%).

### For the snapshot pipeline

- **Recommended call:** `await fundamentals_service.get_fundamentals(symbol)`
  if/when fundamentals enter v2 snapshots. For v1, skip — the plan
  acknowledges fundamentals are optional.
- **Adapter needed:** **Partial.** If snapshots ever need market cap or
  sector, extend `_fetch_from_yfinance` (and `FundamentalsData`) to pull
  `marketCap`, `sector`, `industry` from `Ticker.info`. Cheap to do but
  requires a schema change and migration on `FundamentalsCache`.
- **regime_label derivation:** N/A for this service.

## MultiTimeframe

**File:** `app/services/multi_timeframe.py`
**Singleton:** `multi_timeframe_service = MultiTimeframeService()`
(implemented as a module-level singleton via `__new__` override)

### Public surface (MultiTimeframeService)

- `async analyze(symbol: str) -> ConfluenceResult`
  - Runs `technical_analysis_service.analyze` on 4H, daily, weekly, monthly
    candle slices for `symbol`, then aggregates.
  - Returns a `ConfluenceResult` containing:
    - `timeframes: list[TimeframeSignal]` — one entry per timeframe with
      `direction in {"bullish", "bearish", "neutral"}`, `strength: float`,
      `key_indicators: dict[str, str]`
    - `confluence_score: float` — weighted 0–100 score
    - `bias: str` — `"bullish" | "bearish" | "neutral"`
    - `alignment_pct: float` — **this is the field you want**
    - `key_levels: list[KeyLevel]` (top 20 by strength)
    - `conflicts: list[str]` — readable strings like
      `"daily (bullish) vs weekly (bearish)"`
  - 15-minute in-process cache (`CACHE_TTL_SECONDS = 900`).

### How `alignment_pct` is computed

From `_calculate_alignment` (lines 231–245):

- Filters `signals` to non-neutral entries.
- If all four are neutral, returns `50.0`.
- Otherwise: `dominant_direction_count / total_signal_count * 100`,
  where dominant is whichever of bullish/bearish has more signals.
- **Important:** this is NOT a directional %. It's an "agreement strength"
  number. 100 means all 4 timeframes agree on a single direction
  (bullish OR bearish). 50 means split. The `bias` field on the same
  result tells you which side is dominant.

### Private helpers (in case they're useful later)

- `_analyze_timeframe(symbol, tf_name)` — single-timeframe worker; pulls
  candles + runs `technical_analysis_service.analyze`.
- `_calculate_confluence_score(signals)` — weighted 0–100 score.
- `_determine_bias(signals)` — `"bullish" | "bearish" | "neutral"`.
- `_calculate_alignment(signals)` — described above.
- `_detect_conflicts(signals)` — opposing-direction pairs as strings.

### For the snapshot pipeline

- **Recommended call:** `result = await multi_timeframe_service.analyze(symbol)`
  then read `result.alignment_pct` (and `result.bias` if you want
  direction). Cache hit will be in-memory, but only during the same
  process lifetime.
- **Adapter needed:** **Minimal.** The plan column `mtf_alignment_pct`
  maps directly to `result.alignment_pct`. Persist `result.bias`
  alongside it so you can reconstruct "60% aligned bullish" later.
- **regime_label derivation:** N/A for this service.

## Cross-cutting notes

- All four services use module-level singletons. Snapshot builders should
  import the singleton, not instantiate the class.
- Three of four expose async methods (`CalendarService`,
  `FundamentalsService`, `MultiTimeframeService`). Only
  `RegimeMatcherService` is fully synchronous.
- None of the four services accept a historical `as_of_date`. They
  operate on "now" or on whatever candles you pass in.
  - `RegimeMatcherService.compute_fingerprint` is the only one that
    cleanly supports historical snapshots via candle injection.
  - `MultiTimeframeService.analyze` always pulls live candles via
    `market_data_service.get_candles(end_date=now)`.
  - `CalendarService` uses `date.today()` as the anchor for upcoming
    events.
  - `FundamentalsService` is point-in-time-now (yfinance trailing data).
- For backfill snapshots before today, `MultiTimeframeService` and
  `CalendarService` will need parameter additions (or a parallel
  point-in-time builder), not just adapters.
