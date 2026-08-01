"""DangBot scoped memory provider for Hermes 0.19.0.

This plugin uses only the public MemoryProvider lifecycle. It never writes
Hermes MEMORY.md, USER.md, skills, config, or host files.
"""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.request
from typing import Any, Dict, List

from agent.memory_provider import MemoryProvider


class DangBotScopedMemoryProvider(MemoryProvider):
    def __init__(self) -> None:
        self._session_key = ""
        self._session_id = ""

    @property
    def name(self) -> str:
        return "dangbot_scoped"

    def is_available(self) -> bool:
        return bool(
            os.environ.get("DANGBOT_MEMORY_BRIDGE_URL")
            and len(os.environ.get("DANGBOT_MEMORY_BRIDGE_API_KEY", "")) >= 32
        )

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._session_id = session_id
        self._session_key = str(kwargs.get("gateway_session_key") or "")
        if not self._session_key:
            raise RuntimeError("DangBot scoped memory requires gateway_session_key")

    def system_prompt_block(self) -> str:
        return (
            "DangBot scoped memory is active. Recall contains only this group/user, "
            "this group, and system-admin-approved agent lessons. Memory proposals "
            "must use the first-class dangbot_memory MCP tools; never use shared "
            "MEMORY.md or USER.md."
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        del query, session_id
        try:
            result = self._request("/internal/memory/prefetch", {})
            return str(result.get("content") or "")
        except Exception:
            return ""

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: List[Dict[str, Any]] | None = None,
    ) -> None:
        del session_id, messages
        payload = {
            "userText": user_content[:4000],
            "assistantText": assistant_content[:4000],
        }
        threading.Thread(
            target=self._best_effort_turn,
            args=(payload,),
            daemon=True,
            name="dangbot-memory-sync",
        ).start()

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        # Hermes 0.19 gates external-provider schemas behind the built-in
        # memory toolset. Enabling that toolset would also expose the shared
        # MEMORY.md writer. The same strict schemas are therefore registered
        # by DangBot MCP while this provider owns prefetch and turn hooks.
        return []

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs: Any) -> str:
        del tool_name, args, kwargs
        raise RuntimeError("DangBot memory tools are available through the scoped MCP surface")

    def on_session_switch(self, new_session_id: str, **kwargs: Any) -> None:
        del kwargs
        self._session_id = new_session_id

    def _best_effort_turn(self, payload: Dict[str, Any]) -> None:
        try:
            self._request("/internal/memory/turn", payload)
        except Exception:
            pass

    def _request(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        base = os.environ["DANGBOT_MEMORY_BRIDGE_URL"].rstrip("/")
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"{base}{path}",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {os.environ['DANGBOT_MEMORY_BRIDGE_API_KEY']}",
                "X-Hermes-Session-Key": self._session_key,
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                value = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise RuntimeError(f"DangBot memory bridge HTTP {error.code}") from error
        if not isinstance(value, dict):
            raise RuntimeError("DangBot memory bridge returned non-object JSON")
        return value


def register(ctx: Any) -> None:
    ctx.register_memory_provider(DangBotScopedMemoryProvider())
