"""LangChain tool definitions for medical RAG search.

Uses DuckDuckGo to search trusted medical sources with automatic retry
and returns structured results with URLs for citation.
"""

from __future__ import annotations

import json
import logging
import time

from langchain_core.tools import tool

logger = logging.getLogger(__name__)

_DDG_MAX_RETRIES = 2
_DDG_RETRY_DELAY = 1.0


def _search_site(query: str, site_filter: str, max_results: int = 5) -> str:
    """Search DuckDuckGo with site filter, returning results with URLs.

    Retries on rate-limit or transient failures. Logs clearly on exhaustion.
    """
    last_error = None
    for attempt in range(_DDG_MAX_RETRIES + 1):
        try:
            from ddgs import DDGS
            with DDGS() as ddg:
                results = list(ddg.text(f"{site_filter} {query}", max_results=max_results))
            if not results:
                return json.dumps({"results": [], "count": 0})
            formatted = []
            for r in results:
                formatted.append({
                    "title": r.get("title", ""),
                    "url": r.get("href", r.get("link", "")),
                    "snippet": r.get("body", r.get("snippet", "")),
                })
            return json.dumps({"results": formatted, "count": len(formatted)})
        except Exception as exc:
            last_error = exc
            if attempt < _DDG_MAX_RETRIES:
                logger.info("DuckDuckGo retry %d/%d for %r: %s",
                           attempt + 1, _DDG_MAX_RETRIES, site_filter, exc)
                time.sleep(_DDG_RETRY_DELAY)
            else:
                logger.warning("DuckDuckGo search exhausted %d retries for %r: %s",
                             _DDG_MAX_RETRIES, site_filter, exc)
    return json.dumps({"results": [], "count": 0, "error": str(last_error), "search_failed": True})


@tool
def search_webmd(query: str) -> str:
    """Search WebMD for general medical information including symptoms,
    conditions, treatments, and medications. Use this for common health
    questions about diseases, drug side-effects, or wellness topics."""
    return _search_site(query, "site:webmd.com")


@tool
def search_mayoclinic(query: str) -> str:
    """Search Mayo Clinic for evidence-based medical information including
    disease overviews, symptoms, causes, risk factors, diagnosis, and
    treatment options. Mayo Clinic is a top-tier medical reference."""
    return _search_site(query, "site:mayoclinic.org")


@tool
def search_moh_sg(query: str) -> str:
    """Search Singapore Ministry of Health (MOH) for official clinical practice
    guidelines, health policies, and standards of care in Singapore."""
    return _search_site(query, "site:moh.gov.sg OR site:hpp.moh.gov.sg")


@tool
def search_healthhub_sg(query: str) -> str:
    """Search HealthHub Singapore for patient-friendly health information,
    disease guides, healthy living tips, and healthcare services."""
    return _search_site(query, "site:healthhub.sg")


@tool
def search_nuh(query: str) -> str:
    """Search NUH (National University Hospital) Singapore for local clinical
    resources, specialist departments, and disease information."""
    return _search_site(query, "site:nuh.com.sg")


@tool
def clarify(question: str) -> str:
    """ONLY use this tool when the query is genuinely impossible to answer
    without critical missing context."""
    return question


@tool
def search_healthhub_zh(query: str) -> str:
    """Search HealthHub Singapore Chinese for health information in Mandarin.
    Use for Chinese-speaking patients."""
    return _search_site(query, "site:healthhub.sg 华语 OR 中文")


@tool
def search_kkm_my(query: str) -> str:
    """Search KKM Malaysia (Kementerian Kesihatan Malaysia) for health information
    in Bahasa Melayu. Use for Malay-speaking patients."""
    return _search_site(query, "site:moh.gov.my OR site:myhealth.gov.my")


SEARCH_TOOLS = [search_webmd, search_mayoclinic, search_moh_sg, search_healthhub_sg, search_nuh]
SEARCH_TOOLS_ZH = [search_healthhub_zh, search_moh_sg]
SEARCH_TOOLS_MS = [search_kkm_my, search_healthhub_sg, search_moh_sg]

ALL_TOOLS = SEARCH_TOOLS + [search_healthhub_zh, search_kkm_my, clarify]


def get_search_tools_for_language(lang_code: str) -> list:
    """Return search tools appropriate for the detected language.

    Non-English queries get local-language sources PLUS English sources.
    """
    if lang_code.startswith("zh"):
        return SEARCH_TOOLS_ZH + SEARCH_TOOLS[:2]  # Chinese + WebMD + Mayo
    if lang_code in ("ms", "id"):
        return SEARCH_TOOLS_MS + SEARCH_TOOLS[:1]  # Malay + WebMD
    return SEARCH_TOOLS[:3]  # Default English: WebMD, Mayo, MOH
