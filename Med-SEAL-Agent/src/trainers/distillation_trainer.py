"""Phase 2: Knowledge Distillation Trainer for Med-SEAL.

Subclasses the Hugging Face ``Trainer`` to add a KL-divergence distillation
term computed against a frozen teacher model.  The combined loss is::

    L = alpha * L_task  +  (1 - alpha) * T^2 * KL(p_teacher || p_student)

where the KL term is computed **only** at token positions flagged by the
``sea_token_mask`` in each batch (assistant-response tokens in SEA-language
samples).  This selective masking preserves English medical knowledge while
transferring SEA-language fluency from the teacher.

The teacher model is NOT wrapped by DeepSpeed / FSDP -- it runs plain
``bf16`` inference alongside the DeepSpeed-managed student.
"""

from __future__ import annotations

import logging
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F
from transformers import Trainer

logger = logging.getLogger(__name__)


class DistillationTrainer(Trainer):
    """Trainer with KL distillation from a frozen teacher.

    Parameters (beyond the standard ``Trainer`` arguments)
    ------------------------------------------------------
    teacher_model : nn.Module
        Pre-loaded, frozen teacher.  Must share the same tokeniser vocabulary
        as the student so that logit dimensions match.
    alpha : float
        Weight for the supervised task loss (CE on ground-truth labels).
        The KL distillation weight is ``1 - alpha``.
    temperature : float
        Softmax temperature applied before the KL computation.
    """

    def __init__(
        self,
        *args: Any,
        teacher_model: nn.Module,
        alpha: float = 0.5,
        temperature: float = 2.0,
        **kwargs: Any,
    ):
        super().__init__(*args, **kwargs)
        self.teacher_model = teacher_model
        self.alpha = alpha
        self.temperature = temperature

        self.teacher_model.eval()
        for p in self.teacher_model.parameters():
            p.requires_grad = False

        self._teacher_moved = False
        self._distill_metrics: dict[str, float] = {}

    # ------------------------------------------------------------------
    # Device management
    # ------------------------------------------------------------------

    def _ensure_teacher_on_device(self, reference_model: nn.Module) -> None:
        """Move teacher to the same device as *reference_model* (once)."""
        if self._teacher_moved:
            return
        device = next(reference_model.parameters()).device
        self.teacher_model.to(device)
        self._teacher_moved = True
        logger.info("Teacher model moved to %s", device)

    # ------------------------------------------------------------------
    # Loss computation
    # ------------------------------------------------------------------

    def compute_loss(
        self,
        model: nn.Module,
        inputs: dict[str, Any],
        return_outputs: bool = False,
        **kwargs: Any,
    ) -> torch.Tensor | tuple[torch.Tensor, Any]:
        sea_token_mask = inputs.pop("sea_token_mask", None)

        self._ensure_teacher_on_device(model)

        # --- Student forward ------------------------------------------
        outputs = model(**inputs)
        task_loss = outputs.loss

        has_sea = sea_token_mask is not None and sea_token_mask.any()

        if not has_sea:
            self._distill_metrics = {
                "loss/task": task_loss.detach().item(),
                "loss/distill": 0.0,
                "distill/n_sea_tokens": 0,
            }
            return (task_loss, outputs) if return_outputs else task_loss

        # --- Teacher forward (no gradient) ----------------------------
        with torch.no_grad():
            teacher_inputs = {k: v for k, v in inputs.items() if k != "labels"}
            teacher_outputs = self.teacher_model(**teacher_inputs)

        # --- KL divergence on SEA-masked positions --------------------
        # Causal-LM shift: logits[:, t] predicts position t+1, so we
        # align shifted logits with shifted labels / mask.
        s_logits = outputs.logits[:, :-1, :].contiguous()
        t_logits = teacher_outputs.logits[:, :-1, :].contiguous()
        mask = sea_token_mask[:, 1:].contiguous()

        T = self.temperature

        # Upcast to float32 for numerical stability in softmax / KL
        s_log_p = F.log_softmax(s_logits.float() / T, dim=-1)
        t_p = F.softmax(t_logits.float() / T, dim=-1)

        kl_per_token = F.kl_div(s_log_p, t_p, reduction="none").sum(dim=-1)

        n_sea = mask.sum().clamp(min=1)
        distill_loss = (kl_per_token * mask.float()).sum() / n_sea
        distill_loss = distill_loss * (T ** 2)

        total_loss = self.alpha * task_loss + (1.0 - self.alpha) * distill_loss

        self._distill_metrics = {
            "loss/task": task_loss.detach().item(),
            "loss/distill": distill_loss.detach().item(),
            "distill/n_sea_tokens": n_sea.item(),
        }

        return (total_loss, outputs) if return_outputs else total_loss

    # ------------------------------------------------------------------
    # Inject per-component losses into the Trainer's log stream so they
    # appear in TensorBoard / W&B alongside the default "loss" metric.
    # ------------------------------------------------------------------

    def log(self, logs: dict[str, float], *args: Any, **kwargs: Any) -> None:
        if self._distill_metrics:
            logs.update(self._distill_metrics)
            self._distill_metrics = {}
        super().log(logs, *args, **kwargs)
