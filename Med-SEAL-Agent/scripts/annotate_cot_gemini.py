"""Annotate training data with CoT reasoning using Gemini 3 Flash API.

Sends each (image, question) sample to Gemini, which generates a brief
chain-of-thought reasoning.  The ground-truth answer is preserved; only
the generated reasoning is wrapped in <think>...</think> and prepended.

Supports two modes:
  async  (default) -- concurrent requests, fast, full price
  batch  -- Gemini Batch API, 50% discount, ~24h turnaround

Usage (async, recommended):
    export GEMINI_API_KEY="your-key"
    python scripts/annotate_cot_gemini.py annotate \
        --input  data/combined_train.jsonl \
        --output data/combined_train_cot.jsonl

Usage (batch, 50% cheaper):
    python scripts/annotate_cot_gemini.py annotate \
        --input  data/combined_train.jsonl \
        --output data/combined_train_cot.jsonl \
        --mode batch

Collect batch results after completion:
    python scripts/annotate_cot_gemini.py collect \
        --meta  data/combined_train_cot.batch_meta.json \
        --input data/combined_train.jsonl \
        --output data/combined_train_cot.jsonl

Quick test:
    python scripts/annotate_cot_gemini.py annotate \
        --input data/combined_train.jsonl \
        --output /tmp/cot_test.jsonl \
        --max_samples 5
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import mimetypes
import os
import re
import sys
import time
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

MODEL = "gemini-3-flash-preview"

SYSTEM_PROMPT = (
    "You are a medical imaging expert. Given a medical image and a question "
    "about it, provide a concise chain-of-thought reasoning (2-5 sentences) "
    "that explains what you observe in the image and the medical knowledge "
    "needed to arrive at the answer. Output ONLY the reasoning steps. "
    "Do NOT state the final answer itself."
)

THINK_RE = re.compile(r"<think>(.*?)</think>", flags=re.DOTALL)


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def encode_image_b64(path: str) -> tuple[str, str]:
    """Return (base64_data, mime_type) for a local image file."""
    mime, _ = mimetypes.guess_type(path)
    if mime is None:
        ext = Path(path).suffix.lower()
        mime = {"jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
                ".gif": "image/gif", ".webp": "image/webp"}.get(ext, "image/jpeg")
    with open(path, "rb") as f:
        return base64.standard_b64encode(f.read()).decode("ascii"), mime


def load_done_count(output_path: str) -> int:
    """Count existing lines in the output file (for resume)."""
    p = Path(output_path)
    if not p.exists():
        return 0
    with open(p) as f:
        return sum(1 for _ in f)


def strip_think_tags(text: str) -> str:
    """Remove any <think> tags from model output (we add our own)."""
    text = THINK_RE.sub(lambda m: m.group(1), text)
    return text.strip()


# ---------------------------------------------------------------------------
# Async mode
# ---------------------------------------------------------------------------

async def process_one(
    client,
    idx: int,
    sample: dict,
    semaphore: asyncio.Semaphore,
    use_thinking: bool,
    max_retries: int = 6,
) -> dict:
    """Send one sample to Gemini and return the annotated sample."""
    from google.genai import types

    convos = sample["conversations"]
    question = convos[0]["content"]
    gt_answer = convos[1]["content"]
    image_path = sample.get("image", "")

    clean_q = question.replace("<image>", "").strip()

    parts: list = []
    if image_path and os.path.isfile(image_path):
        b64, mime = encode_image_b64(image_path)
        parts.append(types.Part.from_bytes(data=base64.standard_b64decode(b64), mime_type=mime))
    parts.append(types.Part.from_text(text=clean_q))

    config_kwargs: dict = {
        "system_instruction": SYSTEM_PROMPT,
        "temperature": 0.3,
        "max_output_tokens": 512,
    }
    if use_thinking:
        config_kwargs["thinking_config"] = types.ThinkingConfig(
            thinking_level="MEDIUM",
            include_thoughts=True,
        )

    reasoning = None
    for attempt in range(max_retries):
        try:
            async with semaphore:
                response = await client.aio.models.generate_content(
                    model=MODEL,
                    contents=parts,
                    config=types.GenerateContentConfig(**config_kwargs),
                )

            if use_thinking and response.candidates:
                thought_parts = []
                for part in response.candidates[0].content.parts:
                    if getattr(part, "thought", False):
                        thought_parts.append(part.text)
                if thought_parts:
                    reasoning = strip_think_tags("\n".join(thought_parts))
                elif response.text:
                    reasoning = strip_think_tags(response.text)
            elif response.text:
                reasoning = strip_think_tags(response.text)

            break

        except Exception as e:
            err = str(e)
            wait = min(2 ** attempt * 1.5, 120)
            if "429" in err or "RESOURCE_EXHAUSTED" in err:
                wait = min(2 ** attempt * 5, 120)
                logger.warning("[%d] Rate limited, wait %.0fs (attempt %d)", idx, wait, attempt + 1)
            elif "500" in err or "503" in err:
                logger.warning("[%d] Server error, wait %.0fs (attempt %d)", idx, wait, attempt + 1)
            else:
                logger.warning("[%d] %s, wait %.0fs (attempt %d)", idx, err[:120], wait, attempt + 1)
            await asyncio.sleep(wait)

    if reasoning and len(reasoning) > 20:
        new_answer = f"<think>\n{reasoning}\n</think>\n\n{gt_answer}"
    else:
        new_answer = gt_answer

    return {
        "image": image_path,
        "conversations": [
            {"role": "user", "content": question},
            {"role": "assistant", "content": new_answer},
        ],
    }


async def run_async(
    samples: list[dict],
    output_path: str,
    concurrency: int,
    use_thinking: bool,
):
    """Process samples with concurrent async requests."""
    from google import genai

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        logger.error("GEMINI_API_KEY not set"); return

    client = genai.Client(api_key=api_key)
    semaphore = asyncio.Semaphore(concurrency)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    total = len(samples)
    success = 0
    fail = 0
    t0 = time.time()

    FLUSH_EVERY = 50

    with open(out, "a") as fout:
        for chunk_start in range(0, total, FLUSH_EVERY):
            chunk = samples[chunk_start : chunk_start + FLUSH_EVERY]
            tasks = [
                process_one(client, chunk_start + j, s, semaphore, use_thinking)
                for j, s in enumerate(chunk)
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for r in results:
                if isinstance(r, Exception):
                    logger.error("Unhandled: %s", r)
                    fail += 1
                    continue
                fout.write(json.dumps(r, ensure_ascii=False) + "\n")
                has_cot = "<think>" in r["conversations"][1]["content"]
                success += 1 if has_cot else 0
                fail += 0 if has_cot else 1
            fout.flush()

            done = chunk_start + len(chunk)
            elapsed = time.time() - t0
            rate = done / elapsed if elapsed > 0 else 0
            eta = (total - done) / rate if rate > 0 else 0
            logger.info(
                "Progress %d/%d | %.1f samples/s | CoT: %d | noCoT: %d | ETA %.0fm",
                done, total, rate, success, fail, eta / 60,
            )

    elapsed = time.time() - t0
    logger.info(
        "Done. %d total, %d with CoT (%.1f%%), %d fallback. %.0fs (%.1f samples/s). -> %s",
        total, success, 100 * success / max(total, 1), fail, elapsed, total / max(elapsed, 1), output_path,
    )


# ---------------------------------------------------------------------------
# Batch mode
# ---------------------------------------------------------------------------

def build_batch_request(question: str, image_path: str) -> dict:
    """Build one GenerateContentRequest dict for the batch JSONL."""
    clean_q = question.replace("<image>", "").strip()

    parts: list = []
    if image_path and os.path.isfile(image_path):
        b64, mime = encode_image_b64(image_path)
        parts.append({"inlineData": {"mimeType": mime, "data": b64}})
    parts.append({"text": clean_q})

    return {
        "contents": [{"role": "user", "parts": parts}],
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 512,
        },
    }


def run_batch(samples: list[dict], output_path: str, chunk_size: int):
    """Create batch JSONL files, upload, and submit jobs."""
    from google import genai

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        logger.error("GEMINI_API_KEY not set"); return

    client = genai.Client(api_key=api_key)

    tmp_dir = Path(output_path).parent / "batch_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    chunks = [samples[i : i + chunk_size] for i in range(0, len(samples), chunk_size)]
    logger.info("Splitting %d samples into %d batch chunks (max %d each)", len(samples), len(chunks), chunk_size)

    job_meta: list[dict] = []

    for ci, chunk in enumerate(chunks):
        jsonl_path = tmp_dir / f"batch_input_{ci:04d}.jsonl"
        with open(jsonl_path, "w") as f:
            for s in chunk:
                req = build_batch_request(
                    s["conversations"][0]["content"],
                    s.get("image", ""),
                )
                f.write(json.dumps(req, ensure_ascii=False) + "\n")

        size_mb = jsonl_path.stat().st_size / (1024 ** 2)
        logger.info("Chunk %d: %s (%.0f MB, %d samples)", ci, jsonl_path.name, size_mb, len(chunk))

        if size_mb > 1900:
            logger.error("Chunk too large (%.0f MB). Reduce --batch_size.", size_mb)
            return

        uploaded = client.files.upload(file=str(jsonl_path))
        logger.info("  Uploaded -> %s", uploaded.name)

        job = client.batches.create(
            model=MODEL,
            src=uploaded.name,
            config={"display_name": f"med-seal-cot-{ci:04d}"},
        )
        logger.info("  Job submitted: %s", job.name)
        job_meta.append({
            "chunk_idx": ci,
            "job_name": job.name,
            "num_samples": len(chunk),
            "jsonl_file": str(jsonl_path),
        })

    meta_path = Path(output_path).with_suffix(".batch_meta.json")
    with open(meta_path, "w") as f:
        json.dump({
            "model": MODEL,
            "total_samples": len(samples),
            "input_file": str(Path(output_path).parent / "combined_train.jsonl"),
            "jobs": job_meta,
        }, f, indent=2)

    logger.info(
        "\n%d batch jobs submitted. Expect results within ~24 hours.\n"
        "Metadata: %s\n\n"
        "To collect results, run:\n"
        "  python scripts/annotate_cot_gemini.py collect \\\n"
        "    --meta %s \\\n"
        "    --input data/combined_train.jsonl \\\n"
        "    --output %s\n",
        len(job_meta), meta_path, meta_path, output_path,
    )


def collect_batch_results(meta_path: str, input_path: str, output_path: str):
    """Poll batch jobs until done, then assemble annotated JSONL."""
    from google import genai

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        logger.error("GEMINI_API_KEY not set"); return

    client = genai.Client(api_key=api_key)

    with open(meta_path) as f:
        meta = json.load(f)

    all_samples = []
    with open(input_path) as f:
        for line in f:
            all_samples.append(json.loads(line))
    logger.info("Loaded %d original samples from %s", len(all_samples), input_path)

    pending = True
    while pending:
        pending = False
        for jm in meta["jobs"]:
            job = client.batches.get(name=jm["job_name"])
            state = job.state.name if hasattr(job.state, "name") else str(job.state)
            logger.info("  %s : %s", jm["job_name"], state)
            if state not in ("JOB_STATE_SUCCEEDED", "SUCCEEDED", "JOB_STATE_FAILED", "FAILED"):
                pending = True
        if pending:
            logger.info("Still pending, polling again in 5 minutes...")
            time.sleep(300)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    idx = 0
    success = 0

    with open(out, "w") as fout:
        for jm in meta["jobs"]:
            job = client.batches.get(name=jm["job_name"])

            result_lines: list[str] = []
            if hasattr(job, "dest") and job.dest:
                try:
                    content = client.files.download(file=job.dest)
                    result_lines = content.strip().split("\n") if content else []
                except Exception as e:
                    logger.warning("Failed to download results for %s: %s", jm["job_name"], e)

            for ri in range(jm["num_samples"]):
                if idx >= len(all_samples):
                    break
                s = all_samples[idx]
                gt_answer = s["conversations"][1]["content"]
                reasoning = None

                if ri < len(result_lines):
                    try:
                        resp = json.loads(result_lines[ri])
                        cands = resp.get("response", {}).get("candidates", [])
                        if cands:
                            parts = cands[0].get("content", {}).get("parts", [])
                            for p in parts:
                                if p.get("text"):
                                    reasoning = strip_think_tags(p["text"])
                                    break
                    except Exception:
                        pass

                if reasoning and len(reasoning) > 20:
                    new_answer = f"<think>\n{reasoning}\n</think>\n\n{gt_answer}"
                    success += 1
                else:
                    new_answer = gt_answer

                fout.write(json.dumps({
                    "image": s.get("image", ""),
                    "conversations": [
                        {"role": "user", "content": s["conversations"][0]["content"]},
                        {"role": "assistant", "content": new_answer},
                    ],
                }, ensure_ascii=False) + "\n")
                idx += 1

    logger.info("Collected %d samples (%d with CoT). -> %s", idx, success, output_path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Annotate medical VQA data with CoT using Gemini API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command")

    # --- annotate ---
    ann = sub.add_parser("annotate", help="Generate CoT annotations")
    ann.add_argument("--input", required=True, help="Input JSONL path")
    ann.add_argument("--output", required=True, help="Output JSONL path")
    ann.add_argument("--mode", choices=["async", "batch"], default="async",
                     help="async = concurrent requests (default); batch = 50%% discount, ~24h")
    ann.add_argument("--concurrency", type=int, default=30,
                     help="Max parallel requests (async mode)")
    ann.add_argument("--use_thinking", action="store_true",
                     help="Use Gemini native thinking_config instead of prompt-based reasoning")
    ann.add_argument("--batch_size", type=int, default=8000,
                     help="Samples per batch job (batch mode)")
    ann.add_argument("--max_samples", type=int, default=0,
                     help="Limit samples (0 = all)")
    ann.add_argument("--resume", action="store_true",
                     help="Resume from existing partial output")

    # --- collect ---
    coll = sub.add_parser("collect", help="Collect batch API results")
    coll.add_argument("--meta", required=True, help="Batch metadata JSON file")
    coll.add_argument("--input", required=True, help="Original input JSONL")
    coll.add_argument("--output", required=True, help="Output annotated JSONL")

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        print("\nExamples:")
        print("  # Quick test (5 samples)")
        print("  GEMINI_API_KEY=xxx python scripts/annotate_cot_gemini.py annotate \\")
        print("    --input data/combined_train.jsonl --output /tmp/cot_test.jsonl --max_samples 5")
        print()
        print("  # Full run (async, ~1-2 hours)")
        print("  python scripts/annotate_cot_gemini.py annotate \\")
        print("    --input data/combined_train.jsonl --output data/combined_train_cot.jsonl")
        print()
        print("  # Full run (batch, 50% discount, ~24h)")
        print("  python scripts/annotate_cot_gemini.py annotate --mode batch \\")
        print("    --input data/combined_train.jsonl --output data/combined_train_cot.jsonl")
        return

    if not os.environ.get("GEMINI_API_KEY"):
        logger.error("Set the GEMINI_API_KEY environment variable first.")
        logger.error("  export GEMINI_API_KEY='your-api-key-here'")
        sys.exit(1)

    if args.command == "collect":
        collect_batch_results(args.meta, args.input, args.output)
        return

    # --- Load data ---
    logger.info("Loading samples from %s", args.input)
    with open(args.input) as f:
        samples = [json.loads(line) for line in f]
    logger.info("Loaded %d samples", len(samples))

    if args.max_samples > 0:
        samples = samples[: args.max_samples]
        logger.info("Capped to %d samples", len(samples))

    skip = 0
    if args.resume:
        skip = load_done_count(args.output)
        if skip > 0:
            samples = samples[skip:]
            logger.info("Resuming from line %d, %d remaining", skip, len(samples))

    if not samples:
        logger.info("Nothing to process.")
        return

    avg_img_kb = 50
    est_input_tokens = len(samples) * 350
    est_output_tokens = len(samples) * 200
    est_cost_full = est_input_tokens * 0.10 / 1e6 + est_output_tokens * 0.40 / 1e6
    est_cost_batch = est_cost_full * 0.5
    logger.info("Estimated cost: $%.1f (async) / $%.1f (batch 50%% off)", est_cost_full, est_cost_batch)
    logger.info("Mode: %s | Model: %s | Samples: %d", args.mode, MODEL, len(samples))

    if args.mode == "async":
        asyncio.run(run_async(samples, args.output, args.concurrency, args.use_thinking))
    else:
        run_batch(samples, args.output, args.batch_size)


if __name__ == "__main__":
    main()
