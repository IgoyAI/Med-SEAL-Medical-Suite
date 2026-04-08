"""Live medical journal search, fetch, and read tools.

Pipeline:  search PubMed/Semantic Scholar → find open-access PDF → read
full text → return content with citation for the agent to reference.

No pre-ingestion required — agents search, fetch, and cite on the fly.
"""

from __future__ import annotations

import io
import json
import logging
import re
import xml.etree.ElementTree as ET
from typing import Any

import httpx

from langchain_core.tools import tool

logger = logging.getLogger(__name__)

_HTTP_TIMEOUT = 20.0


# =====================================================================
# Helpers
# =====================================================================

def _extract_pdf_text(pdf_bytes: bytes, max_pages: int = 30) -> str:
    """Extract text from PDF bytes using PyMuPDF."""
    import fitz  # PyMuPDF

    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    pages = []
    for i, page in enumerate(doc):
        if i >= max_pages:
            break
        text = page.get_text("text")
        if text.strip():
            pages.append(f"--- Page {i + 1} ---\n{text.strip()}")
    doc.close()
    return "\n\n".join(pages)


async def _fetch_bytes(url: str) -> bytes | None:
    """Download content from a URL."""
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(url, headers={
                "User-Agent": "Med-SEAL/1.0 (medical AI research; mailto:admin@medseal.ai)",
                "Accept": "application/pdf,*/*",
            })
            if resp.status_code == 200:
                return resp.content
    except Exception as exc:
        logger.warning("Failed to fetch %s: %s", url, exc)
    return None


async def _find_open_access_pdf(doi: str) -> str | None:
    """Try to find an open-access PDF URL via Unpaywall."""
    if not doi:
        return None
    try:
        url = f"https://api.unpaywall.org/v2/{doi}?email=medseal@medseal.ai"
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url)
            if resp.status_code == 200:
                data = resp.json()
                best = data.get("best_oa_location") or {}
                pdf_url = best.get("url_for_pdf") or best.get("url")
                if pdf_url:
                    return pdf_url
    except Exception as exc:
        logger.debug("Unpaywall lookup failed for %s: %s", doi, exc)
    return None


# =====================================================================
# PubMed search
# =====================================================================

async def _pubmed_search(query: str, max_results: int = 5) -> list[dict[str, Any]]:
    """Search PubMed via E-utilities and return article metadata."""
    base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
    articles = []

    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
        # Step 1: search for PMIDs
        search_resp = await client.get(f"{base}/esearch.fcgi", params={
            "db": "pubmed",
            "term": query,
            "retmax": max_results,
            "sort": "relevance",
            "retmode": "json",
        })
        search_data = search_resp.json()
        pmids = search_data.get("esearchresult", {}).get("idlist", [])
        if not pmids:
            return []

        # Step 2: fetch article details
        fetch_resp = await client.get(f"{base}/efetch.fcgi", params={
            "db": "pubmed",
            "id": ",".join(pmids),
            "rettype": "xml",
            "retmode": "xml",
        })
        root = ET.fromstring(fetch_resp.text)

        for article_el in root.findall(".//PubmedArticle"):
            medline = article_el.find("MedlineCitation")
            if medline is None:
                continue

            art = medline.find("Article")
            if art is None:
                continue

            # Title
            title_el = art.find("ArticleTitle")
            title = "".join(title_el.itertext()).strip() if title_el is not None else ""

            # Abstract
            abstract_parts = []
            abstract_el = art.find("Abstract")
            if abstract_el is not None:
                for at in abstract_el.findall("AbstractText"):
                    label = at.get("Label", "")
                    text = "".join(at.itertext()).strip()
                    if label:
                        abstract_parts.append(f"{label}: {text}")
                    else:
                        abstract_parts.append(text)
            abstract = " ".join(abstract_parts)

            # Authors
            authors = []
            for author_el in art.findall(".//Author"):
                last = author_el.findtext("LastName", "")
                first = author_el.findtext("Initials", "")
                if last:
                    authors.append(f"{last} {first}".strip())

            # Journal & year
            journal_el = art.find("Journal")
            journal = ""
            year = ""
            if journal_el is not None:
                journal = journal_el.findtext("Title", "")
                ji = journal_el.find("JournalIssue")
                if ji is not None:
                    pd = ji.find("PubDate")
                    if pd is not None:
                        year = pd.findtext("Year", "")

            # DOI
            doi = ""
            for eid in article_el.findall(".//ArticleId"):
                if eid.get("IdType") == "doi":
                    doi = (eid.text or "").strip()
                    break

            # PMID
            pmid = medline.findtext("PMID", "")

            articles.append({
                "pmid": pmid,
                "title": title,
                "authors": authors[:5],  # first 5
                "journal": journal,
                "year": year,
                "doi": doi,
                "abstract": abstract[:1500],
                "pubmed_url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
            })

    return articles


# =====================================================================
# Semantic Scholar search
# =====================================================================

async def _semantic_scholar_search(query: str, max_results: int = 5) -> list[dict[str, Any]]:
    """Search Semantic Scholar API for papers."""
    articles = []
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.get(
                "https://api.semanticscholar.org/graph/v1/paper/search",
                params={
                    "query": query,
                    "limit": max_results,
                    "fields": "title,authors,year,abstract,externalIds,openAccessPdf,journal,citationCount,url",
                },
            )
            if resp.status_code != 200:
                return []
            data = resp.json()
            for paper in data.get("data", []):
                doi = (paper.get("externalIds") or {}).get("DOI", "")
                pmid = (paper.get("externalIds") or {}).get("PubMed", "")
                oa_pdf = (paper.get("openAccessPdf") or {}).get("url", "")
                authors = [a.get("name", "") for a in (paper.get("authors") or [])[:5]]
                journal_name = (paper.get("journal") or {}).get("name", "")

                articles.append({
                    "title": paper.get("title", ""),
                    "authors": authors,
                    "journal": journal_name,
                    "year": paper.get("year", ""),
                    "doi": doi,
                    "pmid": pmid,
                    "abstract": (paper.get("abstract") or "")[:1500],
                    "open_access_pdf": oa_pdf,
                    "citation_count": paper.get("citationCount", 0),
                    "url": paper.get("url", ""),
                })
    except Exception as exc:
        logger.warning("Semantic Scholar search failed: %s", exc)
    return articles


# =====================================================================
# LangChain Tools
# =====================================================================

def _run(coro):
    """Run async coroutine from sync LangChain tool context."""
    import asyncio
    import concurrent.futures
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


@tool
def search_medical_journals(query: str, max_results: int = 5) -> str:
    """Search PubMed and Semantic Scholar for medical research papers.

    Returns titles, authors, journal, year, abstract, DOI, and links.
    Use this when you need evidence from medical literature to support
    clinical reasoning, answer research questions, or cite guidelines.

    Args:
        query: Clinical or research question (e.g. "metformin cardiovascular
               outcomes type 2 diabetes randomized trial").
        max_results: Number of papers to return per source (default 5).
    """
    async def _search():
        pubmed = await _pubmed_search(query, max_results=max_results)
        scholar = await _semantic_scholar_search(query, max_results=max_results)

        # Merge and deduplicate by DOI
        seen_dois = set()
        merged = []
        for article in pubmed + scholar:
            doi = article.get("doi", "")
            key = doi if doi else article.get("title", "")
            if key and key in seen_dois:
                continue
            if key:
                seen_dois.add(key)
            article["source_db"] = "pubmed" if article in pubmed else "semantic_scholar"
            merged.append(article)

        # Sort by year descending
        merged.sort(key=lambda a: a.get("year", "0"), reverse=True)
        return merged[:max_results]

    try:
        results = _run(_search())
        return json.dumps({"papers": results, "count": len(results)})
    except Exception as exc:
        logger.error("Journal search failed: %s", exc)
        return json.dumps({"papers": [], "count": 0, "error": str(exc)})


@tool
def read_journal_paper(doi: str = "", pdf_url: str = "", pmid: str = "") -> str:
    """Fetch and read the full text of a medical journal paper.

    Provide at least one of: DOI, direct PDF URL, or PMID.
    The tool will attempt to find an open-access PDF, download it,
    extract the full text, and return it for you to cite.

    Args:
        doi: Digital Object Identifier (e.g. "10.1056/NEJMoa2032183").
        pdf_url: Direct URL to a PDF file.
        pmid: PubMed ID (e.g. "33567185").
    """
    async def _read():
        pdf_bytes = None
        source_url = ""

        # Strategy 1: Direct PDF URL provided
        if pdf_url:
            pdf_bytes = await _fetch_bytes(pdf_url)
            source_url = pdf_url

        # Strategy 2: Try Unpaywall with DOI
        if pdf_bytes is None and doi:
            oa_url = await _find_open_access_pdf(doi)
            if oa_url:
                pdf_bytes = await _fetch_bytes(oa_url)
                source_url = oa_url

        # Strategy 3: Try PubMed Central with PMID or DOI
        if pdf_bytes is None:
            pmc_id = None
            async with httpx.AsyncClient(timeout=10) as client:
                # Convert PMID to PMC ID
                if pmid:
                    resp = await client.get(
                        "https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/",
                        params={"ids": pmid, "format": "json"},
                    )
                    if resp.status_code == 200:
                        records = resp.json().get("records", [])
                        if records:
                            pmc_id = records[0].get("pmcid", "")
                elif doi:
                    resp = await client.get(
                        "https://www.ncbi.nlm.nih.gov/pmc/utils/idconv/v1.0/",
                        params={"ids": doi, "format": "json"},
                    )
                    if resp.status_code == 200:
                        records = resp.json().get("records", [])
                        if records:
                            pmc_id = records[0].get("pmcid", "")

                if pmc_id:
                    pmc_pdf_url = f"https://www.ncbi.nlm.nih.gov/pmc/articles/{pmc_id}/pdf/"
                    pdf_bytes = await _fetch_bytes(pmc_pdf_url)
                    source_url = pmc_pdf_url

        # Strategy 4: If still no PDF, return abstract from PubMed
        if pdf_bytes is None:
            if pmid or doi:
                search_term = pmid if pmid else doi
                articles = await _pubmed_search(search_term, max_results=1)
                if articles:
                    art = articles[0]
                    return json.dumps({
                        "status": "abstract_only",
                        "reason": "Full text PDF not openly accessible.",
                        "title": art["title"],
                        "authors": art["authors"],
                        "journal": art["journal"],
                        "year": art["year"],
                        "abstract": art["abstract"],
                        "doi": art["doi"],
                        "pubmed_url": art["pubmed_url"],
                    })
            return json.dumps({
                "status": "not_found",
                "reason": "Could not locate an accessible PDF. Try a different paper or provide a direct PDF URL.",
            })

        # Extract text from PDF
        full_text = _extract_pdf_text(pdf_bytes, max_pages=30)
        if not full_text.strip():
            return json.dumps({
                "status": "error",
                "reason": "PDF downloaded but no text could be extracted (may be scanned/image-based).",
            })

        # Truncate to ~4k chars to avoid context window pollution
        if len(full_text) > 4000:
            full_text = full_text[:4000] + "\n\n[... truncated — use DOI for full paper ...]"

        return json.dumps({
            "status": "full_text",
            "source_url": source_url,
            "content": full_text,
            "char_count": len(full_text),
            "ephemeral": True,  # Signal to context management: clear after use
        })

    try:
        return _run(_read())
    except Exception as exc:
        logger.error("Read journal paper failed: %s", exc)
        return json.dumps({"status": "error", "reason": str(exc)})


# ---------------------------------------------------------------------------
# Tool collection
# ---------------------------------------------------------------------------
JOURNAL_TOOLS = [search_medical_journals, read_journal_paper]
