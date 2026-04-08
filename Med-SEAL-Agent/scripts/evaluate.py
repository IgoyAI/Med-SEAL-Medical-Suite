#!/usr/bin/env python3
"""Evaluate Med-SEAL models on medical VQA and report generation benchmarks.

Supports three test sets prepared by ``scripts/prepare_datasets.py``:

* **PathVQA** (``data/pathvqa/test.jsonl``): pathology VQA accuracy.
* **VQA-RAD** (``data/vqarad/test.jsonl``): radiology VQA accuracy.
* **MIMIC-CXR** (``data/mimic-cxr/test.jsonl``): chest X-ray report generation
  evaluated with BLEU-1/4 and ROUGE-1/2/L.

Usage
-----
Evaluate a merged model on all available datasets::

    python scripts/evaluate.py \\
        --model_path models/med-seal-v0 \\
        --data_dir data/ \\
        --output_dir results/med-seal-v0

Evaluate the base model (for comparison)::

    python scripts/evaluate.py \\
        --model_path Qwen/Qwen3-VL-8B-Thinking \\
        --data_dir data/ \\
        --output_dir results/base-qwen3vl

Evaluate with un-merged LoRA adapters::

    python scripts/evaluate.py \\
        --model_path Qwen/Qwen3-VL-8B-Thinking \\
        --adapter_path checkpoints/phase1 \\
        --data_dir data/ \\
        --output_dir results/phase1-lora

Quick smoke test (5 samples per dataset)::

    python scripts/evaluate.py \\
        --model_path models/med-seal-v0 \\
        --data_dir data/ \\
        --output_dir results/debug \\
        --max_samples 5
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

import torch
from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

logger = logging.getLogger(__name__)

# Make ``src/`` importable when running from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.evaluation.eval_medical_vqa import evaluate_report_generation, evaluate_vqa

_DTYPE_MAP = {
    "bfloat16": torch.bfloat16,
    "float16": torch.float16,
    "float32": torch.float32,
}

DATASET_REGISTRY: dict[str, dict] = {
    "pathvqa": {
        "jsonl": "pathvqa/test.jsonl",
        "kind": "vqa",
        "max_new_tokens": 256,
    },
    "vqarad": {
        "jsonl": "vqarad/test.jsonl",
        "kind": "vqa",
        "max_new_tokens": 256,
    },
    "mimic-cxr": {
        "jsonl": "mimic-cxr/test.jsonl",
        "kind": "report",
        "max_new_tokens": 512,
    },
}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Evaluate Med-SEAL on PathVQA, VQA-RAD, and MIMIC-CXR.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    # Model
    p.add_argument(
        "--model_path",
        type=str,
        required=True,
        help="HF hub ID or local path to a merged model (e.g. models/med-seal-v0).",
    )
    p.add_argument(
        "--adapter_path",
        type=str,
        default=None,
        help=(
            "Optional path to a PEFT adapter checkpoint.  When provided, "
            "--model_path is treated as the base model and the adapter is "
            "loaded on top."
        ),
    )
    p.add_argument(
        "--dtype",
        type=str,
        default="bfloat16",
        choices=list(_DTYPE_MAP.keys()),
        help="Model weight dtype (default: bfloat16).",
    )
    p.add_argument(
        "--attn_implementation",
        type=str,
        default=None,
        help="Attention backend: flash_attention_2, sdpa, or omit for default.",
    )

    # Data
    p.add_argument(
        "--data_dir",
        type=str,
        default="data",
        help="Root data directory containing dataset subfolders (default: data/).",
    )
    p.add_argument(
        "--datasets",
        nargs="+",
        default=None,
        choices=list(DATASET_REGISTRY.keys()),
        help=(
            "Datasets to evaluate.  Default: all whose test JSONL exists in "
            "--data_dir."
        ),
    )
    p.add_argument(
        "--max_samples",
        type=int,
        default=None,
        help="Cap per-dataset sample count (useful for debugging).",
    )

    # Output
    p.add_argument(
        "--output_dir",
        type=str,
        default="results",
        help="Directory for result JSON files (default: results/).",
    )
    p.add_argument(
        "--save_predictions",
        action="store_true",
        default=True,
        help="Include per-sample predictions in the result JSON (default: True).",
    )
    p.add_argument(
        "--no_save_predictions",
        action="store_true",
        default=False,
        help="Exclude per-sample predictions from the result JSON.",
    )

    # Hardware
    p.add_argument(
        "--device",
        type=str,
        default=None,
        help="Device for inference (default: cuda if available, else cpu).",
    )

    # Vision processor
    p.add_argument(
        "--min_pixels",
        type=int,
        default=256 * 28 * 28,
        help="Minimum pixel budget for Qwen3-VL image resizing.",
    )
    p.add_argument(
        "--max_pixels",
        type=int,
        default=1280 * 28 * 28,
        help="Maximum pixel budget for Qwen3-VL image resizing.",
    )

    return p.parse_args()


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------


def load_model_and_processor(args: argparse.Namespace):
    """Load the Qwen3-VL model (optionally with PEFT adapters) and processor."""
    torch_dtype = _DTYPE_MAP.get(args.dtype, torch.bfloat16)

    model_kwargs: dict = dict(
        torch_dtype=torch_dtype,
        trust_remote_code=True,
        device_map="auto",
    )
    if args.attn_implementation:
        model_kwargs["attn_implementation"] = args.attn_implementation

    logger.info("Loading model from %s (dtype=%s) ...", args.model_path, args.dtype)
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        args.model_path, **model_kwargs
    )

    if args.adapter_path is not None:
        from peft import PeftModel

        logger.info("Loading PEFT adapter from %s ...", args.adapter_path)
        model = PeftModel.from_pretrained(
            model, args.adapter_path, torch_dtype=torch_dtype
        )
        model = model.merge_and_unload()
        logger.info("Adapter merged into base model for inference.")

    model.eval()

    processor = AutoProcessor.from_pretrained(
        args.model_path,
        trust_remote_code=True,
        min_pixels=args.min_pixels,
        max_pixels=args.max_pixels,
    )
    if processor.tokenizer.pad_token_id is None:
        processor.tokenizer.pad_token = processor.tokenizer.eos_token

    return model, processor


# ---------------------------------------------------------------------------
# Result helpers
# ---------------------------------------------------------------------------


def _fmt_pct(value: float) -> str:
    return f"{value * 100:.2f}%"


def _print_vqa_results(name: str, results: dict) -> None:
    logger.info("=" * 60)
    logger.info("  %s  --  VQA Accuracy", name.upper())
    logger.info("=" * 60)
    logger.info("  Overall   : %s  (%d / %d)", _fmt_pct(results["accuracy"]), results["correct"], results["total"])
    logger.info("  Yes/No    : %s  (%d / %d)", _fmt_pct(results["yes_no_accuracy"]), results["yes_no_correct"], results["yes_no_total"])
    logger.info("  Open-ended: %s  (%d / %d)", _fmt_pct(results["open_accuracy"]), results["open_correct"], results["open_total"])
    logger.info("  Open F1   : %s", _fmt_pct(results.get("open_token_f1", 0.0)))
    logger.info("=" * 60)


def _print_report_results(name: str, results: dict) -> None:
    logger.info("=" * 60)
    logger.info("  %s  --  Report Generation", name.upper())
    logger.info("=" * 60)
    logger.info("  Samples : %d", results.get("num_samples", 0))
    logger.info("  BLEU-1  : %.4f", results.get("bleu_1", 0.0))
    logger.info("  BLEU-4  : %.4f", results.get("bleu_4", 0.0))
    logger.info("  ROUGE-1 : %.4f", results.get("rouge1", 0.0))
    logger.info("  ROUGE-2 : %.4f", results.get("rouge2", 0.0))
    logger.info("  ROUGE-L : %.4f", results.get("rougeL", 0.0))
    logger.info("=" * 60)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    args = parse_args()

    logging.basicConfig(
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        level=logging.INFO,
    )

    data_dir = Path(args.data_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    save_predictions = args.save_predictions and not args.no_save_predictions

    device = args.device
    if device is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
    logger.info("Inference device: %s", device)

    # Determine which datasets to run
    requested = args.datasets or list(DATASET_REGISTRY.keys())
    to_eval: list[tuple[str, dict, Path]] = []
    for ds_name in requested:
        info = DATASET_REGISTRY[ds_name]
        jsonl_path = data_dir / info["jsonl"]
        if not jsonl_path.exists():
            logger.warning(
                "Test JSONL not found for %s at %s -- skipping.", ds_name, jsonl_path
            )
            continue
        to_eval.append((ds_name, info, jsonl_path))

    if not to_eval:
        logger.error(
            "No test datasets found in %s.  Run scripts/prepare_datasets.py first.",
            data_dir,
        )
        sys.exit(1)

    logger.info(
        "Will evaluate on: %s", ", ".join(name for name, _, _ in to_eval)
    )

    # Load model
    model, processor = load_model_and_processor(args)

    # Run evaluations
    all_results: dict[str, dict] = {}
    for ds_name, info, jsonl_path in to_eval:
        logger.info("--- Evaluating %s ---", ds_name)
        t0 = time.time()

        if info["kind"] == "vqa":
            results = evaluate_vqa(
                model,
                processor,
                jsonl_path,
                max_new_tokens=info["max_new_tokens"],
                max_samples=args.max_samples,
                device=device,
            )
            _print_vqa_results(ds_name, results)
        else:
            results = evaluate_report_generation(
                model,
                processor,
                jsonl_path,
                max_new_tokens=info["max_new_tokens"],
                max_samples=args.max_samples,
                device=device,
            )
            _print_report_results(ds_name, results)

        elapsed = time.time() - t0
        results["elapsed_seconds"] = round(elapsed, 1)
        logger.info("%s evaluation completed in %.1fs", ds_name, elapsed)

        if not save_predictions:
            results.pop("predictions", None)

        all_results[ds_name] = results

        # Save per-dataset result
        ds_out = output_dir / f"{ds_name}_results.json"
        with open(ds_out, "w", encoding="utf-8") as fh:
            json.dump(results, fh, indent=2, ensure_ascii=False, default=str)
        logger.info("Saved %s results -> %s", ds_name, ds_out)

    # Save combined summary
    summary: dict = {
        "model_path": args.model_path,
        "adapter_path": args.adapter_path,
        "datasets": {},
    }
    for ds_name, results in all_results.items():
        info = DATASET_REGISTRY[ds_name]
        entry: dict = {"elapsed_seconds": results.get("elapsed_seconds", 0)}
        if info["kind"] == "vqa":
            entry.update(
                {
                    "accuracy": results["accuracy"],
                    "yes_no_accuracy": results["yes_no_accuracy"],
                    "open_accuracy": results["open_accuracy"],
                    "total": results["total"],
                }
            )
        else:
            for k in ("bleu_1", "bleu_4", "rouge1", "rouge2", "rougeL", "num_samples"):
                entry[k] = results.get(k, 0)
        summary["datasets"][ds_name] = entry

    summary_path = output_dir / "summary.json"
    with open(summary_path, "w", encoding="utf-8") as fh:
        json.dump(summary, fh, indent=2, ensure_ascii=False)
    logger.info("Combined summary -> %s", summary_path)

    # Print final summary table
    logger.info("")
    logger.info("=" * 60)
    logger.info("  EVALUATION SUMMARY")
    logger.info("=" * 60)
    logger.info("  Model: %s", args.model_path)
    if args.adapter_path:
        logger.info("  Adapter: %s", args.adapter_path)
    logger.info("-" * 60)
    for ds_name, entry in summary["datasets"].items():
        info = DATASET_REGISTRY[ds_name]
        if info["kind"] == "vqa":
            logger.info(
                "  %-12s  accuracy=%s  (yn=%s, open=%s, open_f1=%s)  [%d samples, %.1fs]",
                ds_name,
                _fmt_pct(entry["accuracy"]),
                _fmt_pct(entry["yes_no_accuracy"]),
                _fmt_pct(entry["open_accuracy"]),
                _fmt_pct(entry.get("open_token_f1", 0.0)),
                entry["total"],
                entry["elapsed_seconds"],
            )
        else:
            logger.info(
                "  %-12s  BLEU-1=%.4f  BLEU-4=%.4f  R1=%.4f  R2=%.4f  RL=%.4f  [%d samples, %.1fs]",
                ds_name,
                entry.get("bleu_1", 0),
                entry.get("bleu_4", 0),
                entry.get("rouge1", 0),
                entry.get("rouge2", 0),
                entry.get("rougeL", 0),
                entry.get("num_samples", 0),
                entry["elapsed_seconds"],
            )
    logger.info("=" * 60)
    logger.info("Results saved to: %s", output_dir)


if __name__ == "__main__":
    main()
