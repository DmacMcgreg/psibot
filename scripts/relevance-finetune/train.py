# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["mlx-lm==0.31.3", "numpy", "huggingface_hub"]
# ///
"""LoRA fine-tune of Mapika/decider-0.8b for the Discover triage decision (cc-j8ti), in MLX.

Loss = cross-entropy (soft targets allowed) over the letter logits at the answer slot, divided by the
choice temperature: the same readout local-decider.py uses, so training matches inference.

    uv run train.py gate  <dataDir>                       # backprop check on 2 items
    uv run train.py cv    <dataDir> <outDir> --arm human|jev [--folds 0,1,2,3,4]
    uv run train.py final <dataDir> <outDir> --arm human|jev   # train on all 96 human labels

Training prompts are the facts-only payloads (src/relevance/triage-questions-lite.ts): no rubric.
mlx_lm switches GatedDeltaNet to its pure-ops path (differentiable) when model.training is True; at
inference it uses the Metal kernel. Adapters are saved in mlx_lm's format (adapter_config.json +
adapters.safetensors) so `local-decider.py --adapter DIR` loads them with mlx_lm.load.
"""
import argparse, glob, json, os, random, sys, time
from dataclasses import dataclass

HF = os.path.expanduser("~/.cache/huggingface/hub")
REPO = "Mapika/decider-0.8b"
snap = sorted(glob.glob(f"{HF}/models--Mapika--decider-0.8b/snapshots/*"))[-1]
sys.path.insert(0, snap)

import numpy as np
import mlx.core as mx, mlx.nn as nn, mlx.optimizers as optim
from mlx.utils import tree_flatten, tree_map
from tokenizers import Tokenizer
from mlx_lm import load
from mlx_lm.tuner.utils import linear_to_lora_layers
from decider.prompt import build, letter_ids
from decider.systemone import render_state, render_question, plan_rows

CFG = json.load(open(f"{snap}/decider_config.json"))
T_DEFAULT = float(CFG.get("temperature", 1.0))
T_BY_TYPE = CFG.get("temperature_by_type", {})
ORDER = ["interested", "not_interested", "unsure"]  # option order in the lite decision question


class Tok:
    def __init__(self, path): self.t = Tokenizer.from_file(path)
    def encode(self, text, add_special_tokens=False): return self.t.encode(text, add_special_tokens=add_special_tokens).ids


@dataclass
class Q:
    text: str
    options: list
    gold: int = 0


@dataclass
class Example:
    context: str
    qs: list


class Keep:
    def shuffle(self, x): pass
    def sample(self, xs, k): return xs[:k]


TOK = Tok(f"{snap}/tokenizer.json")
LETTERS = mx.array(letter_ids(TOK))


def encode(payload):
    """Same prompt construction as local-decider.py; the lite payload has exactly one row."""
    ctx = render_state(payload["state"])
    rqs = {k: render_question(v) for k, v in payload["questions"].items()}
    flat, index = plan_rows(rqs, bool(CFG.get("isolated_levels", False)))
    assert len(flat) == 1, len(flat)
    r = flat[0]
    it = build(Example(ctx, [Q(r["question"], list(r["options"]), 0)]), TOK, Keep(), max_options=255,
               max_ctx_tokens=32768, layout="state_first")
    return it["ids"], it["nopts"][0], float(T_BY_TYPE.get(rqs["decision"]["type"], T_DEFAULT))


def read_rows(path):
    return [json.loads(l) for l in open(path) if l.strip()]


def human_target(label): return [1.0, 0.0, 0.0] if label == "interested" else [0.0, 1.0, 0.0]


def jev_target(r):
    pi, pn = max(0.0, r["p_interest"]), max(0.0, r["p_not"])
    pu = max(0.0, 1.0 - pi - pn)
    s = pi + pn + pu
    return [pi / s, pn / s, pu / s]


def fresh_model(rank, scale):
    mt = json.load(open(f"{snap}/config.json")).get("model_type")
    model, _ = load(snap, model_config={"model_type": "qwen3_5"}) if mt == "qwen3_5_text" else load(snap)
    model.freeze()
    cfg = {"rank": rank, "scale": scale, "dropout": 0.0}
    linear_to_lora_layers(model, len(model.layers), cfg)
    return model, {"num_layers": len(model.layers), "lora_parameters": cfg, "fine_tune_type": "lora", "model": REPO}


def make_loss(model):
    lm = getattr(model, "language_model", model)

    def logits_at_slot(ids, nopts, T):
        h = lm.model(mx.array([ids]))[:, -1:, :]
        lg = lm.lm_head(h) if hasattr(lm, "lm_head") else lm.model.embed_tokens.as_linear(h)
        return lg[0, 0][LETTERS[:nopts]].astype(mx.float32) / T

    def loss_fn(model_, ids, nopts, T, target, weight):
        lg = logits_at_slot(ids, nopts, T)
        logp = lg - mx.logsumexp(lg)
        return -weight * mx.sum(mx.array(target[:nopts]) * logp)

    return loss_fn, logits_at_slot


def train(model, examples, epochs, lr, accum, seed, log=print, sampler=None):
    """examples: list of (ids, nopts, T, target, weight). sampler(epoch) -> extra examples for that epoch."""
    loss_fn, _ = make_loss(model)
    vg = nn.value_and_grad(model, loss_fn)
    opt = optim.Adam(learning_rate=lr)
    rng = random.Random(seed)
    model.train()
    step = 0
    for ep in range(epochs):
        ex = list(examples) + (sampler(ep) if sampler else [])
        rng.shuffle(ex)
        tot, n, t0 = 0.0, 0, time.time()
        for s in range(0, len(ex), accum):
            acc, bl = None, 0.0
            for ids, nopts, T, target, w in ex[s:s + accum]:
                l, g = vg(model, ids, nopts, T, target, w)
                acc = g if acc is None else tree_map(lambda a, b: a + b, acc, g)
                mx.eval(l, acc)
                bl += l.item()
            k = len(ex[s:s + accum])
            opt.update(model, tree_map(lambda x: x / k, acc))
            mx.eval(model.parameters(), opt.state)
            tot += bl; n += k; step += 1
        log(f"  epoch {ep + 1}/{epochs} loss {tot / max(n, 1):.4f} ({n} ex, {time.time() - t0:.0f}s)")
    model.eval()


def save_adapter(model, meta, out):
    os.makedirs(out, exist_ok=True)
    mx.save_safetensors(f"{out}/adapters.safetensors", dict(tree_flatten(model.trainable_parameters())))
    json.dump(meta, open(f"{out}/adapter_config.json", "w"), indent=1)


def gate(data, lr=2e-4, steps=20):
    """Backprop check: 2 items, ~20 steps; loss must fall and LoRA grads on delta-net and attention must be non-zero."""
    rows = read_rows(f"{data}/human.jsonl")
    pick = [next(r for r in rows if r["label"] == "interested"), next(r for r in rows if r["label"] == "not_interested")]
    model, _ = fresh_model(8, 20.0)
    loss_fn, logits_at_slot = make_loss(model)
    ex = []
    for r in pick:
        ids, nopts, T = encode(r)
        ex.append((ids, nopts, T, human_target(r["label"]), 1.0))
    print("tokens:", [len(e[0]) for e in ex], "T:", ex[0][2])
    vg = nn.value_and_grad(model, loss_fn)
    opt = optim.Adam(learning_rate=lr)
    # train-path vs eval-path logits on the untouched base model (LoRA b=0)
    for mode in ("eval", "train"):
        getattr(model, mode)()
        print(mode, "path probs", [[round(x, 3) for x in mx.softmax(logits_at_slot(e[0], e[1], e[2])).tolist()] for e in ex])
    model.train()
    # which GatedDeltaNet code path is live?
    print("training flag on first delta layer:", model.layers[0].linear_attn.training if hasattr(model.layers[0], "linear_attn") else "n/a")
    for step in range(steps):
        t0 = time.time(); acc = None; tot = 0.0; per = []
        for e in ex:
            l, g = vg(model, *e)
            acc = g if acc is None else tree_map(lambda a, b: a + b, acc, g)
            mx.eval(l, acc); tot += l.item(); per.append(round(l.item(), 3))
        print(f"  step {step} per-item loss {per}", flush=True)
        if step in (0, 1):
            flat = dict(tree_flatten(acc))
            def norm(sub, ab):
                v = [float(mx.sqrt(mx.sum(x * x)).item()) for k, x in flat.items() if sub in k and k.endswith(ab)]
                return (len(v), max(v) if v else 0.0)
            print(f"step {step}: loss {tot / 2:.4f}  delta in_proj_qkv lora_a/b grads {norm('linear_attn.in_proj_qkv','lora_a.weight') if False else norm('in_proj_qkv', 'lora_a')} / {norm('in_proj_qkv', 'lora_b')}"
                  f"  delta out_proj a/b {norm('linear_attn.out_proj', 'lora_a')} / {norm('linear_attn.out_proj', 'lora_b')}"
                  f"  attn q_proj a/b {norm('self_attn.q_proj', 'lora_a')} / {norm('self_attn.q_proj', 'lora_b')}  ({time.time() - t0:.1f}s/step)")
        opt.update(model, tree_map(lambda x: x / 2, acc))
        mx.eval(model.parameters(), opt.state)
    model.eval()
    for e in ex:
        p = mx.softmax(logits_at_slot(e[0], e[1], e[2])).tolist()
        print("final probs (eval path)", [round(x, 3) for x in p], "target", e[3])


def build_arm(rows_h, rows_j, arm, seed):
    """Fixed, pre-registered recipe (set before looking at any held-out fold)."""
    n_i = sum(r["label"] == "interested" for r in rows_h)
    n_n = len(rows_h) - n_i
    wc = {"interested": len(rows_h) / (2 * n_i), "not_interested": len(rows_h) / (2 * n_n)}  # class-balanced
    ex = []
    for r in rows_h:
        ids, nopts, T = encode(r)
        ex.append((ids, nopts, T, human_target(r["label"]), wc[r["label"]]))
    sampler = None
    if arm == "jev":
        enc = {}
        pools = {"hide": [], "mid": [], "pick": []}
        for r in rows_j:
            key = "hide" if r["p_not"] >= 0.5 else "pick" if r["p_interest"] >= 0.8 else "mid"
            pools[key].append(r)
        def sampler(ep, pools=pools, enc=enc):
            rng = random.Random(seed * 100 + ep)
            out = []
            for pool in pools.values():
                for r in rng.sample(pool, min(80, len(pool))):
                    if r["id"] not in enc: enc[r["id"]] = encode(r)
                    ids, nopts, T = enc[r["id"]]
                    out.append((ids, nopts, T, jev_target(r), 0.3))
            return out
    return ex, sampler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["gate", "cv", "final"])
    ap.add_argument("data"); ap.add_argument("out", nargs="?")
    ap.add_argument("--arm", default="human", choices=["human", "jev"])
    ap.add_argument("--folds", default="0,1,2,3,4")
    ap.add_argument("--rank", type=int, default=8); ap.add_argument("--scale", type=float, default=20.0)
    ap.add_argument("--lr", type=float, default=1e-4); ap.add_argument("--epochs", type=int, default=None)
    ap.add_argument("--accum", type=int, default=8); ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--tag", default=None)
    a = ap.parse_args()
    if a.mode == "gate":
        return gate(a.data, a.lr, a.epochs or 20)
    epochs = a.epochs or (6 if a.arm == "human" else 3)
    human = read_rows(f"{a.data}/human.jsonl")
    jev = read_rows(f"{a.data}/jev.jsonl") if a.arm == "jev" else []
    tag = a.tag or a.arm
    folds = [int(x) for x in a.folds.split(",")] if a.mode == "cv" else [-1]
    for k in folds:
        t0 = time.time()
        print(f"[{tag}] fold {k}: arm={a.arm} epochs={epochs} lr={a.lr} rank={a.rank} scale={a.scale}", flush=True)
        rows_h = [r for r in human if r["fold"] != k]
        model, meta = fresh_model(a.rank, a.scale)
        ex, sampler = build_arm(rows_h, jev, a.arm, a.seed + k)
        train(model, ex, epochs, a.lr, a.accum, a.seed + k, log=lambda s: print(s, flush=True), sampler=sampler)
        save_adapter(model, {**meta, "arm": a.arm, "fold": k, "epochs": epochs, "lr": a.lr, "train_human": len(rows_h)},
                     f"{a.out}/{tag}-f{k}" if k >= 0 else f"{a.out}/{tag}-all")
        print(f"[{tag}] fold {k} done in {time.time() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    main()
