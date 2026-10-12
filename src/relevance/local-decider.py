# /// script
# requires-python = ">=3.11"
# dependencies = ["torch", "transformers", "huggingface_hub", "accelerate"]
# ///
"""Local replacement for the hosted Jev call (cc-j8ti).

Reads JSON lines {"id", "state", "questions"} on stdin, scores each with the
local Mapika decider (Jev wire format in, Jev wire format out) and writes JSON
lines {"id", "answers", "model"} on stdout. One load per run: no daemon, no key.

    uv run src/relevance/local-decider.py --model Mapika/decider-0.8b < in.jsonl > out.jsonl

The `decider` package ships inside the model snapshot, so we put the snapshot on
sys.path instead of pip-installing it.
"""
import argparse, json, os, sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Mapika/decider-0.8b")
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()

    os.environ.setdefault("HF_HUB_OFFLINE", "1")  # weights are cached; never reach out
    from huggingface_hub import snapshot_download
    path = snapshot_download(args.model)
    sys.path.insert(0, path)

    import torch
    device = args.device
    if device == "auto":
        device = "mps" if torch.backends.mps.is_available() else "cpu"
    dtype = torch.float32 if device == "cpu" else torch.bfloat16
    from decider.infer import Decider
    d = Decider(path, device=device, dtype=dtype, use_graphs=False)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            out = d.system_one(req["state"], req["questions"])
            rec = {"id": req["id"], "answers": out["answers"], "model": out.get("model"),
                   "usage": out.get("usage", {})}
        except Exception as e:  # one bad item must not sink the batch
            rec = {"id": req["id"], "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(rec, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
