"""Integration tests for medical search tools.

Tests against REAL DuckDuckGo search API.
Verifies search results contain relevant medical content.
"""

import json
import pytest


# ═══════════════════════════════════════════════════════════════════════
# WebMD Search
# ═══════════════════════════════════════════════════════════════════════

class TestSearchWebMD:
    def test_returns_results(self):
        from agent.tools.medical_tools import search_webmd
        result = json.loads(search_webmd.invoke({"query": "diabetes type 2 symptoms"}))
        assert isinstance(result, dict)
        assert "results" in result
        assert "count" in result
        assert result["count"] > 0
        assert len(result["results"]) > 0

    def test_results_have_required_fields(self):
        from agent.tools.medical_tools import search_webmd
        result = json.loads(search_webmd.invoke({"query": "hypertension treatment"}))
        for r in result["results"]:
            assert "title" in r
            assert "url" in r
            assert "snippet" in r

    def test_results_from_webmd(self):
        from agent.tools.medical_tools import search_webmd
        result = json.loads(search_webmd.invoke({"query": "metformin side effects"}))
        urls = [r.get("url", "") for r in result["results"]]
        assert any("webmd.com" in u for u in urls), f"Expected webmd.com URLs, got: {urls}"


# ═══════════════════════════════════════════════════════════════════════
# Mayo Clinic Search
# ═══════════════════════════════════════════════════════════════════════

class TestSearchMayoClinic:
    def test_returns_results(self):
        from agent.tools.medical_tools import search_mayoclinic
        result = json.loads(search_mayoclinic.invoke({"query": "high blood pressure"}))
        assert isinstance(result, dict)
        assert result["count"] > 0

    def test_results_from_mayoclinic(self):
        from agent.tools.medical_tools import search_mayoclinic
        result = json.loads(search_mayoclinic.invoke({"query": "diabetes diagnosis"}))
        urls = [r.get("url", "") for r in result["results"]]
        assert any("mayoclinic.org" in u for u in urls), f"Expected mayoclinic.org URLs, got: {urls}"


# ═══════════════════════════════════════════════════════════════════════
# MOH Singapore Search
# ═══════════════════════════════════════════════════════════════════════

class TestSearchMOHSG:
    def test_returns_results(self):
        from agent.tools.medical_tools import search_moh_sg
        result = json.loads(search_moh_sg.invoke({"query": "diabetes clinical guidelines Singapore"}))
        assert isinstance(result, dict)
        assert "results" in result
        assert "count" in result


# ═══════════════════════════════════════════════════════════════════════
# HealthHub SG Search
# ═══════════════════════════════════════════════════════════════════════

class TestSearchHealthHubSG:
    def test_returns_results(self):
        from agent.tools.medical_tools import search_healthhub_sg
        result = json.loads(search_healthhub_sg.invoke({"query": "healthy eating tips"}))
        assert isinstance(result, dict)
        assert "count" in result


# ═══════════════════════════════════════════════════════════════════════
# NUH Search
# ═══════════════════════════════════════════════════════════════════════

class TestSearchNUH:
    def test_returns_results(self):
        from agent.tools.medical_tools import search_nuh
        result = json.loads(search_nuh.invoke({"query": "cardiology department"}))
        assert isinstance(result, dict)
        assert "results" in result


# ═══════════════════════════════════════════════════════════════════════
# HealthHub Chinese Search
# ═══════════════════════════════════════════════════════════════════════

class TestSearchHealthHubZH:
    def test_returns_results(self):
        from agent.tools.medical_tools import search_healthhub_zh
        result = json.loads(search_healthhub_zh.invoke({"query": "糖尿病 预防"}))
        assert isinstance(result, dict)
        assert "results" in result


# ═══════════════════════════════════════════════════════════════════════
# KKM Malaysia Search
# ═══════════════════════════════════════════════════════════════════════

class TestSearchKKMMY:
    def test_returns_results(self):
        from agent.tools.medical_tools import search_kkm_my
        result = json.loads(search_kkm_my.invoke({"query": "kencing manis rawatan"}))
        assert isinstance(result, dict)
        assert "results" in result


# ═══════════════════════════════════════════════════════════════════════
# Clarify (meta-tool)
# ═══════════════════════════════════════════════════════════════════════

class TestClarify:
    def test_echoes_question(self):
        from agent.tools.medical_tools import clarify
        result = clarify.invoke({"question": "What do you mean by blood sugar?"})
        assert "blood sugar" in result.lower()

    def test_non_empty_response(self):
        from agent.tools.medical_tools import clarify
        result = clarify.invoke({"question": "Can you elaborate?"})
        assert len(result) > 0
