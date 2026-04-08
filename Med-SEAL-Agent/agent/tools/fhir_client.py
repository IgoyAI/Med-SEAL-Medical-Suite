"""Async FHIR client wrapper for Medplum.

Supports two auth flows:
- client_credentials (standard OAuth2)
- email/password with PKCE (Medplum Super Admin)

All Med-SEAL agents use the singleton to interact with the FHIR R4 server.
"""

from __future__ import annotations

import asyncio
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_TOKEN_REFRESH_MARGIN = timedelta(minutes=2)


class MedplumClient:
    """Async FHIR R4 client with Medplum auth."""

    def __init__(
        self,
        base_url: str,
        client_id: str = "",
        client_secret: str = "",
        email: str = "",
        password: str = "",
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._origin = self.base_url.replace("/fhir/R4", "").replace("/fhir", "")
        self._client_id = client_id
        self._client_secret = client_secret
        self._email = email
        self._password = password
        self._timeout = timeout
        self._access_token: str | None = None
        self._token_expires: datetime = datetime.min.replace(tzinfo=timezone.utc)
        self._http: httpx.AsyncClient | None = None

    async def _ensure_http(self) -> httpx.AsyncClient:
        loop = asyncio.get_running_loop()
        # Recreate httpx client if event loop changed (e.g. tool running in thread pool).
        # Token is kept — it's a plain string valid across loops.
        if self._http is None or self._http.is_closed or getattr(self, '_loop', None) is not loop:
            if self._http and not self._http.is_closed:
                try:
                    await self._http.aclose()
                except Exception:
                    pass
            transport = httpx.AsyncHTTPTransport(retries=2)
            self._http = httpx.AsyncClient(timeout=self._timeout, transport=transport)
            self._loop = loop
        return self._http

    async def _ensure_token(self) -> str:
        now = datetime.now(timezone.utc)
        if self._access_token and now < self._token_expires - _TOKEN_REFRESH_MARGIN:
            return self._access_token

        if self._email and self._password:
            return await self._auth_pkce(now)
        if self._client_id and self._client_secret:
            return await self._auth_client_credentials(now)
        return ""

    async def _auth_pkce(self, now: datetime) -> str:
        """Medplum email/password PKCE flow (2 steps)."""
        http = await self._ensure_http()
        verifier = secrets.token_urlsafe(32)

        # Step 1: Login
        login_resp = await http.post(
            f"{self._origin}/auth/login",
            json={
                "email": self._email,
                "password": self._password,
                "scope": "openid fhirUser",
                "codeChallengeMethod": "plain",
                "codeChallenge": verifier,
            },
        )
        login_resp.raise_for_status()
        code = login_resp.json().get("code")
        if not code:
            raise RuntimeError(f"Medplum login did not return a code: {login_resp.text}")

        # Step 2: Exchange code for token
        token_resp = await http.post(
            f"{self._origin}/oauth2/token",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data=f"grant_type=authorization_code&code={code}&code_verifier={verifier}",
        )
        token_resp.raise_for_status()
        data = token_resp.json()
        self._access_token = data["access_token"]
        self._token_expires = now + timedelta(seconds=data.get("expires_in", 3600))
        logger.info("Medplum PKCE auth OK (expires %s)", self._token_expires.isoformat())
        return self._access_token

    async def _auth_client_credentials(self, now: datetime) -> str:
        """Standard OAuth2 client_credentials flow."""
        import base64

        http = await self._ensure_http()
        basic = base64.b64encode(f"{self._client_id}:{self._client_secret}".encode()).decode()
        resp = await http.post(
            f"{self._origin}/oauth2/token",
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Authorization": f"Basic {basic}",
            },
            data="grant_type=client_credentials",
        )
        resp.raise_for_status()
        data = resp.json()
        self._access_token = data["access_token"]
        self._token_expires = now + timedelta(seconds=data.get("expires_in", 3600))
        logger.info("Medplum client_credentials auth OK (expires %s)", self._token_expires.isoformat())
        return self._access_token

    async def _headers(self) -> dict[str, str]:
        token = await self._ensure_token()
        h = {"Content-Type": "application/fhir+json", "Accept": "application/fhir+json"}
        if token:
            h["Authorization"] = f"Bearer {token}"
        return h

    async def read(self, resource_type: str, resource_id: str, params: dict | None = None) -> dict:
        http = await self._ensure_http()
        url = f"{self.base_url}/{resource_type}/{resource_id}"
        resp = await http.get(url, headers=await self._headers(), params=params)
        resp.raise_for_status()
        return resp.json()

    async def search(self, resource_type: str, params: dict[str, Any]) -> list[dict]:
        http = await self._ensure_http()
        url = f"{self.base_url}/{resource_type}"
        resp = await http.get(url, headers=await self._headers(), params=params)
        resp.raise_for_status()
        bundle = resp.json()
        entries = bundle.get("entry", [])
        return [e.get("resource", e) for e in entries]

    async def create(self, resource_type: str, body: dict) -> dict:
        http = await self._ensure_http()
        url = f"{self.base_url}/{resource_type}"
        resp = await http.post(url, headers=await self._headers(), json=body)
        resp.raise_for_status()
        return resp.json()

    async def update(self, resource_type: str, resource_id: str, body: dict) -> dict:
        url = f"{self.base_url}/{resource_type}/{resource_id}"
        body.setdefault("id", resource_id)
        body.setdefault("resourceType", resource_type)
        for attempt in range(3):
            try:
                http = await self._ensure_http()
                resp = await http.put(url, headers=await self._headers(), json=body)
                resp.raise_for_status()
                return resp.json()
            except httpx.ReadError:
                logger.warning("FHIR update ReadError (attempt %d/3), resetting connection", attempt + 1)
                # Force new connection on next attempt
                self._http = None
                if attempt == 2:
                    raise

    async def operation(self, path: str, body: dict | None = None) -> dict:
        http = await self._ensure_http()
        url = f"{self.base_url}/{path}"
        if body:
            resp = await http.post(url, headers=await self._headers(), json=body)
        else:
            resp = await http.get(url, headers=await self._headers())
        resp.raise_for_status()
        return resp.json()

    async def transaction(self, entries: list[dict]) -> dict:
        """POST a FHIR transaction Bundle."""
        bundle = {
            "resourceType": "Bundle",
            "type": "transaction",
            "entry": entries,
        }
        http = await self._ensure_http()
        resp = await http.post(self.base_url, headers=await self._headers(), json=bundle)
        resp.raise_for_status()
        return resp.json()

    async def ping(self) -> bool:
        try:
            http = await self._ensure_http()
            resp = await http.get(f"{self.base_url}/metadata", headers=await self._headers())
            return resp.status_code == 200
        except Exception:
            return False

    async def close(self) -> None:
        if self._http and not self._http.is_closed:
            await self._http.aclose()


_instance: MedplumClient | None = None


def get_medplum() -> MedplumClient:
    """Return the singleton MedplumClient (must be initialized via init_medplum first)."""
    if _instance is None:
        raise RuntimeError("MedplumClient not initialized. Call init_medplum() first.")
    return _instance


def init_medplum(
    base_url: str,
    client_id: str = "",
    client_secret: str = "",
    email: str = "",
    password: str = "",
) -> MedplumClient:
    global _instance
    _instance = MedplumClient(base_url, client_id, client_secret, email, password)
    return _instance
