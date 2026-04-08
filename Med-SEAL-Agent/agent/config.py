from __future__ import annotations

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Agent configuration loaded from environment variables.

    All values have sensible defaults for local development.  Override via
    env vars or a ``.env`` file (pydantic-settings reads both).
    """

    # vLLM server (Med-R1 — clinical reasoning only)
    vllm_url: str = "http://localhost:8000"
    model_name: str = "med-r1"

    # SEA-LION API (conversation + guard)
    sealion_api_url: str = "https://api.sea-lion.ai/v1"
    sealion_api_key: str = ""
    sealion_model: str = "aisingapore/Qwen-SEA-LION-v4-32B-IT"
    sealion_embedding_model: str = "BAAI/bge-m3"
    seaguard_model: str = "aisingapore/SEA-Guard"

    # Clinical LLM backend: "openrouter" (default), "azure", or "vllm"
    clinical_llm_backend: str = "openrouter"

    # OpenRouter (Qwen3.6 Plus — primary clinical LLM)
    openrouter_api_key: str = ""
    openrouter_model: str = "qwen/qwen3.6-plus"

    # Azure OpenAI (optional fallback)
    azure_openai_endpoint: str = ""
    azure_openai_api_key: str = ""
    azure_openai_deployment: str = "gpt-5.3"        # Assuming this is your deployment name
    azure_openai_api_version: str = "2025-04-01-preview"

    # Medplum FHIR R4
    medplum_url: str = "http://119.13.90.82:8103/fhir/R4"
    medplum_client_id: str = ""
    medplum_client_secret: str = ""
    medplum_email: str = "admin@example.com"
    medplum_password: str = "medplum_admin"

    # OpenEMR FHIR R4 (native FHIR API — encounters, SOAP notes, vitals)
    openemr_fhir_url: str = "http://emr.medseal.34.54.226.15.nip.io/apis/default/fhir"
    openemr_client_id: str = ""
    openemr_client_secret: str = ""
    openemr_user: str = "admin"
    openemr_pass: str = "pass"

    # Redis (used by AsyncRedisSaver for LangGraph checkpoints)
    redis_url: str = "redis://localhost:6379/0"

    # Session behaviour
    session_ttl_seconds: int = 86400  # 24 hours

    # Agent loop
    max_recursion: int = 5
    max_tokens: int = 1536
    temperature: float = 0.6

    # Per-agent temperature overrides
    clinical_temperature: float = 0.3
    clinical_max_tokens: int = 1024
    companion_temperature: float = 0.7
    companion_max_tokens: int = 4096
    nudge_temperature: float = 0.6
    nudge_max_tokens: int = 256
    lifestyle_temperature: float = 0.5
    lifestyle_max_tokens: int = 512
    insight_temperature: float = 0.2
    insight_max_tokens: int = 2048

    # Nudge scheduling
    nudge_timezone: str = "Asia/Singapore"

    # Context compression (F1)
    context_window_tokens: int = 32768
    compaction_reserve_tokens: int = 13000
    compaction_summary_max_tokens: int = 600
    compaction_keep_recent: int = 6
    compaction_max_failures: int = 3

    # Tool safety gates (F2)
    tool_gate_enabled: bool = True
    nudge_rate_limit_minutes: int = 60
    escalation_rate_limit_minutes: int = 120

    # LangFuse observability
    langfuse_enabled: bool = True
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""
    langfuse_host: str = "http://119.13.90.82:3100"

    # Patient memory (F4)
    memory_enabled: bool = True
    memory_extraction_max_messages: int = 10
    memory_load_limit: int = 8
    memory_extraction_cooldown_seconds: int = 30

    model_config = {"env_prefix": "MEDSEAL_"}


settings = Settings()
