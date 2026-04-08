#!/usr/bin/env python3
"""Translate English medical VQA data into SEA languages using a local vLLM server.

Reads the English training JSONL, translates each (question, answer) pair into
one or more SEA languages, and writes the results as a new JSONL with a
``"language"`` field suitable for Phase 2 distillation.

Prerequisites
-------------
Start a vLLM server with a SEA-capable model::

    vllm serve aisingapore/Gemma-SEA-LION-v4-27B-IT \
        --tensor-parallel-size 1 --port 8000 --dtype bfloat16

Usage
-----
Translate into Indonesian, Thai, and Vietnamese::

    python scripts/translate_sea.py \
        --input data/combined_train_cot.jsonl \
        --output data/sea_medical_train.jsonl \
        --languages id,th,vi \
        --max_samples 5000

Translate into all supported languages::

    python scripts/translate_sea.py \
        --input data/combined_train_cot.jsonl \
        --output data/sea_medical_train.jsonl \
        --languages all

Resume an interrupted run::

    python scripts/translate_sea.py \
        --input data/combined_train_cot.jsonl \
        --output data/sea_medical_train.jsonl \
        --languages id,th,vi \
        --resume
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path

from openai import AsyncOpenAI

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

LANGUAGE_MAP = {
    "id": "Indonesian",
    "ms": "Malay",
    "th": "Thai",
    "vi": "Vietnamese",
    "tl": "Filipino/Tagalog",
    "my": "Burmese",
    "km": "Khmer",
    "lo": "Lao",
    "jv": "Javanese",
    "su": "Sundanese",
}

SYSTEM_PROMPT = (
    "You are a professional medical translator. Translate the given medical "
    "question and answer accurately into {language}. Keep medical terminology "
    "precise. Preserve the original meaning exactly. Do NOT add explanations.\n\n"
    "Output ONLY valid JSON with two keys: \"question\" and \"answer\"."
)

USER_TEMPLATE = (
    "Translate the following into {language}.\n\n"
    "Question: {question}\n"
    "Answer: {answer}\n\n"
    "Output JSON:"
)


def strip_think_tags(text: str) -> str:
    """Remove <think>...</think> blocks from CoT answers for translation."""
    return re.sub(r"<think>.*?</think>\s*", "", text, flags=re.DOTALL).strip()


def parse_translation(response_text: str) -> dict | None:
    """Extract question/answer from model response, handling various formats."""
    text = response_text.strip()

    if text.startswith("```"):
        text = re.sub(r"^```\w*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
        text = text.strip()

    try:
        parsed = json.loads(text)
        if "question" in parsed and "answer" in parsed:
            return parsed
    except json.JSONDecodeError:
        pass

    match = re.search(r'\{[^{}]*"question"\s*:\s*".*?"[^{}]*"answer"\s*:\s*".*?"[^{}]*\}', text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group())
        except json.JSONDecodeError:
            pass

    return None


async def translate_one(
    client: AsyncOpenAI,
    model: str,
    sample: dict,
    lang_code: str,
    lang_name: str,
    semaphore: asyncio.Semaphore,
    max_retries: int = 4,
) -> dict | None:
    """Translate a single sample into the target language."""
    convos = sample["conversations"]
    question = convos[0]["content"].replace("<image>", "").replace("\n", " ").strip()
    answer = strip_think_tags(convos[1]["content"])

    system = SYSTEM_PROMPT.format(language=lang_name)
    user_msg = USER_TEMPLATE.format(language=lang_name, question=question, answer=answer)

    for attempt in range(max_retries):
        try:
            async with semaphore:
                response = await client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": system},
                        {"role": "user", "content": user_msg},
                    ],
                    temperature=0.3,
                    max_tokens=512,
                )

            text = response.choices[0].message.content or ""
            parsed = parse_translation(text)

            if parsed and len(parsed["question"]) > 3 and len(parsed["answer"]) > 0:
                orig_question = convos[0]["content"]
                if "<image>" in orig_question:
                    translated_q = f"<image>\n{parsed['question']}"
                else:
                    translated_q = parsed["question"]

                return {
                    "image": sample.get("image", ""),
                    "language": lang_code,
                    "conversations": [
                        {"role": "user", "content": translated_q},
                        {"role": "assistant", "content": parsed["answer"]},
                    ],
                }

        except Exception as e:
            err = str(e)
            wait = min(2 ** attempt * 2, 60)
            if "429" in err or "rate" in err.lower():
                wait = min(2 ** attempt * 5, 120)
            logger.warning("Attempt %d failed: %s, retrying in %.0fs", attempt + 1, err[:100], wait)
            await asyncio.sleep(wait)

    return None


async def run_translation(
    samples: list[dict],
    output_path: str,
    languages: list[str],
    model: str,
    api_base: str,
    concurrency: int,
):
    client = AsyncOpenAI(api_key="not-needed", base_url=api_base)
    semaphore = asyncio.Semaphore(concurrency)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    total_tasks = len(samples) * len(languages)
    success = 0
    fail = 0
    t0 = time.time()

    FLUSH_EVERY = 50

    with open(out, "a") as fout:
        for lang_code in languages:
            lang_name = LANGUAGE_MAP[lang_code]
            logger.info("Translating %d samples into %s (%s) ...", len(samples), lang_name, lang_code)

            for chunk_start in range(0, len(samples), FLUSH_EVERY):
                chunk = samples[chunk_start : chunk_start + FLUSH_EVERY]
                tasks = [
                    translate_one(client, model, s, lang_code, lang_name, semaphore)
                    for s in chunk
                ]
                results = await asyncio.gather(*tasks, return_exceptions=True)

                for r in results:
                    if isinstance(r, Exception):
                        logger.error("Unhandled: %s", r)
                        fail += 1
                    elif r is None:
                        fail += 1
                    else:
                        fout.write(json.dumps(r, ensure_ascii=False) + "\n")
                        success += 1
                fout.flush()

                done = success + fail
                elapsed = time.time() - t0
                rate = done / elapsed if elapsed > 0 else 0
                eta = (total_tasks - done) / rate if rate > 0 else 0
                logger.info(
                    "[%s] %d/%d | %.1f/s | ok=%d fail=%d | ETA %.0fm",
                    lang_code, chunk_start + len(chunk), len(samples),
                    rate, success, fail, eta / 60,
                )

    elapsed = time.time() - t0
    logger.info(
        "Done. %d translated (%d failed) in %.0fs (%.1f/s) -> %s",
        success, fail, elapsed, success / max(elapsed, 1), output_path,
    )


def main():
    parser = argparse.ArgumentParser(description="Translate medical VQA data into SEA languages")
    parser.add_argument("--input", required=True, help="Input English JSONL")
    parser.add_argument("--output", required=True, help="Output SEA JSONL")
    parser.add_argument(
        "--languages", default="id,th,vi",
        help="Comma-separated language codes, or 'all' (default: id,th,vi)",
    )
    parser.add_argument("--model", default=None, help="Model name on the vLLM server (auto-detected if omitted)")
    parser.add_argument("--api_base", default="http://localhost:8000/v1", help="vLLM API base URL")
    parser.add_argument("--concurrency", type=int, default=32, help="Max parallel requests")
    parser.add_argument("--max_samples", type=int, default=0, help="Limit samples (0 = all)")
    parser.add_argument("--resume", action="store_true", help="Resume from existing partial output")

    args = parser.parse_args()

    if args.languages == "all":
        languages = list(LANGUAGE_MAP.keys())
    else:
        languages = [l.strip() for l in args.languages.split(",")]
        for l in languages:
            if l not in LANGUAGE_MAP:
                logger.error("Unknown language code '%s'. Supported: %s", l, ", ".join(LANGUAGE_MAP.keys()))
                return

    logger.info("Target languages: %s", ", ".join(f"{l} ({LANGUAGE_MAP[l]})" for l in languages))

    if args.model is None:
        from openai import OpenAI
        client = OpenAI(api_key="not-needed", base_url=args.api_base)
        try:
            models = client.models.list()
            args.model = models.data[0].id
            logger.info("Auto-detected model: %s", args.model)
        except Exception as e:
            logger.error("Could not detect model from vLLM server at %s: %s", args.api_base, e)
            logger.error("Is the vLLM server running? Start it with:")
            logger.error("  vllm serve aisingapore/Gemma-SEA-LION-v4-27B-IT --port 8000 --dtype bfloat16")
            return

    logger.info("Loading samples from %s", args.input)
    with open(args.input) as f:
        samples = [json.loads(line) for line in f if line.strip()]
    logger.info("Loaded %d samples", len(samples))

    if args.max_samples > 0:
        samples = samples[:args.max_samples]
        logger.info("Capped to %d samples", len(samples))

    skip_samples = 0
    if args.resume:
        p = Path(args.output)
        if p.exists():
            with open(p) as f:
                existing = sum(1 for _ in f)
            skip_samples = existing // len(languages)
            if skip_samples > 0:
                samples = samples[skip_samples:]
                logger.info("Resuming: skipping %d already-translated samples, %d remaining", skip_samples, len(samples))

    if not samples:
        logger.info("Nothing to translate.")
        return

    total = len(samples) * len(languages)
    logger.info("Will translate %d samples x %d languages = %d total", len(samples), len(languages), total)

    asyncio.run(run_translation(
        samples, args.output, languages, args.model, args.api_base, args.concurrency,
    ))


if __name__ == "__main__":
    main()
