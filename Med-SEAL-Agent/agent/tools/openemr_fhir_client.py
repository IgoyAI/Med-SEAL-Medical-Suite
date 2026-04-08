"""OpenEMR native FHIR R4 client.

Uses the OpenEMR password grant (Resource Owner) flow to obtain a token,
then wraps standard FHIR read/search operations.

Used alongside the Medplum client to give agents access to data that
lives natively in OpenEMR (encounters, SOAP notes, vitals) but may not
yet be synced to Medplum.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_TOKEN_REFRESH_MARGIN = timedelta(minutes=2)


class OpenEMRFHIRClient:
    """Async FHIR client for OpenEMR's native FHIR API."""

    def __init__(
        self,
        base_url: str,
        username: str = "admin",
        password: str = "pass",
        client_id: str = "",
        client_secret: str = "",
        timeout: float = 15.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._origin = self.base_url.rsplit("/apis", 1)[0]
        self._username = username
        self._password = password
        self._client_id = client_id
        self._client_secret = client_secret
        self._timeout = timeout
        self._access_token: str | None = None
        self._token_expires: datetime = datetime.min.replace(tzinfo=timezone.utc)
        self._http: httpx.AsyncClient | None = None

    async def _ensure_http(self) -> httpx.AsyncClient:
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(timeout=self._timeout)
        return self._http

    async def _ensure_token(self) -> str:
        now = datetime.now(timezone.utc)
        if self._access_token and now < self._token_expires - _TOKEN_REFRESH_MARGIN:
            return self._access_token

        http = await self._ensure_http()

        # OpenEMR password grant (Resource Owner)
        data = {
            "grant_type": "password",
            "username": self._username,
            "password": self._password,
        }
        if self._client_id:
            data["client_id"] = self._client_id
        if self._client_secret:
            data["client_secret"] = self._client_secret

        try:
            resp = await http.post(
                f"{self._origin}/oauth2/default/token",
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            resp.raise_for_status()
            token_data = resp.json()
            self._access_token = token_data["access_token"]
            self._token_expires = now + timedelta(
                seconds=token_data.get("expires_in", 3600)
            )
            logger.info("OpenEMR FHIR auth OK (expires %s)", self._token_expires.isoformat())
            return self._access_token
        except Exception as e:
            logger.warning("OpenEMR FHIR auth failed: %s", e)
            return ""

    async def _headers(self) -> dict[str, str]:
        token = await self._ensure_token()
        h = {"Accept": "application/fhir+json"}
        if token:
            h["Authorization"] = f"Bearer {token}"
        return h

    async def search(self, resource_type: str, params: dict[str, Any]) -> list[dict]:
        http = await self._ensure_http()
        url = f"{self.base_url}/{resource_type}"
        try:
            resp = await http.get(url, headers=await self._headers(), params=params)
            resp.raise_for_status()
            bundle = resp.json()
            entries = bundle.get("entry", [])
            return [e.get("resource", e) for e in entries]
        except Exception as e:
            logger.warning("OpenEMR FHIR search %s failed: %s", resource_type, e)
            return []

    async def read(self, resource_type: str, resource_id: str) -> dict:
        http = await self._ensure_http()
        url = f"{self.base_url}/{resource_type}/{resource_id}"
        resp = await http.get(url, headers=await self._headers())
        resp.raise_for_status()
        return resp.json()

    async def ping(self) -> bool:
        try:
            http = await self._ensure_http()
            resp = await http.get(f"{self.base_url}/metadata")
            return resp.status_code in (200, 501)  # 501 = auth needed but server alive
        except Exception:
            return False

    async def close(self) -> None:
        if self._http and not self._http.is_closed:
            await self._http.aclose()
