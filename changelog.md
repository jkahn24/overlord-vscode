# Changelog

## Fork (Joel Kahn), July to November 2026
About 100 changes on top of 2.1.8. Highlights:
- Needs-you detection from the end of each turn, including finished turns that hand you a task, and native approval dialogs.
- Summary cards: last message summary, model, context used, token spend.
- Helper and subagent rows grouped under their parent session, with the model each ran on.
- Codex sessions on the same board.
- Needs you / Working / Done tabs, park and un-park, rename that follows a session across handoffs, separate caps for Claude and Codex cards.
- Concept search and topic icons via short Haiku calls (Python helpers in `python/`).
- Codex plan usage bar and machine memory bar.
- Click a card to focus its terminal; send text to a session.
- Optional Hand off button and loop / task-list badges driven by your own hook files (`OVERLORD_WORKSPACE`).
- OS toast notifications.


## 2.1.7 — 2026-07-07
- Refreshed listing description; no functional changes from 2.1.6.

## 2.1.6 — 2026-07-07
- **Expandable session cards**: click a card to expand it (▸/▾ chevron). Expanded cards show up to 7 recent activity lines with icons (🔧 Bash, ✏️ edits, 💭 thinking, 📄 reads), a 💬 preview of the session's latest message, and a state-aware action link (Answer now / Watch / Continue).
- **Richer card sub-line**: `state time · model · ctx tokens · % of context used · uptime` on every card.
- **New session launcher**: button in the panel header and status bar. Pick a folder and a fresh session opens as an editor-area terminal. Command is configurable via `overlord.newSessionCommand` (default `claude`).
- **Fix**: uptime ("up 3h45m") now renders — `claude agents --json` reports `startedAt` as epoch milliseconds, which previously parsed as NaN and hid the segment.
- **In-editor transcript viewer** (no card entry point; available via the `Overlord` commands): session output as an editor tab with line-numbered red/green diffs and live follow.

## 2.0.6 — 2026-07-06
- Directive-question detector: catches "want me to proceed…? <trailing statement>" turns that previously showed as idle.

## 2.0.3 — 2026-07-03
- First Marketplace release: session board with colored eyes, status-bar counter, activity-bar badge, sound + pop-up alerts, one-click jump to terminal, typed-question/approval detection for idle sessions.
