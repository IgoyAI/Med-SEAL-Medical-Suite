#!/usr/bin/env python3
"""Phase 1: LoRA SFT on medical VQA data with Qwen3-VL-8B-Thinking.

Fine-tunes Qwen3-VL-8B-Thinking with LoRA adapters on the combined medical VQA
dataset (PathVQA + VQA-RAD + PubMedVision + MIMIC-CXR) using the Hugging Face
Trainer with DeepSpeed ZeRO-2 for multi-GPU training.

The vision encoder is frozen; only the language model's attention and MLP
projections receive LoRA adapters.

Usage
-----
Single-GPU (for debugging)::

    python scripts/train_phase1.py \\
        --model_name_or_path Qwen/Qwen3-VL-8B-Thinking \\
        --data_path data/combined_train.jsonl \\
        --output_dir checkpoints/phase1 \\
        --bf16 --gradient_checkpointing \\
        --per_device_train_batch_size 2 \\
        --num_train_epochs 2

Multi-GPU with DeepSpeed (production)::

    deepspeed --num_gpus=3 scripts/train_phase1.py configs/phase1_config.yaml

YAML / JSON config file::

    python scripts/train_phase1.py configs/phase1_config.yaml
"""

from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import torch
from peft import LoraConfig, TaskType, get_peft_model
from transformers import (
    AutoProcessor,
    HfArgumentParser,
    Qwen3VLForConditionalGeneration,
    Trainer,
    TrainingArguments,
)
from transformers.trainer_utils import get_last_checkpoint

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data.medical_dataset import MedicalVQACollator, MedicalVQADataset

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Argument dataclasses
# ---------------------------------------------------------------------------


@dataclass
class ModelArguments:
    """Base model loading and LoRA configuration."""

    model_name_or_path: str = field(
        default="Qwen/Qwen3-VL-8B-Thinking",
        metadata={"help": "Base model path or HuggingFace hub ID."},
    )
    trust_remote_code: bool = field(default=True)
    torch_dtype: str = field(
        default="bfloat16",
        metadata={"help": "Model weight dtype: bfloat16 | float16 | float32."},
    )
    attn_implementation: Optional[str] = field(
        default="flash_attention_2",
        metadata={
            "help": (
                "Attention backend. Set to 'flash_attention_2' for FA2, "
                "'sdpa' for PyTorch SDPA, or leave empty for the default."
            )
        },
    )
    freeze_vision: bool = field(
        default=True,
        metadata={"help": "Freeze the vision encoder (train only the LLM)."},
    )
    lora_r: int = field(default=64, metadata={"help": "LoRA rank."})
    lora_alpha: int = field(default=128, metadata={"help": "LoRA scaling factor."})
    lora_dropout: float = field(default=0.05, metadata={"help": "LoRA dropout rate."})
    lora_target_modules: str = field(
        default="q_proj,k_proj,v_proj,o_proj,gate_proj,up_proj,down_proj",
        metadata={"help": "Comma-separated LoRA target module names."},
    )
    min_pixels: int = field(
        default=256 * 28 * 28,
        metadata={"help": "Minimum pixel budget for Qwen3-VL image resizing."},
    )
    max_pixels: int = field(
        default=1280 * 28 * 28,
        metadata={"help": "Maximum pixel budget for Qwen3-VL image resizing."},
    )


@dataclass
class DataArguments:
    """Dataset configuration."""

    data_path: str = field(
        metadata={"help": "Path to training JSONL (e.g. data/combined_train.jsonl)."},
    )
    max_length: int = field(
        default=2048,
        metadata={"help": "Maximum sequence length (text + image tokens)."},
    )
    system_message: Optional[str] = field(
        default=None,
        metadata={"help": "Optional system prompt prepended to every conversation."},
    )
    max_samples: Optional[int] = field(
        default=None,
        metadata={"help": "Cap dataset size (useful for debugging / dry-runs)."},
    )


_DTYPE_MAP = {
    "bfloat16": torch.bfloat16,
    "float16": torch.float16,
    "float32": torch.float32,
}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    # ---- Parse arguments ------------------------------------------------
    parser = HfArgumentParser((ModelArguments, DataArguments, TrainingArguments))

    config_file = None
    for arg in sys.argv[1:]:
        if not arg.startswith("-") and arg.endswith((".yaml", ".yml", ".json")):
            config_file = arg
            break

    if config_file is not None and config_file.endswith((".yaml", ".yml")):
        model_args, data_args, training_args = parser.parse_yaml_file(
            os.path.abspath(config_file)
        )
    elif config_file is not None and config_file.endswith(".json"):
        model_args, data_args, training_args = parser.parse_json_file(
            os.path.abspath(config_file)
        )
    else:
        model_args, data_args, training_args = parser.parse_args_into_dataclasses()

    # ---- Logging --------------------------------------------------------
    logging.basicConfig(
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        level=(
            logging.INFO
            if training_args.local_rank in (-1, 0)
            else logging.WARNING
        ),
    )
    logger.info("Model args: %s", model_args)
    logger.info("Data args:  %s", data_args)
    logger.info("Training args: %s", training_args)

    # ---- Checkpoint detection -------------------------------------------
    last_checkpoint = None
    if os.path.isdir(training_args.output_dir):
        last_checkpoint = get_last_checkpoint(training_args.output_dir)
        if last_checkpoint is not None:
            logger.info("Found existing checkpoint — will resume from %s", last_checkpoint)

    # ---- Processor ------------------------------------------------------
    processor = AutoProcessor.from_pretrained(
        model_args.model_name_or_path,
        trust_remote_code=model_args.trust_remote_code,
        min_pixels=model_args.min_pixels,
        max_pixels=model_args.max_pixels,
    )
    if processor.tokenizer.pad_token_id is None:
        processor.tokenizer.pad_token = processor.tokenizer.eos_token

    # ---- Base model -----------------------------------------------------
    torch_dtype = _DTYPE_MAP.get(model_args.torch_dtype, torch.bfloat16)

    model_kwargs: dict = dict(
        torch_dtype=torch_dtype,
        trust_remote_code=model_args.trust_remote_code,
    )
    if model_args.attn_implementation:
        model_kwargs["attn_implementation"] = model_args.attn_implementation

    logger.info("Loading base model from %s ...", model_args.model_name_or_path)
    model = Qwen3VLForConditionalGeneration.from_pretrained(
        model_args.model_name_or_path, **model_kwargs
    )

    # ---- Freeze vision encoder ------------------------------------------
    if model_args.freeze_vision:
        frozen = 0
        for name, param in model.named_parameters():
            if "visual" in name:
                param.requires_grad = False
                frozen += 1
        logger.info("Froze %d vision-encoder parameters", frozen)

    # ---- Gradient checkpointing -----------------------------------------
    if training_args.gradient_checkpointing:
        model.enable_input_require_grads()
        if training_args.gradient_checkpointing_kwargs is None:
            training_args.gradient_checkpointing_kwargs = {"use_reentrant": False}

    # ---- LoRA -----------------------------------------------------------
    target_modules = [m.strip() for m in model_args.lora_target_modules.split(",")]
    lora_config = LoraConfig(
        r=model_args.lora_r,
        lora_alpha=model_args.lora_alpha,
        lora_dropout=model_args.lora_dropout,
        target_modules=target_modules,
        task_type=TaskType.CAUSAL_LM,
        bias="none",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    # ---- Safety: keep multimodal columns --------------------------------
    if training_args.remove_unused_columns:
        logger.warning(
            "Overriding remove_unused_columns to False — required for "
            "pixel_values / image_grid_thw."
        )
        training_args.remove_unused_columns = False

    # ---- Dataset --------------------------------------------------------
    train_dataset = MedicalVQADataset(
        jsonl_path=data_args.data_path,
        processor=processor,
        max_length=data_args.max_length,
        system_message=data_args.system_message,
        max_samples=data_args.max_samples,
    )
    logger.info("Training dataset: %d samples", len(train_dataset))

    collator = MedicalVQACollator(pad_token_id=processor.tokenizer.pad_token_id)

    # ---- Trainer --------------------------------------------------------
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        data_collator=collator,
    )

    # ---- Train ----------------------------------------------------------
    logger.info("Starting Phase 1 LoRA SFT training ...")
    train_result = trainer.train(resume_from_checkpoint=last_checkpoint)

    # ---- Save model & metrics -------------------------------------------
    trainer.save_model()
    trainer.save_state()

    metrics = train_result.metrics
    metrics["train_samples"] = len(train_dataset)
    trainer.log_metrics("train", metrics)
    trainer.save_metrics("train", metrics)

    logger.info(
        "Phase 1 complete — LoRA adapters saved to %s",
        training_args.output_dir,
    )


if __name__ == "__main__":
    main()
