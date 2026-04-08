"""Annotate training data with Chain-of-Thought reasoning.

For each (image, question, answer) sample, a teacher model generates a
<think>...</think> reasoning block.  The original ground-truth answer is
preserved; only the reasoning is prepended.

Supports three modes:
  local  -- load model directly on GPU (single-GPU, simple)
  vllm   -- send async requests to a vLLM/SGLang OpenAI-compatible server
  shard  -- split data across multiple local-mode GPUs

Usage (vLLM mode, recommended for large models):
    # Terminal 1: start vLLM server
    vllm serve /path/to/model --tensor-parallel-size 8 --port 8000

    # Terminal 2: run annotation
    python scripts/annotate_cot.py \\
        --input  data/combined_train.jsonl \\
        --output data/combined_train_cot.jsonl \\
        --mode vllm \\
        --concurrency 64

Usage (local mode, single GPU):
    CUDA_VISIBLE_DEVICES=0 python scripts/annotate_cot.py \\
        --input  data/combined_train.jsonl \\
        --output data/combined_train_cot.jsonl \\
        --mode local \\
        --model Qwen/Qwen3-VL-8B-Thinking

Usage (shard mode, multi-GPU local):
    for i in 0 1 2 3; do
        CUDA_VISIBLE_DEVICES=$i python scripts/annotate_cot.py \\
            --input data/combined_train.jsonl \\
            --output data/cot_part${i}.jsonl \\
            --mode local --shard $i/4 &
    done
    wait
    cat data/cot_part{0,1,2,3}.jsonl > data/combined_train_cot.jsonl
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
import time
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

THINK_RE = re.compile(r"(<think>.*?</think>)", flags=re.DOTALL)

SYSTEM_PROMPT = (
    "You are a medical imaging expert. Given a medical image and a question, "
    "reason step by step about what you observe and the relevant medical "
    "knowledge. Then provide the answer."
)


def extract_thinking(text: str) -> str | None:
    """Return the <think>...</think> block, or None if absent."""
    m = THINK_RE.search(text)
    return m.group(1) if m else None


def load_done_count(path: str) -> int:
    p = Path(path)
    if not p.exists():
        return 0
    with open(p) as f:
        return sum(1 for _ in f)


def encode_image_b64(path: str) -> tuple[str, str]:
    """Return (base64_data, mime_type) for a local image file."""
    mime, _ = mimetypes.guess_type(path)
    if mime is None:
        mime = "image/jpeg"
    with open(path, "rb") as f:
        return base64.standard_b64encode(f.read()).decode("ascii"), mime


# ---------------------------------------------------------------------------
# vLLM mode (async requests to OpenAI-compatible server)
# ---------------------------------------------------------------------------

async def vllm_process_one(
    client,
    model_name: str,
    idx: int,
    sample: dict,
    semaphore: asyncio.Semaphore,
    max_tokens: int,
    max_retries: int = 5,
) -> dict:
    """Send one sample to vLLM server and return annotated sample."""
    convos = sample["conversations"]
    question = convos[0]["content"]
    gt_answer = convos[1]["content"]
    image_path = sample.get("image", "")

    clean_q = question.replace("<image>", "").strip()

    content: list = []
    if image_path and os.path.isfile(image_path):
        b64, mime = encode_image_b64(image_path)
        content.append({
            "type": "image_url",
            "image_url": {"url": f"data:{mime};base64,{b64}"},
        })
    content.append({"type": "text", "text": clean_q})

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": content},
    ]

    thinking = None
    for attempt in range(max_retries):
        try:
            async with semaphore:
                response = await client.chat.completions.create(
                    model=model_name,
                    messages=messages,
                    max_tokens=max_tokens,
                    temperature=0.6,
                    top_p=0.95,
                    extra_body={"top_k": 20},
                )
            text = response.choices[0].message.content or ""

            reasoning_content = getattr(response.choices[0].message, "reasoning_content", None)
            if reasoning_content:
                thinking = f"<think>\n{reasoning_content.strip()}\n</think>"
            else:
                thinking = extract_thinking(text)
                if not thinking and text.strip():
                    thinking = f"<think>\n{text.strip()}\n</think>"
            break

        except Exception as e:
            err = str(e)
            wait = min(2 ** attempt * 2, 60)
            if "429" in err or "503" in err or "overloaded" in err.lower():
                wait = min(2 ** attempt * 5, 120)
                logger.warning("[%d] Server busy, wait %.0fs (attempt %d)", idx, wait, attempt + 1)
            else:
                logger.warning("[%d] %s, wait %.0fs (attempt %d)", idx, err[:120], wait, attempt + 1)
            await asyncio.sleep(wait)

    if thinking and len(thinking) > 30:
        new_answer = f"{thinking}\n\n{gt_answer}"
    else:
        new_answer = gt_answer

    return {
        "image": image_path,
        "conversations": [
            {"role": "user", "content": question},
            {"role": "assistant", "content": new_answer},
        ],
    }


async def run_vllm(
    samples: list[dict],
    output_path: str,
    api_base: str,
    model_name: str,
    concurrency: int,
    max_tokens: int,
):
    """Process all samples via async requests to vLLM server."""
    from openai import AsyncOpenAI

    client = AsyncOpenAI(base_url=api_base, api_key="EMPTY")
    semaphore = asyncio.Semaphore(concurrency)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    total = len(samples)
    success = 0
    fail = 0
    t0 = time.time()

    FLUSH_EVERY = 100

    with open(out, "a") as fout:
        for chunk_start in range(0, total, FLUSH_EVERY):
            chunk = samples[chunk_start : chunk_start + FLUSH_EVERY]
            tasks = [
                vllm_process_one(client, model_name, chunk_start + j, s, semaphore, max_tokens)
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
                if has_cot:
                    success += 1
                else:
                    fail += 1
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
        "Done. %d total, %d with CoT (%.1f%%), %d fallback. %.0fs (%.1f/s) -> %s",
        total, success, 100 * success / max(total, 1), fail,
        elapsed, total / max(elapsed, 1), output_path,
    )


# ---------------------------------------------------------------------------
# Local mode (load model on GPU, process sequentially)
# ---------------------------------------------------------------------------

def run_local(
    samples: list[dict],
    output_path: str,
    model_name: str,
    max_tokens: int,
    resume: bool,
):
    """Process samples by loading the model locally on GPU."""
    import torch
    from PIL import Image
    from tqdm import tqdm
    from transformers import AutoModelForCausalLM, AutoProcessor

    done = 0
    if resume and Path(output_path).exists():
        done = load_done_count(output_path)
        logger.info("Resuming: skipping %d already-processed samples", done)
        samples = samples[done:]

    if not samples:
        logger.info("Nothing to process.")
        return

    logger.info("Loading model %s ...", model_name)
    processor = AutoProcessor.from_pretrained(
        model_name,
        min_pixels=256 * 28 * 28,
        max_pixels=1280 * 28 * 28,
    )
    model = AutoModelForCausalLM.from_pretrained(
        model_name,
        torch_dtype=torch.bfloat16,
        attn_implementation="flash_attention_2",
        device_map="auto",
    )
    model.eval()
    logger.info("Model loaded on %s", model.device)

    success = 0
    fail = 0
    out_path = Path(output_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    file_mode = "a" if resume else "w"

    def build_prompt(question: str) -> list[dict]:
        if "<image>" in question:
            text_part = question.replace("<image>", "").strip()
            content = [{"type": "image"}, {"type": "text", "text": text_part}]
        else:
            content = [{"type": "text", "text": question}]
        return [{"role": "user", "content": content}]

    with open(out_path, file_mode) as fout:
        for sample in tqdm(samples, desc="Annotating CoT", initial=done):
            convos = sample["conversations"]
            question = convos[0]["content"]
            gt_answer = convos[1]["content"]
            image_path = sample.get("image", "")

            messages = build_prompt(question)
            has_image = any(
                item.get("type") == "image"
                for msg in messages for item in msg.get("content", [])
            )

            try:
                img = Image.open(image_path).convert("RGB") if has_image else None
            except Exception:
                img = None

            text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            inputs = processor(
                text=[text], images=[img] if img else None,
                padding=True, return_tensors="pt",
            ).to(model.device)

            with torch.no_grad():
                output_ids = model.generate(**inputs, max_new_tokens=max_tokens, do_sample=False)
            new_tokens = output_ids[:, inputs["input_ids"].shape[1]:]
            decoded = processor.batch_decode(new_tokens, skip_special_tokens=True)[0]

            thinking = extract_thinking(decoded)

            if thinking:
                new_answer = f"{thinking}\n\n{gt_answer}"
                success += 1
            else:
                new_answer = gt_answer
                fail += 1

            new_sample = {
                "image": image_path,
                "conversations": [
                    {"role": "user", "content": question},
                    {"role": "assistant", "content": new_answer},
                ],
            }
            fout.write(json.dumps(new_sample, ensure_ascii=False) + "\n")

            if (success + fail) % 1000 == 0:
                fout.flush()
                logger.info("Progress: %d done (%d CoT, %d fallback)", success + fail, success, fail)

    logger.info("Done! %d with CoT, %d without. Saved to %s", success, fail, output_path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Annotate medical VQA data with CoT reasoning",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--input", required=True, help="Input JSONL")
    parser.add_argument("--output", required=True, help="Output JSONL")
    parser.add_argument("--mode", choices=["vllm", "local"], default="vllm",
                        help="vllm = async requests to server (default); local = load on GPU")
    parser.add_argument("--model", default="/scratch/Projects/CFP-03/CFP03-CF-053/yogi/Qwen3.5-397B-A17B",
                        help="Model path or HF ID")
    parser.add_argument("--api_base", default="http://localhost:8000/v1",
                        help="vLLM server URL (vllm mode)")
    parser.add_argument("--concurrency", type=int, default=64,
                        help="Max concurrent requests (vllm mode)")
    parser.add_argument("--max_new_tokens", type=int, default=1024,
                        help="Max tokens for reasoning generation")
    parser.add_argument("--max_samples", type=int, default=0, help="0 = all")
    parser.add_argument("--shard", default=None, help="Shard spec like '0/4' (local mode)")
    parser.add_argument("--resume", action="store_true", help="Resume from partial output")

    args = parser.parse_args()

    logger.info("Loading samples from %s", args.input)
    with open(args.input) as f:
        samples = [json.loads(line) for line in f]
    logger.info("Loaded %d samples", len(samples))

    if args.shard:
        idx, total = map(int, args.shard.split("/"))
        chunk_size = (len(samples) + total - 1) // total
        start = idx * chunk_size
        end = min(start + chunk_size, len(samples))
        samples = samples[start:end]
        logger.info("Shard %d/%d: samples %d-%d (%d total)", idx, total, start, end - 1, len(samples))

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

    logger.info("Mode: %s | Model: %s | Samples: %d", args.mode, args.model, len(samples))

    if args.mode == "vllm":
        asyncio.run(run_vllm(
            samples, args.output, args.api_base, args.model,
            args.concurrency, args.max_new_tokens,
        ))
    else:
        run_local(samples, args.output, args.model, args.max_new_tokens, args.resume)


if __name__ == "__main__":
    main()
