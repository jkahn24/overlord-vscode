// Codex (GPT) session reader.
//
// The Claude half of the board comes from `claude agents --json` plus the
// transcripts under ~/.claude/projects. Codex has no equivalent JSON command --
// `codex agents` is a TUI with no --json -- but it writes the same shape of
// thing to disk: one JSONL rollout per session under
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<sessionId>.jsonl
// so this module reads those directly, the way transcript.js reads Claude's.
//
// Every export fails CLOSED: any error anywhere returns an empty list, because
// a broken Codex read must never be able to take the Claude board down with it.

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(os.homedir(), ".codex", "sessions");

// Only sessions touched inside this window are read in full. Codex keeps rollouts
// forever; the board is about what is live now, and parsing the whole archive
// (847 MB, 2026-10-01) on a 2.5s poll would be the wrong kind of thorough. Older
// rollouts are read in full only for sessions the board is keeping (patch 80).
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// A rollout is append-only, so a file whose size and mtime are unchanged cannot
// have new events in it. Keyed by path -> { size, mtimeMs, session }.
const cache = new Map();

// Patch 80: path -> session_id for rollouts OUTSIDE the window, read from the first
// line alone and kept for good -- an old rollout's session_meta never changes. And
// every session_id seen on disk, so the board can tell a Codex sid from a Claude one.
const sidOf = new Map();
const known = new Set();

// Walk ROOT/YYYY/MM/DD without a glob dependency. Depth is fixed at 3, so this
// is a bounded walk, not a recursive sweep of the home directory.
function rolloutFiles(nowMs) {
  const out = [];
  let years;
  try { years = fs.readdirSync(ROOT, { withFileTypes: true }); }
  catch (_) { return out; }                       // no ~/.codex/sessions yet
  for (const y of years) {
    if (!y.isDirectory()) continue;
    for (const m of readDirSafe(path.join(ROOT, y.name))) {
      if (!m.isDirectory()) continue;
      for (const d of readDirSafe(path.join(ROOT, y.name, m.name))) {
        if (!d.isDirectory()) continue;
        const dir = path.join(ROOT, y.name, m.name, d.name);
        for (const f of readDirSafe(dir)) {
          if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
          const p = path.join(dir, f.name);
          let st; try { st = fs.statSync(p); } catch (_) { continue; }
          out.push({ path: p, size: st.size, mtimeMs: st.mtimeMs, old: nowMs - st.mtimeMs > MAX_AGE_MS });
        }
      }
    }
  }
  return out;
}

function readDirSafe(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return []; }
}

// The session_id from a rollout's first line (session_meta) only: 23 KB at most
// (measured 2026-10-01) against rollouts of up to 50 MB. "" when the first line is
// not session_meta; null when the file can't be read, so the caller retries later.
function headSid(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const parts = [];
    for (let pos = 0; ;) {
      const b = Buffer.alloc(65536);
      const n = fs.readSync(fd, b, 0, b.length, pos);
      const nl = b.subarray(0, n).indexOf(10);
      parts.push(b.subarray(0, nl >= 0 ? nl : n));
      if (!n || nl >= 0) break;
      pos += n;
    }
    return parseRollout(Buffer.concat(parts).toString("utf8")).sid;
  } catch (_) { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
}

// Last two path segments, matching the Claude cards' context line.
function shortCwd(cwd) {
  if (!cwd) return "";
  const parts = String(cwd).replace(/^\\\\\?\\/, "").split(/[\\/]+/).filter(Boolean);
  return parts.slice(-2).join("/");
}

// A user turn Codex wrote for itself rather than one the user typed.
function injectedTurn(txt) {
  const t = String(txt || "").trim();
  return t.startsWith("<") || /^#\s*AGENTS\.md instructions/i.test(t);
}

// First line of a prompt, clipped to a card-width title.
function firstLine(txt) {
  const one = String(txt || "").split(/\r?\n/).find((l) => l.trim()) || "";
  const t = one.trim().replace(/\s+/g, " ");
  return t.length > 48 ? t.slice(0, 47).trimEnd() + "\u2026" : t;
}

function parseRollout(text) {
  const s = {
    sid: "", cwd: "", startedAt: 0, updatedAt: 0,
    lastMessage: "", firstPrompt: "", engagedAt: 0, tokens: 0, ctxWindow: 0,
    lastTask: "", turns: 0, thread: "", source: "", nickname: "", role: "",
    statusAt: 0, asked: false, imported: false, nativeTurn: false,
    model: "", effort: "", branch: "", lastTurnMs: 0, live: "", usage: null, rl: null, rlAt: 0, originator: ""
  };
  let importing = false;
  for (const ln of String(text || "").split(/\r?\n/)) {
    if (!ln) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    const p = o && o.payload;
    if (!p) continue;
    // Desktop replays external history with today's write timestamps. Those turns
    // are neither fresh work nor proof that a handoff successor has engaged.
    if (o.type === "event_msg" && (p.type === "task_started" || p.type === "task_complete" || p.type === "turn_aborted")) {
      importing = String(p.turn_id || "").startsWith("external-import-");
      if (importing) s.imported = true;
      else s.nativeTurn = true;
    }
    if (importing && o.type !== "session_meta") continue;
    const ts = Date.parse(o.timestamp || "");
    if (ts) s.updatedAt = Math.max(s.updatedAt, ts);

    if (o.type === "session_meta") {
      // Patch 81: which thread this FILE is comes from its own session_meta, the first
      // line. A forked subagent rollout replays its parent's meta right after it --
      // thread_source "user" and all -- so a later meta must not overwrite these.
      // agent_role is on none of the 67 subagent rollouts (2026-10-01); agent_path,
      // "/root/skeptic_2", names the task, so its last segment stands in.
      if (!s.sid) {
        s.thread = p.id || "";
        s.source = p.thread_source || "";
        s.nickname = p.agent_nickname || "";
        s.role = p.agent_role || String(p.agent_path || "").split("/").pop();
      }
      s.sid = p.session_id || p.id || s.sid;
      s.cwd = p.cwd || s.cwd;
      if (!s.branch && p.git && p.git.branch) s.branch = p.git.branch;   // patch 84
      if (!s.originator) s.originator = p.originator || "";   // patch 86: "Codex Desktop" is the app
      const st = Date.parse(p.timestamp || o.timestamp || "");
      if (st) s.startedAt = s.startedAt || st;
      continue;
    }
    // Patch 84: the latest turn's model and reasoning effort, for the status line.
    // Codex Desktop rollouts carry no turn_context, so those cards keep "codex".
    if (o.type === "turn_context") { s.model = p.model || s.model; s.effort = p.effort || ""; continue; }
    // First thing the user actually typed, for the card title. Codex opens a session
    // with machine-written user turns -- the AGENTS.md replay, a <recommended_plugins>
    // envelope -- so those are skipped, or every card would be titled after one of
    // them. A real prompt that opens with "<" loses its title to the folder name;
    // that is the cheap side of the trade.
    if (o.type === "response_item" && p.role === "user" && !s.firstPrompt) {
      const txt = Array.isArray(p.content)
        ? p.content.map((c) => (c && typeof c.text === "string") ? c.text : "").join(" ").trim()
        : "";
      if (txt && !injectedTurn(txt)) s.firstPrompt = txt;
      continue;
    }
    // A successor is engaged only after model output, not a terminal/task-start event.
    if (o.type === "response_item" && (p.role === "assistant" || p.type === "function_call")) {
      s.engagedAt = Math.max(s.engagedAt || 0, ts || 0);
    }
    // Patch 82: Codex's own typed question. The call returns {"accepted":true} and the
    // turn runs on, so it stays owed until the user's answer opens the next turn.
    if (o.type === "response_item" && p.type === "function_call" && p.name === "request_user_input_async") {
      s.asked = true;
      continue;
    }
    if (o.type !== "event_msg") continue;

    // Which lifecycle event came LAST decides whether the session is working.
    //
    // ⛔ It used to be a counter -- openTurns++ on task_started, -- on task_complete,
    // ">0 means busy" -- on the stated assumption that Codex emits exactly one
    // complete per start. THAT ASSUMPTION IS FALSE. An interrupted or errored turn
    // emits the start and no complete, so the counter is really a running total of
    // leaks: measured 2026-09-24, one conversation had 246 starts against 239
    // completes and had therefore claimed "working" for two days. Last-event-wins is
    // self-healing -- a leak is corrected by the very next turn that completes.
    // statusAt (patch 82): when the last of these landed -- the card's status clock.
    const eventAt = p.type === "task_started" ? p.started_at : p.type === "task_complete" ? p.completed_at : 0;
    const statusAt = typeof eventAt === "number" && eventAt > 0 && eventAt * 1000 <= ts ? eventAt * 1000 : ts;
    if (p.type === "task_started") { s.lastTask = "started"; s.turns++; s.statusAt = statusAt || s.statusAt; s.asked = false; s.live = ""; continue; }
    if (p.type === "turn_aborted") { s.lastTask = "aborted"; s.statusAt = ts || s.statusAt; continue; }
    if (p.type === "task_complete") {
      s.lastTask = "complete";
      s.statusAt = statusAt || s.statusAt;
      if (p.last_agent_message) s.lastMessage = String(p.last_agent_message);
      // Patch 84: "last turn Xm". duration_ms is on every codex-tui turn; a Codex
      // Desktop turn has at most started_at/completed_at (epoch seconds), else none.
      s.lastTurnMs = typeof p.duration_ms === "number" ? p.duration_ms
        : p.completed_at && p.started_at ? (p.completed_at - p.started_at) * 1000 : 0;
      continue;
    }
    // Patch 84: what the agent is saying mid-turn -- the card's live text while working.
    if (p.type === "agent_message") { s.engagedAt = Math.max(s.engagedAt || 0, ts || 0); s.live = String(p.message || ""); continue; }
    // Patch 84: the plan's rate limits ride on every token_count; the newest is the meter.
    if (p.type === "token_count" && p.rate_limits && p.rate_limits.primary) { s.rl = p.rate_limits; s.rlAt = ts || s.rlAt; }
    if (p.type === "token_count" && p.info) {
      // ⛔ `total_token_usage` is CUMULATIVE BILLED TOKENS for the whole conversation,
      // not context occupancy -- 322M against a 258k window on one of the user's cards,
      // which the bar rendered as 124630%. What is actually in the window is what was
      // fed to the model on the last turn. Fall back to the cumulative total only if
      // last_token_usage is missing, so an old rollout still shows something.
      const last = p.info.last_token_usage;
      const tot = p.info.total_token_usage && p.info.total_token_usage.total_tokens;
      if (last && typeof last.input_tokens === "number") s.tokens = last.input_tokens;
      else if (typeof tot === "number" && !s.tokens) s.tokens = tot;
      if (typeof p.info.model_context_window === "number") s.ctxWindow = p.info.model_context_window;
      // Patch 84: spend. total_token_usage is this thread's cumulative billed tokens (it
      // matches the sum of its token_usage_records). A Codex Desktop rollout has one
      // token_count with only total_tokens set -- not a spend we can name, so none.
      const tu = p.info.total_token_usage;
      if (tu && (tu.input_tokens || tu.output_tokens)) s.usage = tu;
    }
    if (typeof p.model_context_window === "number" && !s.ctxWindow) s.ctxWindow = p.model_context_window;
  }
  return s;
}

// One board row, in the shape buildSessions already consumes for Claude.
// `s` may be a single rollout or a merge of several fragments (see mergeFragments).
// A session whose last lifecycle event is a start, but which has written nothing
// for this long, is not working -- it was killed or interrupted mid-turn and the
// completing event is never coming. Generous on purpose: a Codex turn waiting on a
// slow tool call is silent too, and a card that wrongly reads idle is a smaller lie
// than one that claims to be working two days after the fact.
const WORKING_STALE_MS = 5 * 60 * 1000;

function toSession(s, file, nowMs) {
  const working = s.lastTask === "started" &&
                  (nowMs || Date.now()) - (s.updatedAt || 0) < WORKING_STALE_MS;
  // Two sessions in one folder are indistinguishable if both are named after it --
  // the same confusion the Claude cards were renamed to fix. Prefer what the user asked.
  const name = firstLine(s.firstPrompt) || shortCwd(s.cwd).split("/").pop() || "codex";
  const ctxPct = (s.ctxWindow > 0) ? Math.min(100, Math.round((s.tokens / s.ctxWindow) * 100)) : 0;
  return {
    agent: "codex",
    handoffPrompt: s.firstPrompt || "",
    engagedAt: s.engagedAt || 0,
    sid: s.sid || path.basename(file, ".jsonl"),
    name,
    cwd: s.cwd,
    shortCwd: shortCwd(s.cwd),
    // Working or idle here. Needs you is decided in extension.js codexCards (patch 82),
    // by the Claude half's own rule, from the two fields below: a Claude card's CLI says
    // idle too, and the board promotes it.
    state: working ? "working" : "idle",
    // A turn that started and never completed, or was interrupted (turn_aborted): with no
    // live terminal behind it, the card reads cutoff (codexCards).
    unfinished: s.lastTask === "started" || s.lastTask === "aborted",
    // The turn is over; its closing message is task_complete's last_agent_message.
    turnFinal: s.lastTask === "complete",
    // That turn asked the user through request_user_input_async, and no turn has started since.
    asked: s.lastTask === "complete" && !!s.asked,
    // Patch 84: mid-turn, what it is saying now (agent_message), as a Claude card shows
    // its live text; the turn's closing message once it is over.
    summary: (working && s.live) || s.lastMessage || "",
    model: s.model ? s.model + (s.effort ? " " + s.effort : "") : "",
    branch: s.branch,
    originator: s.originator,
    lastTurnMs: s.lastTurnMs,
    usage: s.usage,
    tokens: s.tokens,
    ctxWindow: s.ctxWindow,
    ctxPct,
    startedAt: s.startedAt || s.updatedAt,
    // Patch 82: when the card entered its state, as the Claude clock reads -- the last
    // task_started while working, the turn's end once it is over. It used to be the last
    // event of any kind, so a working card's clock restarted on every token count.
    // A turn that started and went quiet has been idle since its last event.
    statusSince: s.lastTask === "started" && !working ? s.updatedAt : (s.statusAt || s.updatedAt),
    touchedAt: s.updatedAt,
    turns: s.turns,
    // How many rollout files this one card stands for. 1 for an ordinary session;
    // the card shows the number only when it is >1, so a session that forked 103
    // times is visible as one card that says so rather than 103 cards.
    fragments: s.fragments || 1
  };
}

// ---- fragments -> one session ------------------------------------------------
// Codex does NOT write one rollout per session. It opens a NEW rollout file every
// time a thread forks -- each carrying the SAME `session_id` in its session_meta
// and chained by `parent_thread_id`. Emitting a row per FILE therefore emits a row
// per fork: measured 2026-09-24, 166 rollout files inside the 24h window were 53
// real conversations, and ONE codex-tui session accounted for 103 of the cards.
// That was the whole of the "166 GPT sessions" the user reported as nonsense.
//
// The merge is over the fragments of one conversation in timestamp order:
//   - startedAt  earliest, so the card's age is the conversation's, not the fork's
//   - updatedAt  latest, which is what the board sorts and ages on
//   - turns      summed: every fork's turns were turns of this conversation
//   - lastTask   from the NEWEST fragment: that fork is the live one, and a stale
//                fork's dangling task_started must not speak for the conversation
//   - statusAt / asked  with lastTask: they describe the same turn (patch 82)
//   - firstPrompt from the EARLIEST fragment -- what the user typed to open the thread
//   - lastMessage / tokens / ctxWindow from the NEWEST fragment: the live context
//     window belongs to the fork that is current, not to the sum of dead ones.
function mergeFragments(parts) {
  const ordered = parts.slice().sort(
    (a, b) => (a.startedAt || a.updatedAt || 0) - (b.startedAt || b.updatedAt || 0));
  const newest = ordered.reduce((a, b) => ((b.updatedAt || 0) >= (a.updatedAt || 0) ? b : a));
  const m = {
    sid: "", cwd: "", startedAt: 0, updatedAt: 0,
    lastMessage: newest.lastMessage || "", firstPrompt: "", engagedAt: 0,
    tokens: newest.tokens || 0, ctxWindow: newest.ctxWindow || 0,
    lastTask: newest.lastTask || "", turns: 0, fragments: ordered.length,
    statusAt: newest.statusAt || 0, asked: !!newest.asked,
    model: "", effort: "", branch: "", lastTurnMs: newest.lastTurnMs || 0, live: newest.live || "",
    usage: newest.usage || null
  };
  for (const s of ordered) {
    if (!m.sid && s.sid) m.sid = s.sid;
    if (s.cwd) m.cwd = s.cwd;                               // newest non-empty wins
    if (s.branch) m.branch = s.branch;
    if (s.originator) m.originator = s.originator;
    if (s.model) { m.model = s.model; m.effort = s.effort; }
    if (s.startedAt && (!m.startedAt || s.startedAt < m.startedAt)) m.startedAt = s.startedAt;
    if (s.updatedAt > m.updatedAt) m.updatedAt = s.updatedAt;
    m.engagedAt = Math.max(m.engagedAt, s.engagedAt || 0);
    if (!m.firstPrompt && s.firstPrompt) m.firstPrompt = s.firstPrompt;
    if (!m.lastMessage && s.lastMessage) m.lastMessage = s.lastMessage;
    m.turns += s.turns;
  }
  if (!m.ctxWindow) for (const s of ordered) if (s.ctxWindow) m.ctxWindow = s.ctxWindow;
  if (!m.tokens) for (let i = ordered.length - 1; i >= 0; i--) if (ordered[i].tokens) { m.tokens = ordered[i].tokens; break; }
  return m;
}

// `keepSids` (patch 80): sessions the board is keeping past the window -- on it at
// the last shutdown, or parked. Their older rollouts are read in full and stay
// cached; every other old rollout costs one first-line read, once per host.
function listSessions(nowMs, keepSids) {
  const now = nowMs || Date.now();
  try {
    const files = rolloutFiles(now);
    const seen = new Set();
    // Fragments of one conversation, keyed by session_id. A rollout with no
    // session_meta (truncated, still being written) has no session_id, so it keys
    // on its own filename and stays a card of its own rather than merging into
    // whichever unrelated session happens to share the empty key.
    const groups = new Map();
    for (const f of files) {
      if (f.old) {
        if (!sidOf.has(f.path)) {
          const id = headSid(f.path);
          if (id !== null) sidOf.set(f.path, id || path.basename(f.path, ".jsonl"));
        }
        const id = sidOf.get(f.path);
        if (id) known.add(id);
        if (!id || !keepSids || !keepSids.has(id)) continue;
      }
      seen.add(f.path);
      let parsed;
      const hit = cache.get(f.path);
      if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) {
        parsed = hit.parsed;                       // the expensive read, skipped
      } else {
        let text; try { text = fs.readFileSync(f.path, "utf8"); } catch (_) { continue; }
        parsed = parseRollout(text);
        cache.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, parsed });
      }
      const key = parsed.sid || path.basename(f.path, ".jsonl");
      known.add(key);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { file: f.path, parts: [], old: true }));
      g.parts.push(parsed);
      g.old = g.old && f.old;
    }
    for (const k of Array.from(cache.keys())) if (!seen.has(k)) cache.delete(k);
    const out = [];
    for (const g of groups.values()) {
      // Patch 81: a subagent or guardian_review rollout carries its PARENT's session_id,
      // so it landed in this group and, being written last, spoke for the card: its
      // state, summary and context %. Only the user's own thread and its genuine forks
      // merge. Guardian reviews (128 on disk) are noise; subagents (67) ride along as
      // the card's helpers, each with its own state. Helpers alone make no card.
      // Keep the sid known so snapshot restoration cannot resurrect an imported
      // card on the Claude half. A real Codex turn makes the session eligible again.
      const own = g.parts.filter((p) => p.source !== "subagent" && p.source !== "guardian_review" &&
        (!p.imported || p.nativeTurn));
      if (!own.length) continue;
      const s = own.length === 1 ? own[0] : mergeFragments(own);
      const row = toSession(s, g.file, now);
      row.old = g.old;              // every fragment is outside the window: kept, not live
      row.subagents = g.parts.filter((p) => p.source === "subagent").map((p) => {
        const t = toSession(p, g.file, now);
        return { thread: p.thread, nickname: p.nickname, role: p.role, state: t.state,
                 startedAt: t.startedAt, touchedAt: t.touchedAt };
      });
      // Patch 84: the spend of the card's helpers and guardian reviews, each thread's own
      // cumulative total, so nothing is counted twice.
      const tok = (src) => g.parts.reduce((n, p) => n + (p.source === src && p.usage ? p.usage.total_tokens || 0 : 0), 0);
      row.helperTokens = tok("subagent");
      row.guardianTokens = tok("guardian_review");
      out.push(row);
    }
    out.sort((a, b) => (b.touchedAt || 0) - (a.touchedAt || 0));
    return out;
  } catch (_) { return []; }                       // fail closed, always
}

// Patch 84: the newest rate-limit reading on the board's rollouts -- Codex's plan meter.
function planUsage() {
  let best = null;
  for (const h of cache.values()) if (h.parsed.rl && (!best || h.parsed.rlAt > best.rlAt)) best = h.parsed;
  return best ? { limits: best.rl, at: best.rlAt } : null;
}

// Has a Codex rollout ever carried this sid? Complete after the first listSessions.
function isCodexSid(sid) { return known.has(sid); }

// ---- transcript viewer (patch 83) ---------------------------------------------
// Watch transcript renders a Codex card through the Claude viewer, so rollout lines
// become the events transcript.js parse() makes. Codex writes each user and agent
// message twice -- an event_msg, then its response_item twin on the very next line
// (all 583 user_messages, 7,610 of 7,651 agent_messages, 2026-10-01) -- so a message
// equal to the one just shown is the twin and is dropped; `st` carries that across
// appended chunks. the user's turns are marked with Codex's own prompt glyph, the Claude
// view having no user rows to borrow from. Developer and injected turns, reasoning
// and tool output are skipped, as the Claude view skips thinking and tool results.
function transcriptEvents(text, st = {}) {
  const out = [];
  const say = (t, user) => {
    t = String(t || "").trim();
    if (!t || (user && injectedTurn(t))) return;
    const e = { kind: "text", text: user ? "› " + t : t };
    if (st.last && st.last.kind === "text" && st.last.text === e.text) return;
    out.push((st.last = e));
  };
  for (const ln of String(text || "").split(/\r?\n/)) {
    if (!ln) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    const p = o && o.payload;
    if (!p) continue;
    if (o.type === "event_msg" && (p.type === "user_message" || p.type === "agent_message")) say(p.message, p.type === "user_message");
    else if (o.type === "response_item" && p.type === "message" && (p.role === "user" || p.role === "assistant"))
      say(Array.isArray(p.content) ? p.content.map((c) => (c && typeof c.text === "string") ? c.text : "").join("") : "", p.role === "user");
    else if (o.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call"))
      for (const e of toolRows(p)) out.push((st.last = e));
  }
  return out;
}

// One tool call as the Claude view shows its own: Shell(<command>), Update(<file>).
// A custom call ("exec") is a JS cell that may run several tools -- a row per command
// or patched file in it, else one row named after the first tool it calls.
function toolRows(p) {
  const s = String(p.input || p.arguments || "");
  if (p.type === "custom_tool_call") {
    const rows = [];
    for (const m of s.matchAll(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|`[^`]*`)|\*\*\* (Update|Add|Delete) File: (.*?)(?=(?<!\\)\\n|\n|"|$)/g)) {
      if (m[2]) { rows.push({ kind: "tool", tool: m[2] === "Update" ? "Edit" : m[2] === "Add" ? "Write" : "Delete", arg: m[3].replace(/\\\\/g, "\\") }); continue; }
      let c = m[1].slice(1, -1);
      if (m[1][0] === '"') try { c = JSON.parse(m[1]); } catch (_) { /* shown as written */ }
      rows.push({ kind: "tool", tool: "Shell", arg: c });
    }
    return rows.length ? rows : [{ kind: "tool", tool: (s.match(/tools\.(\w+)\(/) || [])[1] || p.name || "tool", arg: "" }];
  }
  let a = {}; try { a = JSON.parse(s) || {}; } catch (_) { /* no arguments to show */ }
  const v = [a.cmd, a.command, a.file_path, a.path, a.title, a.task_name, a.target].find((x) => typeof x === "string" || Array.isArray(x));
  return [{ kind: "tool", tool: p.name || "tool", arg: Array.isArray(v) ? v.join(" ") : v || "" }];
}

// The last `max` bytes of a rollout as viewer events, whole lines only: rollouts reach
// 11 MB and are never parsed whole on the UI thread. `offset` is where the next
// appended read starts -- just past the last complete line, so a line still being
// written is read whole on the next tick rather than lost. `cut`: earlier lines unread.
function tailEvents(file, max, st) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const from = start ? buf.indexOf(10) + 1 : 0, to = buf.lastIndexOf(10) + 1;
    return { events: transcriptEvents(buf.subarray(from, to).toString("utf8"), st), offset: start + to, cut: start > 0 };
  } finally { fs.closeSync(fd); }
}

// The rollout the viewer reads: a card's own thread -- the newest fragment, the live
// fork, as mergeFragments takes it -- never a guardian review or subagent; or, with
// `thread`, one subagent thread (a helper row's id). From listSessions' cache, which
// holds every rollout on the board. null when there is none.
function rolloutPath(sid, thread) {
  let best = null, at = -1;
  for (const [p, h] of cache) {
    const s = h.parsed;
    if (thread ? s.thread !== thread : s.sid !== sid || s.source === "subagent" || s.source === "guardian_review") continue;
    if ((s.updatedAt || 0) > at) { best = p; at = s.updatedAt || 0; }
  }
  return best;
}

function isRollout(file) {
  return String(file || "").toLowerCase().startsWith(ROOT.toLowerCase() + path.sep);
}

module.exports = { listSessions, isCodexSid, parseRollout, shortCwd, toSession, firstLine, injectedTurn, mergeFragments,
                   transcriptEvents, tailEvents, rolloutPath, isRollout, planUsage };
