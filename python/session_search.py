#!/usr/bin/env python
"""Overlord session concept-search helper.

Ranks the LIVE board's sessions by how well they match a natural-language query's
*intent* (not just literal keywords), using Haiku. Overlord (extension.js) spawns
this on Enter, passing the current board sids; we pull each session's text from
~/.claude/sessions_cache.json, ask Haiku to rank by concept, and print JSON back.

IO contract (fail-open by design — a broken search must never break the board):
  stdin  : {"query": "...", "cards": [{"sid": "...", "name": "..."}, ...]}
  stdout : {"ok": true,  "ranked": [{"sid": "...", "score": 0-100, "reason": "..."}]}
           {"ok": false, "ranked": [], "error": "..."}   on any failure (exit 0)

Runs on the user's Claude subscription, not on API credits — see claude_oauth,
which is the only place this file talks to a model. Real-time path: single attempt,
short timeout, NO retries — a slow/failed search returns [] fast so the webview keeps
its instant keyword hits.
"""
from __future__ import annotations

import json
import os
import os.path
import re
import sys
import glob

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import claude_oauth  # noqa: E402

# Reasons/titles may carry non-cp1252 chars — force UTF-8 I/O on Windows.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass

HAIKU = "claude-haiku-4-5-20251001"
CACHE = os.path.join(os.path.expanduser("~"), ".claude", "sessions_cache.json")
PROJECTS = os.path.join(os.path.expanduser("~"), ".claude", "projects")

MAX_CARDS = 200         # bound prompt size; matches the board's own 200-session cap
HEAD_CHARS = 500        # excerpt head from the conversation content
TAIL_CHARS = 250        # excerpt tail (recent turns often carry the topic)
CLIENT_TIMEOUT = 15.0   # seconds; fail-open past this. 200 cards is ~28k input
                        # tokens and measured ~6s of model time, so 8s had no margin.


def _fail(msg: str) -> None:
    print(json.dumps({"ok": False, "ranked": [], "error": msg}))
    sys.exit(0)


def _load_cache() -> dict:
    try:
        with open(CACHE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _tail_excerpt(sid: str) -> str:
    """Fallback for a card not yet in the cache (e.g. a just-started session):
    read the tail of its transcript and pull the plain text out."""
    hits = glob.glob(os.path.join(PROJECTS, "*", f"{sid}.jsonl"))
    if not hits:
        return ""
    try:
        with open(hits[0], "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 12000))
            tail = f.read().decode("utf-8", "replace")
    except Exception:
        return ""
    out = []
    for ln in tail.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            o = json.loads(ln)
        except Exception:
            continue
        if o.get("type") not in ("user", "assistant"):
            continue
        c = (o.get("message") or {}).get("content")
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "text":
                    out.append(b.get("text", ""))
        elif isinstance(c, str):
            out.append(c)
    return " ".join(out)[-(HEAD_CHARS + TAIL_CHARS):]


def _excerpt(content: str) -> str:
    content = re.sub(r"\s+", " ", content or "").strip()
    if len(content) <= HEAD_CHARS + TAIL_CHARS:
        return content
    return content[:HEAD_CHARS] + " … " + content[-TAIL_CHARS:]


def _build_docs(cards: list, cache: dict) -> list:
    docs = []
    for c in cards[:MAX_CARDS]:
        sid = (c or {}).get("sid")
        if not sid:
            continue
        name = (c or {}).get("name") or ""
        entry = cache.get(sid) or {}
        title = entry.get("title") or name or "session"
        preview = entry.get("preview") or ""
        # Patch 84: a Codex card has no ~/.claude transcript; the extension sends the
        # text of its rollout's tail instead.
        excerpt = (_excerpt(entry.get("content") or "") or _excerpt(c.get("excerpt") or "")
                   or _tail_excerpt(sid))
        docs.append({"sid": sid, "title": title, "preview": preview, "excerpt": excerpt})
    return docs


SYSTEM = (
    "You rank Claude Code work sessions by how well each matches a search query's "
    "INTENT and TOPIC — semantic relevance, not just literal keyword overlap. "
    "A session about invoicing matches 'billing'; a session that mentions a person "
    "matches a description of that person. Return ONLY sessions that genuinely relate "
    "to the query; drop the rest. Rank most relevant first. For each kept session give "
    "a reason of at most 8 words naming the concrete match. "
    'Output STRICT JSON only, no prose: '
    '[{"sid":"<id>","score":<0-100>,"reason":"<why>"}]. '
    "If nothing is relevant, output []."
)


def _extract_json_array(text: str):
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\n?|\n?```$", "", text).strip()
    i, j = text.find("["), text.rfind("]")
    if i == -1 or j == -1 or j < i:
        return None
    try:
        return json.loads(text[i:j + 1])
    except Exception:
        return None


def _rank(query: str, docs: list) -> list:
    lines = [f"Query: {query}", "", "Sessions:"]
    for d in docs:
        lines.append(
            f'- sid: {d["sid"]}\n  title: {d["title"]}\n  first_prompt: {d["preview"]}\n  excerpt: {d["excerpt"]}'
        )
    user_msg = "\n".join(lines)

    text = claude_oauth.ask(HAIKU, SYSTEM, user_msg,
                            max_tokens=800, timeout=CLIENT_TIMEOUT)
    if not text.strip():
        _fail("haiku call failed")

    arr = _extract_json_array(text)
    if not isinstance(arr, list):
        _fail("model returned unparseable output")

    valid = {d["sid"] for d in docs}
    ranked = []
    for r in arr:
        if not isinstance(r, dict):
            continue
        sid = r.get("sid")
        if sid not in valid:
            continue
        try:
            score = int(r.get("score", 0))
        except Exception:
            score = 0
        ranked.append({"sid": sid, "score": score, "reason": str(r.get("reason", ""))[:80]})
    ranked.sort(key=lambda x: x["score"], reverse=True)
    return ranked


def main() -> None:
    try:
        raw = sys.stdin.read()
        req = json.loads(raw) if raw.strip() else {}
    except Exception as e:
        _fail(f"bad input: {e}")

    query = (req.get("query") or "").strip()
    cards = req.get("cards") or []
    if not query:
        _fail("empty query")
    if not cards:
        print(json.dumps({"ok": True, "ranked": []}))
        return

    docs = _build_docs(cards, _load_cache())
    ranked = _rank(query, docs)
    print(json.dumps({"ok": True, "ranked": ranked}))


if __name__ == "__main__":
    main()
