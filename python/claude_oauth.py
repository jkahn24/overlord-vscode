#!/usr/bin/env python
"""One subscription-billed transport for Overlord's Python helpers.

Model calls run on the user's Claude subscription (the login Claude Code already
has), not on API credits, and go only to api.anthropic.com. This module is the only
place the helpers talk to a model.

Two transports, in the order extension.js uses for its own judge calls:
  1. OAuth — opt-in only: used when OVERLORD_USE_CLAUDE_LOGIN=1, which extension.js
     sets only while `overlord.useClaudeCodeLogin` is on. The token Claude Code keeps
     fresh in ~/.claude/.credentials.json, posted to /v1/messages with the oauth beta
     header. Sub-second.
  2. `claude -p` — the default, and the fallback. Slower (the CLI boots first, ~5s),
     but it does its own auth.

Fail-open: every failure returns None and the caller keeps its non-model answer.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

CREDS = os.path.join(os.path.expanduser("~"), ".claude", ".credentials.json")


def _oauth_token() -> str:
    try:
        with open(CREDS, encoding="utf-8") as f:
            return (json.load(f).get("claudeAiOauth") or {}).get("accessToken") or ""
    except Exception:
        return ""


def _via_oauth(model: str, system: str, user: str, max_tokens: int, timeout: float) -> str:
    token = _oauth_token()
    if not token:
        return ""
    body = json.dumps({
        "model": model,
        "max_tokens": max_tokens,
        "system": [{"type": "text", "text": system,
                    "cache_control": {"type": "ephemeral"}}],
        "messages": [{"role": "user", "content": user}],
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body, method="POST",
        headers={
            "Authorization": "Bearer " + token,
            "anthropic-beta": "oauth-2025-04-20",
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            blocks = json.loads(r.read().decode("utf-8")).get("content") or []
        return "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    except Exception:
        return ""


def _via_cli(model: str, system: str, user: str, timeout: float) -> str:
    # `claude` is a .cmd/.exe shim on Windows and CreateProcess does not apply
    # PATHEXT, so resolve it rather than paying cmd.exe a second parse of the args.
    exe = shutil.which("claude")
    if not exe:
        return ""
    # An empty cwd (no CLAUDE.md) and no MCP servers are what keep this near 5s.
    env = dict(os.environ)
    for var in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        env.pop(var, None)
    try:
        proc = subprocess.run(
            [exe, "-p", "--model", model, "--strict-mcp-config",
             "--mcp-config", json.dumps({"mcpServers": {}})],
            input=system + "\n\n" + user, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout, env=env,
            cwd=tempfile.gettempdir(),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return proc.stdout if proc.returncode == 0 else ""
    except Exception:
        return ""


def ask(model: str, system: str, user: str, max_tokens: int = 800,
        timeout: float = 15.0, cli_model: str = "haiku") -> str:
    """Return the model's text, or "" if neither transport answered.

    `timeout` is the budget for BOTH attempts: whatever OAuth does not spend is what
    the fallback gets. Each caller is spawned with a kill timer of its own, so a
    per-transport budget would let two attempts overrun a window one call must fit.
    """
    started = time.monotonic()
    if os.environ.get("OVERLORD_USE_CLAUDE_LOGIN") == "1":   # opt-in; off = CLI only
        text = _via_oauth(model, system, user, max_tokens, timeout)
        if text.strip():
            return text
    left = timeout - (time.monotonic() - started)
    return _via_cli(cli_model, system, user, left) if left > 3.0 else ""
