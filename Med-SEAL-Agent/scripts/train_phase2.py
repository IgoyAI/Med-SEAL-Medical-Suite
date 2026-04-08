#!/usr/bin/env python3
"""Phase 2: SEA-LION Knowledge Distillation for Med-SEAL.

Distills SEA language capabilities from Qwen-SEA-LION-v4-8B-VL (teacher)
into Med-SEAL v0 (student) using a combined CE + KL loss with selective
SEA-token masking.  The student receives new LoRA adapters on top of the
merged Med-SEAL v0 weights; the teacher is frozen.

Usage
-----
Single-GPU (debugging)::

    python scripts/train_phase2.py \\
        --student_model_path models/med-seal-v0 \\
        --teacher_model_path aisingapore/Qwen-SEA-LION-v4-8B-VL \\
        --sea_data_paths data/sea_medical_train.jsonl \\
        --output_dir checkpoints/phase2 \\
        --bf16 --gradient_checkpointing \\
        --per_device_train_batch_size 2 \\
        --num_train_epochs 2

Multi-GPU with DeepSpeed (production)::

    deepspeed --num_gpus=3 scripts/train_phase2.py configs/phase2_config.yaml

YAML / JSON config file::

    python scripts/train_phase2.py configs/phase2_config.yaml
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
    TrainingArguments,
)
from transformers.trainer_utils import get_last_checkpoint

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data.sea_distill_dataset import SEADistillCollator, SEADistillDataset
from src.trainers.distillation_trainer import DistillationTrainer

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Argument dataclasses
# ---------------------------------------------------------------------------


@dataclass
class ModelArguments:
    """Student / teacher model loading and LoRA configuration."""

    student_model_path: str = field(
        default="models/med-seal-v0",
        metadata={"help": "Path to the Med-SEAL v0 model (merged from Phase 1)."},
    )
    teacher_model_path: str = field(
        default="aisingapore/Qwen-SEA-LION-v4-8B-VL",
        metadata={"help": "Teacher model HuggingFace hub ID or local path."},
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
                "Attention backend. 'flash_attention_2' for FA2, "
                "'sdpa' for PyTorch SDPA, or empty for the default."
            )
        },
    )
    freeze_vision: bool = field(
        default=True,
        metadata={"help": "Freeze the vision encoder on the student model."},
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
    """Dataset configuration for Phase 2 distillation."""

    sea_data_paths: str = field(
        metadata={
            "help": (
                "Comma-separated paths to SEA language medical QA JSONL files."
            )
        },
    )
    english_replay_path: Optional[str] = field(
        default=None,
        metadata={
            "help": (
                "Path to English replay JSONL (e.g. data/combined_train.jsonl). "
                "Set to null to disable English replay."
            )
        },
    )
    english_ratio: float = field(
        default=0.2,
        metadata={"help": "Target fraction of English replay in the combined dataset."},
    )
    max_length: int = field(
        default=2048,
        metadata={"help": "Maximum sequence length (text + image tokens)."},
    )
    system_message: Optional[str] = field(
        default=None,
        metadata={"help": "Optional system prompt prepended to every conversation."},
    )
    max_sea_samples: Optional[int] = field(
        default=None,
        metadata={"help": "Cap SEA language samples (useful for debugging)."},
    )


@dataclass
class DistillArguments:
    """Knowledge distillation hyperparameters."""

    alpha: float = field(
        default=0.5,
        metadata={
            "help": "Weight for task (CE) loss.  Distillation (KL) weight is 1 - alpha."
        },
    )
    temperature: float = field(
        default=2.0,
        metadata={"help": "Softmax temperature for KL divergence computation."},
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
    parser = HfArgumentParser(
        (ModelArguments, DataArguments, DistillArguments, TrainingArguments)
    )

    config_file = None
    for arg in sys.argv[1:]:
        if not arg.startswith("-") and arg.endswith((".yaml", ".yml", ".json")):
            config_file = arg
            break

    if config_file is not None and config_file.endswith((".yaml", ".yml")):
        model_args, data_args, distill_args, training_args = parser.parse_yaml_file(
            os.path.abspath(config_file)
        )
    elif config_file is not None and config_file.endswith(".json"):
        model_args, data_args, distill_args, training_args = parser.parse_json_file(
            os.path.abspath(config_file)
        )
    else:
        model_args, data_args, distill_args, training_args = (
            parser.parse_args_into_dataclasses()
        )

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
    logger.info("Distill args: %s", distill_args)
    logger.info("Training args: %s", training_args)

    # ---- Checkpoint detection -------------------------------------------
    last_checkpoint = None
    if (
        os.path.isdir(training_args.output_dir)
        and not training_args.overwrite_output_dir
    ):
        last_checkpoint = get_last_checkpoint(training_args.output_dir)
        if last_checkpoint is not None:
            logger.info("Found existing checkpoint — will resume from %s", last_checkpoint)

    # ---- Shared config --------------------------------------------------
    torch_dtype = _DTYPE_MAP.get(model_args.torch_dtype, torch.bfloat16)

    model_kwargs: dict = dict(
        torch_dtype=torch_dtype,
        trust_remote_code=model_args.trust_remote_code,
    )
    if model_args.attn_implementation:
        model_kwargs["attn_implementation"] = model_args.attn_implementation

    # ---- Processor (from student) ---------------------------------------
    processor = AutoProcessor.from_pretrained(
        model_args.student_model_path,
        trust_remote_code=model_args.trust_remote_code,
        min_pixels=model_args.min_pixels,
        max_pixels=model_args.max_pixels,
    )
    if processor.tokenizer.pad_token_id is None:
        processor.tokenizer.pad_token = processor.tokenizer.eos_token

    # ---- Student model (Med-SEAL v0 + fresh LoRA) -----------------------
    logger.info("Loading student model from %s ...", model_args.student_model_path)
    student = Qwen3VLForConditionalGeneration.from_pretrained(
        model_args.student_model_path, **model_kwargs
    )

    if model_args.freeze_vision:
        frozen = 0
        for name, param in student.named_parameters():
            if "visual" in name:
                param.requires_grad = False
                frozen += 1
        logger.info("Froze %d vision-encoder parameters on student", frozen)

    if training_args.gradient_checkpointing:
        student.enable_input_require_grads()
        if training_args.gradient_checkpointing_kwargs is None:
            training_args.gradient_checkpointing_kwargs = {"use_reentrant": False}

    target_modules = [m.strip() for m in model_args.lora_target_modules.split(",")]
    lora_config = LoraConfig(
        r=model_args.lora_r,
        lora_alpha=model_args.lora_alpha,
        lora_dropout=model_args.lora_dropout,
        target_modules=target_modules,
        task_type=TaskType.CAUSAL_LM,
        bias="none",
    )
    student = get_peft_model(student, lora_config)
    student.print_trainable_parameters()

    # ---- Teacher model (frozen, inference only) -------------------------
    logger.info("Loading teacher model from %s ...", model_args.teacher_model_path)
    teacher = Qwen3VLForConditionalGeneration.from_pretrained(
        model_args.teacher_model_path, **model_kwargs
    )
    teacher.eval()
    for p in teacher.parameters():
        p.requires_grad = False
    logger.info("Teacher model loaded and frozen.")

    # ---- Safety: keep multimodal columns --------------------------------
    if training_args.remove_unused_columns:
        logger.warning(
            "Overriding remove_unused_columns to False — required for "
            "pixel_values / image_grid_thw / sea_token_mask."
        )
        training_args.remove_unused_columns = False

    # ---- Dataset --------------------------------------------------------
    sea_paths = [p.strip() for p in data_args.sea_data_paths.split(",")]
    train_dataset = SEADistillDataset(
        sea_data_paths=sea_paths,
        processor=processor,
        english_replay_path=data_args.english_replay_path,
        max_length=data_args.max_length,
        english_ratio=data_args.english_ratio,
        system_message=data_args.system_message,
        max_sea_samples=data_args.max_sea_samples,
    )
    logger.info(
        "Distillation dataset: %d total (%d SEA, %d English replay)",
        len(train_dataset),
        train_dataset.n_sea,
        train_dataset.n_english,
    )

    collator = SEADistillCollator(pad_token_id=processor.tokenizer.pad_token_id)

    # ---- Trainer --------------------------------------------------------
    trainer = DistillationTrainer(
        model=student,
        args=training_args,
        teacher_model=teacher,
        alpha=distill_args.alpha,
        temperature=distill_args.temperature,
        train_dataset=train_dataset,
        data_collator=collator,
    )

    # ---- Train ----------------------------------------------------------
    logger.info(
        "Starting Phase 2 distillation (alpha=%.2f, T=%.1f) ...",
        distill_args.alpha,
        distill_args.temperature,
    )
    train_result = trainer.train(resume_from_checkpoint=last_checkpoint)

    # ---- Save model & metrics -------------------------------------------
    trainer.save_model()
    trainer.save_state()

    metrics = train_result.metrics
    metrics["train_samples"] = len(train_dataset)
    metrics["n_sea_samples"] = train_dataset.n_sea
    metrics["n_english_samples"] = train_dataset.n_english
    trainer.log_metrics("train", metrics)
    trainer.save_metrics("train", metrics)

    logger.info(
        "Phase 2 complete — LoRA adapters saved to %s",
        training_args.output_dir,
    )


if __name__ == "__main__":
    main()
