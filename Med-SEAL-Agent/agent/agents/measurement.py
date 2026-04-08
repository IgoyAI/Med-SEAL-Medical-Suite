"""A6: Measurement Agent — pure analytics engine (no LLM).

Computes outcome metrics: medication adherence (PDC), biometric trends
(linear regression), PRO deltas, engagement rates, and readmission
counts.  Writes FHIR MeasureReport resources.  Runs on cron schedules.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from agent.tools.fhir_client import get_medplum

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _linear_regression_slope(values: list[float]) -> float | None:
    """Simple OLS slope over equally-spaced observations."""
    n = len(values)
    if n < 3:
        return None
    x_mean = (n - 1) / 2.0
    y_mean = sum(values) / n
    num = sum((i - x_mean) * (v - y_mean) for i, v in enumerate(values))
    den = sum((i - x_mean) ** 2 for i in range(n))
    if den == 0:
        return 0.0
    return num / den


def _trend_label(slope: float | None, threshold: float = 0.5) -> str:
    if slope is None:
        return "insufficient_data"
    if slope > threshold:
        return "rising"
    if slope < -threshold:
        return "declining"
    return "stable"


async def compute_pdc(patient_id: str, period_days: int = 30) -> dict:
    """Proportion of Days Covered for each active medication."""
    fhir = get_medplum()
    start = (_now() - timedelta(days=period_days)).isoformat()

    requests = await fhir.search("MedicationRequest", {
        "patient": patient_id, "status": "active",
    })
    admins = await fhir.search("MedicationAdministration", {
        "patient": patient_id,
        "effective-time": f"ge{start}",
    })

    admin_dates_by_med: dict[str, set[str]] = {}
    for adm in admins:
        med_ref = adm.get("medicationReference", {}).get("reference", "unknown")
        eff = adm.get("effectiveDateTime", adm.get("effectivePeriod", {}).get("start", ""))
        if eff:
            admin_dates_by_med.setdefault(med_ref, set()).add(eff[:10])

    per_med = []
    total_covered = 0
    total_days = 0
    for req in requests:
        med_name = req.get("medicationCodeableConcept", {}).get("text", "unknown")
        med_ref = f"MedicationRequest/{req.get('id', '')}"
        covered = len(admin_dates_by_med.get(med_ref, set()))
        pdc = round(covered / period_days, 3) if period_days > 0 else 0
        per_med.append({
            "medication": med_name,
            "pdc": pdc,
            "days_covered": covered,
            "days_in_period": period_days,
        })
        total_covered += covered
        total_days += period_days

    overall = round(total_covered / total_days, 3) if total_days > 0 else 0
    return {"overall_pdc": overall, "per_medication": per_med, "period_days": period_days}


async def compute_biometric_trend(
    patient_id: str,
    loinc_code: str,
    vital_name: str,
    period_days: int = 30,
) -> dict:
    """Linear regression trend for a vital sign."""
    fhir = get_medplum()
    start = (_now() - timedelta(days=period_days)).isoformat()
    obs = await fhir.search("Observation", {
        "patient": patient_id,
        "code": f"http://loinc.org|{loinc_code}",
        "date": f"ge{start}",
        "_sort": "date",
    })

    values = []
    for o in obs:
        vq = o.get("valueQuantity", {})
        v = vq.get("value")
        if v is not None:
            values.append(float(v))

    slope = _linear_regression_slope(values)
    avg = round(sum(values) / len(values), 2) if values else None
    return {
        "vital": vital_name,
        "loinc": loinc_code,
        "data_points": len(values),
        "latest": values[-1] if values else None,
        "average": avg,
        "slope": round(slope, 4) if slope is not None else None,
        "trend": _trend_label(slope),
    }


async def compute_pro_delta(patient_id: str) -> dict:
    """PRO score change from last two collections."""
    fhir = get_medplum()
    responses = await fhir.search("QuestionnaireResponse", {
        "patient": patient_id,
        "_sort": "-authored",
        "_count": "10",
    })

    instruments: dict[str, list] = {}
    for resp in responses:
        q_ref = resp.get("questionnaire", "unknown")
        score = None
        for item in resp.get("item", []):
            for ans in item.get("answer", []):
                v = ans.get("valueInteger") or ans.get("valueDecimal")
                if v is not None:
                    score = (score or 0) + float(v)
        if score is not None:
            instruments.setdefault(q_ref, []).append(score)

    results = []
    for q_ref, scores in instruments.items():
        current = scores[0] if scores else None
        previous = scores[1] if len(scores) > 1 else None
        delta = round(current - previous, 2) if current is not None and previous is not None else None
        results.append({
            "instrument": q_ref,
            "current_score": current,
            "previous_score": previous,
            "delta": delta,
        })

    return {"instruments": results}


async def compute_engagement_rate(patient_id: str, period_days: int = 7) -> dict:
    """Weekly interaction frequency and nudge response rate."""
    fhir = get_medplum()
    start = (_now() - timedelta(days=period_days)).isoformat()

    comms = await fhir.search("Communication", {
        "patient": patient_id,
        "sent": f"ge{start}",
    })

    patient_initiated = 0
    nudge_sent = 0
    nudge_responded = 0
    for c in comms:
        sender = c.get("sender", {}).get("reference", "")
        categories = [
            coding.get("code", "")
            for cat in c.get("category", [])
            for coding in cat.get("coding", [])
        ]
        if f"Patient/{patient_id}" in sender:
            patient_initiated += 1
        if "nudge" in categories:
            nudge_sent += 1
        if "nudge-response" in categories:
            nudge_responded += 1

    return {
        "patient_initiated": patient_initiated,
        "interactions_per_day": round(patient_initiated / max(period_days, 1), 2),
        "nudge_sent": nudge_sent,
        "nudge_responded": nudge_responded,
        "nudge_response_rate": round(nudge_responded / max(nudge_sent, 1), 3),
        "period_days": period_days,
    }


async def compute_readmission_count(patient_id: str, period_days: int = 90) -> dict:
    """Count inpatient/emergency encounters in the period."""
    fhir = get_medplum()
    start = (_now() - timedelta(days=period_days)).isoformat()

    encounters = await fhir.search("Encounter", {
        "patient": patient_id,
        "date": f"ge{start}",
    })

    readmissions = 0
    for enc in encounters:
        cls = enc.get("class", {})
        code = cls.get("code", "")
        if code in ("IMP", "EMER", "inpatient", "emergency"):
            readmissions += 1

    return {
        "readmission_count": readmissions,
        "period_days": period_days,
    }


async def run_all_metrics(patient_id: str) -> dict:
    """Compute all metrics for a patient and write MeasureReports."""
    import asyncio

    fhir = get_medplum()
    now = _now()
    period_start = (now - timedelta(days=30)).strftime("%Y-%m-%d")
    period_end = now.strftime("%Y-%m-%d")

    # Run all independent metric computations in parallel
    results = await asyncio.gather(
        compute_pdc(patient_id),
        compute_biometric_trend(patient_id, "8480-6", "systolic_bp"),
        compute_biometric_trend(patient_id, "2345-7", "glucose"),
        compute_pro_delta(patient_id),
        compute_engagement_rate(patient_id),
        compute_readmission_count(patient_id),
        return_exceptions=True,
    )

    _defaults = [
        {"overall_pdc": None, "per_medication": [], "period_days": 30},
        {"vital": "systolic_bp", "trend": "error"},
        {"vital": "glucose", "trend": "error"},
        {"instruments": []},
        {"interactions_per_day": None},
        {"readmission_count": 0},
    ]
    resolved = []
    for i, r in enumerate(results):
        if isinstance(r, Exception):
            logger.warning("Metric computation %d failed for %s: %s", i, patient_id, r)
            resolved.append(_defaults[i])
        else:
            resolved.append(r)

    pdc, bp_trend, glucose_trend, pro, engagement, readmissions = resolved

    metrics = {
        "adherence_pdc": pdc,
        "bp_trend": bp_trend,
        "glucose_trend": glucose_trend,
        "pro_change": pro,
        "engagement_rate": engagement,
        "readmissions": readmissions,
    }

    for metric_id, data in metrics.items():
        score = None
        if metric_id == "adherence_pdc":
            score = data.get("overall_pdc")
        elif metric_id in ("bp_trend", "glucose_trend"):
            score = data.get("slope")
        elif metric_id == "engagement_rate":
            score = data.get("interactions_per_day")
        elif metric_id == "readmissions":
            score = float(data.get("readmission_count", 0))

        if score is not None:
            try:
                await fhir.create("MeasureReport", {
                    "resourceType": "MeasureReport",
                    "status": "complete",
                    "type": "individual",
                    "measure": f"Measure/medseal-{metric_id}",
                    "subject": {"reference": f"Patient/{patient_id}"},
                    "date": now.isoformat(),
                    "period": {"start": period_start, "end": period_end},
                    "group": [{
                        "code": {"text": metric_id},
                        "measureScore": {"value": round(score, 4)},
                    }],
                    "reporter": {"reference": "Device/medseal-measurement-agent"},
                })
            except Exception:
                logger.exception("Failed to write MeasureReport for %s/%s", patient_id, metric_id)

    return metrics


async def health_check() -> dict:
    try:
        ok = await get_medplum().ping()
        return {"agent": "measurement-agent", "status": "ok" if ok else "degraded", "medplum": "ok" if ok else "unreachable"}
    except Exception as exc:
        return {"agent": "measurement-agent", "status": "degraded", "error": str(exc)}
