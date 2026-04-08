"""Tool execution audit log — SQLite-backed.

Records every write-tool invocation with patient context, gate decision,
and execution outcome.  Used by tool_gate() for rate-limiting queries.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiosqlite

logger = logging.getLogger(__name__)

_DB_PATH: str | None = None
_TABLE = "tool_audit"

_CREATE_SQL = f"""
CREATE TABLE IF NOT EXISTS {_TABLE} (
    id          TEXT PRIMARY KEY,
    timestamp   TEXT NOT NULL,
    patient_id  TEXT NOT NULL,
    agent_id    TEXT NOT NULL,
    tool_name   TEXT NOT NULL,
    tool_args   TEXT,
    gate_decision TEXT NOT NULL,
    gate_reasons  TEXT,
    exec_result TEXT,
    duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_audit_patient_tool
    ON {_TABLE}(patient_id, tool_name, timestamp);
"""


@dataclass
class ToolAuditEntry:
    patient_id: str
    agent_id: str
    tool_name: str
    gate_decision: str  # allow / deny / rate_limited
    tool_args: str = ""
    gate_reasons: str = ""
    exec_result: str = ""
    duration_ms: int = 0
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    timestamp: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


async def init_audit_log(db_path: str) -> None:
    """Create the audit table if it doesn't exist."""
    global _DB_PATH
    _DB_PATH = db_path
    try:
        async with aiosqlite.connect(db_path) as db:
            await db.executescript(_CREATE_SQL)
            await db.commit()
        logger.info("Audit log initialised: %s", db_path)
    except Exception as exc:
        logger.warning("Audit log init failed (non-fatal): %s", exc)


async def log_tool_execution(entry: ToolAuditEntry) -> None:
    """Insert an audit entry (fire-and-forget safe)."""
    if _DB_PATH is None:
        return
    try:
        async with aiosqlite.connect(_DB_PATH) as db:
            await db.execute(
                f"INSERT INTO {_TABLE} "
                "(id, timestamp, patient_id, agent_id, tool_name, tool_args, "
                "gate_decision, gate_reasons, exec_result, duration_ms) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    entry.id,
                    entry.timestamp,
                    entry.patient_id,
                    entry.agent_id,
                    entry.tool_name,
                    entry.tool_args,
                    entry.gate_decision,
                    entry.gate_reasons,
                    entry.exec_result,
                    entry.duration_ms,
                ),
            )
            await db.commit()
    except Exception as exc:
        logger.warning("Audit log write failed: %s", exc)


async def get_recent_tool_calls(
    patient_id: str,
    tool_name: str,
    since_minutes: int = 60,
) -> list[dict[str, Any]]:
    """Query recent tool calls for rate-limiting decisions."""
    if _DB_PATH is None:
        return []
    try:
        cutoff = datetime.now(timezone.utc).isoformat()
        async with aiosqlite.connect(_DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                f"SELECT * FROM {_TABLE} "
                "WHERE patient_id = ? AND tool_name = ? "
                "AND gate_decision = 'allow' "
                "AND timestamp >= datetime(?, '-' || ? || ' minutes') "
                "ORDER BY timestamp DESC",
                (patient_id, tool_name, cutoff, since_minutes),
            )
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]
    except Exception as exc:
        logger.warning("Audit log query failed: %s", exc)
        return []


async def get_patient_audit(patient_id: str, limit: int = 50) -> list[dict]:
    """Return recent audit entries for a patient."""
    if _DB_PATH is None:
        return []
    try:
        async with aiosqlite.connect(_DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                f"SELECT * FROM {_TABLE} WHERE patient_id = ? "
                "ORDER BY timestamp DESC LIMIT ?",
                (patient_id, limit),
            )
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]
    except Exception as exc:
        logger.warning("Audit log patient query failed: %s", exc)
        return []
