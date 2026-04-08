from __future__ import annotations
import logging
from typing import Any
from langchain_core.language_models import BaseChatModel
from langchain_openai import AzureChatOpenAI, ChatOpenAI
from agent.config import settings

logger = logging.getLogger(__name__)

def _make_vllm_llm(temperature: float, max_tokens: int, **kwargs: Any) -> ChatOpenAI:
    return ChatOpenAI(
        base_url=f"{settings.vllm_url}/v1",
        api_key="EMPTY",
        model=settings.model_name,
        temperature=temperature,
        max_tokens=max_tokens,
        **kwargs,
    )

def _make_azure_llm(temperature: float, max_tokens: int, **kwargs: Any) -> AzureChatOpenAI:
    if not settings.azure_openai_endpoint or not settings.azure_openai_api_key:
        raise ValueError("Azure OpenAI not configured. Set MEDSEAL_AZURE_OPENAI_ENDPOINT and MEDSEAL_AZURE_OPENAI_API_KEY.")
    return AzureChatOpenAI(
        azure_endpoint=settings.azure_openai_endpoint,
        api_key=settings.azure_openai_api_key,
        azure_deployment=settings.azure_openai_deployment,
        api_version=settings.azure_openai_api_version,
        temperature=temperature,
        max_tokens=max_tokens,
        **kwargs,
    )

def _make_openrouter_llm(temperature: float, max_tokens: int, **kwargs: Any) -> ChatOpenAI:
    return ChatOpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=settings.openrouter_api_key,
        model=settings.openrouter_model,
        temperature=temperature,
        max_tokens=max_tokens,
        **kwargs,
    )

def create_clinical_llm(temperature: float = 0.3, max_tokens: int = 1024, **kwargs: Any) -> tuple[BaseChatModel, str]:
    """Create clinical LLM with automatic fallback chain.

    Tries primary backend first, falls back through the chain:
    openrouter → azure → sealion (vLLM-compatible API).
    """
    backend = settings.clinical_llm_backend.strip().lower()

    # Define fallback order based on primary
    if backend == "openrouter":
        chain = [
            ("openrouter", _make_openrouter_llm),
            ("azure", _make_azure_llm),
            ("sealion", lambda t, m, **kw: _make_sealion_llm(t, m, **kw)),
        ]
    elif backend == "azure":
        chain = [
            ("azure", _make_azure_llm),
            ("openrouter", _make_openrouter_llm),
            ("sealion", lambda t, m, **kw: _make_sealion_llm(t, m, **kw)),
        ]
    else:  # vllm
        chain = [
            ("vllm", _make_vllm_llm),
            ("openrouter", _make_openrouter_llm),
            ("sealion", lambda t, m, **kw: _make_sealion_llm(t, m, **kw)),
        ]

    for name, factory in chain:
        try:
            llm = factory(temperature, max_tokens, **kwargs)
            logger.info("Using %s backend for clinical LLM", name)
            return llm, name
        except (ValueError, Exception) as e:
            logger.warning("Clinical LLM backend %s unavailable: %s", name, e)
            continue

    # Last resort: SEA-LION direct
    logger.error("All clinical LLM backends failed — using SEA-LION as final fallback")
    return _make_sealion_llm(temperature, max_tokens, **kwargs), "sealion-fallback"


def _make_sealion_llm(temperature: float, max_tokens: int, **kwargs: Any) -> ChatOpenAI:
    """Create a ChatOpenAI pointing at the SEA-LION API."""
    return ChatOpenAI(
        base_url=settings.sealion_api_url,
        api_key=settings.sealion_api_key,
        model=settings.sealion_model,
        temperature=temperature,
        max_tokens=max_tokens,
        **kwargs,
    )
