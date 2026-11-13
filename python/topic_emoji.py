#!/usr/bin/env python
"""Overlord topic-emoji fallback helper.

The board's keyword table (in extension.js) is the PRIMARY source of a card's topic
glyph. Only session titles it can't classify reach here: Overlord spawns this with
those titles, we ask Haiku for the single best-fitting emoji per title, and return a
{title: emoji} map. Overlord caches the answers by title (persisted), so each title
costs one Haiku call ever.

IO contract (fail-open — a broken lookup just leaves those cards on 💬):
  stdin  : {"titles": ["...", "..."]}
  stdout : {"ok": true,  "emojis": {"<title>": "🎥", ...}}
           {"ok": false, "emojis": {}}                       on any failure (exit 0)

Runs on the user's Claude subscription, not on API credits — see claude_oauth,
which is the only place this file talks to a model. Sync, single attempt, no retries.
"""
from __future__ import annotations

import json
import os
import re
import sys

# Emoji output would crash on Windows' default cp1252 stdout — force UTF-8 both ways.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import claude_oauth  # noqa: E402

HAIKU = "claude-haiku-4-5-20251001"
CLIENT_TIMEOUT = 25.0   # whole budget; extension.js kills this spawn at 30s
MAX_TITLES = 40


def _out(ok: bool, emojis: dict) -> None:
    print(json.dumps({"ok": ok, "emojis": emojis}, ensure_ascii=False))
    sys.exit(0)


def _first_emoji(s: str) -> str:
    """Keep only the leading emoji/symbol grapheme from a model reply, dropping any
    stray words or quotes. Returns '' if there's nothing emoji-like."""
    s = (s or "").strip().strip('"\'` ')
    if not s:
        return ""
    # Take up to the first two codepoints (covers a base emoji + variation selector
    # or a simple ZWJ-free glyph); reject plain ASCII letters/digits.
    out = s[:2]
    if re.fullmatch(r"[A-Za-z0-9 ]+", out or " "):
        return ""
    return out.strip()


SYSTEM = (
    "You label developer/work session titles with ONE emoji that best captures the "
    "title's MAIN subject (not an incidental word). Prefer a specific, conventional "
    "emoji: video/recording 🎥, document 📄, research 🔬, design 🎨, code/tool 🛠️, "
    "email 📧, meeting 📅, bug 🐛, data 📊, security 🔒, task 📋. "
    "Reply with STRICT JSON only: an object mapping each EXACT input title to one "
    "emoji. No commentary, no extra keys."
)


def _extract_obj(text: str):
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", text).strip()
    i, j = text.find("{"), text.rfind("}")
    if i == -1 or j == -1 or j < i:
        return None
    try:
        return json.loads(text[i:j + 1])
    except Exception:
        return None


def main() -> None:
    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
    except Exception:
        _out(False, {})

    titles = [t for t in (req.get("titles") or []) if isinstance(t, str) and t.strip()]
    titles = list(dict.fromkeys(titles))[:MAX_TITLES]   # dedupe, cap
    if not titles:
        _out(True, {})

    user = "Titles:\n" + json.dumps(titles, ensure_ascii=False)
    text = claude_oauth.ask(HAIKU, SYSTEM, user,
                            max_tokens=600, timeout=CLIENT_TIMEOUT)
    if not text.strip():
        _out(False, {})

    obj = _extract_obj(text)
    if not isinstance(obj, dict):
        _out(False, {})

    emojis = {}
    for t in titles:
        e = _first_emoji(str(obj.get(t, "")))
        if e:
            emojis[t] = e
    _out(True, emojis)


if __name__ == "__main__":
    main()
