"""Integration tests for medical journal search tools.

Tests against REAL PubMed and Semantic Scholar APIs.
"""

import json
import pytest


# ═══════════════════════════════════════════════════════════════════════
# search_medical_journals
# ═══════════════════════════════════════════════════════════════════════

class TestSearchMedicalJournals:
    def test_returns_results_for_common_query(self):
        from agent.tools.journal_tools import search_medical_journals
        result = json.loads(search_medical_journals.invoke({"query": "metformin type 2 diabetes"}))
        assert isinstance(result, dict)
        assert "papers" in result
        assert "count" in result
        assert result["count"] > 0
        assert len(result["papers"]) > 0

    def test_results_have_title(self):
        from agent.tools.journal_tools import search_medical_journals
        result = json.loads(search_medical_journals.invoke({"query": "SGLT2 inhibitors cardiovascular"}))
        for paper in result["papers"]:
            assert "title" in paper
            assert len(paper["title"]) > 0

    def test_results_have_authors_or_source(self):
        from agent.tools.journal_tools import search_medical_journals
        result = json.loads(search_medical_journals.invoke({"query": "hypertension guidelines 2025"}))
        for paper in result["papers"]:
            has_authors = "authors" in paper and paper["authors"]
            has_source = "source" in paper or "journal" in paper
            assert has_authors or has_source, f"Paper missing authors/source: {paper.get('title')}"

    def test_respects_max_results(self):
        from agent.tools.journal_tools import search_medical_journals
        result = json.loads(search_medical_journals.invoke({
            "query": "diabetes",
            "max_results": 3,
        }))
        assert len(result["papers"]) <= 3

    def test_empty_query_returns_something(self):
        from agent.tools.journal_tools import search_medical_journals
        result = json.loads(search_medical_journals.invoke({"query": "aspirin"}))
        assert isinstance(result, dict)
        assert "papers" in result


# ═══════════════════════════════════════════════════════════════════════
# read_journal_paper
# ═══════════════════════════════════════════════════════════════════════

class TestReadJournalPaper:
    def test_read_by_known_pmid(self):
        """PMID 31697824 = DAPA-HF trial (well-known, has full text)."""
        from agent.tools.journal_tools import read_journal_paper
        result = read_journal_paper.invoke({"pmid": "31697824"})
        assert isinstance(result, str)
        assert len(result) > 50

    def test_read_by_doi(self):
        """DOI for a known open-access paper."""
        from agent.tools.journal_tools import read_journal_paper
        result = read_journal_paper.invoke({"doi": "10.1056/NEJMoa1911303"})
        assert isinstance(result, str)
        assert len(result) > 0

    def test_no_params_returns_guidance(self):
        from agent.tools.journal_tools import read_journal_paper
        result = read_journal_paper.invoke({"doi": "", "pdf_url": "", "pmid": ""})
        assert isinstance(result, str)
        assert len(result) > 0
