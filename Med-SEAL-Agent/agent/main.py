"""FastAPI application for the Med-SEAL multi-agent system.

Start with::

    uvicorn agent.main:app --host 0.0.0.0 --port 8080

Requires:
- vLLM server running Med-R1 GRPO (default: localhost:8000)
- Medplum FHIR R4 server (default: localhost:8103)
- Sessions persisted to SQLite (medseal_sessions.db) — no external DB needed

Configure via environment variables prefixed with ``MEDSEAL_``
(see ``agent/config.py``).
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from langgraph.checkpoint.memory import MemorySaver

from agent.api.routes import router as api_router
from agent.config import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-8s %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)


async def _make_checkpointer():
    """Try SQLite persistent checkpointer; fall back to in-memory MemorySaver."""
    import os

    db_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "medseal_sessions.db",
    )
    try:
        import aiosqlite
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        conn = aiosqlite.connect(db_path)
        await conn.__aenter__()

        _orig_start = conn._thread.start
        def _safe_start():
            if conn._thread.is_alive():
                return
            _orig_start()
        conn._thread.start = _safe_start

        checkpointer = AsyncSqliteSaver(conn=conn)
        await checkpointer.setup()
        logger.info("Using SQLite checkpointer at %s", db_path)
        return checkpointer
    except Exception as exc:
        logger.info(
            "SQLite checkpointer unavailable (%s), using in-memory MemorySaver. "
            "Sessions persist during runtime but not across restarts.",
            exc,
        )
        return MemorySaver()


def _build_all_graphs(checkpointer):
    """Build and compile all agent LangGraphs."""
    from agent.agents.companion import build_companion_graph
    from agent.agents.clinical import build_clinical_graph
    from agent.agents.doctor_cds import build_doctor_cds_graph
    from agent.agents.insight import build_insight_graph
    from agent.agents.lifestyle import build_lifestyle_graph
    from agent.agents.nudge import build_nudge_graph
    from agent.agents.previsit import build_previsit_graph
    from agent.core.graph import build_graph as build_legacy_graph

    graphs = {}

    companion = build_companion_graph().compile(checkpointer=checkpointer)
    graphs["companion-agent"] = companion

    clinical = build_clinical_graph().compile(checkpointer=checkpointer)
    graphs["clinical-reasoning-agent"] = clinical

    doctor_cds = build_doctor_cds_graph().compile(checkpointer=checkpointer)
    graphs["doctor-cds-agent"] = doctor_cds

    nudge = build_nudge_graph().compile(checkpointer=checkpointer)
    graphs["nudge-agent"] = nudge

    lifestyle = build_lifestyle_graph().compile(checkpointer=checkpointer)
    graphs["lifestyle-agent"] = lifestyle

    insight = build_insight_graph().compile(checkpointer=checkpointer)
    graphs["insight-synthesis-agent"] = insight

    previsit = build_previsit_graph().compile(checkpointer=checkpointer)
    graphs["previsit-summary-agent"] = previsit

    legacy = build_legacy_graph().compile(checkpointer=checkpointer)
    graphs["legacy-agent"] = legacy

    return graphs


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize all agents, orchestrator, guard, and FHIR client."""
    medplum = None
    try:
        # 1. Checkpointer
        checkpointer = await _make_checkpointer()

        # 2. FHIR client (lazy — no network calls on init)
        from agent.tools.fhir_client import init_medplum
        medplum = init_medplum(
            base_url=settings.medplum_url,
            client_id=settings.medplum_client_id,
            client_secret=settings.medplum_client_secret,
            email=settings.medplum_email,
            password=settings.medplum_password,
        )
        logger.info("Medplum FHIR client initialized: %s", settings.medplum_url)

        # 3. Build all agent graphs
        graphs = _build_all_graphs(checkpointer)

        # 4. Register agents with the orchestrator
        from agent.core.orchestrator import register_agent
        for agent_id, compiled_graph in graphs.items():
            if agent_id != "legacy-agent":
                register_agent(agent_id, compiled_graph)

        # 5. Initialize audit log (F2)
        import os as _os
        _db_path = _os.path.join(
            _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
            "medseal_sessions.db",
        )
        from agent.core.audit import init_audit_log
        await init_audit_log(_db_path)

        # 5b. Initialize task tracker (F3)
        from agent.core.task_tracker import TaskTracker
        from agent.core.orchestrator import set_task_tracker
        tracker = TaskTracker(_db_path)
        await tracker.setup()
        set_task_tracker(tracker)
        app.state.task_tracker = tracker

        # 5c. Initialize memory store (F4)
        if settings.memory_enabled:
            from agent.core.memory import init_memory_store
            await init_memory_store(_db_path)

        # 6. Store on app state
        app.state.settings = settings
        app.state.checkpointer = checkpointer
        app.state.graphs = graphs
        app.state.graph = graphs.get("legacy-agent") or graphs.get("companion-agent")

        logger.info(
            "Med-SEAL multi-agent system ready  (vLLM=%s  model=%s  agents=%s)",
            settings.vllm_url,
            settings.model_name,
            list(graphs.keys()),
        )
    except Exception as exc:
        logger.exception("STARTUP FAILED — running in degraded mode: %s", exc)
        app.state.graphs = {}
        app.state.graph = None

    yield

    # Cleanup
    logger.info("Shutting down Med-SEAL multi-agent system")
    try:
        if medplum:
            await medplum.close()
    except Exception:
        pass


app = FastAPI(
    title="Med-SEAL Multi-Agent System",
    description=(
        "Med-SEAL patient empowerment platform with 6 specialized agents "
        "(Companion, Clinical Reasoning, Nudge, Lifestyle, Insight Synthesis, "
        "Measurement), an orchestrator, and a guard layer."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

app.include_router(api_router)
