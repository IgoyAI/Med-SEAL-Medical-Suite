"""Rule-based task router that classifies incoming messages.

Assigns a ``TaskType`` used to select the appropriate system prompt block
before the first LLM call in the LangGraph agent.
"""

from __future__ import annotations

import enum
import re

_REPORT_KEYWORDS = re.compile(
    r"\b(report|findings|impression|generate\s+report|radiology\s+report"
    r"|discharge\s+summary)\b",
    re.IGNORECASE,
)
_YN_KEYWORDS = re.compile(
    r"\b(is\s+it|is\s+this|does\s+it|are\s+there|can\s+it|will\s+it"
    r"|is\s+there|do\s+you\s+see)\b",
    re.IGNORECASE,
)


class TaskType(str, enum.Enum):
    VQA_YN = "vqa_yn"
    VQA_OPEN = "vqa_open"
    REPORT = "report"
    DIAGNOSIS = "diagnosis"


_SYSTEM_BLOCKS: dict[TaskType, str] = {
    TaskType.VQA_YN: (
        "The user is asking a yes/no medical question about an image. "
        "Provide a concise yes or no answer followed by a brief explanation."
    ),
    TaskType.VQA_OPEN: (
        "The user is asking an open-ended medical question about an image. "
        "Provide a thorough, evidence-based answer."
    ),
    TaskType.REPORT: (
        "The user wants a medical report generated from an image. "
        "Structure your response with FINDINGS and IMPRESSION sections."
    ),
    TaskType.DIAGNOSIS: (
        "The user is seeking a medical diagnosis or clinical advice. "
        "Reason step by step, consider differential diagnoses, and cite "
        "sources when available. Always recommend consulting a healthcare "
        "professional for definitive diagnosis."
    ),
}


def classify_task(message: str, *, has_image: bool = False) -> TaskType:
    """Return the ``TaskType`` for a user message."""
    if _REPORT_KEYWORDS.search(message):
        return TaskType.REPORT

    if has_image and _YN_KEYWORDS.search(message) and message.rstrip().endswith("?"):
        return TaskType.VQA_YN

    if has_image and message.rstrip().endswith("?"):
        return TaskType.VQA_OPEN

    return TaskType.DIAGNOSIS


def system_block_for(task_type: TaskType) -> str:
    """Return the system prompt fragment for a given task type."""
    return _SYSTEM_BLOCKS[task_type]
