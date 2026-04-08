"""Tests for agent contract schemas and parsing utilities."""

import json
import pytest
from agent.core.schemas import (
    ClinicalAssessment,
    LifestyleResponse,
    ResponseConfidence,
    compute_confidence,
    parse_clinical_response,
    parse_lifestyle_response,
    _extract_json,
)


class TestExtractJson:
    def test_plain_json(self):
        assert _extract_json('{"key": "value"}') == {"key": "value"}

    def test_json_in_text(self):
        raw = 'Here is the result: {"assessment": "ok"} done.'
        result = _extract_json(raw)
        assert result == {"assessment": "ok"}

    def test_json_with_code_fence(self):
        raw = '```json\n{"assessment": "ok"}\n```'
        result = _extract_json(raw)
        assert result == {"assessment": "ok"}

    def test_json_array(self):
        raw = '[{"type": "test"}]'
        result = _extract_json(raw)
        assert isinstance(result, list)

    def test_no_json(self):
        assert _extract_json("just plain text") is None

    def test_malformed_json(self):
        assert _extract_json("{broken json") is None


class TestParseClinicalResponse:
    def test_valid_response(self):
        raw = json.dumps({
            "assessment": "Patient has well-controlled diabetes",
            "evidence": [{"resource_type": "Observation", "key_value": "HbA1c 6.5%", "date": "2026-01-15"}],
            "confidence": "high",
            "warnings": [],
            "suggested_actions": ["Continue current regimen"],
        })
        result = parse_clinical_response(raw)
        assert result is not None
        assert result.assessment == "Patient has well-controlled diabetes"
        assert result.confidence == "high"
        assert len(result.evidence) == 1

    def test_minimal_response(self):
        raw = '{"assessment": "needs review"}'
        result = parse_clinical_response(raw)
        assert result is not None
        assert result.confidence == "low"  # default

    def test_non_json_returns_none(self):
        result = parse_clinical_response("The patient is doing well overall.")
        assert result is None

    def test_wrapped_in_text(self):
        raw = 'Based on the analysis:\n{"assessment": "hypertension controlled", "confidence": "medium"}\nEnd.'
        result = parse_clinical_response(raw)
        assert result is not None
        assert result.confidence == "medium"


class TestParseLifestyleResponse:
    def test_valid_response(self):
        raw = json.dumps({
            "recommendations": [{"category": "diet", "text": "Reduce rice portion", "reason": "glycemic control"}],
            "warnings": [{"food": "grapefruit", "drug": "atorvastatin", "severity": "high", "message": "avoid"}],
            "alternatives": [],
            "goal_suggestions": [],
        })
        result = parse_lifestyle_response(raw)
        assert result is not None
        assert len(result.recommendations) == 1
        assert result.warnings[0].severity == "high"

    def test_empty_response(self):
        raw = '{"recommendations": []}'
        result = parse_lifestyle_response(raw)
        assert result is not None
        assert len(result.recommendations) == 0


class TestComputeConfidence:
    def test_no_grounding(self):
        conf = compute_confidence("", "", 0, 50)
        assert conf.score < 0.5
        assert not conf.has_ehr_data
        assert not conf.has_search_results
        assert "model knowledge" in conf.reasoning

    def test_ehr_only(self):
        conf = compute_confidence("Patient: John Doe\nConditions: diabetes", "", 0, 100)
        assert conf.score >= 0.5
        assert conf.has_ehr_data
        assert not conf.has_search_results

    def test_dual_grounding(self):
        conf = compute_confidence(
            "Patient: John\nConditions: hypertension",
            "WebMD: hypertension is high blood pressure",
            3, 200,
        )
        assert conf.score >= 0.8
        assert conf.has_ehr_data
        assert conf.has_search_results

    def test_search_only(self):
        conf = compute_confidence("", "Mayo Clinic: diabetes overview...", 2, 150)
        assert conf.has_search_results
        assert not conf.has_ehr_data
        assert conf.score > 0.3
