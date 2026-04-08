"""Shared agent contract schemas for inter-agent communication.

All sub-agents (A2 Clinical, A4 Lifestyle, A5 Insight) must return
responses conforming to these Pydantic models. The orchestrator and
companion validate payloads on both sides.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from pydantic import BaseModel, Field, ValidationError

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════
# A2: Clinical Reasoning Agent output
# ═══════════════════════════════════════════════════════════════════════

class ClinicalEvidence(BaseModel):
    resource_type: str = ""
    resource_id: str = ""
    key_value: str = ""
    date: str = ""


class ClinicalAssessment(BaseModel):
    assessment: str = Field(description="Plain text clinical summary")
    evidence: list[ClinicalEvidence] = Field(default_factory=list)
    confidence: str = Field(default="low", description="high/medium/low")
    warnings: list[str] = Field(default_factory=list)
    suggested_actions: list[str] = Field(default_factory=list)


# ═══════════════════════════════════════════════════════════════════════
# A4: Lifestyle Agent output
# ═══════════════════════════════════════════════════════════════════════

class LifestyleRecommendation(BaseModel):
    category: str = Field(description="diet/exercise/goal")
    text: str = ""
    reason: str = ""


class FoodDrugWarning(BaseModel):
    food: str = ""
    drug: str = ""
    severity: str = "medium"
    message: str = ""


class FoodAlternative(BaseModel):
    instead_of: str = ""
    try_: str = Field(default="", alias="try")
    benefit: str = ""

    class Config:
        populate_by_name = True


class GoalSuggestion(BaseModel):
    description: str = ""
    value: float = 0
    unit: str = ""
    timeframe: str = ""


class LifestyleResponse(BaseModel):
    recommendations: list[LifestyleRecommendation] = Field(default_factory=list)
    warnings: list[FoodDrugWarning] = Field(default_factory=list)
    alternatives: list[FoodAlternative] = Field(default_factory=list)
    goal_suggestions: list[GoalSuggestion] = Field(default_factory=list)


# ═══════════════════════════════════════════════════════════════════════
# A5: Insight Synthesis Agent output
# ═══════════════════════════════════════════════════════════════════════

class InsightSection(BaseModel):
    title: str = ""
    content: str = ""
    actions: list[str] = Field(default_factory=list)


class InsightBrief(BaseModel):
    sections: list[InsightSection] = Field(default_factory=list)
    status: str = "preliminary"
    patient_id: str = ""


# ═══════════════════════════════════════════════════════════════════════
# Response confidence scoring
# ═══════════════════════════════════════════════════════════════════════

class ResponseConfidence(BaseModel):
    """Confidence metadata attached to patient-facing responses."""
    score: float = Field(default=0.5, ge=0.0, le=1.0, description="0-1 confidence")
    has_ehr_data: bool = False
    has_search_results: bool = False
    source_count: int = 0
    reasoning: str = ""


def compute_confidence(
    ehr_context: str,
    search_results: str,
    source_count: int,
    response_length: int,
) -> ResponseConfidence:
    """Compute response confidence based on available grounding data."""
    score = 0.3  # Base score

    has_ehr = bool(ehr_context and len(ehr_context.strip()) > 20)
    has_search = bool(search_results and len(search_results.strip()) > 20)

    if has_ehr:
        score += 0.3  # Strong boost for EHR grounding
    if has_search:
        score += 0.15  # Moderate boost for search grounding
    if source_count >= 3:
        score += 0.1
    if response_length > 100:
        score += 0.05
    if has_ehr and has_search:
        score += 0.1  # Bonus for dual grounding

    score = min(score, 1.0)

    reasons = []
    if has_ehr:
        reasons.append("grounded in patient EHR data")
    if has_search:
        reasons.append(f"supported by {source_count} source(s)")
    if not has_ehr and not has_search:
        reasons.append("no external grounding — based on model knowledge only")

    return ResponseConfidence(
        score=round(score, 2),
        has_ehr_data=has_ehr,
        has_search_results=has_search,
        source_count=source_count,
        reasoning="; ".join(reasons),
    )


# ═══════════════════════════════════════════════════════════════════════
# Parsing utilities
# ═══════════════════════════════════════════════════════════════════════

def _extract_json(text: str) -> dict | list | None:
    """Best-effort JSON extraction from LLM output."""
    text = text.strip()
    # Strip markdown code fences
    text = re.sub(r"```json\s*", "", text)
    text = re.sub(r"```\s*$", "", text)
    # Try direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Try finding JSON object/array
    for start_char, end_char in [("{", "}"), ("[", "]")]:
        start = text.find(start_char)
        end = text.rfind(end_char)
        if start >= 0 and end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                continue
    return None


def parse_clinical_response(raw: str) -> ClinicalAssessment | None:
    """Parse A2 Clinical Agent output into validated schema."""
    data = _extract_json(raw)
    if data is None:
        logger.warning("Clinical response: no JSON found in output")
        return None
    try:
        if isinstance(data, dict):
            return ClinicalAssessment(**data)
    except ValidationError as e:
        logger.warning("Clinical response validation failed: %s", e)
    return None


def parse_lifestyle_response(raw: str) -> LifestyleResponse | None:
    """Parse A4 Lifestyle Agent output into validated schema."""
    data = _extract_json(raw)
    if data is None:
        logger.warning("Lifestyle response: no JSON found in output")
        return None
    try:
        if isinstance(data, dict):
            return LifestyleResponse(**data)
    except ValidationError as e:
        logger.warning("Lifestyle response validation failed: %s", e)
    return None


def parse_agent_response(agent_id: str, raw: str) -> BaseModel | None:
    """Route to the appropriate parser based on agent ID."""
    parsers = {
        "clinical-reasoning-agent": parse_clinical_response,
        "lifestyle-agent": parse_lifestyle_response,
    }
    parser = parsers.get(agent_id)
    if parser:
        return parser(raw)
    return None
