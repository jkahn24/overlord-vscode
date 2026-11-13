// Pure transcript parsing/rendering for Overlord's viewer. No VS Code deps, no fs —
// callers pass in JSONL text. Stateless per line so the same parse() handles a full
// file or an appended tail.
"use strict";

// Claude Code tool names -> the verb the CLI shows in a transcript header.
const VERB = { Edit: "Update", MultiEdit: "Update", Write: "Write", Read: "Read",
  Bash: "Bash", Grep: "Grep", Glob: "Glob", NotebookEdit: "Update" };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toolArg(b) {
  const inp = b.input || {};
  if (inp.file_path) return inp.file_path;
  if (typeof inp.command === "string") return inp.command;
  if (typeof inp.pattern === "string") return inp.pattern;
  return "";
}

function toDiff(structuredPatch) {
  let added = 0, removed = 0;
  const hunks = [];
  for (const h of structuredPatch) {
    if (!h || !Array.isArray(h.lines) || !h.lines.length) continue;
    const lines = [];
    for (const raw of h.lines) {
      const c = String(raw)[0];
      const sign = c === "+" ? "+" : c === "-" ? "-" : " ";
      if (sign === "+") added++; else if (sign === "-") removed++;
      lines.push({ sign, text: String(raw).slice(1) });
    }
    hunks.push({ oldStart: h.oldStart || 0, newStart: h.newStart || 0, lines });
  }
  return hunks.length ? { kind: "diff", added, removed, hunks } : null;
}

function parse(jsonlText) {
  const events = [];
  for (const ln of String(jsonlText || "").split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    if (o.type === "assistant" && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (!b) continue;
        if (b.type === "text" && b.text && b.text.trim())
          events.push({ kind: "text", text: b.text.trim() });
        else if (b.type === "tool_use")
          events.push({ kind: "tool", tool: b.name || "tool", arg: toolArg(b) });
      }
    }
    const sp = o.toolUseResult && o.toolUseResult.structuredPatch;
    if (Array.isArray(sp) && sp.length) { const d = toDiff(sp); if (d) events.push(d); }
  }
  return events;
}

function renderDiff(e) {
  const out = ['<div class="ov-diffsub">Added ' + e.added + " lines, removed " +
               e.removed + ' lines</div>', '<div class="ov-diff">'];
  for (const h of e.hunks) {
    let oldLn = h.oldStart, newLn = h.newStart;
    for (const l of h.lines) {
      let num, cls;
      if (l.sign === "-") { num = oldLn++; cls = "del"; }
      else if (l.sign === "+") { num = newLn++; cls = "add"; }
      else { num = oldLn++; newLn++; cls = "ctx"; }
      out.push('<div class="ov-line ' + cls + '"><span class="ov-ln">' + num +
               '</span><span class="ov-code">' + esc(l.text) + "</span></div>");
    }
  }
  out.push("</div>");
  return out.join("");
}

function renderEvent(e) {
  if (e.kind === "text") return '<div class="ov-text">' + esc(e.text) + "</div>";
  if (e.kind === "tool") {
    const head = esc(VERB[e.tool] || e.tool);
    return '<div class="ov-tool">• ' + head + (e.arg ? "(" + esc(e.arg) + ")" : "") + "</div>";
  }
  if (e.kind === "diff") return renderDiff(e);
  return "";
}

function renderHtml(events, opts = {}) {
  const parts = [];
  if (opts.truncatedNote) parts.push('<div class="ov-note">earlier history hidden</div>');
  for (const e of events) parts.push(renderEvent(e));
  return parts.join("\n");
}

const ACT_VERB = { Edit: "Edit", MultiEdit: "Edit", Write: "Write", Read: "Read", Bash: "Bash" };
function baseName(p) { const a = String(p || "").split(/[\\/]/); return a[a.length - 1]; }
function pushAct(arr, s) { if (s && arr[arr.length - 1] !== s) arr.push(s); }
// Keep sidebar activity compact: a command's first line, capped, so a multi-line
// heredoc doesn't dump its whole body into the card DOM.
function firstLine(s) {
  s = String(s || "").split(/\r?\n/)[0].trim();
  return s.length > 80 ? s.slice(0, 79) + "…" : s;
}

// Card summary: what the session last SAID, not what it did. Prefer the
// message's own TL;DR section when present (the user's replies always end with
// one); otherwise the head of the message (outcome-first style makes the
// opening informative). Multi-line; the webview clamps display length.
function summarize(text, cap) {
  text = String(text || "").trim();
  if (!text) return "";
  cap = cap || 450;
  const m = text.match(/\*{0,2}TL;?DR:?\*{0,2}\s*/i);
  let s = m ? text.slice(m.index + m[0].length).trim() : text;
  if (m) {
    // the user's TL;DR block: an italic "(7 Sep, 10:56)" stamp beside the marker, then
    // "❓ Why" / "💡 What" / "👉 Next" / "🔗 Link" labels each alone on a line. The
    // card body clamps to two lines, so drop the stamp and the label-only lines
    // and let the Why/What text lead (2026-09-07: a card read "*(7 Sep, 10:56)*").
    s = s.replace(/^\*\([^)\n]*\)\*\s*/, "")
         .replace(/^[^\w\s]{1,3}\s*\*{0,2}(Why|What|Next|Link)\*{0,2}\s*$/gm, "")
         .replace(/\n\s*\n/g, "\n").trim();
  }
  s = s.replace(/\*\*/g, "").replace(/^#+\s*/gm, "");   // light markdown strip
  if (s.length > cap) s = s.slice(0, cap - 1) + "…";
  return s;
}

// Parse a tail once and derive everything the sidebar card needs, so the extension
// reads each transcript at most once per tick. awaitFn (agents.awaitReason) is injected
// to keep question-detection out of this module.
function readTail(jsonlTail, awaitFn) {
  let model = "", ctxTokens = 0, lastText = "", lastTldr = "", gitBranch = "";
  const activity = [];
  // Turn-over tracking (patch 36). Claude Code appends a non-sidechain
  // system/turn_duration record at the END of every turn, so the model is done iff
  // that marker is NEWER than the last real conversation record. This is the only
  // way to tell "generating" from "turn finished, background work outstanding" —
  // `claude agents --json` reports BOTH as busy.
  // Sidechain lines are excluded on purpose: a BACKGROUND subagent keeps writing
  // them after its parent turn closed, and that session is sitting at the prompt.
  const lines = String(jsonlTail || "").split(/\r?\n/);
  let iTurnEnd = -1, iActivity = -1, lastTurnMs = 0, lastPromptAtMs = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    // gitBranch rides on every transcript line (user + assistant) — grab it
    // before the assistant-only skip so the card can show branch context.
    if (o.gitBranch) gitBranch = o.gitBranch;
    if (!o.isSidechain) {
      if (o.type === "system" && o.subtype === "turn_duration") { iTurnEnd = i; lastTurnMs = Number(o.durationMs) || 0; }
      else if (o.type === "user" || o.type === "assistant") {
        iActivity = i;
        // When the current turn STARTED (patch 59): the newest human prompt. Tool
        // results and hook-injected context also arrive as "user" records, but they
        // carry toolUseResult / isMeta and are mid-turn, so they are skipped. So are
        // compaction summaries (isCompactSummary) and background-task notices
        // (promptSource "system") — neither is the user continuing the session (patch 66).
        if (o.type === "user" && !o.isMeta && !o.toolUseResult && !o.isCompactSummary && o.promptSource !== "system" && o.timestamp) lastPromptAtMs = Date.parse(o.timestamp) || lastPromptAtMs;
      }
    }
    if (o.type !== "assistant" || !o.message) continue;
    const m = o.message;
    if (m.model) model = m.model;
    if (m.usage) {
      const u = m.usage;
      const c = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (c) ctxTokens = c;
    }
    if (Array.isArray(m.content)) for (const b of m.content) {
      if (!b) continue;
      if (b.type === "text" && b.text && b.text.trim()) {
        lastText = b.text.trim();
        // Sticky summary anchor: only turn-final messages carry a TL;DR, so
        // remembering the newest one keeps the card text stable while the
        // session streams mid-turn narration.
        if (/TL;?DR/i.test(lastText)) lastTldr = lastText;
      }
      else if (b.type === "tool_use") {
        const verb = ACT_VERB[b.name] || b.name;
        const inp = b.input || {};
        const arg = b.name === "Bash" ? firstLine(inp.command) : baseName(inp.file_path);
        pushAct(activity, verb + (arg ? ": " + arg : ""));
      } else if (b.type === "thinking") pushAct(activity, "thinking…");
    }
  }
  // awaitFn is agents.awaitVerdict ({tier, reason}) — but a caller passing the older
  // string-returning agents.awaitReason still works, and `awaitReason` stays a plain
  // string either way so existing consumers (and test-transcript.js) don't move.
  const v = awaitFn ? awaitFn(lastText) : null;
  const reason = typeof v === "string" ? v : (v && v.reason) || null;
  const tier = v ? (typeof v === "string" ? "blocking" : v.tier || "blocking") : null;
  return { model, ctxTokens, gitBranch, awaitReason: reason, awaitTier: tier,
           turnFinal: /TL;?DR/i.test(lastText),
           // Distinct from turnFinal: that asks "did this MESSAGE close a turn"
           // (a TL;DR heuristic, feeds the judge); this asks "is the turn over
           // NOW". A tail with no marker yields false — fail-safe, since the
           // caller only ever uses it to move a card OUT of "working".
           turnOver: iTurnEnd > iActivity,
           // How long the last COMPLETED turn took (patch 51). Claude Code no longer
           // prints "Cooked for 5m 12s" in the terminal (showTurnDuration off), so the
           // card is the only place that number lives now.
           lastTurnMs,
           // 0 when the prompt fell outside the 64KB window — callers treat 0 as unknown.
           lastPromptAtMs,
           activity: activity.slice(-7), lastMsg: firstLine(lastText),
           summary: summarize(lastTldr || lastText),
           lastFull: lastText.slice(0, 2000) };
}

// A condensed digest of the last few exchanges, for the card's Simplify / Next-step
// buttons (patch 35). The card sub-line and the needs-you judge only ever look at the
// CLOSING message, which is enough to classify a turn but not to explain the work
// behind it — "8 fixes shipped" says nothing about what was fixed. This walks the
// same tail and returns a compact conversation:
//
//   [you] fix the crash on startup
//   [did] Read: providers.py · Edit: audio.py · Bash: pytest -q
//   [claude] Eight fixes shipped and verified…
//
// Tool calls collapse into one [did] line per turn — the verbs are the evidence of
// what happened, but their arguments would swamp the prompt. Everything is capped so
// a long session can't turn a button click into an expensive call.
function readRecent(jsonlTail, opts) {
  const o = opts || {};
  const maxTurns = o.maxTurns || 5;
  const perMsg = o.perMsg || 700;
  const maxChars = o.maxChars || 6000;
  const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

  const rows = [];               // {tag, text}
  let pendingTools = [];
  const flushTools = () => {
    if (!pendingTools.length) return;
    rows.push({ tag: "did", text: pendingTools.slice(0, 8).join(" · ") });
    pendingTools = [];
  };
  for (const ln of String(jsonlTail || "").split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let e; try { e = JSON.parse(ln); } catch (_) { continue; }
    if (e.isSidechain) continue;            // subagent chatter isn't the session's own work
    const m = e.message;
    if (e.type === "user" && m) {
      // A user line is either a real prompt or a tool RESULT being fed back; only
      // the former marks a turn boundary.
      const c = m.content;
      let t = "";
      if (typeof c === "string") t = c;
      else if (Array.isArray(c)) for (const b of c) { if (b && b.type === "text") t += b.text || ""; }
      if (t.trim() && !/^\s*<(command-name|local-command|system-reminder)/.test(t)) {
        flushTools();
        rows.push({ tag: "you", text: clip(t, perMsg) });
      }
    } else if (e.type === "assistant" && m && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b) continue;
        if (b.type === "text" && b.text && b.text.trim()) { flushTools(); rows.push({ tag: "claude", text: clip(b.text, perMsg) }); }
        else if (b.type === "tool_use") {
          const inp = b.input || {};
          const arg = b.name === "Bash" ? firstLine(inp.command) : baseName(inp.file_path);
          const s = (ACT_VERB[b.name] || b.name) + (arg ? ": " + arg : "");
          if (pendingTools[pendingTools.length - 1] !== s) pendingTools.push(s);
        }
      }
    }
  }
  flushTools();

  // Keep the last `maxTurns` exchanges, counting a [you] line as the boundary.
  let start = 0, turns = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].tag === "you" && ++turns >= maxTurns) { start = i; break; }
  }
  let out = rows.slice(start).map((r) => "[" + r.tag + "] " + r.text).join("\n");
  if (out.length > maxChars) out = "…" + out.slice(-maxChars);
  return out;
}

// One helper (subagent) log tail -> what its card row needs (helper rows, 2026-09-17,
// the user: "I need to have a way to see the subagents working"). A helper's log ends
// with exactly one assistant record carrying stop_reason "end_turn" — mid-run
// records carry "tool_use" or null — and a SendMessage resume appends a user record
// after it, so "done" is: the newest conversation record is that end_turn.
function readHelperTail(jsonlTail) {
  let lastMs = 0, lastAction = "", done = false, model = "";
  for (const ln of String(jsonlTail || "").split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }   // a cut first line is expected
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (o.timestamp) lastMs = Date.parse(o.timestamp) || lastMs;
    const m = o.message || {};
    if (o.type === "assistant" && m.model) model = m.model;
    done = o.type === "assistant" && m.stop_reason === "end_turn";
    if (o.type === "assistant" && Array.isArray(m.content)) for (const b of m.content) {
      if (!b || b.type !== "tool_use") continue;
      const inp = b.input || {};
      const arg = b.name === "Bash" ? firstLine(inp.command)
        : inp.file_path ? baseName(inp.file_path)
        : typeof inp.pattern === "string" ? inp.pattern
        : typeof inp.description === "string" ? inp.description : "";
      const s = (ACT_VERB[b.name] || b.name) + (arg ? ": " + arg : "");
      lastAction = s.length > 60 ? s.slice(0, 59) + "…" : s;
    }
  }
  return { lastMs, lastAction, done, model };
}

// Token spend (2026-09-17, the user: "how many tokens have been spent"). Spent = fresh input +
// cache written + cache read + output. Claude Code writes one line per content block and
// repeats the SAME usage on each, so a plain sum runs ~2.2x high — each message.id counts
// once, and a later line for the same id replaces the earlier one. `state` is carried
// across calls so a caller can feed a growing log chunk by chunk (complete lines only).
//
// Task steps ride along (phase 2): a message is charged to the task-list steps that were
// in progress when it was first seen (split evenly), or to `between` when none was. The
// message that starts or ends a step is charged to the state BEFORE its own TaskUpdate.
// Agent launches remember the steps in progress, keyed by tool_use id — a helper's
// .meta.json carries that id, so the caller can charge the helper to the same steps.
function newSpend() {
  return { byId: new Map(), input: 0, cacheWrite: 0, cacheRead: 0, output: 0,
           tasks: new Map(), active: new Set(), between: 0, agentTasks: new Map() };
}
function taskEntry(state, id) {
  let t = state.tasks.get(id);
  if (!t) { t = { subject: "", tokens: 0 }; state.tasks.set(id, t); }
  return t;
}
function addUsage(state, jsonlChunk) {
  for (const ln of String(jsonlChunk || "").split(/\r?\n/)) {
    const hasUsage = ln.includes('"usage"');
    if (!hasUsage && !ln.includes('"task"')) continue;   // cheap skip: most lines carry neither
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    // TaskCreate result: {toolUseResult: {task: {id, subject}}}. A reused id starts over.
    const made = o.type === "user" && o.toolUseResult && o.toolUseResult.task;
    if (made && made.id != null) {
      state.tasks.set(String(made.id), { subject: String(made.subject || ""), tokens: 0 });
      continue;
    }
    const m = o.type === "assistant" && o.message;
    const u = m && m.usage;
    if (!u) continue;
    const key = m.id || o.uuid;
    const next = [u.input_tokens || 0, u.cache_creation_input_tokens || 0,
                  u.cache_read_input_tokens || 0, u.output_tokens || 0];
    const prev = key && state.byId.get(key);
    if (prev) { state.input -= prev[0]; state.cacheWrite -= prev[1]; state.cacheRead -= prev[2]; state.output -= prev[3]; }
    state.input += next[0]; state.cacheWrite += next[1]; state.cacheRead += next[2]; state.output += next[3];
    const sum = next[0] + next[1] + next[2] + next[3];
    const charge = prev ? prev.charge : [...state.active];   // first sight fixes who pays
    const delta = sum - (prev ? prev.sum : 0);
    if (charge.length) for (const id of charge) taskEntry(state, id).tokens += delta / charge.length;
    else state.between += delta;
    if (key) state.byId.set(key, Object.assign(next, { sum, charge }));
    if (Array.isArray(m.content)) for (const b of m.content) {
      if (!b || b.type !== "tool_use") continue;
      const inp = b.input || {};
      if (b.name === "TaskUpdate" && inp.taskId != null && inp.status) {
        const id = String(inp.taskId);
        if (inp.status === "in_progress") state.active.add(id); else state.active.delete(id);
      } else if (b.name === "Agent" || b.name === "Task") {
        if (b.id) state.agentTasks.set(b.id, [...state.active]);
      }
    }
  }
  return state;
}
function spendTotals(state) {
  const { input, cacheWrite, cacheRead, output } = state;
  const tasks = {};
  for (const [id, t] of state.tasks) tasks[id] = { subject: t.subject, tokens: Math.round(t.tokens) };
  return { input, cacheWrite, cacheRead, output, total: input + cacheWrite + cacheRead + output,
           tasks, between: Math.round(state.between) };
}

module.exports = { parse, renderHtml, esc, readTail, readRecent, readHelperTail, newSpend, addUsage, spendTotals };
