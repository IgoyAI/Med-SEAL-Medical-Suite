"""Stream event types for real-time SSE (F5).

Defines typed events emitted during request processing so the client
can display progress in real time rather than waiting for the full
response.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any


class EventType(str, Enum):
    AGENT_START = "agent_start"
    GUARD_CHECK = "guard_check"
    TOOL_START = "tool_start"
    TOOL_END = "tool_end"
    LLM_TOKEN = "llm_token"
    THINKING_TOKEN = "thinking_token"
    DELEGATION_START = "delegation_start"
    DELEGATION_END = "delegation_end"
    TASK_UPDATE = "task_update"
    COMPLETE = "complete"
    ERROR = "error"


@dataclass
class StreamEvent:
    type: EventType
    agent: str = ""
    tool: str = ""
    content: str = ""
    summary: str = ""
    done: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["type"] = self.type.value
        return d
