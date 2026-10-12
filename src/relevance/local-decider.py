# /// script
# requires-python = ">=3.11,<3.14"
# dependencies = ["mlx-lm==0.31.3", "numpy", "huggingface_hub"]
# ///
"""Local replacement for the hosted Jev call (cc-j8ti), scored through MLX.

Reads JSON lines {"id", "state", "questions"} on stdin, scores each with a local decider
checkpoint (Jev wire format in, Jev wire format out) and writes JSON lines
{"id", "answers", "model", "usage"} on stdout. One model load per run: no daemon, no key.

    uv run src/relevance/local-decider.py --model midium-ai/decider-4b-dwq-4bit < in.jsonl > out.jsonl

Why MLX: the torch/MPS path ran ~40 s per item because the hybrid layers fell back to
reference PyTorch kernels. MLX runs one forward pass per row in a few hundred ms.

Readout is the decider's own (decider.infer.system_one, state_first layout, independent rows):
one row per question with a single answer slot at the last position, letter logits over that
row's options, divided by the temperature for the answer type, softmaxed. The prompt builder and
answer assembly come from the `decider` package shipped inside the Mapika/decider-0.8b snapshot.
"""
import argparse, copy, json, os, sys, glob

HF = os.path.expanduser("~/.cache/huggingface/hub")
PKG_REPO = "Mapika/decider-0.8b"  # source of the `decider` python package (prompt/systemone)


def snapshot(repo: str) -> str:
    hits = sorted(glob.glob(f"{HF}/models--{repo.replace('/', '--')}/snapshots/*"))
    if not hits:
        raise SystemExit(f"{repo} is not in the HF cache ({HF})")
    return hits[-1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="midium-ai/decider-4b-dwq-4bit")
    args = ap.parse_args()

    model_dir = snapshot(args.model)
    sys.path.insert(0, snapshot(PKG_REPO))
    from dataclasses import dataclass
    from tokenizers import Tokenizer
    import mlx.core as mx
    from mlx_lm import load
    from decider.prompt import build, letter_ids
    from decider.systemone import render_state, render_question, plan_rows, assemble, unique_tokens

    cfg = json.load(open(f"{model_dir}/decider_config.json"))
    t_default = float(cfg.get("temperature", 1.0))
    t_by_type = cfg.get("temperature_by_type", {})
    if cfg.get("neutralize_none", True):
        raise SystemExit("checkpoints that need neutralize_none are not supported by the MLX path")
    isolated_levels = bool(cfg.get("isolated_levels", False))
    layout = "schema_first" if cfg.get("schema_first") else "state_first"
    if layout != "state_first":
        raise SystemExit("schema_first checkpoints are not supported by the MLX path")

    class Tok:
        def __init__(self, path):
            self.t = Tokenizer.from_file(path)

        def encode(self, text, add_special_tokens=False):
            return self.t.encode(text, add_special_tokens=add_special_tokens).ids

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

    tok = Tok(f"{model_dir}/tokenizer.json")
    # midium's DWQ builds ship a text-only qwen3_5_text config that mlx_lm loads through its qwen3_5 module
    mt = json.load(open(f"{model_dir}/config.json")).get("model_type")
    model, _ = load(model_dir, model_config={"model_type": "qwen3_5"}) if mt == "qwen3_5_text" else load(model_dir)
    mx.eval(model.parameters())
    lm = getattr(model, "language_model", model)
    letters = mx.array(letter_ids(tok))

    def head(h):  # hidden [1,1,H] -> logits [1,1,V]
        if hasattr(lm, "lm_head"):
            return lm.lm_head(h)
        return lm.model.embed_tokens.as_linear(h)

    def read(h, nopts, T):
        lg = head(h[:, -1:, :])[0, 0]
        p = mx.softmax(lg[letters[:nopts]].astype(mx.float32) / T)
        mx.eval(p)
        return [float(x) for x in p.tolist()]

    def score_rows(items, temps):
        """Rows share the rendered state as a prefix: run it once, fork the cache per row (the delta-net
        layers keep recurrent state, so the fork is a deep copy rather than a trim)."""
        ids = [it["ids"] for it in items]
        lcp = min(map(len, ids))
        for i in range(lcp):
            if any(x[i] != ids[0][i] for x in ids):
                lcp = i
                break
        # the last token of every row is its answer slot, so a row always keeps at least one token of its own
        lcp = min(lcp, min(map(len, ids)) - 1)
        if len(ids) < 2 or lcp < int(os.environ.get("DECIDER_PREFIX_MIN", "32")):
            return [read(lm.model(mx.array([x])), it["nopts"][0], t) for x, it, t in zip(ids, items, temps)]
        cache = model.make_cache()
        mx.eval(lm.model(mx.array([ids[0][:lcp]]), cache=cache))
        out = []
        for x, it, t in zip(ids, items, temps):
            c = copy.deepcopy(cache)
            out.append(read(lm.model(mx.array([x[lcp:]]), cache=c), it["nopts"][0], t))
        return out

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            ctx = render_state(req["state"])
            rqs = {k: render_question(v) for k, v in req["questions"].items()}
            flat, index = plan_rows(rqs, isolated_levels)
            # temperature per row: iso rows belong to a score question, the rest use their question's type
            row_type = [None] * len(flat)
            for k, kind, s, n in index:
                for j in range(n):
                    row_type[s + j] = "score" if kind == "iso" else rqs[k]["type"]
            items = [build(Example(ctx, [Q(r["question"], list(r["options"]), 0)]), tok, Keep(), max_options=255,
                           max_ctx_tokens=32768, layout=layout) for r in flat]
            probs = score_rows(items, [float(t_by_type.get(t, t_default)) for t in row_type])
            out = {"model": args.model, "answers": assemble(rqs, index, probs),
                   "usage": {"input_tokens": unique_tokens(items), "output_tokens": 0}}
            rec = {"id": req["id"], "answers": out["answers"], "model": out["model"], "usage": out["usage"]}
        except Exception as e:  # one bad item must not sink the batch
            rec = {"id": req["id"], "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
