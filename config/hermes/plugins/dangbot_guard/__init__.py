"""DangBot policy hook for Hermes 0.19.0.

The hook uses Hermes' public pre_tool_call approval directive. It does not
execute tools or access credentials. WeChat exposes only allow-once and deny,
so no persistent approval is reachable from DangBot.
"""

from __future__ import annotations

from typing import Any, Dict


_REFLECTION_PREFIX = "dangbot_r_"
_REFLECTION_TOOLS = {
    "dangbot_memory_recall",
    "dangbot_memory_propose",
    "dangbot_memory_feedback",
}


def _matches_tool(tool_name: str, expected: str) -> bool:
    return tool_name == expected or tool_name.endswith(f"__{expected}")


def _on_pre_tool_call(tool_name: str, args: Dict[str, Any], **kwargs: Any) -> Dict[str, str] | None:
    del args
    session_id = str(kwargs.get("session_id") or "")
    if session_id.startswith(_REFLECTION_PREFIX) and not any(
        _matches_tool(tool_name, allowed) for allowed in _REFLECTION_TOOLS
    ):
        return {
            "action": "block",
            "message": "DangBot reflection sessions are restricted to scoped memory tools.",
        }
    if _matches_tool(tool_name, "dangbot_video_generate"):
        return {
            "action": "approve",
            "message": "HappyHorse video generation is billable and must be approved for this operation.",
            "rule_key": "dangbot_video_generate:once",
        }
    return None


def register(ctx: Any) -> None:
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
