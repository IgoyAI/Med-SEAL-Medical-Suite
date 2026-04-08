"""Shared reasoning utilities for all Med-SEAL agents.

Provides clean <think> tag stripping and retry logic, replacing the
50+ regex patterns previously used in the companion agent.
"""

from __future__ import annotations

import logging
import re

from langchain_core.messages import AIMessage, HumanMessage

logger = logging.getLogger(__name__)

_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
_THINK_OPEN_RE = re.compile(r"<think>.*", re.DOTALL)
_ANSWER_RE = re.compile(r"</?answer\s*>", re.IGNORECASE)

MAX_RETRIES = 2


def strip_thinking(text: str) -> tuple[str, str]:
    """Return (thinking, answer) from LLM output with <think> tags.

    Handles complete ``<think>...</think>`` blocks and unclosed ``<think>``
    tags (model cut off mid-reasoning).
    """
    # Handle list content (Qwen 3.6+ returns content blocks)
    if isinstance(text, list):
        parts = []
        for block in text:
            if isinstance(block, dict):
                btype = block.get("type", "")
                if btype in ("reasoning", "reasoning_content"):
                    continue  # skip CoT blocks
                bcontent = block.get("text", "") or block.get("content", "")
                if isinstance(bcontent, list):
                    bcontent = "".join(b.get("text", "") for b in bcontent if isinstance(b, dict))
                if isinstance(bcontent, str):
                    parts.append(bcontent)
            elif isinstance(block, str):
                parts.append(block)
        text = "".join(parts)
    if not isinstance(text, str):
        text = str(text)

    thinking = ""
    think_match = _THINK_RE.search(text)
    if think_match:
        thinking = think_match.group(0).removeprefix("<think>").removesuffix("</think>").strip()

    cleaned = _THINK_RE.sub("", text)
    # Handle unclosed <think> (model was cut off)
    cleaned = _THINK_OPEN_RE.sub("", cleaned)
    cleaned = _ANSWER_RE.sub("", cleaned)
    return thinking, cleaned.strip()


def clean_response(response: AIMessage) -> AIMessage:
    """Strip thinking tags from an AI response, preserving tool_calls."""
    if not response.content:
        return response
    _, cleaned = strip_thinking(response.content)
    if cleaned != response.content:
        return AIMessage(content=cleaned, tool_calls=response.tool_calls or [])
    return response


def invoke_with_retry(llm, messages: list, *, max_retries: int = MAX_RETRIES) -> AIMessage:
    """Invoke an LLM with retry on empty/thinking-only responses.

    Follows the pattern from core/graph.py — if the LLM returns only
    <think> content with no visible answer and no tool calls, retry
    with a nudge message.
    """
    current_messages = list(messages)

    response: AIMessage | None = None
    for attempt in range(max_retries + 1):
        response = llm.invoke(current_messages)

        # Tool calls → return immediately (LLM is acting)
        if response.tool_calls:
            return response

        # Check if there's visible content after stripping thinking
        raw = response.content or ""
        logger.info("LLM response type=%s content_preview=%s", type(raw).__name__, str(raw)[:200])
        # Qwen 3.6+ returns list content blocks — extract text parts
        if isinstance(raw, list):
            text_parts = []
            for block in raw:
                if isinstance(block, dict):
                    btype = block.get("type", "")
                    # Skip reasoning blocks — those are CoT
                    if btype in ("reasoning", "reasoning_content"):
                        continue
                    # Extract text from various formats
                    bcontent = block.get("text", "") or block.get("content", "")
                    if isinstance(bcontent, list):
                        # Nested content: [{"text": "..."}]
                        bcontent = "".join(b.get("text", "") for b in bcontent if isinstance(b, dict))
                    if isinstance(bcontent, str) and bcontent.strip():
                        text_parts.append(bcontent)
                elif isinstance(block, str):
                    text_parts.append(block)
            text = "".join(text_parts)
            logger.info("Qwen content: %d blocks, answer=%d chars, types=%s",
                        len(raw), len(text),
                        [b.get("type","?") if isinstance(b,dict) else "str" for b in raw])
            if text.strip():
                return AIMessage(content=text.strip(), tool_calls=response.tool_calls or [])
        else:
            text = raw
        _, cleaned = strip_thinking(text)

        if cleaned:
            # Has visible content — return cleaned version
            if cleaned != text:
                return AIMessage(content=cleaned, tool_calls=response.tool_calls or [])
            return response

        # Empty/thinking-only response — retry with nudge
        logger.warning(
            "LLM returned only <think> content (attempt %d/%d), retrying",
            attempt + 1,
            max_retries + 1,
        )
        if attempt < max_retries:
            current_messages = current_messages + [
                AIMessage(content=text),
                HumanMessage(
                    content=(
                        "Your previous response contained only internal reasoning. "
                        "Please provide your final answer."
                    )
                ),
            ]

    # Last resort: return whatever we got
    return response  # type: ignore[return-value]
