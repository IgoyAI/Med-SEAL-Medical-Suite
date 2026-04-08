"""Tests for the embeddings module — authority ranking and cosine similarity."""

import pytest
from agent.core.embeddings import (
    cosine_similarity,
    _get_authority_boost,
    _AUTHORITY_TIERS,
)


class TestCosineSimilarity:
    def test_identical_vectors(self):
        v = [1.0, 0.0, 0.5]
        assert cosine_similarity(v, v) == pytest.approx(1.0, abs=1e-6)

    def test_orthogonal_vectors(self):
        a = [1.0, 0.0]
        b = [0.0, 1.0]
        assert cosine_similarity(a, b) == pytest.approx(0.0, abs=1e-6)

    def test_opposite_vectors(self):
        a = [1.0, 0.0]
        b = [-1.0, 0.0]
        assert cosine_similarity(a, b) == pytest.approx(-1.0, abs=1e-6)

    def test_empty_vectors(self):
        assert cosine_similarity([], []) == 0.0

    def test_mismatched_lengths(self):
        assert cosine_similarity([1, 2], [1, 2, 3]) == 0.0

    def test_zero_vector(self):
        assert cosine_similarity([0, 0], [1, 1]) == 0.0


class TestAuthorityRanking:
    def test_tier1_moh(self):
        item = {"source_label": "MOH Singapore", "url": "https://moh.gov.sg/guidelines"}
        assert _get_authority_boost(item) >= 0.12

    def test_tier2_pubmed(self):
        item = {"source_label": "PubMed/Scholar", "url": "https://pubmed.ncbi.nlm.nih.gov/12345/"}
        assert _get_authority_boost(item) >= 0.08

    def test_tier2_mayo(self):
        item = {"source_label": "Mayo Clinic", "url": "https://mayoclinic.org/diseases/diabetes"}
        assert _get_authority_boost(item) >= 0.05

    def test_tier3_webmd(self):
        item = {"source_label": "WebMD", "url": "https://webmd.com/diabetes"}
        assert _get_authority_boost(item) == 0.0

    def test_unknown_source(self):
        item = {"source_label": "Random Blog", "url": "https://random-blog.com"}
        assert _get_authority_boost(item) == 0.0

    def test_url_fallback(self):
        """Should match by URL domain when label doesn't match."""
        item = {"source_label": "Unknown", "url": "https://www.nuh.com.sg/conditions"}
        assert _get_authority_boost(item) >= 0.08
