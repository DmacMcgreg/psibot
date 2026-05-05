# S21 Research Summary: Signal Source Implementation Roadmap

**Date:** April 24, 2026, 1:00 PM ET
**Session:** 21
**Task:** Task B - S20 Follow-up (Signal Source Integration)
**Regime:** Mixed 50% (transitional, down from Macro-Driven 93%)

---

## Executive Summary

S21 delivers a **concrete implementation roadmap** for the three high-value replacement signal sources identified in S20. The primary recommendation: **Start with Unusual Whales options flow (Phase 1)**. This single source replacement should eliminate 60% of false-positive clusters by providing real-time institutional conviction data instead of 26-day-lagged congressional hindsight.

---

## Signal Clusters Summary (Last 24h)

### LONG CLUSTERS (9 tickers)

1. **QQQ** — 3 sources (reddit-stocks, reddit-investing, wsb), strength 0.083 (STRONGEST)
2. **PLTR** — 3 sources (reddit-options, reddit-investing, reddit-stocks), strength 0.00007 (WEAK)
3. **MSFT** — 2 sources (wsb, reddit-stocks), strength 0.375 (STRONG — **DECLINING** from 0.414)
4. **TSLA** — 2 sources (reddit-options, wsb), strength 0.311 (STRONG)
5. **INTC** — 2 sources (wsb, reddit-options), strength 0.121 (NEW)
6. **MU** — 2 sources (reddit-options, wsb), strength 0.086
7. **NOW** — 2 sources (wsb, reddit-options), strength 0.077
8. **GOOGL** — 2 sources (reddit-stocks, wsb), strength 0.021
9. **AMD** — 2 sources (wsb, reddit-stocks), strength 0.003 (WEAK)

### SHORT CLUSTERS (2 tickers)

1. **KWEB** — 2 sources (reddit-investing, reddit-stocks), strength 0.008 (WEAK)
2. **QQQ** — 2 sources (reddit-options, wsb), strength 0.003 (WEAK - chop with long cluster)

### WATCHLIST TICKERS (48h)

- **GDX:** ZERO signals (6th consecutive session = signal void PERSISTS — **HIGHEST CONTRARIAN SETUP**)
- **MSFT:** 9 signals (several already acted_on=1 — Tier-B already entered)
- **AMT:** 2 pennystock signals (0.0001 strength — ignore)
- **WMT:** ZERO signals

### KEY CHANGES FROM S20

- **MSFT strength declining:** 0.414 → 0.375 (momentum fading — trail stop)
- **TSLA unchanged:** 0.311 (stable strength)
- **NEW:** PLTR appears (3 sources, very weak 0.00007 strength)
- **NEW:** INTC appears (0.121 strength)
- **NEW:** KWEB appears in short cluster (0.008 strength)
- **GDX void:** 6 sessions with ZERO signals (was 5 in S20)

### CRITICAL OBSERVATION

Only **3-4 sources active:** wsb, reddit-stocks, reddit-options, reddit-investing, reddit-pennystocks

**shadow-quiver** (congressional), **openinsider**, **finviz-analyst**, **shadow-tipranks**, **shadow-c2zulu**, **shadow-afterhour** = ALL INACTIVE (zero signals 7d)

---

## Research Findings: Concrete Implementation Roadmap

### 1. Unusual Whales Options Flow API ⭐⭐⭐⭐⭐

**What it provides:**
- Real-time unusual options activity (sweeps, blocks, large OTM orders)
- Dark pool print data (institutional order flow)
- Greek exposure analytics
- Volatility surface data

**Implementation:**

```typescript
// File: src/heartbeat/autonomy.ts
// Polls every 5 minutes during market hours (Mon-Fri, 9:30 AM - 4:00 PM ET)

async function pollUnusualWhales(): Promise<void> {
  const API_KEY = process.env.UNUSUAL_WHALES_API_KEY;
  const BASE_URL = 'https://api.unusualwhales.com';

  const flowResponse = await fetch(`${BASE_URL}/v2/flow/alerts`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });
  const flowData = await flowResponse.json();

  // Filter for high-conviction signals
  const highConviction = flowData.filter(signal => {
    return signal.premium_usd > 100000 &&           // $100K+ premium
           signal.order_type === 'sweep' &&         // Sweep orders only
           (signal.bullish_score > 0.7 || signal.bearish_score > 0.7);
  });

  // Store to trading_signals with source='unusual-whales-flow'
  for (const signal of highConviction) {
    await db.insert(trading_signals).values({
      source: 'unusual-whales-flow',
      ticker: signal.ticker,
      direction: signal.bullish_score > 0.7 ? 'long' : 'short',
      strength: Math.max(signal.bullish_score, signal.bearish_score),
      reason: `UW: ${signal.order_type} $${signal.premium_usd.toLocaleString()}`,
      payload_json: JSON.stringify(signal),
      captured_at: new Date()
    });
  }
}
```

**Pricing:** $49/month (base) or $199/month (pro with dark pool)

**Expected Signal Volume:** 10-20 high-conviction signals/day

**Cluster Weight:** 1.5x (highest priority)

---

### 2. InsiderFlow.io SEC Form 4 Data ⭐⭐⭐⭐

**What it provides:**
- Real-time SEC Form 4 insider trading filings
- CEO, director, officer purchases/sales
- Same-day or next-day filing capture (NOT 26-day lag)
- "Smart Money Matrix" filters out routine sales

**Implementation:**

```typescript
// File: src/heartbeat/autonomy.ts
// Polls daily at 6:00 PM ET (after SEC filing deadline)

async function pollInsiderFlow(): Promise<void> {
  const API_KEY = process.env.INSIDERFLOW_API_KEY;
  const BASE_URL = 'https://api.insiderflow.io';

  const form4Response = await fetch(`${BASE_URL}/v1/filings/form4`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify({
      start_date: new Date(Date.now() - 86400000).toISOString().split('T')[0],
      end_date: new Date().toISOString().split('T')[0]
    })
  });
  const formData = await form4Response.json();

  // Filter for high-conviction insider purchases
  const smartMoney = formData.filter(filing => {
    return filing.transaction_type === 'open_market_purchase' &&
           (filing.title === 'CEO' || filing.title === 'CFO') &&
           !filing.is_10b5_1_plan &&
           filing.shares_changed > 1000;
  });

  // Store to trading_signals with source='insiderflow-form4'
  for (const filing of smartMoney) {
    await db.insert(trading_signals).values({
      source: 'insiderflow-form4',
      ticker: filing.ticker,
      direction: 'long',
      strength: Math.min(filing.shares_changed / 10000, 1.0),
      reason: `IF: ${filing.title} ${filing.transaction_type}`,
      payload_json: JSON.stringify(filing),
      captured_at: new Date()
    });
  }
}
```

**Pricing:** Free tier available or $29/month (pro)

**Expected Signal Volume:** 5-10 high-conviction CEO/CFO purchases/week

**Cluster Weight:** 0.8x

---

### 3. WhaleStream Dark Pool Data ⭐⭐⭐ (OPTIONAL)

**What it provides:**
- Real-time dark pool trading activity
- Signature print flow (large institutional blocks)
- Top dark pool flow scanner

**Pricing:** $79/month

**Expected Signal Volume:** 3-5 patterns/day

**Cluster Weight:** 0.6x (contextual, not directional)

**Implementation:** ONLY if Phases 1-2 show improvement

---

## Cost-Benefit Analysis

### Current State (Shadow-Quiver)

- Cost: $0
- Signal volume: 50/day (spam)
- Predictive accuracy: NEGATIVE (-13% wrong-direction on MU/NVDA)
- Latency: 26-day reporting delay
- Cluster impact: 60% false positives

### Proposed State (Unusual Whales + InsiderFlow)

| Source | Cost/Month | Signals/Day | Latency | Expected Accuracy | Weight |
|--------|-----------|-------------|---------|-------------------|--------|
| Unusual Whales | $49-$199 | 10-20 | Real-time | HIGH | 1.5x |
| InsiderFlow | $0-$29 | 1-2 | 1-2 days | MODERATE-HIGH | 0.8x |
| WhaleStream | $79 | 3-5 | EOD | MODERATE | 0.6x |
| **TOTAL** | **$128-$307** | **14-27/day** | **Real-time** | **HIGH** | -- |

### ROI Calculation

If new sources prevent 1 losing trade per week (-2% avg loss) on $10K portfolio:
- Weekly savings: $200
- Monthly savings: $800
- API cost: $128-$307
- **Net ROI: +$493 to +$672/month**

**Break-even:** Prevent 0.6 losing trades per month

---

## Implementation Timeline

### Week 1-2 (May 1-14): Unusual Whales Rollout

1. Subscribe to Unusual Whales API
2. Write `pollUnusualWhales()` function
3. Run validation mode (poll but don't store)
4. Enable storage with manual review
5. Full integration with 1.5x cluster weight
6. **DISABLE shadow-quiver (weight 0.0)**

### Week 3-4 (May 15-28): InsiderFlow Rollout

1. Subscribe to InsiderFlow API (or free tier)
2. Write `pollInsiderFlow()` function
3. Run validation mode
4. Enable with 0.8x cluster weight

### Week 5-6 (May 29 - June 11): Validation

1. Compare cluster accuracy vs S19 baseline
2. Measure false-positive reduction rate
3. Adjust source weights

### Week 7+ (June 12+): Optional WhaleStream

- ONLY implement if Phases 1-2 show >40% false-positive reduction

---

## Action Items

1. **🔧 IMPLEMENT UNUSUAL WHALES (Week 1-2)**
   - Subscribe: https://unusualwhales.com/public-api
   - Create `pollUnusualWhales()` in `src/heartbeat/autonomy.ts`
   - Schedule: Every 5 minutes during market hours
   - Filter: Premium >$100K, sweeps, bullish/bearish >0.7
   - Weight: 1.5x in clustering
   - **DISABLE shadow-quiver (weight 0.0)**

2. **🔧 IMPLEMENT INSIDERFLOW (Week 3-4)**
   - Subscribe: https://insiderflow.io
   - Create `pollInsiderFlow()` in `src/heartbeat/autonomy.ts`
   - Schedule: Daily at 6:00 PM ET
   - Filter: Open-market purchases, CEO/CFO only, exclude 10b5-1
   - Weight: 0.8x in clustering

3. **💰 GDX ENTRY $36-38** — 6 sessions zero signals = HIGHEST conviction contrarian setup

4. **⚠️ AVOID PLTR** — New in clusters with weakest strength (0.00007)

5. **⚠️ MONITOR MSFT** — Strength declining (0.414 → 0.375). Trail stops.

6. **📊 BACKTEST NEW SOURCES** — After implementation, run accuracy test vs S19 baseline

---

## Trading Implications

### Tier-B Entries (Signal Trader Job)

- **MSFT:** Strength declining (0.414 → 0.375). Tier-B already entered — trail stop, don't add.
- **INTC:** New long cluster (0.121). Wait for pullback before entry.
- **TSLA:** Stable strength (0.311). No new entry — momentum-chasing risk.
- **PLTR:** AVOID — weakest strength (0.00007), 3 sources but all noise.

### Watchlist Tickers

- **GDX:** **HIGHEST conviction contrarian setup** — 6 sessions zero signals = retail capitulation. Entry $36-38.
- **MSFT:** Momentum fading. Protect existing gains with trailing stop.
- **AMT:** Ignore pennystock signals (0.0001 strength).
- **WMT:** Zero signals — no setup.

### Regime Alignment

**Current Regime:** Mixed / Transitional (50% confidence)

- Regime Detection: 55% weight (AMT winning with 100% MTF rule)
- Kalman Filter: 30% weight (downgraded)
- POC Reversion: 0% (suspended - JNJ 0/2)
- Mean Reversion: 0% GATED (PCE 3.58% > 2.5% threshold)

**Implication:** Focus on Regime Detection with 100% MTF alignment. Avoid mean reversion strategies until PCE drops below 2.5%.

---

## Next Session (After Implementation)

1. Validate signal quality improvement (S21 vs S19)
2. Measure false-positive reduction (target: >40%)
3. Adjust source weights based on 30-day performance
4. Consider WhaleStream integration (only if Phases 1-2 succeed)
5. GDX trade review

---

**Status:** ✅ COMPLETE — Implementation roadmap delivered
**Next Task:** Await user approval to begin Phase 1 (Unusual Whales integration)
