#!/usr/bin/env python3
"""Merge Phase 1 LoRA adapters into base Qwen3-VL-8B-Thinking -> Med-SEAL v0.

Loads the base model and the PEFT adapter checkpoint produced by Phase 1 SFT,
merges the LoRA weights into the base weights, and saves the resulting full
model (with processor) to a new directory.

Usage
-----
Default paths (base model from HF cache, adapters from checkpoints/phase1)::

    python scripts/merge_lora.py

Custom paths::

    python scripts/merge_lora.py \
        --base_model Qwen/Qwen3-VL-8B-Thinking \
        --adapter_path checkpoints/phase1 \
        --output_dir models/med-seal-v0 \
        --dtype bfloat16
"""

from __future__ import annotations

import argparse
import logging
import shutil
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

logger = logging.getLogger(__name__)

_DTYPE_MAP = {
    "bfloat16": torch.bfloat16,
    "float16": torch.float16,
    "float32": torch.float32,
}

DEFAULT_BASE_MODEL = "Qwen/Qwen3-VL-8B-Thinking"
DEFAULT_ADAPTER_PATH = "checkpoints/phase1"
DEFAULT_OUTPUT_DIR = "models/med-seal-v0"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Merge Phase 1 LoRA adapters into the base model."
    )
    parser.add_argument(
        "--base_model",
        type=str,
        default=DEFAULT_BASE_MODEL,
        help="Base model HF hub ID or local path.",
    )
    parser.add_argument(
        "--adapter_path",
        type=str,
        default=DEFAULT_ADAPTER_PATH,
        help="Path to the PEFT adapter checkpoint (output_dir from Phase 1).",
    )
    parser.add_argument(
        "--output_dir",
        type=str,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory to save the merged Med-SEAL v0 model.",
    )
    parser.add_argument(
        "--dtype",
        type=str,
        default="bfloat16",
        choices=list(_DTYPE_MAP.keys()),
        help="Dtype to load and save the model in.",
    )
    parser.add_argument(
        "--trust_remote_code",
        action="store_true",
        default=True,
        help="Trust remote code when loading model/processor.",
    )
    parser.add_argument(
        "--safe_serialization",
        action="store_true",
        default=True,
        help="Save in safetensors format (default: True).",
    )
    parser.add_argument(
        "--no_safe_serialization",
        action="store_true",
        default=False,
        help="Disable safetensors, save as .bin files instead.",
    )
    parser.add_argument(
        "--max_shard_size",
        type=str,
        default="5GB",
        help="Max shard size for model weight files.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    logging.basicConfig(
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        level=logging.INFO,
    )

    adapter_path = Path(args.adapter_path)
    output_dir = Path(args.output_dir)
    torch_dtype = _DTYPE_MAP[args.dtype]
    safe_serialization = not args.no_safe_serialization and args.safe_serialization

    if not adapter_path.exists():
        raise FileNotFoundError(
            f"Adapter checkpoint not found at {adapter_path}. "
            "Run Phase 1 training first."
        )

    adapter_config_file = adapter_path / "adapter_config.json"
    if not adapter_config_file.exists():
        raise FileNotFoundError(
            f"No adapter_config.json found in {adapter_path}. "
            "Ensure this is a valid PEFT checkpoint directory."
        )

    output_dir.mkdir(parents=True, exist_ok=True)

    # -- Load base model ---------------------------------------------------
    logger.info("Loading base model: %s (dtype=%s) ...", args.base_model, args.dtype)
    base_model = Qwen3VLForConditionalGeneration.from_pretrained(
        args.base_model,
        torch_dtype=torch_dtype,
        trust_remote_code=args.trust_remote_code,
        device_map="cpu",
    )

    # -- Load LoRA adapters ------------------------------------------------
    logger.info("Loading PEFT adapters from: %s ...", adapter_path)
    model = PeftModel.from_pretrained(
        base_model,
        str(adapter_path),
        torch_dtype=torch_dtype,
    )

    # -- Merge & unload ----------------------------------------------------
    logger.info("Merging LoRA weights into base model ...")
    model = model.merge_and_unload()
    logger.info("Merge complete.")

    # -- Save merged model -------------------------------------------------
    logger.info(
        "Saving merged model to %s (safe_serialization=%s, max_shard_size=%s) ...",
        output_dir,
        safe_serialization,
        args.max_shard_size,
    )
    model.save_pretrained(
        str(output_dir),
        safe_serialization=safe_serialization,
        max_shard_size=args.max_shard_size,
    )

    # -- Save processor/tokenizer ------------------------------------------
    logger.info("Saving processor and tokenizer ...")
    processor = AutoProcessor.from_pretrained(
        args.base_model,
        trust_remote_code=args.trust_remote_code,
    )
    processor.save_pretrained(str(output_dir))

    # -- Copy adapter config for provenance --------------------------------
    provenance_dir = output_dir / "adapter_provenance"
    provenance_dir.mkdir(exist_ok=True)
    for fname in ("adapter_config.json", "README.md"):
        src = adapter_path / fname
        if src.exists():
            shutil.copy2(str(src), str(provenance_dir / fname))
    logger.info("Adapter config copied to %s for provenance.", provenance_dir)

    logger.info(
        "Done! Med-SEAL v0 saved to: %s",
        output_dir.resolve(),
    )


if __name__ == "__main__":
    main()
