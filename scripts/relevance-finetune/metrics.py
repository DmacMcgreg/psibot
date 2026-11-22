# /// script
# requires-python = ">=3.11"
# dependencies = ["numpy"]
# ///
"""Score pred-<tag>-f{k}.jsonl against the human labels.

    uv run metrics.py <dataDir> <tag> [<tag> ...]

Positive class = not_interested (the class we would hide). Score = decision.probabilities.not_interested.
  recall@10%FPR: share of not_interested items scored above the threshold that lets through at most
                 10% of interested items (threshold chosen on the SAME fold: it is a ranking metric, not a
                 deployable threshold; with ~13 interested items per fold this is 1 false positive).
  AUC:           tie-aware (Mann-Whitney, ties count 1/2).
  acc:           binary rule  not_interested if p_not > p_interested  (unsure mass ignored), vs always-interested.
  hide@.85:      what production hide >= 0.85 would do: hidden total / hidden that are really interested.
"""
import json, sys, numpy as np

data, tags = sys.argv[1], sys.argv[2:]
rng = np.random.default_rng(0)

def auc(pos, neg):
    if len(pos) == 0 or len(neg) == 0: return float("nan")
    d = pos[:, None] - neg[None, :]
    return float(((d > 0).sum() + 0.5 * (d == 0).sum()) / d.size)

def recall_at_fpr(pos, neg, fpr=0.10):
    # largest threshold t with FP(t) = #(neg >= t) <= fpr*len(neg) (floor); recall = #(pos >= t)/len(pos)
    budget = int(np.floor(fpr * len(neg) + 1e-9))
    best = 0.0
    for t in sorted(set(np.concatenate([pos, neg]))) + [float("inf")]:
        if (neg >= t).sum() <= budget:
            best = max(best, float((pos >= t).mean()))
    return best

def load(tag, k):
    rows = []
    for l in open(f"{data}/pred-{tag}-f{k}.jsonl"):
        r = json.loads(l)
        gold = None
        rows.append(r)
    return rows

labels = {}
for l in open(f"{data}/human.jsonl"):
    r = json.loads(l); labels[r["id"]] = r["label"]

def summarize(tag):
    folds, allp, ally, lat, errs = [], [], [], [], 0
    for k in range(5):
        p, y = [], []
        for r in load(tag, k):
            if "error" in r: errs += 1; continue
            d = r["answers"]["decision"]
            pr = d.get("probabilities", {})
            p.append((pr.get("not_interested", 0.0), pr.get("interested", 0.0)))
            y.append(1 if labels[r["id"]] == "not_interested" else 0)
            if "elapsed_s" in r: lat.append(r["elapsed_s"])
        p, y = np.array(p), np.array(y)
        s = p[:, 0]
        pos, neg = s[y == 1], s[y == 0]
        pred = (p[:, 0] > p[:, 1]).astype(int)
        folds.append(dict(
            rec=recall_at_fpr(pos, neg), auc=auc(pos, neg), acc=float((pred == y).mean()),
            maj=float(1 - y.mean()), hid=int((s >= 0.85).sum()), hid_bad=int(((s >= 0.85) & (y == 0)).sum()),
            n=len(y)))
        allp.append(s); ally.append(y)
    s, y = np.concatenate(allp), np.concatenate(ally)
    # pooled out-of-fold with bootstrap CI
    def pooled(idx):
        yy, ss = y[idx], s[idx]
        return recall_at_fpr(ss[yy == 1], ss[yy == 0]), auc(ss[yy == 1], ss[yy == 0])
    bs = np.array([pooled(rng.integers(0, len(y), len(y))) for _ in range(1000)])
    rec, a = pooled(np.arange(len(y)))
    f = lambda key: np.array([x[key] for x in folds])
    def ms(key): v = f(key); return f"{v.mean():.2f} +/- {v.std(ddof=1):.2f}"
    print(f"== {tag}  (errors {errs}, n={len(y)}, not_interested={int(y.sum())})")
    print(f"  recall@10%FPR  folds {ms('rec')}   pooled {rec:.2f}  95% CI [{np.nanpercentile(bs[:,0],2.5):.2f}, {np.nanpercentile(bs[:,0],97.5):.2f}]")
    print(f"  AUC            folds {ms('auc')}   pooled {a:.2f}  95% CI [{np.nanpercentile(bs[:,1],2.5):.2f}, {np.nanpercentile(bs[:,1],97.5):.2f}]")
    print(f"  accuracy       folds {ms('acc')}   always-interested baseline {ms('maj')}")
    print(f"  production hide>=0.85: hides {sum(x['hid'] for x in folds)} items, {sum(x['hid_bad'] for x in folds)} of them are really interested")
    if lat: print(f"  latency/item   median {np.median(lat):.2f}s  mean {np.mean(lat):.2f}s  (excl. model load)")
    print("  per-fold rec: " + " ".join(f"{x['rec']:.2f}" for x in folds) + " | auc: " + " ".join(f"{x['auc']:.2f}" for x in folds))

for t in tags: summarize(t)
