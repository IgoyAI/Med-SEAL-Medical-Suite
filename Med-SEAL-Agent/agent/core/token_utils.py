"""Token estimation utilities for context window management.

Uses character-based heuristics since Med-SEAL operates across SEA-LION
(BPE) and Azure OpenAI (cl100k) tokenizers — neither is available
locally.  The ratios are conservative: better to compact slightly early
than to hit API limits.
"""

from __future__ import annotations

import re
from typing import Sequence

from langchain_core.messages import BaseMessage

# CJK Unified Ideographs + common CJK ranges
_CJK_RE = re.compile(
    r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff"
    r"\u2e80-\u2eff\u3000-\u303f\u31f0-\u31ff"
    r"\uff00-\uffef]"
)

# Average characters per token (conservative estimates)
_CHARS_PER_TOKEN_LATIN = 3.5  # English, Malay, Indonesian
_CHARS_PER_TOKEN_CJK = 1.8    # Chinese, Japanese
_CJK_THRESHOLD = 0.15          # If > 15% CJK chars, use CJK ratio


def has_cjk(text: str) -> bool:
    """Return True if text contains significant CJK characters."""
    if not text:
        return False
    cjk_count = len(_CJK_RE.findall(text))
    return cjk_count / max(len(text), 1) > _CJK_THRESHOLD


def estimate_tokens(text: str) -> int:
    """Estimate token count for a string."""
    if not text:
        return 0
    ratio = _CHARS_PER_TOKEN_CJK if has_cjk(text) else _CHARS_PER_TOKEN_LATIN
    return int(len(text) / ratio)


def count_message_tokens(messages: Sequence[BaseMessage]) -> int:
    """Estimate total token count across a list of LangChain messages.

    Accounts for message overhead (~4 tokens per message for role/separator).
    """
    total = 0
    for msg in messages:
        content = msg.content if isinstance(msg.content, str) else str(msg.content)
        total += estimate_tokens(content) + 4  # role + separators overhead
    return total
