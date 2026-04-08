"""Doctor CDS Agent — Clinical Decision Support for OpenEMR.

Conversational agent for clinicians on the OpenEMR surface. Provides:
- Patient summary on demand
- Lab trend analysis & interpretation
- Drug interaction checks
- Differential diagnosis reasoning
- Treatment context & guideline references
- Risk stratification

Uses SEA-LION for general clinical conversation and Med-R1 for deep
clinical reasoning via tool-calling into FHIR.

Graph topology:
  START → fetch_patient → llm_node ⇄ tool_node → END
"""

from __future__ import annotations

import json, logging
from typing import Annotated, TypedDict

import httpx
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from agent.config import settings

logger = logging.getLogger(__name__)


# ── State ─────────────────────────────────────────────────────────────────

class DoctorCDSState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    patient_id: str
    patient_context: str
    steps: list[dict]
    sources: list[str]


# ── System prompt ─────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are **Med-SEAL CDS**, a clinical decision support assistant embedded in OpenEMR.
You are speaking with a **licensed clinician** (doctor, nurse, pharmacist).

ROLE:
- Provide evidence-based clinical decision support for chronic disease management.
- Summarize patient records, interpret lab trends, flag drug interactions, and
  assist with risk stratification.
- You may discuss diagnoses, treatment options, dosage adjustments, and clinical
  guidelines — this is a clinician-facing tool, NOT patient-facing.

CLINICAL GUIDELINES:
- Cite specific EHR data: "HbA1c 7.2% (2026-02-15)" not "HbA1c is elevated."
- Use standard codes when available (SNOMED CT, LOINC, RxNorm).
- For lab trends, compare at least 2-3 data points when available.
- State your confidence: high (clear EHR evidence), medium (partial data), low (insufficient data).
- When uncertain, say so explicitly.

FORMAT:
- Be concise and clinical — no patient-friendly phrasing needed.
- Use bullet points and structured sections for readability.
- For complex assessments, structure as: Assessment → Evidence → Recommendations → Caveats.

SAFETY:
- NEVER fabricate data not present in the EHR. If data is missing, state it.
- Always note that final clinical decisions rest with the treating clinician.
- Flag contraindications and allergy conflicts proactively.

{patient_block}"""


# ── Helpers ───────────────────────────────────────────────────────────────

def _run_in_new_loop(coro):
    import asyncio
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _run_async(coro):
    import asyncio
    try:
        asyncio.get_running_loop()
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(_run_in_new_loop, coro).result(timeout=25)
    except RuntimeError:
        return asyncio.run(coro)


def _pick_text(codeable: dict) -> str:
    """Extract display text from a FHIR CodeableConcept."""
    if not isinstance(codeable, dict):
        return ""
    txt = codeable.get("text", "")
    if txt:
        return txt
    codings = codeable.get("coding", [])
    if codings:
        return codings[0].get("display", "") or codings[0].get("code", "")
    return ""


_UUID_RE = __import__("re").compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", __import__("re").I
)


async def _resolve_fhir_patient(fhir, patient_id: str) -> tuple[str, dict | None]:
    """Resolve a patient_id (which may be a FHIR UUID, OpenEMR PID, or name)
    into (fhir_id, patient_resource).  Returns ("", None) on total failure."""

    # 1. Direct read — works for FHIR UUIDs
    try:
        patient = await fhir.read("Patient", patient_id)
        if patient and patient.get("resourceType") == "Patient":
            return patient.get("id", patient_id), patient
    except Exception:
        pass

    # 2. Search by identifier (covers OpenEMR PIDs stored as identifiers)
    try:
        results = await fhir.search("Patient", {"identifier": patient_id})
        if results:
            p = results[0]
            return p.get("id", ""), p
    except Exception:
        pass

    # 3. Search by name (handles cases where a name string is passed)
    if not patient_id.isdigit() and not _UUID_RE.match(patient_id):
        try:
            results = await fhir.search("Patient", {"name": patient_id, "_count": "5"})
            if results:
                p = results[0]
                return p.get("id", ""), p
        except Exception:
            pass

    return "", None


def _extract_patient_name(messages: list) -> str:
    """Try to extract a patient name from the conversation messages.

    Proper-cased name: two+ words each starting uppercase (e.g. "Chase Abernathy").
    Patterns intentionally avoid re.I so [A-Z] only matches uppercase.
    """
    import re
    _NAME = r"[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+"
    patterns = [
        re.compile(rf"({_NAME})\s*\(?\s*(?:PID|pid|MRN|mrn|ID|id)\b"),
        re.compile(rf"[Pp]atient[\s:]+({_NAME})"),
        re.compile(rf"[Pp]t[\s:]+({_NAME})"),
        re.compile(rf"[Ff]or\s+({_NAME})"),
        re.compile(rf"[Oo]f\s+({_NAME})"),
        re.compile(rf"[Ss]ummary\s+(?:for|of)\s+({_NAME})"),
    ]
    for msg in reversed(messages):
        text = getattr(msg, "content", "") if hasattr(msg, "content") else str(msg)
        for pat in patterns:
            m = pat.search(text)
            if m:
                return m.group(1).strip()
    return ""


async def _fetch_patient_summary(patient_id: str, messages: list | None = None) -> str:
    """Quick FHIR fetch: demographics, conditions, meds, labs, allergies, encounters.

    Queries **both** Medplum and OpenEMR FHIR APIs to get the most complete
    patient picture.  Medplum holds curated/synced data; OpenEMR holds native
    EMR data (SOAP notes, encounters, vitals entered by clinicians).

    Each resource type is fetched independently so a single failure
    does not blank the entire summary.
    """
    from agent.tools.fhir_client import get_medplum
    fhir = get_medplum()

    # --- OpenEMR FHIR client (best-effort, singleton) ---
    oe_fhir = None
    try:
        from agent.tools.openemr_fhir_client import OpenEMRFHIRClient
        if settings.openemr_fhir_url:
            oe_fhir = OpenEMRFHIRClient(
                base_url=settings.openemr_fhir_url,
                username=settings.openemr_user,
                password=settings.openemr_pass,
                client_id=settings.openemr_client_id,
                client_secret=settings.openemr_client_secret,
            )
    except Exception as e:
        logger.warning("OpenEMR FHIR client init failed: %s", e)

    lines: list[str] = []

    # ── Resolve patient_id → FHIR UUID (Medplum) ────────────────────
    fhir_id, patient = await _resolve_fhir_patient(fhir, patient_id)

    if not fhir_id and messages:
        name = _extract_patient_name(messages)
        if name:
            logger.info("CDS: patient_id %s not found, trying name '%s'", patient_id, name)
            fhir_id, patient = await _resolve_fhir_patient(fhir, name)

    # Also try resolving via OpenEMR if Medplum didn't find it
    oe_patient_id = patient_id  # OpenEMR uses numeric PIDs
    if not fhir_id and oe_fhir:
        try:
            results = await oe_fhir.search("Patient", {"identifier": patient_id})
            if results:
                patient = results[0]
                fhir_id = patient.get("id", patient_id)
                logger.info("CDS: Found patient via OpenEMR FHIR: %s", fhir_id)
        except Exception:
            pass

    if not fhir_id:
        logger.warning("CDS: Could not resolve patient_id=%s to a FHIR resource", patient_id)
        if oe_fhir:
            try: await oe_fhir.close()
            except Exception: pass
        return "No patient data available."

    if fhir_id != patient_id:
        logger.info("CDS: Resolved patient_id=%s → FHIR id=%s", patient_id, fhir_id)

    # ── Demographics ─────────────────────────────────────────────────
    if patient:
        names = patient.get("name", [])
        if names:
            given = " ".join(names[0].get("given", []))
            family = names[0].get("family", "")
            name_str = f"{given} {family}".strip()
        else:
            name_str = "Unknown"
        gender = patient.get("gender", "")
        dob = patient.get("birthDate", "")
        lines.append(f"Patient: {name_str} | {gender} | DOB: {dob}")

    # ── Helper: search both FHIR servers and merge results ───────────
    async def _dual_search(resource_type: str, params: dict) -> list[dict]:
        """Search Medplum + OpenEMR and merge (deduplicate by id)."""
        results = []
        seen_ids = set()

        # Medplum first
        try:
            medplum_results = await fhir.search(resource_type, params)
            for r in medplum_results:
                rid = r.get("id", "")
                if rid not in seen_ids:
                    seen_ids.add(rid)
                    results.append(r)
        except Exception as e:
            logger.warning("CDS: Medplum %s search failed: %s", resource_type, e)

        # OpenEMR second (using the numeric PID as identifier)
        if oe_fhir:
            oe_params = dict(params)
            # OpenEMR uses numeric patient IDs
            for key in ["subject", "patient"]:
                if key in oe_params:
                    oe_params[key] = oe_patient_id
            try:
                oe_results = await oe_fhir.search(resource_type, oe_params)
                for r in oe_results:
                    rid = r.get("id", "")
                    if rid not in seen_ids:
                        seen_ids.add(rid)
                        r["_source"] = "OpenEMR"  # tag source
                        results.append(r)
            except Exception as e:
                logger.warning("CDS: OpenEMR %s search failed: %s", resource_type, e)

        return results

    # ── Conditions ───────────────────────────────────────────────────
    try:
        conditions = await _dual_search("Condition", {
            "subject": f"Patient/{fhir_id}", "clinical-status": "active",
        })
        if not conditions:
            conditions = await _dual_search("Condition", {
                "patient": fhir_id, "clinical-status": "active",
            })
        if conditions:
            conds = [_pick_text(c.get("code", {})) or "Unknown" for c in conditions]
            lines.append(f"Active conditions: {', '.join(conds)}")
    except Exception as e:
        logger.warning("CDS: Condition search failed for %s: %s", fhir_id, e)

    # ── Medications ──────────────────────────────────────────────────
    try:
        meds = await _dual_search("MedicationRequest", {
            "subject": f"Patient/{fhir_id}", "status": "active",
        })
        if not meds:
            meds = await _dual_search("MedicationRequest", {
                "patient": fhir_id, "status": "active",
            })
        if not meds:
            meds = await _dual_search("MedicationRequest", {
                "subject": f"Patient/{fhir_id}",
            })
        if meds:
            med_parts = []
            for m in meds:
                med_name = _pick_text(m.get("medicationCodeableConcept", {})) or "Unknown"
                dosage = ""
                if m.get("dosageInstruction"):
                    dosage = m["dosageInstruction"][0].get("text", "")
                status = m.get("status", "")
                source_tag = " [EMR]" if m.get("_source") == "OpenEMR" else ""
                entry = f"{med_name}"
                if dosage:
                    entry += f" ({dosage})"
                if status and status != "active":
                    entry += f" [{status}]"
                entry += source_tag
                med_parts.append(entry)
            lines.append(f"Medications: {', '.join(med_parts)}")
    except Exception as e:
        logger.warning("CDS: MedicationRequest search failed for %s: %s", fhir_id, e)

    # ── Allergies ────────────────────────────────────────────────────
    try:
        allergies = await _dual_search("AllergyIntolerance", {
            "patient": fhir_id,
        })
        if allergies:
            allergy_names = [_pick_text(a.get("code", {})) or "Unknown" for a in allergies]
            lines.append(f"Allergies: {', '.join(allergy_names)}")
        else:
            lines.append("Allergies: NKDA (No Known Drug Allergies)")
    except Exception as e:
        logger.warning("CDS: AllergyIntolerance search failed for %s: %s", fhir_id, e)

    # ── Observations / Labs ──────────────────────────────────────────
    try:
        obs = await _dual_search("Observation", {
            "subject": f"Patient/{fhir_id}", "_sort": "-date", "_count": "20",
        })
        if not obs:
            obs = await _dual_search("Observation", {
                "patient": fhir_id, "_sort": "-date", "_count": "20",
            })
        if obs:
            lab_lines = []
            for o in obs[:15]:
                name_text = _pick_text(o.get("code", {})) or "Observation"
                vq = o.get("valueQuantity", {})
                source_tag = " [EMR]" if o.get("_source") == "OpenEMR" else ""
                if vq and vq.get("value") is not None:
                    value = f"{vq.get('value', '')} {vq.get('unit', '')}".strip()
                elif o.get("component"):
                    comp_parts = []
                    for comp in o["component"][:3]:
                        cvq = comp.get("valueQuantity", {})
                        if cvq.get("value") is not None:
                            cname = _pick_text(comp.get("code", {})) or "Component"
                            comp_parts.append(f"{cname}: {cvq['value']} {cvq.get('unit', '')}")
                    value = ", ".join(comp_parts) if comp_parts else "N/A"
                else:
                    value = "N/A"
                date = (o.get("effectiveDateTime") or "")[:10]
                lab_lines.append(f"  - {name_text}: {value} ({date}){source_tag}")
            lines.append("Recent observations:\n" + "\n".join(lab_lines))
    except Exception as e:
        logger.warning("CDS: Observation search failed for %s: %s", fhir_id, e)

    # ── Encounters ───────────────────────────────────────────────────
    try:
        encounters = await _dual_search("Encounter", {
            "subject": f"Patient/{fhir_id}", "_sort": "-date", "_count": "10",
        })
        if not encounters:
            encounters = await _dual_search("Encounter", {
                "patient": fhir_id, "_sort": "-date", "_count": "10",
            })
        if encounters:
            enc_lines = []
            for enc in encounters[:10]:
                etype = ""
                if enc.get("type"):
                    etype = _pick_text(enc["type"][0])
                period = enc.get("period", {})
                start = (period.get("start") or "")[:10]
                status = enc.get("status", "")
                source_tag = " [EMR]" if enc.get("_source") == "OpenEMR" else ""
                reason = ""
                if enc.get("reasonCode"):
                    reason = f" - {_pick_text(enc['reasonCode'][0])}"
                enc_lines.append(f"  - {etype or 'Encounter'} ({status}) {start}{reason}{source_tag}")
            lines.append("Recent encounters:\n" + "\n".join(enc_lines))
    except Exception as e:
        logger.warning("CDS: Encounter search failed for %s: %s", fhir_id, e)

    # ── DocumentReference / SOAP Notes (OpenEMR specific) ────────────
    if oe_fhir:
        try:
            docs = await oe_fhir.search("DocumentReference", {
                "patient": oe_patient_id, "_sort": "-date", "_count": "5",
            })
            if docs:
                doc_lines = []
                for doc in docs[:5]:
                    doc_type = _pick_text(doc.get("type", {})) or "Document"
                    doc_date = (doc.get("date") or "")[:10]
                    desc = doc.get("description", "")
                    # Try to extract text content from attachment
                    content_text = ""
                    for content in doc.get("content", []):
                        att = content.get("attachment", {})
                        if att.get("data"):
                            import base64
                            try:
                                decoded = base64.b64decode(att["data"]).decode("utf-8", errors="replace")
                                content_text = decoded[:500]  # first 500 chars
                            except Exception:
                                pass
                    entry = f"  - {doc_type} ({doc_date})"
                    if desc:
                        entry += f": {desc}"
                    if content_text:
                        entry += f"\n    Content: {content_text[:300]}"
                    doc_lines.append(entry)
                lines.append("Clinical Documents (SOAP/Notes) [EMR]:\n" + "\n".join(doc_lines))
        except Exception as e:
            logger.warning("CDS: DocumentReference search failed: %s", e)

    # ── Data sources summary ─────────────────────────────────────────
    sources = ["Medplum FHIR"]
    if oe_fhir:
        sources.append("OpenEMR FHIR")
    lines.append(f"\n[Data sources queried: {', '.join(sources)}]")

    # Only close OpenEMR client (Medplum is a shared singleton)
    if oe_fhir:
        try: await oe_fhir.close()
        except Exception: pass

    return "\n".join(lines) if lines else "No patient data available."


# ── Graph builder ─────────────────────────────────────────────────────────

def build_doctor_cds_graph() -> StateGraph:
    """Construct the Doctor CDS Agent graph for OpenEMR."""

    llm = ChatOpenAI(
        base_url=f"{settings.sealion_api_url}",
        api_key=settings.sealion_api_key,
        model=settings.sealion_model,
        temperature=0.3,
        max_tokens=2048,
    )

    # ── Node: Fetch patient context ───────────────────────────────────

    def fetch_patient_node(state: DoctorCDSState) -> dict:
        pid = state.get("patient_id", "")
        messages = state.get("messages", [])
        steps = list(state.get("steps", []))
        if not pid:
            return {"patient_context": "", "steps": steps}

        steps.append({"action": "Loading patient record", "category": "fhir"})
        try:
            ctx = _run_async(_fetch_patient_summary(pid, messages=messages))
            if ctx and ctx != "No patient data available." and len(ctx.strip()) > 10:
                steps.append({"action": "Patient record loaded", "category": "result"})
                return {"patient_context": ctx, "steps": steps}
        except Exception as e:
            logger.warning("Patient fetch failed: %s", e)
        steps.append({"action": "Could not load patient record", "category": "error"})
        return {"patient_context": "", "steps": steps}

    # ── Node: LLM with patient context in system prompt ───────────────

    def llm_node(state: DoctorCDSState) -> dict:
        patient_ctx = state.get("patient_context", "")
        patient_block = ""
        if patient_ctx:
            patient_block = (
                f"[PATIENT RECORD — LIVE EHR DATA]\n{patient_ctx}\n[END PATIENT RECORD]\n"
                "Base your response ONLY on this live EHR data. Cite specifics."
            )
        prompt = SYSTEM_PROMPT.format(patient_block=patient_block)

        msgs = list(state["messages"])
        non_sys = [m for m in msgs if not isinstance(m, SystemMessage)]

        # Keep only recent messages to avoid stale session history
        # overriding fresh patient context. CDS queries are mostly
        # independent — last 4 messages (2 turns) is sufficient context.
        if len(non_sys) > 4:
            non_sys = non_sys[-4:]

        # If patient data was fetched, inject it as a recent context
        # message so the LLM sees it right before the user's query,
        # not just buried in the system prompt.
        final_msgs = [SystemMessage(content=prompt)]
        if patient_ctx and non_sys:
            ehr_inject = SystemMessage(
                content=(
                    f"[LIVE EHR DATA RETRIEVED — use this data for your response]\n"
                    f"{patient_ctx}"
                )
            )
            final_msgs.extend(non_sys[:-1])
            final_msgs.append(ehr_inject)
            final_msgs.append(non_sys[-1])
        else:
            final_msgs.extend(non_sys)

        steps = list(state.get("steps", []))
        steps.append({"action": "Analyzing clinical query", "category": "thinking"})

        from agent.core.reasoning import invoke_with_retry
        response = invoke_with_retry(llm, final_msgs)
        steps.append({"action": "Clinical assessment ready", "category": "result"})
        return {"messages": [response], "steps": steps}

    # ── Wire the graph ────────────────────────────────────────────────

    g = StateGraph(DoctorCDSState)
    g.add_node("fetch_patient", fetch_patient_node)
    g.add_node("llm_node", llm_node)

    g.add_edge(START, "fetch_patient")
    g.add_edge("fetch_patient", "llm_node")
    g.add_edge("llm_node", END)

    return g


# ── Health check ──────────────────────────────────────────────────────────

async def health_check() -> dict:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{settings.sealion_api_url}/models",
                headers={"Authorization": f"Bearer {settings.sealion_api_key}"},
            )
            return {"status": "ok", "agent": "doctor-cds-agent"}
    except Exception as exc:
        return {"status": "error", "agent": "doctor-cds-agent", "detail": str(exc)}
