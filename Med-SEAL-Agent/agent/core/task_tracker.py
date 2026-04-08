"""Clinical task lifecycle tracker.

Tracks each orchestrator request through its stages:
PENDING → INPUT_GUARD → ROUTING → AGENT_RUNNING → DELEGATING →
OUTPUT_GUARD → COMPLETED / FAILED / BLOCKED.

In-memory dict for fast reads; SQLite for durability.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any

import aiosqlite

logger = logging.getLogger(__name__)


class TaskStatus(str, Enum):
    PENDING = "pending"
    INPUT_GUARD = "input_guard"
    ROUTING = "routing"
    AGENT_RUNNING = "agent_running"
    DELEGATING = "delegating"
    OUTPUT_GUARD = "output_guard"
    COMPLETED = "completed"
    FAILED = "failed"
    BLOCKED = "blocked"


@dataclass
class ClinicalTask:
    task_id: str
    session_id: str
    patient_id: str
    status: TaskStatus = TaskStatus.PENDING
    agent_id: str = ""
    delegation_agent: str = ""
    query_summary: str = ""
    guard_input_decision: str = ""
    guard_output_decision: str = ""
    safety_alerts: list[str] = field(default_factory=list)
    error: str = ""
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = ""
    completed_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["status"] = self.status.value
        return d


_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS clinical_tasks (
    task_id     TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    patient_id  TEXT NOT NULL,
    status      TEXT NOT NULL,
    agent_id    TEXT,
    delegation_agent TEXT,
    query_summary TEXT,
    guard_input_decision TEXT,
    guard_output_decision TEXT,
    safety_alerts TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_clinical_tasks_session
    ON clinical_tasks(session_id, created_at);
"""


class TaskTracker:
    """In-memory + SQLite task tracker."""

    def __init__(self, db_path: str):
        self._db_path = db_path
        self._active: dict[str, ClinicalTask] = {}

    async def setup(self) -> None:
        try:
            async with aiosqlite.connect(self._db_path) as db:
                await db.executescript(_CREATE_SQL)
                await db.commit()
            logger.info("TaskTracker initialised")
        except Exception as exc:
            logger.warning("TaskTracker setup failed (non-fatal): %s", exc)

    async def create(
        self,
        session_id: str,
        patient_id: str,
        query: str,
    ) -> ClinicalTask:
        task = ClinicalTask(
            task_id=uuid.uuid4().hex[:12],
            session_id=session_id,
            patient_id=patient_id,
            query_summary=query[:200],
        )
        self._active[task.task_id] = task
        asyncio.create_task(self._persist(task))
        return task

    async def update_status(
        self,
        task_id: str,
        status: TaskStatus,
        **kwargs: Any,
    ) -> None:
        task = self._active.get(task_id)
        if not task:
            return
        task.status = status
        task.updated_at = datetime.now(timezone.utc).isoformat()
        if status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.BLOCKED):
            task.completed_at = task.updated_at
        for k, v in kwargs.items():
            if hasattr(task, k):
                setattr(task, k, v)
        asyncio.create_task(self._persist(task))

    async def get_task(self, task_id: str) -> ClinicalTask | None:
        return self._active.get(task_id)

    async def get_tasks(self, session_id: str) -> list[ClinicalTask]:
        # In-memory first
        tasks = [t for t in self._active.values() if t.session_id == session_id]
        if tasks:
            return sorted(tasks, key=lambda t: t.created_at)
        # Fallback to SQLite
        try:
            async with aiosqlite.connect(self._db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    "SELECT * FROM clinical_tasks WHERE session_id = ? "
                    "ORDER BY created_at DESC LIMIT 50",
                    (session_id,),
                )
                rows = await cursor.fetchall()
                return [self._row_to_task(r) for r in rows]
        except Exception:
            return []

    async def _persist(self, task: ClinicalTask) -> None:
        try:
            import json

            async with aiosqlite.connect(self._db_path) as db:
                await db.execute(
                    "INSERT OR REPLACE INTO clinical_tasks "
                    "(task_id, session_id, patient_id, status, agent_id, "
                    "delegation_agent, query_summary, guard_input_decision, "
                    "guard_output_decision, safety_alerts, error, "
                    "created_at, updated_at, completed_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        task.task_id,
                        task.session_id,
                        task.patient_id,
                        task.status.value,
                        task.agent_id,
                        task.delegation_agent,
                        task.query_summary,
                        task.guard_input_decision,
                        task.guard_output_decision,
                        json.dumps(task.safety_alerts),
                        task.error,
                        task.created_at,
                        task.updated_at,
                        task.completed_at,
                    ),
                )
                await db.commit()
        except Exception as exc:
            logger.warning("TaskTracker persist failed: %s", exc)

    @staticmethod
    def _row_to_task(row) -> ClinicalTask:
        import json

        return ClinicalTask(
            task_id=row["task_id"],
            session_id=row["session_id"],
            patient_id=row["patient_id"],
            status=TaskStatus(row["status"]),
            agent_id=row["agent_id"] or "",
            delegation_agent=row["delegation_agent"] or "",
            query_summary=row["query_summary"] or "",
            guard_input_decision=row["guard_input_decision"] or "",
            guard_output_decision=row["guard_output_decision"] or "",
            safety_alerts=json.loads(row["safety_alerts"] or "[]"),
            error=row["error"] or "",
            created_at=row["created_at"],
            updated_at=row["updated_at"] or "",
            completed_at=row["completed_at"] or "",
        )
