// Overlord — a live board of your Claude Code sessions inside VS Code.
//
// Data source: `claude agents --json`, Claude Code's own session supervisor.
// No hooks, no state files — install the extension and it works. Each session
// becomes a colored eye:
//   waiting -> red "needs you"   busy -> amber "working"   idle -> grey "idle"
// A short green "done" flash marks a session that just went busy->idle (the only
// client-derived cue; every other state comes straight from Claude Code).
//
// The pid in each record is the live `claude` process, so we walk the process
// tree from it to (a) label each eye with its VS Code terminal tab and (b) jump
// straight to that terminal on click.

const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const A = require("./agents");
const D = require("./device");
const T = require("./transcript");
const X = require("./codex");   // Codex (GPT) sessions — see codex.js
const { raiseVSCodeWindow } = require("./raise");

// Concept-search helper: ranks the live board by a query's INTENT via Haiku.
// The Python helpers ship in ./python. OVERLORD_PYTHON picks the interpreter
// (default: `python` on PATH). Fail-open: if the helper can't run, search just
// returns null and the webview keeps its instant keyword hits.
//
// OVERLORD_WORKSPACE (optional) is a folder whose _temp/ holds companion state
// files (loop registry, plan gate, task archive, handoff gate). Unset = those
// features stay quiet.
const WORKSPACE = process.env.OVERLORD_WORKSPACE || "";
function wsPath(...p) { return WORKSPACE ? path.join(WORKSPACE, ...p) : ""; }
const SEARCH_PY = process.env.OVERLORD_PYTHON || "python";
const SEARCH_HELPER = path.join(__dirname, "python", "session_search.py");
let _searchSeq = 0;   // only the newest in-flight search may post results

// Spawn the ranker for the current board and post {type:"searchResults"} back.
// ranked:null  -> search unavailable (keep keyword results); ranked:[] -> ran,
// nothing matched; ranked:[...] -> concept hits, most-relevant first.
function runSessionSearch(q, webview) {
  const seq = ++_searchSeq;
  const sessions = buildSessions(_agentCache, Date.now(), _metaCache);
  // Patch 84: a Codex card has no ~/.claude transcript for the ranker to read, so the
  // text of its rollout's last 12 KB rides along -- the viewer's tail read, never a parse.
  const cards = sessions.map((s) => {
    if (s.agent !== "codex") return { sid: s.sid, name: s.name };
    let excerpt = "";
    try { const f = X.rolloutPath(s.sid);
      if (f) excerpt = X.tailEvents(f, 12000, {}).events.filter((e) => e.kind === "text").map((e) => e.text).join(" ").slice(-750); } catch (_) { /* title only */ }
    return { sid: s.sid, name: s.name, excerpt };
  });
  const payload = JSON.stringify({ query: q, cards });
  let settled = false;
  const finish = (ranked) => {
    if (settled) return; settled = true;
    if (seq !== _searchSeq) return;              // superseded by a newer search
    webview.postMessage({ type: "searchResults", q, ranked });
  };
  let child;
  try {
    child = cp.execFile(SEARCH_PY, [SEARCH_HELPER], { timeout: 22000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return finish(null);
        let ranked = null;
        try { const o = JSON.parse(stdout); if (o && o.ok) ranked = o.ranked || []; } catch (_) { ranked = null; }
        finish(ranked);
      });
    child.stdin.write(payload); child.stdin.end();
  } catch (_) { finish(null); }
}

// Topic-emoji fallback: the webview's keyword table is primary; only titles it
// can't classify reach here. We ask Haiku for one emoji each, cache the answer by
// title (persisted in globalState), and re-post so the glyph swaps in. Fail-open
// and best-effort — a title we can't resolve just stays 💬.
const TOPIC_EMOJI_HELPER = path.join(__dirname, "python", "topic_emoji.py");
let topicEmojiCache = {};   // title -> emoji (loaded from globalState in activate)
let _emojiInFlight = false;

function runTopicEmoji(names) {
  // Only titles we've never resolved; skip while one batch is already running.
  if (_emojiInFlight) return;
  const need = [...new Set((names || []).filter((n) => n && !(n in topicEmojiCache)))].slice(0, 40);
  if (!need.length) return;
  _emojiInFlight = true;
  let child;
  const done = () => { _emojiInFlight = false; };
  try {
    child = cp.execFile(SEARCH_PY, [TOPIC_EMOJI_HELPER], { timeout: 30000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        done();
        if (err) return;
        let map = null;
        try { const o = JSON.parse(stdout); if (o && o.ok) map = o.emojis || {}; } catch (_) { map = null; }
        if (!map) return;
        // Cache every requested title: the model's pick, or 💬 so we don't re-ask
        // a title it declined to classify.
        let changed = false;
        for (const n of need) { const e = map[n] || "💬"; if (topicEmojiCache[n] !== e) { topicEmojiCache[n] = e; changed = true; } }
        if (changed) {
          if (gState) gState.update("topicEmojiCache", topicEmojiCache);
          if (provider) provider.post(buildSessions(_agentCache, Date.now(), _metaCache));  // swap 💬 for the real glyph
        }
      });
    child.stdin.write(JSON.stringify({ titles: need })); child.stdin.end();
  } catch (_) { done(); }
}

let provider;      // OverlordViewProvider
let timer;         // poll interval
let polling = false;           // guard: never overlap slow polls
let seeded = false;            // suppress notifications on the first read
let prevStatus = {};           // sid -> last raw status (busy/waiting/idle)
let notifiedWait = {};         // sid -> true once we've toasted its current "needs you" episode
let notifiedDone = {};         // sid -> true once we've toasted its current "finished" episode
let finishedAt = {};           // sid -> ms when it last went busy->idle
let statusSince = {};          // sid -> ms when it entered its current status
const panels = new Map();      // sid -> { panel, offset }  (open transcript viewers)
let lastError = null;          // last spawn error (for the empty state)
let procCache = { at: 0, map: null };
let termNames = new Map();      // sid -> resolved terminal tab name
let termResolveAt = 0;
const codexTerminals = new Map(); // Codex sid -> exact Terminal captured at launch
let pendingCodexTerminals = [];   // launches waiting for their rollout/session id
let codexTerminalPids = {};       // sid -> shell pid, persisted across extension-host reloads
const CODEX_TERMINAL_MAP_VERSION = 2; // v1 could bind an unrelated active rollout
let _agentCache = [];           // most recent raw records (for jump lookups)
let _lastBoard = null;          // the board last posted to the webview (patch 89: click lookups)
let _metaCache = {};            // sid -> last readMeta() result (for off-tick rebuilds)
let codexHandoffNames = {};     // successor sid -> inherited parent title, persisted
let renames = {};               // sid -> user-chosen display name (persisted in globalState)
let parked = {};                // sid -> true: user "Move to done" override (persisted); cleared on activity
let pinned = [];                // sids pinned to the top strip, at most 3 (patch 86); never evicted
// Sids KNOWN to be headless `claude -p` runs -> {at: firstSeenMs}. Persisted, because
// isBackgroundRun() reads the PROCESS command line and a finished run has no process:
// once it exits it can never be re-identified, so nestRuns (which needs a live pid)
// drops it and snapshotBoard used to restore it as an anonymous dormant card forever.
// 53 of the 200 cards on the user's board on 2026-09-24 were exactly this. Recording the
// verdict while the pid is still readable is the only place the knowledge exists.
let bgRunSids = {};
let taskArchive = {};           // sid -> {latest:{stamp,done,total,items}, runs:[...]} — persisted to
                                // TASK_ARCHIVE_FILE (a vault file, NOT globalState: survives profile
                                // resets and is seedable/repairable externally; patch 38d)
// Board snapshot for cross-restart restore: sid -> {name,cwd,status,startedAt,ts}.
// Persisted in globalState; on the next launch, any snapshot sid that isn't live
// again becomes a DORMANT card (resumable via `claude --resume`). See restore
// feature (patch 22).
let boardSnapshot = {};
let _snapAt = 0;                // throttle for persisting the snapshot
let _snapSig = "";              // last-persisted sid signature (persist promptly on change)
// Sids eligible to appear as DORMANT this run = those that were in the snapshot at
// startup (i.e. from the previous Cursor session). A session started (or resumed)
// THIS run is removed from the set the moment it goes live, so closing one of its
// terminals mid-session does NOT resurrect it as a dormant card — restore is only
// for what was on the board when Cursor last closed.
let restoreSet = new Set();
let closedParked = new Set();   // sids closed by "Move to done" this run -> kept as dormant Done cards (patch 2026-09-28)
let sweptParked = false;        // closeParked run over already-parked sessions once per activation
let gState = null;             // ExtensionContext.globalState (set in activate)
let activeAgent = "claude";     // which half of the board toggle is showing; the
                                // new-session shortcut launches this agent's CLI
let activeSid = null;           // sid whose terminal is currently focused (selected card)
let usageStat = null;           // {plan, rows:[{label,leftPct,severity,resetsAt,group}]} last /usage fetch
let usageAt = 0;                // ms of last usage fetch (throttle)
let usageBusy = false;          // a usage fetch + transcript scan is running (patch 89)
let subCreatedAt = null;        // subscription_created_at (from /profile) — for the renewal bar

function cfg() { return vscode.workspace.getConfiguration("overlord"); }

// ---- data: `claude agents --json` ------------------------------------------
// The exact command the board polls; the error state shows it (patch 86).
function agentsCmd() { return `"${cfg().get("claudePath") || "claude"}" agents --json`; }
function getAgents() {
  return new Promise((resolve) => {
    cp.exec(agentsCmd(),
      { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, err });
        try { resolve({ ok: true, agents: A.parseAgents(stdout) }); }
        catch (e) { resolve({ ok: false, err: e }); }
      });
  });
}

// Overlord's own headless button-labeler runs a `claude` session in the Cursor
// install dir (…\Programs\cursor\_), so `claude agents --json` reports it with a
// bare "_" folder name. It is never the user's work — drop it before rendering cards.
// Also drops any CWD-LESS agent: a headless `claude` (a hook- or job-spawned
// `claude -p` with no project dir) reports no cwd, renders as a phantom "claude"
// card that can't be jumped to, and — pre-fix — toasted "🟢 claude finished" on
// every busy->idle. No working directory ⇒ not real board content.
function isNoiseAgent(a) {
  const cwd = String((a && a.cwd) || "");
  if (!cwd.trim()) return true;
  if (/[\\/]programs[\\/]cursor[\\/]/i.test(cwd)) return true;
  const seg = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return seg === "_" || A.folderName(cwd) === "_";
}

// ---- background runs -> a SECTION on the launcher's card (2026-08-21) --------
// the user: "I prefer not to see them as cards, can they be sections in the existing
// session card that they are working with." A session that fans out `claude -p`
// runs — a variance A/B, a graded eval — used to put a full card on the board per
// run, none of them jumpable, because a background run has no terminal.
//
// ⛔ THE LINK CANNOT COME FROM THE PROCESS TREE. `run_in_background` detaches:
// the launching shell exits and the child reparents to a dead pid within seconds
// (verified 2026-08-21 — pid 42560 -> env.exe -> a pid already gone). So it comes
// from the LAUNCHER'S TRANSCRIPT, which records the spawning command verbatim,
// cwd and all. Resolved once per child and cached — a pid's cwd never changes,
// and a run is short-lived anyway.
//
// Fail-safe direction: an unresolved run keeps its own card. Never hide a session
// on a guess; the whole point of the board is that nothing runs invisibly.
const RUN_RETRIES = 5;          // polls to keep looking before it gets its own card
const RUN_SCAN_BYTES = 4 * 1024 * 1024;
const _cmdCache = new Map();    // pid -> command line ("" = looked and found nothing)
const _parentOf = new Map();    // run sid -> {parent: sid|null, tries}
const runNames = new Map();     // nested sid -> name, so the transcript viewer keeps its title
let _cmdPending = false;

// Patch 93: the transcript match misses every run a SCRIPT launched — the walk pipeline's
// walkers and graders ("D1-app-persona-a-…", "g1") never appear in the launcher's
// transcript, so each got its own card (the user, 2026-10-22: "helpers should always be
// grouped underneath their parent session - no exception"). The tree is broken, but the
// ENVIRONMENT is not: every command a session runs carries CLAUDE_CODE_SESSION_ID and
// every process below it inherits it. parent_sid.py reads it from the run or its nearest
// live ancestor. Asked once per run; the transcript match stays as the fallback.
const PARENT_HELPER = path.join(__dirname, "python", "parent_sid.py");
const _envParent = new Map();   // run sid -> parent sid | null (asked, none found)
let _envPending = false, _envFails = 0;
function askEnvParents(runs) {
  const ask = runs.filter((r) => r.pid && !_envParent.has(r.sid));
  if (_envPending || !ask.length) return;
  _envPending = true;
  cp.execFile(SEARCH_PY, [PARENT_HELPER, ...ask.map((r) => r.pid + ":" + r.sid)], { timeout: 15000, windowsHide: true },
    (err, stdout) => {
      _envPending = false;
      let got = {};
      try { if (!err) got = JSON.parse(stdout); } catch (_) { /* unreadable -> transcript fallback */ }
      // Patch 96: a failed call (timeout under load) is asked again, not cached as "no
      // parent" for the life of the run; after three failures in a row it gives up.
      if ((err || !stdout) && ++_envFails < 3) return;
      _envFails = 0;
      for (const r of ask) _envParent.set(r.sid, got[r.pid] || null);
    });
}

// One WMI sweep serving two readers: the command lines that identify a background
// run, and the live shell processes that prove a session's background work is
// actually alive. Narrowed to shells + claude.exe in the query, so the result is a
// few dozen rows rather than the whole process table. Fires when a pid we have
// never seen appears, and otherwise at most every WORKER_REFRESH_MS.
const WORKER_REFRESH_MS = 8000;
const SHELL_NAMES = "'bash.exe','sh.exe','cmd.exe','pwsh.exe','powershell.exe','claude.exe'";
let _procs = [];        // [{pid, ppid, name, created}]
let _procsAt = 0;
function refreshCmdlines(pids, now) {
  // Patch 96: Windows reuses pids. A command line cached for a pid that has left the
  // session list would be read as the next claude.exe that gets that pid.
  for (const p of _cmdCache.keys()) if (!pids.includes(p)) _cmdCache.delete(p);
  if (_cmdPending) return;
  const missing = pids.filter((p) => p && !_cmdCache.has(p));
  if (!missing.length && (now || Date.now()) - _procsAt < WORKER_REFRESH_MS) return;
  _cmdPending = true;
  cp.exec("powershell -NoProfile -Command \"Get-CimInstance Win32_Process | " +
          "Where-Object { $_.Name -in " + SHELL_NAMES + " } | Select-Object ProcessId," +
          "ParentProcessId,Name,CommandLine,@{n='C';e={$_.CreationDate.ToString('o')}} | " +
          "ConvertTo-Json -Compress\"",
    { timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout) => {
      _cmdPending = false;
      _procsAt = Date.now();
      if (!err) {
        try {
          let rows = JSON.parse(stdout);
          if (!Array.isArray(rows)) rows = [rows];
          _procs = rows.map((r) => ({
            pid: Number(r.ProcessId), ppid: Number(r.ParentProcessId),
            name: String(r.Name || "").toLowerCase(), created: Date.parse(r.C) || 0,
          }));
          for (const r of rows) {
            if (String(r.Name || "").toLowerCase() === "claude.exe")
              _cmdCache.set(Number(r.ProcessId), String(r.CommandLine || ""));
          }
        } catch (_) { /* malformed -> retry next tick */ }
      }
      // Anything still unknown is a process we cannot read: mark it looked-at so
      // the sweep does not re-fire every 2.5s for the life of the session.
      for (const p of missing) if (!_cmdCache.has(p)) _cmdCache.set(p, "");
    });
}

// Shells this session started AFTER booting — its DIRECT children only, so a shell
// that itself spawned a shell counts once. The 30s grace excludes the startup stack
// (every session opens a cmd/python of its own in the first second), which would
// otherwise read as permanent background work on an idle card.
const WORKER_GRACE_MS = 30000;
function workersFor(pid, startedAt, now) {
  if (!pid || !_procs.length) return null;
  const floor = (startedAt || 0) + WORKER_GRACE_MS;
  let n = 0, oldest = 0;
  for (const p of _procs) {
    if (p.ppid !== pid || p.name === "claude.exe") continue;
    if (!p.created || p.created < floor) continue;
    n++;
    if (!oldest || p.created < oldest) oldest = p.created;
  }
  return n ? { workers: n, workerAgeMs: Math.max(0, (now || Date.now()) - oldest) } : null;
}

// ⛔ The OS process table cannot always answer this at all. Verified 2026-08-24: a
// `run_in_background` shell, ten seconds into a 120s run, already carried a `ppid`
// the OS could not resolve to any live process — the exact reparenting this
// codebase already documented for RUNS (line ~176 above), just breaking a
// DIFFERENT feature that trusted the same process tree. No depth of tree-walking
// recovers a link the OS itself has dropped.
//
// The fix is the same shape as RUNS's: stop asking the process tree and ask
// something that doesn't forget. The harness writes one `<taskId>.output` file per
// `run_in_background` call, in a directory keyed by SESSION ID (not by any live
// pid), and appends `[exited with code N]` the instant that call finishes — its
// own bookkeeping, immune to whatever Windows did to the process's ancestry.
// Confirmed empirically: the file exists and is empty/marker-free for the whole
// run, then gets exactly that trailer.
//
// Additive to the OS-table count, same as `bg` is additive to `⚙` — the two
// sources cover different failure classes (this one can't see a background
// SUBAGENT's shells if they don't land in the session's own task dir; the OS
// table can't see a shell once its ancestry is gone). Take the larger of the two
// rather than trying to merge them 1:1: under-counting hides real activity, which
// is the one failure direction this board treats as worse than a double-count.
const EXIT_MARKER = "[exited with code";
const TASK_TAIL_BYTES = 256;
const _taskDirs = new Map();   // sid -> {dir, at}; a miss is retried after 30s
function taskDir(cwd, sid) {
  if (!cwd || !sid) return null;
  const slug = String(cwd).replace(/:/g, "-").replace(/[\\/]+/g, "-");
  // Patch 98 (2026-11-04): from about 3 Nov the CLI names this folder by a hash of the
  // cwd instead of the slug, so every current session's background jobs went unseen.
  // The hash input is unknown, so find the session by id. The new folder wins: a
  // resumed session has both, and only the new one holds its live jobs.
  const root = path.join(os.tmpdir(), "claude");
  const legacy = path.join(root, slug, sid, "tasks");
  const hit = _taskDirs.get(sid);
  const t = Date.now();
  if (hit && (hit.dir || t - hit.at < 30000)) return hit.dir || legacy;
  let dir = null;
  try {
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name, sid, "tasks");
      if (name !== slug && fs.existsSync(p)) { dir = p; break; }
    }
  } catch (_) {}
  _taskDirs.set(sid, { dir, at: t });
  return dir || legacy;
}
// A foreground Bash call whose output was too big to inline is PERSISTED to the
// session's tool-results/ dir — and its .output file is left behind with NO exit
// marker, so the loop below counted a finished read as a running job forever.
// Seen 2026-08-25: an idle card sat in the Working tab on a 39m-old phantom.
// The basenames match exactly (b9485l54b.output <-> b9485l54b.txt) and a real
// background job never has a persisted result, so this excludes them with no
// false negatives. mtime-cached — one readdir per session per change.
const _persisted = new Map();   // sid -> {mtime, names:Set}
function persistedOutputs(sid) {
  try {
    const t = transcriptPath(sid);
    if (!t) return null;
    const dir = path.join(path.dirname(t), sid, "tool-results");
    const mtime = fs.statSync(dir).mtimeMs;
    const hit = _persisted.get(sid);
    if (hit && hit.mtime === mtime) return hit.names;
    const names = new Set(fs.readdirSync(dir).map((f) => f.replace(/\.[^.]*$/, "")));
    _persisted.set(sid, { mtime, names });
    return names;
  } catch (_) { return null; }              // no dir -> nothing persisted
}
// startedAt bounds the count to THIS run of the session. A `--resume` reuses the
// sid, so the task dir still holds every .output file the session ever wrote —
// and "no exit marker" only means "still running" while the process that opened
// it is alive. After a restart those become permanent phantoms: seen 2026-08-25,
// a card 3 minutes old reporting 8 background jobs whose oldest was 24h28m.
// Same floor the OS-table side already applies.
//
// ⛔ 2026-09-11 — the THIRD phantom of this shape (after the cross-restart
// leftovers and the persisted foreground outputs), and the one that changed the
// DEFAULT instead of excluding another class. The classes were never the bug:
// inferring "running" from the ABSENCE of an end marker is, because every class
// that does not write one counts forever. A subagent's a*.output is created
// empty and never touched again — two of them had a PARKED card claiming live
// work 41h after the agents had finished, which is what the user reported.
//
// The invariant now: NO file counts forever. A job must show recent evidence of
// life, and a subagent's evidence is its own transcript — appended on every
// message — not its .output, which stays empty for the whole run. A file that
// identifies itself as a subagent gets the tight quiet window; everything else,
// future classes included, falls back to a bounded ceiling instead of infinity.
const WORKER_QUIET_MS = 20 * 60 * 1000;        // no end marker exists: silence == finished
const WORKER_CEILING_MS = 6 * 60 * 60 * 1000;  // a marker was expected and never came: writer died
// A subagent appends to `subagents/agent-<taskId>.jsonl` on every message, so that
// file's mtime is the liveness witness its own (always empty) .output cannot be.
// 0 also means "not a subagent", which is what selects the ceiling above — so the
// prefix letter is never consulted and a new marker-less class is still bounded.
function agentWitnessMs(sid, taskId) {
  const t = transcriptPath(sid);
  if (!t) return 0;
  const p = path.join(path.dirname(t), sid, "subagents", "agent-" + taskId + ".jsonl");
  const st = fs.statSync(p, { throwIfNoEntry: false });
  return (st && st.mtimeMs) || 0;
}
function taskWorkersFor(cwd, sid, now, startedAt) {
  const dir = taskDir(cwd, sid);
  if (!dir) return null;
  let files;
  try { files = fs.readdirSync(dir); } catch (_) { return null; }
  const persisted = persistedOutputs(sid);
  const t0 = now || Date.now();
  let n = 0, oldest = 0;
  for (const f of files) {
    if (!f.endsWith(".output")) continue;
    const id = f.slice(0, -7);
    if (persisted && persisted.has(id)) continue;   // finished, output persisted
    let stat, tail;
    try {
      const p = path.join(dir, f);
      stat = fs.statSync(p);
      const len = Math.min(stat.size, TASK_TAIL_BYTES);
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, Math.max(0, stat.size - len));
      fs.closeSync(fd);
      tail = buf.toString("utf8");
    } catch (_) { continue; }                  // unreadable -> skip, don't guess
    if (tail.includes(EXIT_MARKER) || tail.includes("[killed]")) continue;   // finished or stopped via TaskStop
    const created = stat.birthtimeMs || stat.mtimeMs || 0;
    if (startedAt && created < startedAt) continue;   // an earlier run's leftover
    const agent = agentWitnessMs(sid, id);
    const witness = Math.max(stat.mtimeMs || 0, agent);
    if (t0 - witness > (agent ? WORKER_QUIET_MS : WORKER_CEILING_MS)) continue;   // gone quiet -> finished
    n++;
    if (!oldest || created < oldest) oldest = created;
  }
  return n ? { workers: n, workerAgeMs: Math.max(0, t0 - oldest) } : null;
}

// Patch 98 (2026-11-04, the user: outside runs must "still be placed in the session
// overlord card and then in the working tab"). A scheduled task outlives its session
// on purpose, so nothing above can see it. ~/.claude/hooks/link-scheduled-job.py
// records which session started which task. Windows' own task state is the signal,
// so it cannot go stale the way an absent end marker can.
const JOB_DIR = path.join(os.homedir(), ".claude", "overlord-jobs");
const JOB_TTL_MS = 48 * 60 * 60 * 1000;   // past this the link is dropped, so a recurring task stops claiming its old session
const JOB_POLL_MS = 20 * 1000;
const _jobState = new Map();              // task -> {sid, running, since}
let _jobPolled = 0;
function readJobs(now) {
  let files;
  try { files = fs.readdirSync(JOB_DIR); } catch (_) { return []; }
  const jobs = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const p = path.join(JOB_DIR, f);
    try {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      if (now - j.at > JOB_TTL_MS) fs.unlinkSync(p);
      else if (j.sid && j.task) jobs.push(j);
    } catch (_) {}
  }
  return jobs;
}
function pollJobs(now) {
  if (now - _jobPolled < JOB_POLL_MS) return;
  _jobPolled = now;
  const jobs = readJobs(now);
  for (const task of _jobState.keys()) if (!jobs.some((j) => j.task === task)) _jobState.delete(task);
  for (const j of jobs) {
    cp.execFile("schtasks", ["/query", "/tn", j.task, "/fo", "csv", "/nh"], { windowsHide: true, timeout: 5000 }, (err, out) => {
      const running = !err && /"Running"/.test(out);
      const had = _jobState.get(j.task);
      _jobState.set(j.task, { sid: j.sid, running, since: running ? ((had && had.running && had.since) || Date.now()) : 0 });
    });
  }
}
function jobWorkersFor(sid, now) {
  pollJobs(now);
  let n = 0, oldest = 0;
  for (const j of _jobState.values()) {
    if (j.sid !== sid || !j.running) continue;
    n++;
    if (!oldest || j.since < oldest) oldest = j.since;
  }
  return n ? { workers: n, workerAgeMs: Math.max(0, now - oldest) } : null;
}

// Helper rows (2026-09-17): the count above says "N background jobs"; this says WHO.
// Each helper leaves `<sid>/subagents/agent-<id>.meta.json` (type + brief) beside its
// live log. Same startedAt floor as taskWorkersFor (resume leftovers), same quiet
// window as the fallback finish for a log that never wrote its end_turn.
// Which model a helper actually ran on (2026-09-25, the user: "show the model of each
// helper on each card"). The resolved id off the log wins — it distinguishes opus 5
// from 5.5 — and .meta.json's alias is the fallback, since it exists from launch
// while the log has no assistant turn yet. Unknown ids degrade to a trimmed id, not "".
function shortModel(m) {
  const s = String(m || "").toLowerCase().replace(/\[1m\]$/, "");
  if (!s || s.startsWith("<")) return "";   // "<synthetic>" is not a model
  for (const k of ["haiku", "sonnet", "fable", "mythos"]) if (s.includes(k)) return k;
  const o = s.match(/opus-?(\d+)(?:-(\d+))?/);
  if (o) return "opus " + o[1] + (o[2] ? "." + o[2] : "");
  return s.replace(/^claude-/, "");
}
const HELPER_TAIL_BYTES = 16 * 1024;
const _helperCache = new Map();   // log path -> {key, meta, tail}
function helpersIn(dir, now, startedAt) {
  let files;
  try { files = fs.readdirSync(dir); } catch (_) { return []; }
  const t0 = now || Date.now();
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".meta.json")) continue;
    const log = path.join(dir, f.slice(0, -10) + ".jsonl");
    try {
      const mst = fs.statSync(path.join(dir, f));
      const startedMs = mst.birthtimeMs || mst.mtimeMs || 0;
      if (startedAt && startedMs < startedAt) continue;   // an earlier run's helper
      const st = fs.statSync(log, { throwIfNoEntry: false });
      const key = st ? st.mtimeMs + ":" + st.size : "none";
      let c = _helperCache.get(log);
      if (!c || c.key !== key) {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        let tail = { lastMs: 0, lastAction: "", done: false, model: "" };
        if (st) {
          const len = Math.min(st.size, HELPER_TAIL_BYTES);
          const buf = Buffer.alloc(len);
          const fd = fs.openSync(log, "r");
          try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
          tail = T.readHelperTail(buf.toString("utf8"));
          // One big tool result can fill the whole tail and push its own call out
          // of it — keep the last action seen rather than blank the row.
          if (!tail.lastAction && c) tail.lastAction = c.tail.lastAction;
          if (!tail.model && c) tail.model = c.tail.model;
        }
        c = { key, meta, tail };
        _helperCache.set(log, c);
      }
      const lastMs = c.tail.lastMs || (st && st.mtimeMs) || startedMs;
      out.push({ id: f.slice(6, -10), type: c.meta.agentType || "", brief: c.meta.description || "",
                 startedMs, lastMs, lastAction: c.tail.lastAction, log,
                 model: shortModel(c.tail.model || c.meta.model),
                 done: c.tail.done || t0 - lastMs > WORKER_QUIET_MS });
    } catch (_) { continue; }   // half-written meta or unreadable log -> skip, don't guess
  }
  return out.sort((a, b) => (a.done - b.done) || (a.startedMs - b.startedMs));
}
function helpersFor(sid, now, startedAt) {
  const t = transcriptPath(sid);
  return t ? helpersIn(path.join(path.dirname(t), sid, "subagents"), now, startedAt) : [];
}

// Token spend per log file (2026-09-17). Logs run to many MB, so each file keeps a byte
// offset and only new COMPLETE lines are read per tick, in 4 MB slices. A file that
// shrank was rewritten — start it over. A reload meets every log cold (the biggest is
// 100+ MB), and the extension host freezes the board while it reads, so each poll tick
// gets SPEND_TICK_BYTES in total: a big backlog fills in over a few ticks, `partial` set.
const SPEND_SLICE = 4 * 1024 * 1024;
const SPEND_TICK_BYTES = 16 * 1024 * 1024;
let _spendBudget = SPEND_TICK_BYTES;
function spendTick() { _spendBudget = SPEND_TICK_BYTES; }
const _spend = new Map();   // log path -> {offset, state}
function spendFor(p) {
  let st;
  try { st = fs.statSync(p); } catch (_) { return null; }
  let c = _spend.get(p);
  if (!c || st.size < c.offset) { c = { offset: 0, state: T.newSpend() }; _spend.set(p, c); }
  if (st.size > c.offset) {
    let fd;
    try {
      fd = fs.openSync(p, "r");
      let slice = SPEND_SLICE;
      // Cut on the last newline BYTE, so a slice never splits a multi-byte character.
      // A line bigger than the budget still finishes: a grown slice ignores the budget.
      while (c.offset < st.size && (_spendBudget > 0 || slice > SPEND_SLICE)) {
        const len = Math.min(slice, st.size - c.offset);
        _spendBudget -= len;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, c.offset);
        const nl = buf.lastIndexOf(10);
        if (nl < 0) {
          if (c.offset + len >= st.size) break;       // unfinished last line: next tick
          slice *= 2; continue;                       // one line longer than a slice
        }
        T.addUsage(c.state, buf.toString("utf8", 0, nl + 1));
        c.offset += nl + 1;
        slice = SPEND_SLICE;
      }
    } catch (_) { /* transient read race; the offset only moved past parsed lines */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  const out = T.spendTotals(c.state);
  out.partial = st.size - c.offset > 64 * 1024;   // more than an unfinished line left
  return out;
}
// A session's spend = its own log (every run of it — a resume appends to the same file)
// plus every helper log it ever wrote. Helper rows are filtered to this run; this is not.
function sessionSpend(sid) {
  const t = transcriptPath(sid);
  if (!t) return null;
  const sum = spendFor(t);
  if (!sum) return null;
  const dir = path.join(path.dirname(t), sid, "subagents");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch (_) { /* no helpers */ }
  let helpers = 0;
  const agentTasks = (_spend.get(t) || {}).state.agentTasks;
  for (const tk of Object.values(sum.tasks)) tk.helpers = 0;
  for (const f of files) {
    const hp = path.join(dir, f);
    const h = spendFor(hp);
    if (!h) continue;
    helpers += h.total;
    if (h.partial) sum.partial = true;
    for (const k of ["input", "cacheWrite", "cacheRead", "output", "total"]) sum[k] += h[k];
    // Charge the helper to the steps in progress when it was launched (meta.toolUseId).
    const charge = agentTasks.get(helperMeta(hp).toolUseId) || [];
    for (const id of charge) if (sum.tasks[id]) sum.tasks[id].helpers += Math.round(h.total / charge.length);
  }
  sum.helpers = helpers;
  return sum;
}
const _metaJson = new Map();   // helper log path -> parsed .meta.json (written once at launch)
function helperMeta(logPath) {
  if (_metaJson.has(logPath)) return _metaJson.get(logPath);
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(logPath.replace(/\.jsonl$/, ".meta.json"), "utf8")); _metaJson.set(logPath, meta); }
  catch (_) { /* not written yet: retry next tick */ }
  return meta;
}

// Handoff chain (2026-09-17). A successor's log opens with the SessionStart hook's
// "Handed over from session <8 hex>" — only that attachment counts, so a session merely
// talking about a handoff never adopts one. Found links are kept; a miss is re-checked
// once a minute (the attachment lands a few seconds after the session starts).
const HANDOFF_RE = /Handed over from session ([0-9a-f]{8})/;
const _pred = new Map();   // sid -> predecessor sid, or {missAt}
function predecessorOf(sid, now) {
  const hit = _pred.get(sid);
  if (typeof hit === "string") return hit;
  if (hit && now - hit.missAt < hit.ttl) return null;
  let found = null, settled = false;
  const t = transcriptPath(sid);
  if (t) {
    try {
      const fd = fs.openSync(t, "r");
      const buf = Buffer.alloc(Math.min(64 * 1024, fs.fstatSync(fd).size));
      try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
      const txt = buf.toString("utf8");
      // Patch 96: the handoff line lands ~1.5s after the successor starts. A miss read
      // before its first prompt is written is not a verdict, so it is retried in 3s.
      settled = txt.includes('"type":"user"');
      for (const ln of txt.split("\n")) {
        if (!ln.includes("Handed over from session")) continue;
        let o; try { o = JSON.parse(ln); } catch (_) { continue; }
        const a = o.type === "attachment" && o.attachment;
        const m = a && a.hookEvent === "SessionStart" && HANDOFF_RE.exec(JSON.stringify(a));
        if (!m) continue;
        const dir = path.dirname(t);
        const f = fs.readdirSync(dir).find((n) => n.startsWith(m[1]) && n.endsWith(".jsonl") && n !== sid + ".jsonl");
        if (f) found = f.slice(0, -6);
        break;
      }
    } catch (_) { /* unreadable -> treat as a miss */ }
  }
  _pred.set(sid, found || { missAt: now, ttl: settled ? 60000 : 3000 });
  return found;
}
// Earlier sessions of a chain, newest first. Real chains run long — 30 sessions was
// measured on 17 Sep — so the cap only guards against a runaway; `seen` stops loops.
const CHAIN_MAX = 200;
function chainOf(sid, now) {
  const out = [], seen = new Set([sid]);
  let cur = sid;
  while (out.length < CHAIN_MAX) {
    const p = predecessorOf(cur, now);
    if (!p || seen.has(p)) break;
    seen.add(p); out.push(p); cur = p;
  }
  return out;
}
function chainSpend(sid, now) {
  const own = sessionSpend(sid);
  const earlier = chainOf(sid, now);
  if (!own || !earlier.length) return null;
  let total = own.total, partial = !!own.partial;
  for (const p of earlier) {
    const s = settledSpend(p, now);
    if (!s) continue;
    total += s.total;
    if (s.partial) partial = true;
  }
  if (_spendCacheDirty && now - _spendCacheSaved > 30000) {
    try { writeJsonAtomic(SPEND_CACHE_FILE, spendCache()); _spendCacheDirty = false; _spendCacheSaved = now; }
    catch (_) { /* retried on a later tick */ }
  }
  return { total, sessions: earlier.length + 1, partial };
}
// Earlier sessions of a chain are finished, but one chain held 1.5 GB of logs — minutes of
// reading after every reload. Their totals are kept on disk, keyed by a fingerprint of
// their files (sizes + count), and their in-memory counters are dropped once settled.
let SPEND_CACHE_FILE = path.join(os.homedir(), ".claude", "overlord-spend-cache.json");
let _spendCache = null, _spendCacheDirty = false, _spendCacheSaved = 0;
function spendCache() {
  if (!_spendCache) {
    try { _spendCache = JSON.parse(fs.readFileSync(SPEND_CACHE_FILE, "utf8")); } catch (_) { _spendCache = {}; }
  }
  return _spendCache;
}
function sessionFiles(sid) {
  const t = transcriptPath(sid);
  if (!t) return [];
  const dir = path.join(path.dirname(t), sid, "subagents");
  let hs = [];
  try { hs = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(dir, f)); } catch (_) { /* none */ }
  return [t, ...hs];
}
// 16.8M / 3.35B — fmtTokens stops at "k", which reads badly at these sizes.
function fmtSpend(n) {
  n = Math.round(Number(n) || 0);
  if (n < 1000) return String(n);
  if (n < 1e6) return Math.round(n / 1000) + "k";
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + "M";
  return (n / 1e9).toFixed(2) + "B";
}
// What the card shows: one line of totals, a hover breakdown, per-step labels.
function spendView(sid, now) {
  const sp = sessionSpend(sid);
  if (!sp || !sp.total) return null;
  const ch = chainSpend(sid, now);
  const wait = (x) => x && x.partial ? " (counting…)" : "";
  const text = fmtSpend(sp.total) + " tokens" + wait(sp) +
    (ch ? " · chain " + fmtSpend(ch.total) + wait(ch) : "");
  const title = "Tokens this session (every run of it, helpers included)\n" +
    "fresh input " + fmtSpend(sp.input) + " · cache written " + fmtSpend(sp.cacheWrite) +
    " · cache re-read " + fmtSpend(sp.cacheRead) + " · output " + fmtSpend(sp.output) +
    "\nof which helpers " + fmtSpend(sp.helpers) + " · between task steps " + fmtSpend(sp.between) +
    (ch ? "\nHandoff chain: this session and the " + (ch.sessions - 1) + " before it" : "");
  const steps = {};
  for (const [id, t] of Object.entries(sp.tasks)) {
    if (t.tokens || t.helpers) steps[id] = fmtSpend(t.tokens) + (t.helpers ? " + helpers " + fmtSpend(t.helpers) : "");
  }
  return { text, title, steps };
}
function settledSpend(sid, now) {
  const files = sessionFiles(sid);
  let fp = files.length + ":";
  for (const f of files) { try { fp += fs.statSync(f).size + ","; } catch (_) { fp += "x,"; } }
  const hit = spendCache()[sid];
  if (hit && hit.fp === fp) return { total: hit.total };
  const s = sessionSpend(sid);
  if (s && !s.partial) {
    spendCache()[sid] = { fp, total: s.total, at: now };
    _spendCacheDirty = true;
    for (const f of files) _spend.delete(f);
  }
  return s;
}

// `claude -p "..."` / `--print` is the headless form. An interactive session's
// command line carries --resume or nothing at all.
function isBackgroundRun(s) {
  const cmd = _cmdCache.get(s.pid) || "";
  return /\s-p(\s|$)|\s--print(\s|$)/.test(cmd);
}

// Which live session's transcript LAUNCHED this run.
//
// ⛔ Mentioning the run's directory is not enough — a session that merely talks
// about a run (printing a test's output, writing about it) would adopt it, which
// is exactly what the first cut did: this very session stole two runs whose names
// it had only echoed. So the folder name must sit inside a window that also looks
// like a claude spawn: the word `claude` and a `-p` flag near the hit.
const SPAWN_WINDOW = 300;
function launchedHere(text, needle) {
  let i = text.indexOf(needle);
  while (i !== -1) {
    const w = text.slice(Math.max(0, i - SPAWN_WINDOW), i + needle.length + SPAWN_WINDOW);
    if (w.includes("claude") && /\s-p[\s"']|\s--print[\s"']/.test(w)) return true;
    i = text.indexOf(needle, i + needle.length);
  }
  return false;
}
function resolveParent(run, candidates) {
  const seg = String(run.cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  if (!seg || seg.length < 4) return null;      // too generic to match on
  const needle = seg.toLowerCase();
  for (const c of candidates) {
    const p = transcriptPath(c.sid);
    if (!p) continue;
    try {
      const fd = fs.openSync(p, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, RUN_SCAN_BYTES);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        if (launchedHere(buf.toString("utf8").toLowerCase(), needle)) return c.sid;
      } finally { fs.closeSync(fd); }
    } catch (_) { /* unreadable -> next candidate */ }
  }
  return null;
}

// A run's folder name ("run-0821-vare") says nothing about what it is doing. Its
// FIRST PROMPT does, and a headless run has exactly one — so that becomes the title,
// the same way a card is titled by what it is about rather than by its directory
// (the user, 2026-08-21: "make the runs titles for each always human readable").
// Read from the HEAD of the transcript, cached: a run's first prompt never changes.
const RUN_TITLE_MAX = 58;
const _runTitle = new Map();
function runTitle(sid, fallback) {
  if (_runTitle.has(sid)) return _runTitle.get(sid) || fallback;
  let title = "";
  try {
    const p = transcriptPath(sid);
    if (p) {
      const fd = fs.openSync(p, "r");
      try {
        const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 128 * 1024));
        fs.readSync(fd, buf, 0, buf.length, 0);
        for (const line of buf.toString("utf8").split("\n")) {
          let r; try { r = JSON.parse(line); } catch (_) { continue; }
          if (!r || r.type !== "user") continue;
          let c = r.message && r.message.content;
          if (Array.isArray(c)) c = c.map((b) => (b && b.text) || "").join(" ");
          c = String(c || "").replace(/\s+/g, " ").trim();
          // Skip harness-injected openers (system reminders, resumed context).
          if (!c || c.startsWith("<")) continue;
          title = c.length > RUN_TITLE_MAX ? c.slice(0, RUN_TITLE_MAX - 1) + "…" : c;
          break;
        }
      } finally { fs.closeSync(fd); }
    }
  } catch (_) { /* unreadable -> fall back to the folder name */ }
  // Only cache a hit: a transcript that has not been flushed yet resolves later.
  if (title) _runTitle.set(sid, title);
  return title || fallback;
}

// Runs that have EXITED. Without this the count in the header is meaningless — a
// finished run simply vanishes from the session feed, so "1/3" could never be
// reached. Kept for the life of the window, dim and motionless on the card.
const _runHist = new Map();   // parent sid -> Map(run sid -> row)

// Moves resolved runs onto their launcher as `runs[]` and drops them from the list.
function nestRuns(list) {
  // Patch 96: a new pid whose command line is not read yet may be a run, and showing it
  // for that tick is the flash of a card per walker. Held back until the sweep answers
  // (~1s); the very first sweep after a reload is exempt, so the board never starts blank.
  if (_procsAt) list = list.filter((s) => s.dormant || !s.pid || _cmdCache.has(s.pid));
  const runs = list.filter((s) => !s.dormant && isBackgroundRun(s));
  // Remember the verdict NOW: this is the only moment the run has a live pid, and so
  // the only moment its command line can prove it headless. Recorded whether or not a
  // parent resolves -- an unresolved run still keeps its own card this run (the
  // fail-safe below), but it must not come back as a dormant one after a restart.
  if (runs.length) {
    let added = false;
    for (const r of runs) if (!bgRunSids[r.sid]) { bgRunSids[r.sid] = { at: Date.now() }; added = true; }
    if (added && gState) gState.update("bgRunSids", bgRunSids);
  }
  if (!runs.length) return list;
  const isRun = new Set(runs.map((s) => s.sid));
  const parents = list.filter((s) => !isRun.has(s.sid));
  const byId = new Map(parents.map((s) => [s.sid, s]));
  const nested = new Set();
  askEnvParents(runs);
  for (const r of runs) {
    let e = _parentOf.get(r.sid);
    const envP = _envParent.get(r.sid);
    if (envP && (!e || e.parent !== envP)) {
      e = { parent: envP, tries: 0 };
      _parentOf.set(r.sid, e);
    } else if (!e || (e.parent === null && e.tries < RUN_RETRIES)) {
      e = { parent: resolveParent(r, parents), tries: (e ? e.tries : 0) + 1 };
      _parentOf.set(r.sid, e);
    }
    // Patch 93: a launcher that has since handed off lives on as its successor's card —
    // the walk chain of 22 Oct was started by 7c01e4fd, which handed off to 3f056075.
    const p = e.parent && (parents.find((c) => c.sid !== e.parent && chainOf(c.sid, Date.now()).includes(e.parent)) || byId.get(e.parent));
    if (!p) {
      // Patch 93: no own card while its parent is being read. Patch 96: nor once the
      // environment has named a parent that has no card yet (a launcher mid-handoff) —
      // only a run with no parent anywhere gets a card of its own.
      if (envP !== null) nested.add(r.sid);
      continue;
    }
    const title = runTitle(r.sid, r.name);
    const row = { sid: r.sid, name: title, state: r.state, meta: r.metaLine, done: false };
    (p.bgRuns || (p.bgRuns = [])).push(row);
    if (!_runHist.has(p.sid)) _runHist.set(p.sid, new Map());
    _runHist.get(p.sid).set(r.sid, row);
    runNames.set(r.sid, title);
    nested.add(r.sid);
  }
  // Fold in the ones that have since exited, so the header count means something.
  for (const p of parents) {
    const hist = _runHist.get(p.sid);
    if (!hist) continue;
    const live = new Set((p.bgRuns || []).map((r) => r.sid));
    for (const [sid, row] of hist) {
      if (live.has(sid)) continue;
      row.done = true; row.state = "idle"; row.meta = "finished";
      (p.bgRuns || (p.bgRuns = [])).push(row);
    }
  }
  // Patch 94 (the user, 2026-10-22): a working run keeps its launcher under Working, like
  // any other background job. The worker count never sees a detached run, and a card
  // that ended on a question skips the task scan, so it fell into Needs you mid-run.
  for (const p of parents) {
    const n = (p.bgRuns || []).filter((r) => !r.done && r.state === "working").length;
    if (n && !p.running && !p.dormant && p.state !== "done") { p.running = true; p.runText = n + " run" + (n > 1 ? "s" : ""); }
  }
  return nested.size ? list.filter((s) => !nested.has(s.sid)) : list;
}

// Dead-session sweep: `claude agents --json` can keep reporting a session whose
// process has already exited (ghost card until the supervisor catches up).
// process.kill(pid, 0) is a pure existence probe — ESRCH means gone. EPERM
// means alive-but-protected, so only ESRCH counts as dead.
function isDeadAgent(a) {
  const pid = Number(a && a.pid);
  if (!pid) return false;                 // no pid -> can't verify, keep it
  try { process.kill(pid, 0); return false; }
  catch (e) { return !!e && e.code === "ESRCH"; }
}

// "Projects/MyVault" from the full cwd — the last two path
// segments give enough context to tell same-named sessions apart on the card.
function shortCwd(cwd) {
  const parts = String(cwd || "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

// ---- active auto-loops -> per-card LOOP badge --------------------------------
// The hands-off loop system (hooks/loop_common.py) keeps a registry of active
// poll/grind loops keyed by session_id. When a card's session owns an ACTIVE
// loop we show a live badge at the foot of the card, mirroring the Claude Code
// loop statusline: ● ⠿ LOOP <slug> · <detail>. Read is mtime-cached (the file
// is tiny but buildSessions runs every poll tick), fail-open on any error.
const DEFAULT_LOOP_REGISTRY =
  wsPath("_temp", "active-loops.json");
let _loopCache = { mtime: 0, map: {} };
function loopSlug(id) {
  // id shape: loop-YYYY-MM-DD-HHMM-slug(-with-dashes) -> everything after the 5th "-"
  const p = String(id || "").split("-");
  return p.length > 5 ? p.slice(5).join("-") : (id || "loop");
}
function loopHhmm(stamp) {
  return stamp && stamp.indexOf("T") >= 0 ? stamp.split("T")[1].slice(0, 5) : "";
}
function loopBadgeText(loop) {
  const parts = [];
  const nxt = loopHhmm(loop.next_wake); if (nxt) parts.push("next " + nxt);
  const iters = parseInt(loop.iterations || 0, 10) || 0;
  if (loop.unlimited) {
    parts.push("check " + iters);
    if (loop.cadence_min) parts.push("every " + loop.cadence_min + "m");
  } else {
    const cap = parseInt(loop.max_iterations || 15, 10) || 15;
    parts.push(iters + "/" + cap);
    const exp = loopHhmm(loop.expires); if (exp) parts.push("exp " + exp);
  }
  const slug = loopSlug(loop.id);
  return slug + (parts.length ? " · " + parts.join(" · ") : "");
}
function readLoopMap() {
  const p = cfg().get("loopRegistry") || DEFAULT_LOOP_REGISTRY;
  let st; try { st = fs.statSync(p); } catch (_) { _loopCache = { mtime: 0, map: {} }; return _loopCache.map; }
  if (st.mtimeMs === _loopCache.mtime) return _loopCache.map;
  const map = {};
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const l of (data.loops || [])) {
      if (!l || l.status !== "active" || !l.session_id) continue;
      const sid = l.session_id;
      if (map[sid]) { map[sid]._n = (map[sid]._n || 1) + 1; continue; }  // keep first, count extras
      map[sid] = { text: loopBadgeText(l), _n: 1 };
    }
    for (const sid in map) { if (map[sid]._n > 1) map[sid].text += " (+" + (map[sid]._n - 1) + ")"; }
  } catch (_) { /* malformed registry -> no badges this tick */ }
  _loopCache = { mtime: st.mtimeMs, map };
  return map;
}

// ---- Plan-board task panel (patch 38a) --------------------------------------
// Claude Code's native Tasks persist at ~/.claude/tasks/<listId>/<n>.json
// (research 2026-08-12, _temp/research/2026-08-12-plan-board.md). listId is the
// session uuid for solo sessions, or the team name (session-<first8>) when
// subagents are in play — resolved via ~/.claude/teams/<name>/config.json
// leadSessionId. Reads are polled like everything else here: per-dir
// mtime-aggregate cache, fail-open on every path, no watcher. Harness writes
// are NOT atomic — a torn file is skipped this tick and heals on the next.
const DEFAULT_TASKS_ROOT = path.join(os.homedir(), ".claude", "tasks");
const TEAMS_ROOT = path.join(os.homedir(), ".claude", "teams");
const DEFAULT_PLAN_GATE_FILE =
  wsPath("_temp", "plan-gate.json");
const TASK_ARCHIVE_FILE =
  wsPath("_temp", "task-archive.json");
function loadTaskArchive() {
  try {
    const d = JSON.parse(fs.readFileSync(TASK_ARCHIVE_FILE, "utf8"));
    if (d && typeof d === "object") taskArchive = d;
  } catch (_) { /* first run / unreadable -> start empty */ }
}
let _teamScan = { at: 0, bySid: {} };          // leadSessionId -> sanitized team dir name
const _taskDirCache = new Map();               // dir -> { key, items }
let _gateCache = { mtime: 0, sids: {} };       // plan-gate.json sessions map

function taskSan(id) { return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "-"); }

function teamDirFor(sid) {
  const now = Date.now();
  if (now - _teamScan.at > 30000) {            // teams change rarely; rescan every 30s
    const bySid = {};
    try {
      for (const t of fs.readdirSync(TEAMS_ROOT)) {
        try {
          const c = JSON.parse(fs.readFileSync(path.join(TEAMS_ROOT, t, "config.json"), "utf8"));
          if (c && c.leadSessionId) bySid[c.leadSessionId] = taskSan(t);
        } catch (_) { /* not a team dir */ }
      }
    } catch (_) { /* no teams root */ }
    _teamScan = { at: now, bySid };
  }
  return _teamScan.bySid[sid] || "";
}

function readGateFlags() {
  const p = cfg().get("planGateFile") || DEFAULT_PLAN_GATE_FILE;
  let st; try { st = fs.statSync(p); } catch (_) { _gateCache = { mtime: 0, sids: {} }; return _gateCache.sids; }
  if (st.mtimeMs === _gateCache.mtime) return _gateCache.sids;
  let sids = {};
  try { sids = JSON.parse(fs.readFileSync(p, "utf8")).sessions || {}; } catch (_) { sids = {}; }
  _gateCache = { mtime: st.mtimeMs, sids };
  return sids;
}

function readTaskPanel(sid, lastPromptAtMs) {
  // Aggregate tasks across the session's candidate dirs (solo uuid + team name).
  const root = cfg().get("taskRegistry") || DEFAULT_TASKS_ROOT;
  // Candidates: solo uuid + deterministic "session-<first8>" + team config. The
  // deterministic fallback exists because the harness DELETES a team's config.json
  // when its agents finish (live finding 2026-08-12) — config lookup alone nulled
  // the panel for the very session that built it. Shared with write-back (38b).
  const names = taskDirNamesFor(sid);
  const items = [];
  for (const n of names) {
    const dir = path.join(root, n);
    let files; try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch (_) { continue; }
    if (!files.length) continue;
    // Cache key = every task file's name+mtime — any harness write bumps it.
    const stats = [], mtimes = {};
    for (const f of files) {
      try { const ms = fs.statSync(path.join(dir, f)).mtimeMs; mtimes[f] = ms; stats.push(f + ":" + ms); } catch (_) {}
    }
    const key = stats.sort().join(",");
    const hit = _taskDirCache.get(dir);
    if (hit && hit.key === key) { items.push(...hit.items); continue; }
    const parsed = [];
    for (const f of files) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        if (!t || typeof t !== "object" || !t.subject || !t.status) continue;  // torn write
        parsed.push({
          id: String(t.id || f.replace(".json", "")),
          dir: n,   // dir NAME (not path) — routes write-back (patch 38b) to the right file
          subject: String(t.subject).slice(0, 160),
          status: t.status,
          skipped: !!(t.metadata && t.metadata.skipped),
          reason: t.metadata && t.metadata.skip_reason ? String(t.metadata.skip_reason).slice(0, 200) : "",
          blocked: Array.isArray(t.blockedBy) && t.blockedBy.length > 0,
          // Live-activity fields (patch 38c): activeForm is the harness's own
          // present-continuous label; metadata.sub is the plan-layer convention
          // for the CURRENT SUB-STEP, updated by the model as it works.
          active: t.activeForm ? String(t.activeForm).slice(0, 120) : "",
          sub: t.metadata && t.metadata.sub ? String(t.metadata.sub).slice(0, 160) : "",
          // Evidence (patch 38e): one line of what proves this step is actually
          // done. Absent = the tick is self-graded and nothing backs it, which
          // the panel now says out loud instead of showing a clean green row.
          evidence: t.metadata && t.metadata.evidence ? String(t.metadata.evidence).slice(0, 200) : "",
          // File mtime drives staleness (patch 38e). Derived from the filesystem
          // rather than a model-written timestamp on purpose: a model that stops
          // updating its sub-step also stops writing the timestamp, so a
          // self-reported clock can never detect the case it exists to detect.
          mtime: mtimes[f] || 0,
        });
      } catch (_) { /* torn/invalid — next tick heals */ }
    }
    _taskDirCache.set(dir, { key, items: parsed });
    items.push(...parsed);
  }
  const gate = readGateFlags()[sid] || {};
  const optOut = !!gate.opt_out;
  // Session GOAL (patch 38e). Lives in the plan-gate flag file, not in a task
  // file: it is one per session, outlives any individual list, and both the
  // hooks and this panel already read that file. Never auto-edited — the whole
  // point is that it says what was asked for at the start, not what the run
  // has since become.
  const goal = gate.goal ? String(gate.goal).slice(0, 240) : "";
  items.sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0));
  const done = items.filter((t) => t.status === "completed").length;

  // History archive (patch 38d): the harness DELETES a list's files once every
  // task is completed, which would blank an all-green stepper the moment it
  // finishes. Snapshot every live read; when the files are gone, serve the last
  // snapshot read-only. A finished snapshot rolls into `runs` when a NEW list
  // (disjoint id/subject set) starts — so history stacks across processes.
  const arch = taskArchive[sid] || (taskArchive[sid] = { latest: null, runs: [] });
  const persist = () => { if (!TASK_ARCHIVE_FILE) return; try { writeJsonAtomic(TASK_ARCHIVE_FILE, taskArchive); } catch (_) {} };
  if (items.length) {
    const L = arch.latest;
    if (L && L.done === L.total && L.total > 0 &&
        !items.some((t) => L.items.some((o) => o.id === t.id && o.subject === t.subject))) {
      arch.runs.push(L); while (arch.runs.length > 3) arch.runs.shift();   // new process began
      arch.times = {};                                                     // ids restart at 1
    }
    // Per-step elapsed (patch 38e). Task files carry no timestamps, so the board
    // stamps the transitions it observes and persists them beside the archive.
    // A step whose START was never seen (extension restarted mid-run) reports NO
    // duration rather than a wrong one.
    const times = arch.times || (arch.times = {});
    const nowMs = Date.now();
    let timesDirty = false;
    for (const t of items) {
      const tr = times[t.id] || (times[t.id] = {});
      if (t.status === "in_progress" && !tr.s) { tr.s = nowMs; timesDirty = true; }
      if (t.status === "completed") { if (!tr.e) { tr.e = nowMs; timesDirty = true; } }
      else if (tr.e) { delete tr.e; timesDirty = true; }                   // un-completed on the board
      const span = (tr.s && tr.e) ? tr.e - tr.s
                 : (tr.s && t.status === "in_progress") ? nowMs - tr.s : 0;
      // Minute granularity on purpose: a second-by-second value would bust the
      // webview's repaint key on every 2.5s poll.
      t.el = fmtSpan(span);
      // Staleness (patch 38e) — only meaningful for the step claiming to be live.
      if (t.status === "in_progress") {
        const age = Math.floor((nowMs - (t.mtime || nowMs)) / 60000);
        if (age >= 10) t.ageMin = age;                                     // below 10m: not worth saying
      }
    }
    if (timesDirty) persist();
    const stalledMin = items.reduce((m, t) =>
      (t.status === "in_progress" && t.ageMin >= 30 && t.ageMin > m) ? t.ageMin : m, 0);
    const unevidenced = items.filter((t) =>
      t.status === "completed" && !t.skipped && !t.evidence).length;
    const snap = { stamp: localStamp(), done, total: items.length, items };
    if (!arch.latest || JSON.stringify(arch.latest.items) !== JSON.stringify(items) || arch.latest.done !== done) {
      arch.latest = snap; persist();
    }
    return { total: items.length, done, optOut, goal, items, runs: arch.runs,
             unevidenced, stalledMin };
  }
  if (arch.latest) {   // files pruned (or list not started) — serve the archive
    // A prompt newer than the finished snapshot means the session is on new work
    // its list never described (patch 61, 2026-09-14: "4/4 finished 12:05" shown
    // through two hours of banner work). Said on the card, not left to be inferred.
    const newWork = !!(lastPromptAtMs && arch.latest.stamp && Date.parse(arch.latest.stamp) < lastPromptAtMs);
    return { total: arch.latest.total, done: arch.latest.done, optOut, goal, newWork,
             items: arch.latest.items, archived: true, stamp: arch.latest.stamp, runs: arch.runs,
             unevidenced: arch.latest.items.filter((t) =>
               t.status === "completed" && !t.skipped && !t.evidence).length };
  }
  if (optOut) return { total: 0, done: 0, optOut, goal, items: [], runs: arch.runs };
  // NO LIST (patch 38e). Previously this returned null and the panel simply
  // vanished — so the commonest state (measured: 8 of 32 sessions ever held a
  // list) was rendered as silence. Show it instead, but only once the nudge hook
  // has judged this session non-trivial, so trivial cards stay clean.
  if (goal || gate.nudged) {
    return { total: 0, done: 0, optOut, goal, items: [], runs: arch.runs, noPlan: true };
  }
  return null;
}

// "" under a minute, "7m" under an hour, "1h20" beyond. Minute granularity keeps
// the webview repaint key stable between ticks.
function fmtSpan(ms) {
  if (!ms || ms < 60000) return "";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + "m";
  return Math.floor(mins / 60) + "h" + String(mins % 60).padStart(2, "0");
}

// ---- Plan-board write-back (patch 38b) --------------------------------------
// Board edits write the SAME native task files the harness owns. The harness
// re-reads uncached on every TaskList/TaskGet, so external edits are picked up
// (verified live 2026-08-12). Our writes are tmp+rename (atomic-ish — better
// than the harness's own writer); last-writer-wins inside the tiny race window
// is accepted by design (plan §NOT-doing). Never touches the session terminal.
function localStamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
         "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function writeJsonAtomic(p, obj) {
  const tmp = p + ".ov-tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function taskRoot() { return cfg().get("taskRegistry") || DEFAULT_TASKS_ROOT; }

// Toggle: pending/in_progress -> completed; completed -> pending (clearing any
// skip marker — un-completing a skipped task revives it as real scope).
function applyTaskToggle(root, dirName, id) {
  const p = path.join(root, taskSan(dirName), String(parseInt(id, 10)) + ".json");
  const t = JSON.parse(fs.readFileSync(p, "utf8"));
  if (t.status === "completed") {
    t.status = "pending";
    if (t.metadata) { delete t.metadata.skipped; delete t.metadata.skip_reason; }
  } else t.status = "completed";
  writeJsonAtomic(p, t);
  _taskDirCache.delete(path.join(root, taskSan(dirName)));
  return t;
}

// Skip = the gate's escape hatch, from the board: completed + visible reason.
function applyTaskSkip(root, dirName, id, reason) {
  const p = path.join(root, taskSan(dirName), String(parseInt(id, 10)) + ".json");
  const t = JSON.parse(fs.readFileSync(p, "utf8"));
  t.status = "completed";
  t.metadata = Object.assign({}, t.metadata,
    { skipped: true, skip_reason: String(reason || "skipped from board").slice(0, 200) });
  writeJsonAtomic(p, t);
  _taskDirCache.delete(path.join(root, taskSan(dirName)));
  return t;
}

// Add into the dir that currently holds this session's tasks (first candidate
// with files). No list yet -> no-op: dir NAMING is the harness's call (solo uuid
// vs team), and guessing wrong creates a list it will never read.
function applyTaskAdd(root, dirNames, subject) {
  for (const n of dirNames) {
    const dir = path.join(root, taskSan(n));
    let files; try { files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)); } catch (_) { continue; }
    if (!files.length) continue;
    let hw = 0; try { hw = parseInt(fs.readFileSync(path.join(dir, ".highwatermark"), "utf8"), 10) || 0; } catch (_) {}
    for (const f of files) hw = Math.max(hw, parseInt(f, 10) || 0);
    const id = String(hw + 1);
    writeJsonAtomic(path.join(dir, id + ".json"), {
      id, subject: String(subject || "").slice(0, 200).trim() || "(untitled)",
      description: "(added from the Overlord board " + localStamp() + ")",
      status: "pending", blocks: [], blockedBy: [],
    });
    try { fs.writeFileSync(path.join(dir, ".highwatermark"), id); } catch (_) {}
    _taskDirCache.delete(dir);
    return id;
  }
  return null;
}

// Evidence write-back (patch 38e): attach one line of what proves a step is done.
// Same file the harness owns, same metadata bag as skip_reason, so the model sees
// whatever the user types here on its next TaskGet.
function applyTaskEvidence(root, dirName, id, text) {
  const p = path.join(root, taskSan(dirName), String(parseInt(id, 10)) + ".json");
  const t = JSON.parse(fs.readFileSync(p, "utf8"));
  t.metadata = Object.assign({}, t.metadata, { evidence: String(text || "").slice(0, 200) });
  writeJsonAtomic(p, t);
  _taskDirCache.delete(path.join(root, taskSan(dirName)));
  return t;
}

// Session-goal write-back (patch 38e). Read-modify-write of the plan-gate flag
// file, which the Python hooks also own; both sides write via a temp + rename,
// and the file is touched rarely enough that a lost update is a non-event (the
// goal is re-typed, not recomputed). Busts the mtime cache so the next poll
// re-reads rather than serving the pre-write value.
function applySessionGoal(sid, text) {
  const p = cfg().get("planGateFile") || DEFAULT_PLAN_GATE_FILE;
  let data = {};
  try { data = JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { data = {}; }
  if (!data || typeof data !== "object") data = {};
  if (!data.sessions || typeof data.sessions !== "object") data.sessions = {};
  const e = data.sessions[sid] || (data.sessions[sid] = {});
  const g = String(text || "").slice(0, 240).trim();
  if (g) e.goal = g; else delete e.goal;
  e.stamped = localStamp();
  writeJsonAtomic(p, data);
  _gateCache = { mtime: 0, sids: {} };
  return g;
}

// Session opt-out flip. The FILE is authoritative — the plan-gate Stop hook
// reads it; the panel's ⛔ badge follows on the next tick (gate cache busted).
function applyPlanGateToggle(file, sid) {
  let data; try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { data = {}; }
  if (!data || typeof data !== "object") data = {};
  if (!data.sessions || typeof data.sessions !== "object") data.sessions = {};
  const cur = data.sessions[sid] || {};
  cur.opt_out = !cur.opt_out;
  cur.reason = cur.opt_out ? "Overlord board toggle" : "";
  cur.stamped = localStamp();
  data.sessions[sid] = cur;
  writeJsonAtomic(file, data);
  _gateCache = { mtime: 0, sids: {} };
  return cur.opt_out;
}

function taskDirNamesFor(sid) {
  const names = [taskSan(sid)];
  if (sid && sid.length >= 8) {
    const p = "session-" + taskSan(String(sid).slice(0, 8));
    if (names.indexOf(p) < 0) names.push(p);
  }
  const team = teamDirFor(sid); if (team && names.indexOf(team) < 0) names.push(team);
  // Breadcrumb (3rd live finding 2026-08-12): the harness's internal session id
  // can drift from the external one (resume/compaction) and land the list in a
  // dir no derivation from `sid` reaches. The model writes the mapping into the
  // plan-gate flag file (task_dir) when it discovers it; honor it here too.
  const crumb = (readGateFlags()[sid] || {}).task_dir;
  if (crumb && names.indexOf(taskSan(crumb)) < 0) names.push(taskSan(crumb));
  return names;
}

// djb2 over the card's last message -> a short stable id for "this turn".
function hashKey(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Snapshot entries whose session isn't currently live -> dormant pseudo-records.
// The stored last status routes the tab: busy(working)->cutoff, waiting->needs,
// else idle. Carries _dormant so toSession dims it + resumes on click.
//
// ⛔ A dormant card whose TRANSCRIPT IS GONE is a card that lies: its only
// affordance is "click to resume", and `claude --resume <sid>` cannot resume a
// session with nothing on disk. Measured 2026-09-24 on the user's board: 172 of the
// 200 cards had no transcript -- all 39 handoff successors, all 43 headless
// helpers, and 90 others -- leaving 28 real sessions buried under them. He asked
// whether they belonged in Done; they belong nowhere. Done means "I finished with
// this", and parking 172 unresumable cards would only relabel the mess.
// A PARKED card is exempt: putting it in Done was a deliberate act of the user's, and
// this rule never overrides one of those.
// Dropping them here is self-cleaning -- snapshotBoard rebuilds from `sessions`,
// so a card skipped here also leaves boardSnapshot on the same tick.
// Codex entries are codexCards' to restore (patch 80): through here they became
// Claude cards that could only `claude --resume` a GPT session.
function dormantAgents(liveSids) {
  const out = [];
  for (const sid in boardSnapshot) {
    if (liveSids.has(sid) || !(restoreSet.has(sid) || closedParked.has(sid))) continue;
    if (isCodexSnap(sid)) continue;
    if (!parked[sid] && !hasTranscript(sid)) continue;
    const snap = boardSnapshot[sid];
    const ds = snap.status === "busy" ? "cutoff" : snap.status === "waiting" ? "needs" : "idle";
    out.push({ sessionId: sid, cwd: snap.cwd || "", name: snap.name || "",
               startedAt: snap.startedAt || 0, _dormant: true, _dormantState: ds });
  }
  return out;
}

// Patch 80: which half a snapshot entry belongs to -- its tag says so, or a Codex
// rollout carries the sid. The rollout check covers entries written before patch 80
// (no tag: the 54 Codex cards that had leaked into the Claude half, 2026-10-01), and
// one mis-tagged on a tick when the Codex scan came back short heals the next tick.
function isCodexSnap(sid) {
  const snap = boardSnapshot[sid];
  return !!snap && (snap.agent === "codex" || X.isCodexSid(sid));
}

// Does this sid still have a transcript on disk? transcriptPath() deliberately
// caches only HITS, so that a transcript created after the first look still
// resolves -- which means every MISS re-walks ~/.claude/projects. With 172 missing
// sids on a 2.5s poll that is a directory walk a second. Re-check a miss on a TTL:
// long enough to cost nothing, short enough that a session which starts writing is
// picked up within the minute.
const MISS_TTL_MS = 60000;
const _noTranscript = new Map();   // sid -> ms of the last look that found nothing
function hasTranscript(sid) {
  const at = _noTranscript.get(sid);
  const now = Date.now();
  if (at !== undefined && now - at < MISS_TTL_MS) return false;
  if (transcriptPath(sid)) { _noTranscript.delete(sid); return true; }
  _noTranscript.set(sid, now);
  return false;
}

// Last real activity for a session: the transcript is appended on every turn, so
// its mtime is the honest "when did anything happen here". Falls back to the
// session's start time when the file is gone, which sorts it oldest — the right
// answer for a session with nothing left on disk.
function lastActivityMs(sid, snap) {
  // A Codex card's activity is its rollout's last event, carried on the entry (patch 80).
  if (snap && snap.agent === "codex") return snap.touchedAt || snap.startedAt || 0;
  try {
    const p = transcriptPath(sid);
    if (p) return fs.statSync(p).mtimeMs;
  } catch (_) { /* unreadable → fall back to start time */ }
  return (snap && snap.startedAt) || 0;
}

// Rolling retention: the board keeps at most BOARD_CAP sessions across restarts.
// Over the cap, the least-recently-ACTIVE cards are dropped one at a time — 201
// evicts one, 202 evicts two. EVERY dormant card is eligible (the user, 2026-09-24),
// least-recently-active first. Live cards are never touched — evicting one wouldn't
// shrink the board anyway, since it reappears from `claude agents --json` next tick.
//
// Until 2026-09-24 only dormant cards that were ALSO parked-Done could be evicted,
// which made the cap unenforceable in the one case that matters: snapshotBoard
// rebuilds from `sessions`, and `sessions` already contains the dormant cards
// restored from the PREVIOUS snapshot — so every session ever seen re-added itself
// forever and the board sat pinned at exactly 200 against 4 live sessions. Parking
// is a statement about your attention, not about retention; it should not be the
// thing standing between the board and its own ceiling.
// Patch 80: Claude and Codex are capped SEPARATELY, 200 each (the user, 2026-10-01), so a
// burst of Codex sessions cannot push Claude cards off the board, or the reverse.
const BOARD_CAP = 200;
// How long a sid stays on the known-headless list. Well past any run's life, and
// past `claude agents --json`'s own memory of it, so the set stays bounded without
// ever forgetting a run that could still come back as a card.
const BG_RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let _bgPruneAt = 0;
function evictOverCap(next, evictable) {
  let parkedChanged = false;
  for (const agent of ["claude", "codex"]) {
    const over = Object.keys(next).filter((sid) => next[sid].agent === agent).length - BOARD_CAP;
    const mine = evictable.filter((sid) => next[sid] && next[sid].agent === agent);   // the claude pass deletes
    if (over <= 0 || !mine.length) continue;               // common case: no stat() calls at all
    const byAge = mine
      .map((sid) => ({ sid, at: lastActivityMs(sid, next[sid]) }))
      .sort((a, b) => a.at - b.at);
    for (const { sid } of byAge.slice(0, over)) {
      delete next[sid];
      // `parked` is what puts a card in Done; leaving its entry behind would keep the
      // map growing forever now that Done entries survive restarts.
      if (parked[sid]) { delete parked[sid]; parkedChanged = true; }
    }
  }
  if (parkedChanged && gState) gState.update("parked", parked);
}

// Record the board so it can be restored after a Cursor restart. REBUILT from the
// current cards each tick, so sessions that left the board (closed) drop out and
// won't restore. Live, dormant AND parked-Done cards are all kept — Done used to be
// discarded here, which is why the tab emptied itself on every restart (changed
// 2026-08-25; retention is now the BOARD_CAP rolling window instead). For a dormant
// card we store the status that reproduces its tab next launch (cutoff→busy,
// needs→waiting, else idle); live cards store their raw status. Persist is
// throttled but forced when the sid set changes (and on quit).
function snapshotBoard(sessions, now) {
  const next = {};
  const evictable = [];
  for (const s of sessions) {
    // A headless run is not board content to restore: it cannot be resumed usefully,
    // and it already shows inside its launcher's card for the life of the window.
    // Skipping it here is what stops it becoming a permanent anonymous dormant card.
    if (bgRunSids[s.sid]) continue;
    // Patch 80: every entry says which half it belongs to. A Codex row has no `raw`
    // status, so its own state is mapped the same way a dormant card's is.
    const codex = s.agent === "codex";
    // Patch 92: a live card whose turn is over but whose helpers/background jobs still
    // run has `raw` masked to idle (maskFinishedTurns) and maybe promoted to waiting.
    // Saved as-is, a restart that kills those helpers restored it to Needs you / Idle
    // instead of Cut off. Store "busy" unless a native dialog (permission prompt) holds
    // it. Not the judge's "blocking": it reads "I'll show you the plan to approve when
    // the draft is back" as blocking, which is a promise waiting on a helper, not on the user.
    const helpersLive = !s.dormant && !codex && (s.bg || s.running) && !s.native;
    const status = (s.dormant || codex) ? (s.state === "cutoff" || s.state === "working" ? "busy" : s.state === "needs" ? "waiting" : "idle") : helpersLive ? "busy" : s.raw;
    next[s.sid] = { name: s.name, cwd: s.cwd, status, startedAt: s.started || 0, ts: now, agent: codex ? "codex" : "claude" };
    if (codex) next[s.sid].touchedAt = s.touchedAt || 0;
    if (s.dormant && !pinned.includes(s.sid)) evictable.push(s.sid);   // patch 86: a pin is never evicted
  }
  evictOverCap(next, evictable);
  boardSnapshot = next;
  // A parked sid whose card has LEFT the board is unreachable by every other path:
  // un-parking only happens on `busy` (the session is gone, so it never goes busy),
  // and evictOverCap only runs past BOARD_CAP. So its entry sat in `parked` forever —
  // the map had grown to 298 entries against a 51-card board when this was added
  // (2026-09-03). Prune whatever the freshly rebuilt snapshot no longer knows about.
  // Guarded on a non-empty tick: `sessions` is briefly empty when the agent list is
  // unavailable, and pruning then would wipe every legitimate park in one go.
  if (sessions.length) {
    let pruned = 0;
    for (const sid in parked) if (!next[sid]) { delete parked[sid]; pruned++; }
    if (pruned && gState) gState.update("parked", parked);
    // Same for pins (patch 86): a pinned card that left the board frees its slot.
    const keep = pinned.filter((sid) => next[sid]);
    if (keep.length !== pinned.length) { pinned = keep; if (gState) gState.update("pinned", pinned); }
  }
  // bgRunSids cannot be pruned against `next` the way `parked` is — these sids are
  // deliberately absent from it, so that test would empty the set every tick and
  // undo the fix. Bound it by age instead: a run older than BG_RUN_TTL_MS is long
  // gone from `claude agents --json`, so forgetting it cannot resurrect a card.
  if (now - _bgPruneAt > 3600000) {
    _bgPruneAt = now;
    let dropped = 0;
    for (const sid in bgRunSids) {
      const at = (bgRunSids[sid] && bgRunSids[sid].at) || 0;
      if (now - at > BG_RUN_TTL_MS) { delete bgRunSids[sid]; dropped++; }
    }
    if (dropped && gState) gState.update("bgRunSids", bgRunSids);
  }
  // Signature includes each session's status, so a status change (e.g. busy→idle)
  // persists promptly — otherwise a hard crash within 20s could restore a finished
  // session as an orange "cutoff" card. Still only writes on a real change.
  const sig = Object.keys(next).sort().map((sid) => sid + ":" + next[sid].status).join(",");
  if (gState && (sig !== _snapSig || now - _snapAt > 20000)) { _snapSig = sig; _snapAt = now; gState.update("boardSnapshot", boardSnapshot); }
}

// `claude agents --json` can report the SAME sessionId twice — seen when an
// external resume (e.g. a session-picker's "--resume <sid>") is fired against a
// sessionId that already has a live process, instead of attaching to it. Two
// records for one sid used to flow all the way to the webview, which counts
// tab badges by iterating the raw list — so one session showed simultaneously
// in Idle AND Working (2026-07-21). Dedupe to the more "active" record so a
// needs-you/working state is never masked by a stale idle duplicate.
const STATUS_RANK = { waiting: 0, busy: 1, idle: 2 };
function dedupeBySid(agents) {
  const bestBySid = new Map();
  for (const a of agents) {
    const prev = bestBySid.get(a.sessionId);
    if (!prev || (STATUS_RANK[a.status] ?? 3) < (STATUS_RANK[prev.status] ?? 3)) bestBySid.set(a.sessionId, a);
  }
  return Array.from(bestBySid.values());
}

function buildSessions(agents, now, meta, noCodex) {
  const loopMap = readLoopMap();
  agents = dedupeBySid(agents);
  // Inject dormant (restored) sessions: snapshot entries not present in the live set.
  const liveSids = new Set(agents.map((a) => a.sessionId));
  // Codex first (patch 80): its scan is what lets dormantAgents tell an untagged
  // Codex entry from a Claude one.
  const codexRows = noCodex ? [] : codexCards(now);
  agents = agents.concat(dormantAgents(liveSids));
  refreshCmdlines(agents.map((a) => a.pid), now);
  const claudeRows = nestRuns(agents
    .filter((a) => a._dormant || (!isNoiseAgent(a) && !isDeadAgent(a)))
    .map((a) => {
      const m = (meta && meta[a.sessionId]) || {};
      // startedAt arrives as epoch ms (number) from `claude agents --json`; older
      // builds sent an ISO string — accept both, else uptime is NaN and never shows.
      const started = typeof a.startedAt === "number" ? a.startedAt
                    : a.startedAt ? Date.parse(a.startedAt) : 0;
      const s = A.toSession(a, {
        nowMs: now,
        termName: termNames.get(a.sessionId),
        statusSinceMs: statusSince[a.sessionId],
        startedAtMs: Number.isFinite(started) ? started : 0,
        model: m.model, ctxTokens: m.ctxTokens, ctxCapTokens: ctxCapTokens(),
        lastTurnMs: m.lastTurnMs,
      });
      // Dormant cards keep the title they showed at snapshot time (toSession would
      // otherwise fall back to the folder name, since there's no live terminal).
      if (a._dormant && a.name) s.name = a.name;
      if (renames[a.sessionId]) s.name = renames[a.sessionId];
      // Manual "Move to done" (right-click menu) is the ONLY way a card reaches the
      // Done tab — there is no time-based auto-park. Works for an idle or "needs you"
      // card, and since 2026-08-06 for a DORMANT one too (a session restored from the
      // snapshot after a Cursor restart, which the user is never going to reopen and just
      // wants off the board without killing it). The flag clears only when the session
      // goes BUSY again — for a dormant card, that means actually resuming it.
      // Dormant stays true, so a parked dormant card still RESUMES on click rather
      // than trying to jump to a terminal that died with the last Cursor window.
      // (Park block moved below the worker count — patch 58.)
      // Context line: shortened cwd + git branch (from the transcript tail).
      // "HEAD" = detached/no branch — noise, not context — so it's dropped.
      s.agent = "claude";
      s.dir = shortCwd(a.cwd);
      s.branch = (m.gitBranch && m.gitBranch !== "HEAD") ? m.gitBranch : "";
      s.started = Number.isFinite(started) ? started : 0;   // stable session-age key for sorting
      s.emoji = topicEmojiCache[s.name] || "";              // cached Haiku fallback glyph (keyword table is primary in the webview)
      // Live shells this session owns — the card's only self-verifying number.
      // Two independent sources (2026-08-24): the OS process table can miss a
      // shell whose ancestry got severed; the harness's own task bookkeeping
      // can't see work outside a `run_in_background` call. Take whichever
      // reports more — never the one that reports less.
      const wOs = workersFor(a.pid, s.started, now);
      // Patch 69 (2026-09-15): a session the CLI reports idle (not busy, not masked
      // to idle with _bgWork) has nothing outstanding — the harness says busy while any
      // background task lives. Task files can only lag that by the 20-min quiet window,
      // which parked a finished card under Working "3 jobs" while it asked the user to go.
      const cliIdle = !a._bgWork && (a.status === "idle" || (a.status === "waiting" && a.tier));
      // A dormant card's process is dead and runBadge/metaLine ignore its count: skip the scan.
      const wTask = (cliIdle || a._dormant) ? null : taskWorkersFor(a.cwd, a.sessionId, now, s.started);
      const w = (wTask && (!wOs || wTask.workers > wOs.workers)) ? wTask : wOs;
      const wJob = a._dormant ? null : jobWorkersFor(a.sessionId, now);   // patch 98: added, it is never one of the shells above
      if (w || wJob) {
        s.workers = (w ? w.workers : 0) + (wJob ? wJob.workers : 0);
        s.workerAgeMs = Math.max(w ? w.workerAgeMs : 0, wJob ? wJob.workerAgeMs : 0);
      }
      if (!a._dormant) {
        const hv = helperView(helpersFor(a.sessionId, now, s.started), now);
        if (hv) s.helpers = hv;
      }
      // RUNNING badge (2026-08-24, the user: "if it runs subagents it always needs to
      // show"). Must be computed AFTER the worker count above — it reads it.
      s.runText = A.runBadge(s);
      s.running = !!s.runText;
      // A NATIVE dialog (permission prompt, sandbox, elicitation) blocks the session
      // outright — nothing else it owns can move until the user answers. Patch 62 (the user,
      // 2026-09-14: "everytime any session request a tool use, it goes into the
      // finished tab ... it should go to the needs you tab"): it outranks the park
      // below AND the running→Working promotion in the webview. Typed questions
      // carry a tier and are not "native"; the harness sets no tier for its dialogs.
      s.native = a.status === "waiting" && !a.tier;
      // Patch 87: the webview's clock, sort and why-line. stateAt = when the card entered
      // its state (statusSince; a dormant card's last transcript write), doneAt = a
      // finished turn's end (the "ready for review" test), via = what put it in Needs you.
      s.stateAt = (a._dormant ? m.mtimeMs : statusSince[a.sessionId]) || 0;
      s.doneAt = s.state === "idle" && !a._dormant && m.lastPromptAtMs ? s.stateAt : 0;
      s.via = a._dormant ? "snapshot" : s.native ? "dialog" : a.tier ? a.via || "" : "";
      s.reason = a.waitingFor || "";
      // Park override (patch 58, 2026-09-14, the user: a card "in the done tab while it is
      // still actively working"). A parked session with live background jobs is not
      // finished, so it keeps its real state until the jobs end. The park flag itself
      // is untouched: the card drops back into Done on its own once the count hits 0.
      // Patch 68: no `!s.native` here any more — a NEW native dialog already clears the
      // park (A.shouldUnpark), so a park that survives is one the user made on this dialog.
      if (parked[a.sessionId] && !s.running && (s.state === "idle" || s.state === "needs" || (a._dormant && s.state === "cutoff"))) {
        s.state = "done"; s.color = A.COLOR.done; s.label = A.LABEL.done;
        s.sub = a._dormant ? "parked · click to resume" : "parked";
        s.jumpLabel = a._dormant ? A.JUMP_LABEL.cutoff : A.JUMP_LABEL.done;
        if (typeof parked[a.sessionId] === "number") s.stateAt = parked[a.sessionId];   // patch 87: parked since
      }
      s.offerHandoff = A.offerHandoff(s, handedOff(a.cwd, a.sessionId));
      s.metaLine = A.metaLine(s);
      // Token spend (2026-09-17): appended to the status line, breakdown on hover.
      const sv = a._dormant ? null : spendView(a.sessionId, now);
      if (sv) { s.spendText = sv.text; s.spendTitle = sv.title; }
      Object.assign(s, compactCard(s));
      s.activity = m.activity || [];
      s.lastMsg = m.lastMsg || "";
      // Cheap per-turn identity for the assist cache (patch 35): changes when the
      // session says something new, so a cached Simplify answer expires with the turn
      // it explained instead of describing stale work.
      s.msgKey = hashKey((m.lastMsg || "") + "|" + (m.summary || ""));
      s.summary = m.summary || "";
      s.loop = (loopMap[a.sessionId] || {}).text || "";   // active auto-loop badge, "" if none
      s.tasks = readTaskPanel(a.sessionId, m.lastPromptAtMs);   // plan-board panel (patch 38a), null if none
      if (sv && s.tasks && Array.isArray(s.tasks.items)) for (const t of s.tasks.items) t.tok = sv.steps[t.id] || "";
      const qc = askCache.get(a.sessionId);
      if (qc && !qc.pending) { s.ask = qc.ask || ""; s.buttons = qc.buttons || null; }
      return s;
    }))
    // Stable, activity-independent order: newest session first, ALWAYS — a card's
    // position is fixed by when its session started, never by its live state. (The
    // old state-grouping `A.ORDER[...]` made cards jump top<->bottom as they went
    // working->idle, which read as confusing churn.) `started` desc = newest on top;
    // name is only a tiebreak for sessions that report no/equal start time.
    .sort((x, y) => ((y.started || 0) - (x.started || 0)) || x.name.localeCompare(y.name));
  return hideEngagedPredecessors(claudeRows.concat(codexRows));
}

// Helper rows (2026-09-17). Shown while any helper runs and for 10 min after the
// last one finished. Ages are whole minutes so the row repaints once a minute,
// not every tick. Patch 81: Codex subagent threads come through here too.
function helperView(hs, now) {
  const live = hs.filter((h) => !h.done);
  const lastDone = Math.max(0, ...hs.filter((h) => h.done).map((h) => h.lastMs));
  if (!live.length && now - lastDone >= 10 * 60 * 1000) return null;
  const mins = (ms) => ms < 60000 ? "<1m" : A.fmtDuration(ms);
  const tok = (h) => { const x = spendFor(h.log); return x && x.total ? fmtSpend(x.total) : ""; };
  const doneTok = hs.filter((h) => h.done).reduce((n, h) => n + ((spendFor(h.log) || {}).total || 0), 0);
  return { done: hs.length - live.length, lastDoneAgo: lastDone ? mins(now - lastDone) : "",
    doneTok: doneTok ? fmtSpend(doneTok) : "",
    live: live.map((h) => ({ id: h.id, type: h.type, brief: h.brief, model: h.model, action: h.lastAction, age: mins(now - h.startedMs), tok: tok(h) })) };
}

// Compact card (2026-09-17): one status line = state · model · project folder; the
// uptime and the full folder + branch move to its hover. Patch 84: Codex rows too.
function compactCard(s) {
  const folder = (s.dir || "").split("/").pop();
  return { cardLine: A.metaLine(Object.assign({}, s, { uptimeMs: 0 })) + (folder ? " · " + folder : ""),
    cardTitle: [(s.dir || "") + (s.branch ? " · " + s.branch : ""),
                s.uptimeMs && !s.dormant ? "up " + A.fmtDuration(s.uptimeMs) : ""].filter(Boolean).join("\n") };
}

// Codex rows, shaped like the Claude ones so the webview renders them with the
// same card. Needs you follows the Claude half's rule and judge (patch 82).
// Anything that throws here yields an empty list — the Claude board must not be
// takeable down by the GPT half.
function codexCards(now) {
  try {
    // A fresh destination vault may not have a Codex rollout yet.
    for (const folder of vscode.workspace.workspaceFolders || []) {
      if (folder.uri && folder.uri.fsPath) handedOff(folder.uri.fsPath, "", "codex");
    }
    // Patch 80: Claude's retention rule, applied to Codex. A session on the board at
    // the last shutdown (restoreSet) or parked outlives the 24h window as a dormant
    // card; one that starts and goes quiet within this run does not. Every such entry
    // is offered, tag or not, so a Codex entry that was untagged or mis-tagged comes
    // back to this half; a Claude sid never matches a rollout, so offering one is free.
    const keep = new Set(Object.keys(boardSnapshot).filter((sid) => restoreSet.has(sid) || parked[sid]));
    const typed = cfg().get("detectTypedQuestions") !== false, judgeOn = cfg().get("judgeWithHaiku") !== false;
    const rows = X.listSessions(now, keep);
    inheritCodexHandoffNames(rows);
    return rows.map((c) => {
      // Un-park a Codex session that has done anything since it was parked. The Claude
      // un-park runs over `res.agents`, which Codex rows are never in, so without this
      // a parked Codex card stays in Done for good.
      //
      // "Working" is NOT a usable trigger here: a Codex turn opens and closes between
      // two 2.5s polls often enough that the board may never once observe it, so a card
      // parked while idle would sit in Done through a whole conversation. The rollout's
      // last event time is the honest signal -- it cannot be missed, whatever the poll
      // catches. A legacy park has no timestamp (it was a bare `true`); those are
      // exactly the ones that could never clear, so they are released.
      const parkedAt = parked[c.sid];
      if (parkedAt && (typeof parkedAt !== "number" || c.touchedAt > parkedAt)) {
        delete parked[c.sid];
        closedParked.delete(c.sid);
        if (gState) gState.update("parked", parked);
      }
      const term = codexTerminals.get(c.sid);
      const live = term && vscode.window.terminals.includes(term) && term.exitStatus === undefined;
      // Closed by Move to done (patch 83): dormant like a Claude card closedParked.
      const dormant = (!!c.old || closedParked.has(c.sid)) && !live;
      // Patch 82: Needs you, by the tick's Claude rule (two-tier promotion, then the
      // judge loop), on a turn that is over. Codex's own typed question or a regex hit
      // first, both blocking; else the cached verdict of the same judgeAndAsk. The Claude
      // half judges live sessions only, so a dormant card is never judged: like a dormant
      // Claude card, it keeps the tab its snapshot recorded.
      const m = { lastFull: String(c.summary || "").slice(0, 2000) };
      let tier = null, reason = "", via = "";   // via: patch 87's why-line
      if (c.turnFinal) {
        reason = c.asked ? "asked for your input" : typed ? A.awaitReason(m.lastFull) || "" : "";
        if (reason) { tier = "blocking"; via = c.asked ? "tool" : "regex"; }
        else if (dormant) { tier = (boardSnapshot[c.sid] || {}).status === "waiting" ? "blocking" : null; via = "snapshot"; }
        else if (typed && judgeOn) {
          const j = judged.get(c.sid);
          if (j && j.key === judgeKey(m) && j.tier) { tier = j.tier; reason = j.reason; via = "judge"; }
        }
      }
      if (tier && !dormant) judgeAndAsk(c.sid, m, false);
      else if (c.turnFinal && !dormant && judgeOn) judgeAndAsk(c.sid, m, true);
      else askCache.delete(c.sid);
      const qc = askCache.get(c.sid);
      const st = c.unfinished && c.state === "idle" && !live ? "cutoff" : tier ? "needs" : c.state;
      const state = parked[c.sid] ? "done" : st;
      // Patch 81: subagent threads as the card's helper rows, working or idle from their
      // own rollout, and the RUNNING badge while any of them works. A Codex thread has
      // no helper log (log undefined), so its row carries no token count.
      const hs = (c.subagents || []).map((t) => ({ id: t.thread, type: t.role, brief: t.nickname,
        model: "", lastAction: "", startedMs: t.startedAt, lastMs: t.touchedAt, done: t.state !== "working" }));
      const busy = hs.filter((h) => !h.done);
      const runText = busy.length ? A.runBadge({ workers: busy.length,
        workerAgeMs: now - Math.min(...busy.map((h) => h.startedMs)) }) : "";
      // Status line and hover, the Claude cards' own (patch 84): the turn_context model
      // and effort ("codex" on a Codex Desktop rollout, which has none), last turn and
      // folder; folder + branch and uptime on hover.
      const branch = c.branch && c.branch !== "HEAD" ? c.branch : "";
      const card = compactCard({ state, model: c.model || "codex", sub: reason ? "needs you · " + reason : "needs you",
        sinceMs: Math.max(0, now - (c.statusSince || c.touchedAt || now)), lastTurnMs: c.lastTurnMs,
        uptimeMs: c.startedAt ? Math.max(0, now - c.startedAt) : 0, dormant, dir: c.shortCwd, branch });
      // Spend (patch 84) in tokens, as the Claude cards show it -- no dollar figure there
      // or here. The thread's own cumulative total, plus its helpers' and guardian reviews'.
      const u = !dormant && c.usage, ht = c.helperTokens || 0, gt = c.guardianTokens || 0;
      return {
      agent: "codex",
      handoffPrompt: c.handoffPrompt, engagedAt: c.engagedAt, startedAt: c.startedAt,
      cardLine: card.cardLine,
      // Codex forks a new rollout file per thread; the card merges them (codex.js
      // mergeFragments). Say so when it did, or a 103-fragment conversation looks
      // like an ordinary one-turn session.
      cardTitle: [card.cardTitle, c.fragments > 1 ? c.fragments + " threads" : ""].filter(Boolean).join("\n"),
      spendText: u ? fmtSpend(u.total_tokens + ht + gt) + " tokens" : undefined,
      spendTitle: u ? "Tokens this session (helpers included)\nthis thread: fresh input " +
        fmtSpend(u.input_tokens - (u.cached_input_tokens || 0)) + " · cache re-read " + fmtSpend(u.cached_input_tokens) +
        " · output " + fmtSpend(u.output_tokens) + "\nhelpers " + fmtSpend(ht) + " · guardian reviews " + fmtSpend(gt) : undefined,
      sid: c.sid,
      name: renames[c.sid] || codexHandoffNames[c.sid] || c.name,
      cwd: c.cwd,
      dir: c.shortCwd,
      branch,
      state,
      liveState: st,   // the state under a park: the activation sweep closes only an idle one
      unfinished: c.unfinished,
      turnFinal: c.turnFinal,   // alertCodex: "finished" means a completed turn (patch 83)
      tier: state === "needs" ? tier : "",
      via, reason,
      ask: qc && !qc.pending ? qc.ask || "" : "",
      // Patch 82: a quick reply types into the session's terminal, so buttons show only
      // with a bound, live one. A Codex Desktop session has none: no button, rather
      // than one that can only warn "reply NOT sent".
      buttons: live && qc && !qc.pending ? qc.buttons || null : null,
      // Patch 86: a Codex app thread has no terminal to type into; the card says where to reply.
      desktopApp: !live && c.originator === "Codex Desktop",
      summary: c.summary,
      lastMsg: c.summary,
      offerHandoff: A.offerHandoff({ state, dormant, ctxTokens: c.tokens, ctxCapTokens: c.ctxWindow }, handedOff(c.cwd, c.sid, "codex")),
      ctxTokens: c.tokens,
      ctxCapTokens: c.ctxWindow,
      ctxPct: c.ctxPct,
      started: c.startedAt,
      startedAt: c.startedAt,
      statusSince: c.statusSince,
      // Patch 87: the webview clock (a park counts from the park) and "ready for review"
      // (a completed turn, idle since its end).
      stateAt: (state === "done" && typeof parkedAt === "number" ? parkedAt : c.statusSince || c.touchedAt) || 0,
      doneAt: st === "idle" && c.turnFinal && !dormant ? c.statusSince || 0 : 0,
      touchedAt: c.touchedAt,
      emoji: topicEmojiCache[c.name] || "",
      // Kept past the window and not reopened: dims, and resumes on click (patch 80).
      dormant,
      workers: 0, bg: 0,
      helpers: helperView(hs, now),
      runText,
      running: !!runText
      };
    }).sort((x, y) => ((y.started || 0) - (x.started || 0)) || x.name.localeCompare(y.name));
  } catch (_) { return []; }
}

// Claude Code reports `idle` both for "finished" and for "ended the turn
// needing you" — a typed question, or an approval/go-ahead request ("say go
// and I'll…"). The supervisor can't tell them apart, so for idle sessions we
// peek the transcript's last assistant message and, if it awaits you, surface
// why. Off via `overlord.detectTypedQuestions: false`.
const _tPath = new Map();   // sid -> resolved transcript path (paths are stable)
function transcriptPath(sid) {
  if (_tPath.has(sid)) return _tPath.get(sid);
  let found = null;
  try {
    const base = path.join(os.homedir(), ".claude", "projects");
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, sid + ".jsonl");
      if (fs.existsSync(p)) { found = p; break; }
    }
  } catch (_) { /* projects dir missing -> no transcript */ }
  if (found) _tPath.set(sid, found);   // only cache hits, so late-created ones resolve later
  return found;
}
// Returns a short reason the idle session needs you ("typed a question" /
// "awaiting your reply"), or null if it's genuinely finished.
function idleAwaitReason(sid) {
  try {
    const p = transcriptPath(sid);
    if (!p) return null;
    const fd = fs.openSync(p, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);   // read the tail only
      return A.awaitReason(A.lastAssistantText(buf.toString("utf8")));
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
}

// One 64KB tail read per session per tick -> model, ctx tokens, activity, await reason.
// The working ceiling in tokens: the point at which a session actually gets
// compacted, which is what the card's fill should be measured against — not the
// raw model window, which is far larger and never the thing that bites.
// Read live from settings so the card cannot disagree with the setting, and cached
// for a minute because this runs per session per poll tick.
let _capCache = { at: 0, val: 200000 };
function ctxCapTokens() {
  const now = Date.now();
  if (now - _capCache.at < 60000) return _capCache.val;
  let pct = 20;
  try {
    const p = wsPath(".claude", "settings.local.json");
    const v = JSON.parse(fs.readFileSync(p, "utf8"));
    const raw = Number((v.env || {}).CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
    if (Number.isFinite(raw) && raw >= 1 && raw <= 100) pct = raw;
  } catch (_) { /* fall back to 20 */ }
  // Assumes the 1M-window models the user runs. If he moves to a 200k-only model this
  // is the one number to change.
  _capCache = { at: now, val: Math.round(1000000 * (pct / 100)) };
  return _capCache.val;
}

// ---- Hand off (patch 49) ---------------------------------------------------
// The card's Hand off button runs the same gate the Stop hook runs at 400k, in
// force mode, for THIS session (--session; force alone would take the newest
// transcript in the folder, which on a busy board is someone else). The gate
// writes the snapshot + baton (--no-open: no toast, no window); its one output
// line comes back into the rail. The extension then opens the fresh session
// ITSELF, with the opening prompt on the command line, so the new session runs
// its first turn on boot and reads the handover without the user typing anything
// (2026-09-04: a session opened via the keystroke launcher sat empty until he
// did -- the SessionStart context only reaches the model on the first prompt).
// handed_off is read from the vault's
// gate state file (cached 10s per cwd) so the button vanishes after ANY handoff,
// auto or clicked, and stays gone across a Reload Window.
// Since 2026-09-04 (evening) the EXTENSION is the only thing that opens the fresh
// session, on both paths: the gate never spawns a window any more. the user's 400k
// auto-handoff at 19:59 that day went through the old keystroke launcher and the
// new session sat empty with no first prompt, so the launcher is retired and
// handedOff() opens the session when a NEW sid appears in the map.
const HANDOFF_PY = SEARCH_PY;
const HANDOFF_GATE = wsPath("hooks", "handoff-gate.py");   // optional; button does nothing without it
const _handoffCache = new Map();   // cwd -> { at, sids, atMs: sid -> handoff time }
function handedOff(cwd, sid, agent) {
  const now = Date.now();
  const cacheKey = (cwd || "") + (agent === "codex" ? "\ncodex" : "");
  let e = _handoffCache.get(cacheKey);
  if (!e || now - e.at > 10000) {
    let sids = new Set();
    const atMs = new Map();
    // The cwd if it has a _temp/ folder, else OVERLORD_WORKSPACE.
    const vault = cwd && fs.existsSync(path.join(cwd, "_temp")) ? cwd : WORKSPACE;
    try {
      const file = agent === "codex" ? "codex-handoff-gate.json" : "handoff-gate.json";
      const st = JSON.parse(fs.readFileSync(path.join(vault, "_temp", file), "utf8"));
      const h = st.handed_off || {};
      sids = new Set(Object.keys(h).filter((s) => !h[s].dry_run));
      // When it handed off (patch 59): `at` is written by handoff-gate.py since
      // 2026-09-14; older records fall back to the snapshot's local-time filename.
      for (const s of sids) {
        const rec = h[s] || {};
        let t = Number(rec.at) || 0;
        const f = !t && /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-/.exec(String(rec.snapshot || ""));
        if (f) t = new Date(+f[1], f[2] - 1, +f[3], +f[4], +f[5]).getTime();
        if (t) atMs.set(s, t);
      }
    } catch (_) { /* no state file yet = nothing handed off */ }
    // A session that handed off is finished: park it (Done tab) the first time it
    // shows up in the map. Diffed against the previous read so it fires ONCE per
    // handoff, not on every tick -- the user can still un-park by continuing the session.
    // Covers the auto 400k Stop-hook path; the button parks explicitly in handOff().
    // A sid whose handoff TIME moved is a re-handoff of a continued session (patch 64,
    // 2026-09-14) and opens a successor just like a new sid does.
    // Braces matter (patch 91, 2026-10-09): without them this else bound to the inner
    // if, so every refresh re-ran the first-read block once per unchanged sid (183^2
    // gate-file reads, ~1.6 GB per tick) and froze the extension host.
    if (e) { for (const sid of sids) if (!e.sids.has(sid) || (atMs.get(sid) || 0) > (e.atMs.get(sid) || 0)) onHandedOff(sid, cwd, atMs.get(sid) || 0); }
    // ⛔ FIRST read per cwd has no previous set to diff, so until 2026-09-12 every
    // session that handed off BEFORE this board started stayed unparked forever.
    // That is how three dead cards from one chain were still sitting outside Done
    // wearing the same inherited name as the live one. recoverUnclaimedBaton runs
    // FIRST: it opens a successor via onHandedOff, and parking that sid ahead of it
    // would mark the handoff done and the successor would never open.
    else {
      if (agent !== "codex") recoverUnclaimedBaton(vault, sids, cwd);
      // Codex receives an explicit snapshot prompt, not Claude's SessionStart hook.
      for (const s of sids) {
        const rec = handoffRecord(s, cwd);
        const age = now - (Number(rec.at) || 0);
        if (rec.agent === "codex" && age >= 0 && age < 600000) onHandedOff(s, cwd, rec.at);
      }
      parkSuperseded(sids);
    }
    e = { at: now, sids, atMs }; _handoffCache.set(cacheKey, e);
  }
  return e.sids.has(sid);
}
// Handoff time in ms, or 0 when unknown. Shares handedOff()'s cache.
function handoffAtMs(cwd, sid) {
  handedOff(cwd, sid);
  const e = _handoffCache.get(cwd || "");
  return (e && e.atMs.get(sid)) || 0;
}
// Safety net for the gap the diff cannot see: a handoff written in the seconds
// between a Reload Window and this board's first read has no "previous read" to
// diff against, so nothing would open. On the first read per vault, look at the
// baton the gate wrote: if nobody has claimed it (handoff-pickup.py stamps
// claimed_by at the successor's SessionStart) and it is 20 s - 10 min old, the
// successor never started -- open it. The 20 s floor leaves a successor that IS
// booting time to claim; the 10 min ceiling keeps a day-old baton from popping a
// session on the next Cursor start.
function recoverUnclaimedBaton(vault, sids, cwd) {
  try {
    const p = path.join(vault, "_temp", "session-log", "_baton.json");
    const b = JSON.parse(fs.readFileSync(p, "utf8"));
    const age = Date.now() - fs.statSync(p).mtimeMs;
    if (b.claimed_by || age < 20000 || age > 600000) return;
    if (b.from_session && sids.has(b.from_session)) onHandedOff(b.from_session, cwd);
  } catch (_) { /* no baton = nothing to recover */ }
}
// Park sessions that handed off before this board was watching. A handed-off session
// is finished by definition, so leaving it on the active side puts a dead card beside
// its own live successor -- and since the successor inherits the thread name, the two
// read as the same session in two places.
// ⛔ Once per sid, EVER (persisted): the existing rule is that the user can un-park by
// continuing a session, and a backfill that re-ran on every window reload would undo
// that silently. Remembering which sids this parked is what keeps it a one-time
// correction rather than a fight with him.
function parkSuperseded(sids) {
  const seen = (gState && gState.get("autoParked")) || {};
  let changed = false;
  for (const sid of sids) {
    if (parked[sid] || seen[sid]) continue;
    seen[sid] = true;        // patch 65: no auto-park -- Done is manual only
    _handoffDone.add(sid);   // finished long ago: never open a successor for it now
    changed = true;
  }
  if (changed && gState) gState.update("autoParked", seen);
}
const HANDOFF_PROMPT = "Handoff received. Read the handover record in your startup context and follow its instructions.";
// One sid, once: park the finished session and open its successor with the opening
// prompt on the command line. Guarded by a set because handedOff() is cached PER
// CWD, so a new sid would otherwise be "new" once per distinct cwd in the vault.
const _handoffDone = new Set();
function onHandedOff(sid, cwdHint, at) {
  const key = at ? sid + ":" + at : sid;   // one successor per HANDOFF, not per sid (patch 64)
  if (_handoffDone.has(key)) return;
  const record = handoffRecord(sid, cwdHint);
  if (record.dry_run) return;
  if (record.agent === "codex") {
    openCodexHandoff(sid, cwdHint, record);
    _handoffDone.add(key);
    return;
  }
  _handoffDone.add(key);
  // Patch 65 (2026-09-14, the user): a handed-off card is NOT parked -- it stays Idle.
  // "Done sessions should be placed there manually by me." Only "Move to done" parks.
  const rec = _agentCache.find((a) => a.sessionId === sid);
  const cwd = (rec && rec.cwd) || cwdHint || "";
  const cmd = cfg().get("newSessionCommand") || "claude";
  // Title = what the work IS, marked as a continuation (patch 55). The tab name is
  // the card title, and a terminal created with a name never picks up Claude
  // Code's own auto-title -- which would be useless anyway, since every successor's
  // first prompt is the same HANDOFF_PROMPT ("Handoff record review" on all three
  // live cards, 2026-09-07). Precedence (the user, 2026-09-09: "the new session ... does
  // not produce the same title as the original"): his rename of the old card, else
  // WHAT THE OLD CARD IS CALLED, so one name runs the length of a handoff chain; the
  // gate's derived title only when the predecessor never got a resolved tab name.
  // ⛔ TWO HALVES: the THREAD's identity, then WHAT THIS SESSION IS DOING (patch 57,
  // 2026-09-12). Until now this was the thread half alone, inherited whole from the
  // predecessor -- and because boardTitle() strips the ↻, the same string was copied
  // down every generation. the user renamed a card "Mobile Component creator" on 9 Sep;
  // 17 handoffs later that label was still on a card running a decision-doc audit,
  // beside two dead cards from the same chain wearing the name too. He read it as
  // sessions being mixed together and told a session with a CORRECT record that it
  // had the wrong one, and it dropped real work. The gate was deriving an accurate
  // title for every one of those handoffs and none of them ever reached a card,
  // because this line only consulted handoffTitle as a third fallback.
  // The rename still runs the length of the chain (the user, 2026-09-09, wanting
  // continuity); the half that changes is the half that describes the work.
  const thread = renames[sid] || threadOf(sid) || path.basename(cwd) || "claude";
  const name = A.handoffName(thread, handoffTitle(sid, cwd));
  // Panel, not the editor area: an editor-tab terminal sits BESIDE the panel one
  // as a second visible terminal (the user's 2026-09-07 screenshot). In the panel it
  // takes the old session's slot instead (patch 54).
  const term = vscode.window.createTerminal({ name, cwd: cwd || undefined,
    location: vscode.TerminalLocation.Panel, ...termStyle(name) });
  term.show();
  term.sendText(withRemoteControl(cmd, name) + ' "' + HANDOFF_PROMPT + '"');
  // Handed off = finished: close the old session's terminal too, or it sits open
  // next to the successor and takes input that splits the work (the user, 2026-09-04).
  // Pid ancestry only -- never the cwd / lone-terminal fallbacks, which could
  // close the wrong session. Transcript stays resumable.
  if (rec && rec.pid) closeTerminalByPid(Number(rec.pid), term);
}
// Confirmed successors retire predecessor cards without deleting history or using Done.
// Launch receipts alone are never sufficient. Persist links so chains stay retired on reload.
function hideEngagedPredecessors(rows) {
  const retired = (gState && gState.get("engagedHandoffs")) || {};
  let changed = false;
  const norm = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
  for (const old of rows) {
    if (retired[old.sid]) continue;
    const rec = handoffRecord(old.sid, old.cwd);
    if (!rec.snapshot || !rec.at || rec.dry_run) continue;
    let successor;
    if (rec.agent === "codex") {
      const prefix = "Handoff received. Read the saved handover at " + rec.snapshot + ".";
      const matches = rows.filter((r) => r.sid !== old.sid && r.agent === "codex" &&
        r.startedAt >= rec.at && r.engagedAt >= rec.at &&
        norm(r.handoffPrompt).startsWith(norm(prefix)));
      if (matches.length === 1) successor = matches[0];
    } else {
      // Claude's claim identifies the successor; its own response proves engagement.
      try {
        const baton = JSON.parse(fs.readFileSync(path.join(old.cwd, "_temp", "session-log", "_baton.json"), "utf8"));
        if (baton.from_session === old.sid && norm(baton.snapshot) === norm(rec.snapshot)) {
          successor = rows.find((r) => r.sid === baton.claimed_by && r.sid !== old.sid &&
            r.started >= rec.at && r.summary && r.summary !== HANDOFF_PROMPT);
        }
      } catch (_) { /* No exact claim: keep the predecessor visible. */ }
    }
    if (successor) {
      retired[old.sid] = { successor: successor.sid, at: rec.at };
      changed = true;
    }
  }
  if (changed && gState) gState.update("engagedHandoffs", retired);
  return rows.filter((r) => !retired[r.sid]);
}
// Exact record and atomic launch receipt prevent duplicate successors across windows.
function handoffRecord(sid, cwd) {
  const vault = cwd && fs.existsSync(path.join(cwd, "_temp")) ? cwd : WORKSPACE;
  for (const file of ["codex-handoff-gate.json", "handoff-gate.json"]) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(vault, "_temp", file), "utf8"));
      if ((st.handed_off || {})[sid]) return st.handed_off[sid];
    } catch (_) { /* this agent has no handoffs yet */ }
  }
  return {};
}
// Resolve only exact handoff snapshots, never a generic title or shared cwd.
// Save the inherited name separately so a later explicit child rename still wins.
function inheritCodexHandoffNames(rows) {
  const vaults = new Set([WORKSPACE]);
  for (const r of rows) if (r.cwd) vaults.add(r.cwd);
  const records = new Map();
  for (const vault of vaults) {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(vault, "_temp", "codex-handoff-gate.json"), "utf8"));
      for (const [sid, rec] of Object.entries(st.handed_off || {})) {
        if (rec.agent === "codex" && rec.snapshot && rec.at && !rec.dry_run)
          records.set(sid + ":" + rec.at, { sid, ...rec });
      }
    } catch (_) { /* Not every cwd is a vault. */ }
  }
  const bySid = new Map(rows.map(r => [r.sid, r]));
  const norm = p => String(p || "").replace(/\\/g, "/").toLowerCase();
  const resolving = new Set();
  let changed = false;
  function resolve(sid) {
    if (renames[sid]) return renames[sid];
    if (codexHandoffNames[sid]) return codexHandoffNames[sid];
    const row = bySid.get(sid);
    if (!row || resolving.has(sid)) return "";
    resolving.add(sid);
    const matches = [...records.values()].filter(rec => rec.sid !== sid && row.startedAt >= rec.at &&
      norm(row.handoffPrompt).startsWith(norm("Handoff received. Read the saved handover at " + rec.snapshot + ".")));
    if (matches.length === 1) {
      const rec = matches[0];
      let launchName = "";
      try {
        const receipt = JSON.parse(fs.readFileSync(path.join(path.dirname(rec.snapshot),
          "codex-launch-" + rec.sid + "-" + rec.at + ".json"), "utf8"));
        if (receipt.from_session === rec.sid && norm(receipt.snapshot) === norm(rec.snapshot))
          launchName = receipt.name || "";
      } catch (_) { /* Older launches did not save a name. */ }
      const parentName = launchName || resolve(rec.sid) ||
        ((_lastBoard || []).find(r => r.sid === rec.sid) || {}).name ||
        (boardSnapshot[rec.sid] || {}).name || rec.title;
      if (parentName) {
        codexHandoffNames[sid] = parentName;
        changed = true;
      }
    }
    resolving.delete(sid);
    return codexHandoffNames[sid] || row.name;
  }
  for (const row of rows) resolve(row.sid);
  if (changed && gState) gState.update("codexHandoffNames", codexHandoffNames);
}
function openCodexHandoff(sid, cwd, record) {
  if (!/^[0-9a-f-]{36}$/i.test(sid) || !record.snapshot || !fs.existsSync(record.snapshot)) {
    throw new Error("Codex handoff has no valid session or snapshot");
  }
  const prompt = "Handoff received. Read the saved handover at " + record.snapshot +
    ". Continue only the latest authorized work. Preserve all recorded restrictions; a new session does not override approval denials.";
  const name = renames[sid] || codexHandoffNames[sid] ||
    ((_lastBoard || []).find(r => r.sid === sid) || {}).name ||
    (boardSnapshot[sid] || {}).name || record.title || "Codex";
  const options = codexTerminalOptions(name, cwd, null, prompt);
  const receipt = path.join(path.dirname(record.snapshot), "codex-launch-" + sid + "-" + record.at + ".json");
  let fd;
  try { fd = fs.openSync(receipt, "wx"); }
  catch (e) { if (e.code === "EEXIST") return; throw e; }
  const openedAt = Date.now(), knownSessions = X.listSessions(openedAt);
  let term;
  try {
    fs.writeFileSync(fd, JSON.stringify({ from_session: sid, state: "launching", name, snapshot: record.snapshot }));
    term = vscode.window.createTerminal(options);
    trackCodexTerminal(term, openedAt, knownSessions);
    fs.writeFileSync(receipt, JSON.stringify({ from_session: sid, state: "launched", name, at: openedAt, snapshot: record.snapshot }));
    term.show(false);
  } catch (e) {
    // Only release a claim when no terminal was created; never duplicate an unknown launch.
    if (!term) { fs.closeSync(fd); fd = undefined; fs.unlinkSync(receipt); }
    throw e;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
// What the PREDECESSOR's card is showing, which is the name the successor takes.
// termNames holds the resolved terminal tab name, and that is what buildSessions
// renders as the card title. Two things have to come off it: VS Code prefixes a
// tab the shell retitled with "claude — ", sometimes twice, and a card that is
// itself a handoff already carries the ↻ we are about to re-add — leave either in
// and a three-deep chain reads "claude — claude — ↻ ↻ ↻ ...".
function boardTitle(sid) {
  return String(termNames.get(sid) || "")
    .replace(/^(?:claude\s+—\s+)+/, "").replace(/^[↻✳]\s*/, "").trim();
}
// Just the THREAD half of the predecessor's card name. The split rule itself lives in
// agents.js so it can be tested without vscode (Tools/Overlord/test-handoff-name.js).
function threadOf(sid) {
  return A.threadOf(boardTitle(sid));
}
// The title handoff-gate.py derived for this handoff (Haiku over the handover's last
// requests), read from the same state file handedOff() diffs. One read per handoff.
function handoffTitle(sid, cwd) {
  try {
    const vault = cwd && fs.existsSync(path.join(cwd, "_temp")) ? cwd : WORKSPACE;
    const st = JSON.parse(fs.readFileSync(path.join(vault, "_temp", "handoff-gate.json"), "utf8"));
    return String(((st.handed_off || {})[sid] || {}).title || "").trim().slice(0, 60);
  } catch (_) { return ""; }
}
async function closeTerminalByPid(pid, keep) {
  try {
    const map = getProcMap();
    if (!map.size) return;
    const anc = ancestorsOf(pid, map);
    for (const t of vscode.window.terminals) {
      if (t === keep) continue;
      let tpid; try { tpid = await t.processId; } catch (_) { tpid = undefined; }
      if (tpid && anc.has(tpid)) { t.dispose(); return; }
    }
  } catch (_) { /* fail open: the old terminal just stays */ }
}
function handOff(session, webview) {
  if (!HANDOFF_GATE) return;
  cp.execFile(HANDOFF_PY, [HANDOFF_GATE, "--force", "--cwd", session.cwd, "--session", session.sid, "--no-open"],
    { timeout: 60000, windowsHide: true, maxBuffer: 1 << 20 }, (err, out) => {
      _handoffCache.clear();   // the state file just changed; re-read on the next tick
      // Strip the "handoff: " prefix and the snapshot path — the rail is 9.5px text.
      let text = String(out || "").trim().replace(/^handoff[^:]*:\s*/, "").replace(/snapshot \S+ written, /, "");
      if (!text) text = err ? "failed: " + err.message.slice(0, 60) : "nothing happened";
      if (/baton set/.test(text)) {
        onHandedOff(session.sid, session.cwd);
        text = text.replace(/\.$/, "") + ", fresh session opening";
      }
      webview.postMessage({ type: "handoff", sid: session.sid, text });
    });
}

const _metaRead = new Map();   // transcript path -> {key, meta}: an unchanged transcript is not re-read
function readMeta(sid) {
  try {
    const p = transcriptPath(sid);
    if (!p) return {};
    const st0 = fs.statSync(p), hit = _metaRead.get(p);
    if (hit && hit.key === st0.size + ":" + st0.mtimeMs) return hit.meta;
    const fd = fs.openSync(p, "r");
    try {
      const st = fs.fstatSync(fd), size = st.size;
      const len = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      // mtimeMs (patch 87): a dormant card's clock, and a live one's first-sight seed.
      const meta = Object.assign(T.readTail(buf.toString("utf8"), A.awaitReason), { mtimeMs: st.mtimeMs });
      _metaRead.set(p, { key: size + ":" + st.mtimeMs, meta });
      return meta;
    } finally { fs.closeSync(fd); }
  } catch (_) { return {}; }
}

// ---- transcript viewer (editor-area webview panel) -------------------------
// logPath (2026-09-17): a helper's own log, opened under a "helper:<id>" key.
function openTranscript(sid, name, logPath) {
  const existing = panels.get(sid);
  if (existing) { existing.panel.reveal(vscode.ViewColumn.Active); return; }
  const panel = vscode.window.createWebviewPanel(
    "overlord.transcript", name || "session", vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true });
  panel.webview.html = transcriptHtml();
  const entry = { panel, offset: 0, path: logPath || null };
  panels.set(sid, entry);
  panel.onDidDispose(() => panels.delete(sid));

  const p = logPath || transcriptPath(sid) || X.rolloutPath(sid);
  if (!p) { panel.webview.postMessage({ type: "full", html: '<div class="ov-note">Waiting for transcript…</div>' }); return; }
  try {
    let events, truncated = false;
    if (X.isRollout(p)) {
      // Patch 83: a Codex rollout -- a card's own thread, or a subagent's from its
      // helper row -- adapted to the same events and renderer. Its last 2 MB only;
      // entry.cx marks the panel as Codex for followPanels and carries the twin check.
      const r = X.tailEvents(p, 2 * 1024 * 1024, (entry.cx = {}));
      entry.path = p; entry.offset = r.offset; events = r.events; truncated = r.cut;
    } else {
      const text = fs.readFileSync(p, "utf8");
      entry.offset = fs.statSync(p).size;
      events = T.parse(text);
    }
    if (events.length > 500) { events = events.slice(-500); truncated = true; }
    panel.webview.postMessage({ type: "full", html: T.renderHtml(events, { truncatedNote: truncated }) });
  } catch (_) {
    panel.webview.postMessage({ type: "full", html: '<div class="ov-note">Waiting for transcript…</div>' });
  }
}

// On each poll tick, stream new transcript lines into any open panel.
function followPanels() {
  for (const [sid, entry] of panels) {
    const p = entry.path || transcriptPath(sid);
    if (!p) continue;
    let size; try { size = fs.statSync(p).size; } catch (_) { continue; }
    if (size <= entry.offset) continue;
    try {
      const fd = fs.openSync(p, "r");
      try {
        const len = size - entry.offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, entry.offset);
        const chunk = buf.toString("utf8");
        const nl = chunk.lastIndexOf("\n");
        if (nl < 0) continue;                       // no complete line yet; wait
        const complete = chunk.slice(0, nl + 1);
        entry.offset += Buffer.byteLength(complete, "utf8");
        const events = entry.cx ? X.transcriptEvents(complete, entry.cx) : T.parse(complete);
        if (events.length) entry.panel.webview.postMessage({ type: "append", html: T.renderHtml(events) });
      } finally { fs.closeSync(fd); }
    } catch (_) { /* transient read race; retry next tick */ }
  }
}

function transcriptHtml() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  body{margin:0;padding:10px 14px;font-family:var(--vscode-editor-font-family,monospace);
       font-size:12px;line-height:1.5;color:var(--vscode-foreground)}
  .ov-note{color:var(--vscode-descriptionForeground);font-style:italic;margin:6px 0}
  .ov-text{margin:10px 0;white-space:pre-wrap;word-break:break-word}
  .ov-tool{font-weight:600;margin:14px 0 2px}
  .ov-diffsub{color:var(--vscode-descriptionForeground);margin:2px 0 4px}
  .ov-diff{border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));border-radius:4px;overflow:hidden}
  .ov-line{display:flex;white-space:pre}
  .ov-ln{width:46px;flex:0 0 auto;text-align:right;padding-right:10px;
         color:var(--vscode-editorLineNumber-foreground,#858585);user-select:none}
  .ov-code{flex:1;white-space:pre-wrap;word-break:break-word}
  .ov-line.add{background:var(--vscode-diffEditor-insertedLineBackground,rgba(60,200,120,.18));
               color:var(--vscode-gitDecoration-addedResourceForeground,#89d185)}
  .ov-line.del{background:var(--vscode-diffEditor-removedLineBackground,rgba(220,80,90,.18));
               color:var(--vscode-gitDecoration-deletedResourceForeground,#f48771)}
  </style></head><body>
  <div id="root"></div>
  <script>
    const root=document.getElementById("root");
    function nearBottom(){ return window.innerHeight+window.scrollY >= document.body.scrollHeight-48; }
    window.addEventListener("message",(e)=>{
      const m=e.data; if(!m) return;
      if(m.type==="full"){ root.innerHTML=m.html; window.scrollTo(0,document.body.scrollHeight); }
      else if(m.type==="append"){ const b=nearBottom(); root.insertAdjacentHTML("beforeend",m.html);
        if(b) window.scrollTo(0,document.body.scrollHeight); }
    });
  </script></body></html>`;
}

// ---- new session launcher --------------------------------------------------
async function newSession() {
  const items = [];
  for (const wf of (vscode.workspace.workspaceFolders || [])) {
    items.push({ label: wf.name, description: wf.uri.fsPath, fsPath: wf.uri.fsPath });
    try {
      const projDir = path.join(wf.uri.fsPath, "projects");
      for (const d of fs.readdirSync(projDir, { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith("."))
          items.push({ label: d.name, description: "projects/" + d.name, fsPath: path.join(projDir, d.name) });
      }
    } catch (_) { /* no projects/ dir -> just the root */ }
  }
  if (!items.length) { vscode.window.showInformationMessage("Overlord: open a folder first."); return; }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "New Claude Code session in…" });
  if (!pick) return;
  const cmd = cfg().get("newSessionCommand") || "claude";
  const term = vscode.window.createTerminal({ name: pick.label, cwd: pick.fsPath,
    location: vscode.TerminalLocation.Panel, ...termStyle(pick.label) });   // one terminal dock for every session (patch 54)
  term.show();
  term.sendText(withRemoteControl(cmd, pick.label));   // RC on, named after the folder → phone-reachable
}

// Append `--remote-control "<name>"` so a session is drivable from the phone and
// identifiable in the mobile list. Name sanitised for the shell; no-op if the base
// command already enables RC (so a custom overlord.newSessionCommand isn't doubled).
// Patch 56 (2026-09-09, the user): "I don't see clearly enough which session I'm working
// on" — he had typed prompts into the wrong one more than once. Every terminal tab
// was named "claude — <x>", and tab labels truncate from the right, so several read
// identically. Two fixes: the distinguishing word goes FIRST (callers pass the bare
// name now), and each session's tab is tinted from its own name.
// ⛔ The ring and the hash must stay identical to Tools/session-statusline/statusline.py,
// which paints the same colour block above the prompt box — the point is that the tab,
// the card and the status line are recognisably ONE object. Change both or neither.
const TERM_COLORS = ["terminal.ansiRed", "terminal.ansiGreen", "terminal.ansiYellow",
                     "terminal.ansiBlue", "terminal.ansiMagenta", "terminal.ansiCyan"];
function termStyle(name) {
  let h = 5381;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h + s.charCodeAt(i)) | 0) >>> 0;
  return { color: new vscode.ThemeColor(TERM_COLORS[h % TERM_COLORS.length]),
           iconPath: new vscode.ThemeIcon("terminal") };
}

// What a resumed CUT OFF session is told on launch (patch 55). Deliberately not a
// bare "continue": the session was killed mid-turn, so its last words can be a plan
// it never carried out, and a resumed run must not treat stale handover notes as
// live instructions. So: re-orient from the task list, then continue only if the
// work still stands. Override with the overlord.resumeContinuePrompt setting.
const RESUME_CONTINUE_PROMPT =
  "You were interrupted mid-task when Cursor closed, and this is a resume. " +
  "Check your task list and the last few turns to work out what was actually in " +
  "progress, confirm it is still what is wanted, then carry on and finish it. " +
  "Do not re-do completed work. If what remains is unclear or looks stale, say so " +
  "in one line and stop rather than guessing.";

function withRemoteControl(cmd, name) {
  if (/--remote-control/.test(cmd)) return cmd;
  const rc = String(name || "").replace(/["'`$%&|<>^\r\n]/g, "").trim().slice(0, 60);
  return cmd + (rc ? ' --remote-control "' + rc + '"' : " --remote-control");
}

// ---- process tree (terminal labelling + jump) ------------------------------
// Patch 66 (2026-09-15, the user: "the session takes ages to load or does not show
// at all ... it stays on the same screen no matter which card I click"): the
// Windows branch ran Windows PowerShell 5.1 SYNCHRONOUSLY with a 4 s timeout, and
// on this machine (610 processes, 2 s shell start-up) it took 4.05-4.3 s — so it
// timed out almost every time, returned an EMPTY map, and every jump fell through
// to the cwd fallback = the first terminal in the vault folder, the same bare
// shell for every card. It also re-ran every ~4 s from the poll, freezing the
// extension host for most of each cycle. Now: PowerShell 7 with a two-column
// query (~1.6 s), a 30 s cache, and refreshes in the BACKGROUND — only the very
// first call (empty cache) blocks, so a click always resolves against a map.
const PROC_MAP_TTL_MS = 30000;
const PS7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const PROC_PS_EXE = process.platform === "win32" && fs.existsSync(PS7) ? PS7 : "powershell.exe";
const PROC_PS_ARGS = ["-NoProfile", "-NonInteractive", "-Command",
  "Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId FROM Win32_Process' | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"];
let _procRefreshing = false;
function parseProcMap(out) {
  const map = new Map();
  for (const line of String(out || "").split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  return map;
}
// Returns a promise (2026-11-09) so a card click can wait for a fresh map without freezing the host.
function refreshProcMapAsync() {
  if (_procRefreshing) return _procRefreshing;
  _procRefreshing = new Promise((resolve) => cp.execFile(PROC_PS_EXE, PROC_PS_ARGS,
    { encoding: "utf8", timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    (err, out) => {
      _procRefreshing = null;
      const map = err ? new Map() : parseProcMap(out);
      if (map.size) procCache = { at: Date.now(), map };
      resolve();
    }));
  return _procRefreshing;
}
function getProcMap() {
  if (procCache.map && procCache.map.size) {
    if (Date.now() - procCache.at > PROC_MAP_TTL_MS) refreshProcMapAsync();
    return procCache.map;
  }
  // Patch 89: an empty answer is cached too, or every click re-ran the blocking query.
  if (procCache.map && Date.now() - procCache.at < PROC_MAP_TTL_MS) return procCache.map;
  let map = new Map();
  try {
    if (process.platform === "win32") {
      map = parseProcMap(cp.execFileSync(PROC_PS_EXE, PROC_PS_ARGS,
        { encoding: "utf8", timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
    } else {
      map = parseProcMap(cp.execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8", timeout: 4000 }));
    }
  } catch (_) { /* leave empty -> fall back to cwd matching */ }
  procCache = { at: Date.now(), map };
  return map;
}

function ancestorsOf(pid, map) {
  const set = new Set();
  let p = Number(pid), guard = 0;
  while (p && p > 1 && !set.has(p) && guard++ < 40) { set.add(p); p = map.get(p); }
  return set;
}

// Create the Codex terminal ourselves so the Terminal object cannot be confused
// with another terminal opened while `newWithProfile` is still resolving. Reuse
// the configured Codex profile, but let cmd exit with Codex: a dead `/k` shell
// looks live to VS Code and can keep a stale card mapping forever.
function codexTerminalOptions(name, cwd, resumeSid, prompt) {
  const profiles = vscode.workspace.getConfiguration("terminal.integrated").get("profiles.windows") || {};
  const profile = profiles.Codex || {};
  const shellPath = typeof profile.path === "string" ? profile.path : "cmd.exe";
  const shellArgs = Array.isArray(profile.args) ? profile.args.slice() : ["/k", "codex"];
  if (path.basename(shellPath).toLowerCase() === "cmd.exe" &&
      String(shellArgs[0] || "").toLowerCase() === "/k") shellArgs[0] = "/c";
  if (resumeSid) shellArgs.push("resume", resumeSid);
  if (prompt) {
      // Cursor quotes each shellArgs element; prequoting splits the prompt in cmd.
    const shell = path.basename(shellPath).toLowerCase();
    if (shell === "cmd.exe" && /[&|<>^!%\r\n]/.test(prompt)) throw new Error("Unsupported shell characters in Codex opening prompt");
      if (shell === "cmd.exe") shellArgs.push(prompt.replace(/["%\r\n]/g, "'"));
    else if (/^(pwsh|powershell)(\.exe)?$/.test(shell)) shellArgs.push("'" + prompt.replace(/'/g, "''") + "'");
    else shellArgs.push(prompt);
  }
  return { name, shellPath, shellArgs, cwd: cwd || undefined };
}

// Codex rollouts do not contain a process id, so cwd matching cannot distinguish
// several GPT terminals opened in the same workspace. Capture the Terminal object
// when Overlord launches it, then bind the first new rollout created by that launch.
function trackCodexTerminal(term, openedAt, knownSessions) {
  if (!term) return;
  pendingCodexTerminals.push({
    term,
    openedAt: Number(openedAt) || Date.now(),
    knownTouched: new Map((knownSessions || []).map((s) =>
      typeof s === "string" ? [s, 0] : [s.sid, s.touchedAt || 0])),
  });
}

function bindCodexTerminal(sid, term) {
  if (!sid || !term) return;
  codexTerminals.set(sid, term);
  termNames.set(sid, term.name);
  Promise.resolve(term.processId).then((pid) => {
    if (!pid || codexTerminals.get(sid) !== term) return;
    codexTerminalPids[sid] = Number(pid);
    if (gState) gState.update("codexTerminalPids", codexTerminalPids);
  }, () => {});
}

function forgetCodexTerminal(sid) {
  codexTerminals.delete(sid);
  termNames.delete(sid);
  if (Object.prototype.hasOwnProperty.call(codexTerminalPids, sid)) {
    delete codexTerminalPids[sid];
    if (gState) gState.update("codexTerminalPids", codexTerminalPids);
  }
}

async function restoreCodexTerminals() {
  const byPid = new Map();
  for (const term of vscode.window.terminals) {
    if (term.exitStatus !== undefined) continue;
    let pid; try { pid = await term.processId; } catch (_) { pid = undefined; }
    if (pid) byPid.set(Number(pid), term);
  }
  for (const [sid, pid] of Object.entries(codexTerminalPids)) {
    const term = byPid.get(Number(pid));
    if (term) bindCodexTerminal(sid, term);
    else delete codexTerminalPids[sid];
  }
  if (gState) gState.update("codexTerminalPids", codexTerminalPids);
}

function matchCodexTerminals(sessions, now) {
  const liveTerms = new Set(vscode.window.terminals.filter((t) => t.exitStatus === undefined));
  for (const [sid, term] of codexTerminals) {
    if (!liveTerms.has(term)) forgetCodexTerminal(sid);
  }
  pendingCodexTerminals = pendingCodexTerminals.filter((p) =>
    liveTerms.has(p.term) && now - p.openedAt < 120000);

  const rows = (sessions || []).filter((s) => s.agent === "codex" && s.sid)
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const matched = new Set(codexTerminals.keys());
  // New rollouts first. If two launchers are pending, the rollout belongs to the
  // most recent terminal opened before it, not whichever pending row happens to
  // be iterated first.
  for (const s of rows.filter((r) => !matched.has(r.sid))) {
    const candidates = pendingCodexTerminals.filter((p) =>
      !p.matched && !p.knownTouched.has(s.sid) && (s.startedAt || 0) >= p.openedAt - 2000)
      .sort((a, b) => b.openedAt - a.openedAt);
    if (!candidates.length) continue;
    bindCodexTerminal(s.sid, candidates[0].term);
    matched.add(s.sid);
    candidates[0].matched = true;
  }
  // Never infer an interactive resume from an existing rollout advancing. Any
  // other active GPT session can advance after this terminal opens and would then
  // steal the mapping. Card clicks resume an exact sid explicitly instead.
  pendingCodexTerminals = pendingCodexTerminals.filter((p) => !p.matched);
}

// Resolve each session to the VS Code terminal it runs in and remember the tab
// name, so sessions sharing a cwd stay distinguishable. Throttled.
async function resolveTermNames(sessions) {
  if (Date.now() - termResolveAt < 3000) return;
  termResolveAt = Date.now();
  const terms = vscode.window.terminals;
  if (!terms.length) return;
  const map = getProcMap();
  if (!map.size) return;
  const tpids = [];
  for (const t of terms) {
    let pid; try { pid = await t.processId; } catch (_) { pid = undefined; }
    if (pid) tpids.push({ pid, name: t.name });
  }
  let changed = false;
  for (const s of sessions) {
    if (!s.pid) continue;
    const anc = ancestorsOf(s.pid, map);
    const hit = tpids.find((tp) => anc.has(tp.pid));
    if (hit && termNames.get(s.sid) !== hit.name) { termNames.set(s.sid, hit.name); changed = true; }
  }
  // Pass _metaCache: a meta-less build zeroes every card's summary/lastMsg, which
  // blanks all card bodies for a tick (until the next full refresh) — the "all
  // cards flash together while one works" bug. Term-name resolution must not drop
  // the transcript-derived text.
  if (changed && provider) provider.post(buildSessions(_agentCache, Date.now(), _metaCache));
}

// Resolve a session to its VS Code terminal (pid ancestry, then cwd, then
// only-terminal fallback). Shared by jump and quick-reply.
// Patch 67 (2026-09-15): `strict` = pid ancestry ONLY. A reply typed into a
// cwd-guessed terminal lands in whatever shell happens to be first in the vault
// folder — the user's screenshot showed a prompt executed as a PowerShell command
// ("Make: The term 'Make' is not recognized"). A jump may guess; a send may not.
async function findTerminalFor(session, strict) {
  const terms = vscode.window.terminals;
  if (!terms.length) return null;
  if (session.agent === "codex") {
    const exact = codexTerminals.get(session.sid);
    if (exact && terms.includes(exact) && exact.exitStatus === undefined) return exact;
    forgetCodexTerminal(session.sid);
    return null; // never guess by cwd: every GPT session here shares the same cwd
  }
  if (session.pid) {
    const map = getProcMap();
    if (map.size) {
      const anc = ancestorsOf(session.pid, map);
      // Patch 89: ask every terminal at once, not one round trip each.
      const tpids = await Promise.all(terms.map(async (t) => { try { return await t.processId; } catch (_) { return undefined; } }));
      for (let i = 0; i < terms.length; i++) if (tpids[i] && anc.has(tpids[i])) return terms[i];
    }
  }
  if (strict) return null;
  if (session.cwd) {
    const want = session.cwd.replace(/[\\/]+$/, "").toLowerCase();
    for (const t of terms) {
      const c = t.shellIntegration && t.shellIntegration.cwd && t.shellIntegration.cwd.fsPath;
      if (c && c.replace(/[\\/]+$/, "").toLowerCase() === want) return t;
    }
  }
  if (terms.length === 1) return terms[0];
  return null;
}

async function jumpToTerminal(session) {
  const terms = vscode.window.terminals;
  if (session.agent === "codex") {
    const exact = await findTerminalFor(session);
    if (exact) { exact.show(false); updateActiveSid(); return; }
    // An extension reload or a session resumed from Codex's picker can leave no
    // reliable Terminal object. Open the requested session explicitly rather than
    // guessing among same-folder shells and revealing a blank PowerShell prompt.
    const term = vscode.window.createTerminal(codexTerminalOptions(
      "GPT · " + String(session.name || "session").slice(0, 36),
      session.cwd, session.sid, codexResumePrompt(session)));
    bindCodexTerminal(session.sid, term);
    term.show(false);
    updateActiveSid();
    return;
  }
  // the user 2026-11-09: a click must end with THAT session on the right. Pid match only:
  // the cwd fallback picked any same-folder terminal, i.e. another vault session. On a
  // miss, retry once against a fresh process map before giving up.
  let t = await findTerminalFor(session, true);
  if (!t && session.pid) { await refreshProcMapAsync(); t = await findTerminalFor(session, true); }
  if (t) { t.show(false); updateActiveSid(); return; }
  // No live process anywhere: resume it here. A live one is left alone (running elsewhere;
  // resuming would put two processes on one conversation) and goes to the picker below.
  const pm = getProcMap();   // empty = the process query failed: can't tell, so don't resume
  if (!session.pid || (pm.size && !pm.has(Number(session.pid)))) { resumeSession(session); return; }
  if (!terms.length) {
    vscode.window.showInformationMessage("Overlord: " + (session.name || "that session") + " is running outside this window.");
    return;
  }
  // No pid/cwd match in THIS window — the session likely lives in another
  // Cursor window (VS Code can't focus a terminal across windows). Make the
  // fallback picker useful instead of a blind list: annotate each terminal
  // with its cwd, rank cwd-overlap matches first, and offer the transcript
  // as a first-class escape hatch.
  const want = String(session.cwd || "").replace(/[\\/]+$/, "").toLowerCase();
  const scored = terms.map((tt, i) => {
    const c = tt.shellIntegration && tt.shellIntegration.cwd && tt.shellIntegration.cwd.fsPath || "";
    const cl = c.replace(/[\\/]+$/, "").toLowerCase();
    // 2 = same dir, 1 = one contains the other (parent/subdir), 0 = unrelated
    const score = want && cl ? (cl === want ? 2 : (cl.startsWith(want) || want.startsWith(cl) ? 1 : 0)) : 0;
    return { label: tt.name || ("Terminal " + (i + 1)),
             description: shortCwd(c) || "", t: tt, score };
  }).sort((x, y) => y.score - x.score);
  const items = [];
  if (scored[0] && scored[0].score > 0) {
    items.push({ label: "Likely matches (same folder)", kind: vscode.QuickPickItemKind.Separator });
    items.push(...scored.filter((s) => s.score > 0));
    items.push({ label: "Other terminals", kind: vscode.QuickPickItemKind.Separator });
    items.push(...scored.filter((s) => s.score === 0));
  } else {
    items.push(...scored);
  }
  items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: "$(book) Watch transcript instead", transcript: true });
  const pick = await vscode.window.showQuickPick(items,
    { placeHolder: session.name + " isn't in this window's terminals — pick one, or watch its transcript" });
  // The board lit the clicked card optimistically; re-post so it matches what is shown.
  if (pick && pick.t) pick.t.show(false);
  else if (pick && pick.transcript) openTranscript(session.sid, session.name);
  if (provider) provider.post(buildSessions(_agentCache, Date.now(), _metaCache));
  updateActiveSid();
}

// Which session's terminal is focused right now → the "selected" card. Resolved
// by pid ancestry (same match as findTerminalFor, reversed). Returns null when
// the active terminal isn't a Claude session (or none is focused): no card is lit
// (the user 2026-11-09). undefined = can't tell yet, keep the current one. cachedOnly
// never runs the blocking process query, for the poll.
async function activeSidFor(cachedOnly) {
  const t = vscode.window.activeTerminal;
  if (!t) return null;
  for (const [sid, term] of codexTerminals) if (term === t) return sid;
  let tpid; try { tpid = await t.processId; } catch (_) { tpid = undefined; }
  if (!tpid) return undefined;
  if (cachedOnly && !(procCache.map && procCache.map.size)) return undefined;
  const map = getProcMap();
  if (!map.size) return undefined;
  for (const s of buildSessions(_agentCache, Date.now(), _metaCache)) {
    if (!s.pid) continue;
    if (ancestorsOf(s.pid, map).has(tpid)) return s.sid;
  }
  return null;
}

// Recompute the selected sid from the focused terminal and, if it changed,
// push a fresh model to the webview so the highlight moves.
async function updateActiveSid(cachedOnly) {
  const sid = await activeSidFor(cachedOnly);
  if (sid !== undefined && sid !== activeSid) {
    activeSid = sid;
    if (provider) provider.post(buildSessions(_agentCache, Date.now(), _metaCache));
  }
}

// Quick-reply from a card: type into the session's terminal without leaving
// the board. sendText(text, true) types the text and submits it to the Claude
// Code prompt. No terminal reveal — the card flips to "working" on the next
// poll, which is the feedback.
// Remove a session from the board by ending its process: dispose its terminal
// when we can find it, else kill the claude pid directly. Idle/done sessions
// go without ceremony; working/waiting ones ask first.
// Resume a dormant (restored) session in a fresh terminal — mirrors newSession but
// runs `claude --resume <sid>` in the session's original folder. Same sid (no
// fork), so on the next poll it re-appears as a live card and de-dormants itself.
function codexResumePrompt(session) {
  if (session.state === "done" || session.state === "needs" ||
      !(session.unfinished || session.state === "cutoff")) return "";
  const raw = String(cfg().get("resumeContinuePrompt") || "").trim();
  return raw.toLowerCase() === "off" ? "" : raw || RESUME_CONTINUE_PROMPT;
}

const resuming = new Map();     // sid -> ms of its last resume (patch 89)
function resumeSession(session) {
  if (session && session.agent === "codex") return jumpToTerminal(session);
  const sid = session && session.sid;
  if (!sid) return;
  // Patch 89: the card stays dormant until the next poll, so every click during a host
  // freeze opened another terminal (5e63 resumed 5x in 2 s, 2026-10-09). Once a minute.
  if (Date.now() - (resuming.get(sid) || 0) < 60000) {
    vscode.window.setStatusBarMessage("Overlord: already resuming " + (session.name || "that session") + "…", 5000);
    return;
  }
  resuming.set(sid, Date.now());
  closedParked.delete(sid);
  const snap = boardSnapshot[sid] || {};
  const cwd = session.cwd || snap.cwd || undefined;
  // Open in the terminal PANEL (not the editor area) so a resumed session doesn't
  // spawn a second claude terminal side-by-side with the editor one — it lands in
  // the existing terminal dock instead. (New session + handoff followed, patch 54.)
  const rname = session.name || snap.name || "resumed";
  const term = vscode.window.createTerminal({
    name: rname,
    cwd, location: vscode.TerminalLocation.Panel, ...termStyle(rname),
  });
  term.show();
  // Mirror newSession's launcher (honours overlord.newSessionCommand) + --resume,
  // and re-enable Remote Control (a bare `--resume` drops RC) named after the
  // session so it's phone-reachable + identifiable. sid is a UUID — safe.
  const cmd = cfg().get("newSessionCommand") || "claude";
  const launch = withRemoteControl(cmd + " --resume " + sid + " --permission-mode bypassPermissions", session.name || snap.name);
  // Patch 55 (2026-09-09, the user): a CUT OFF card picks its work back up on click
  // instead of sitting at an empty prompt waiting to be told to carry on. Only
  // "cutoff" — a "needs you" card is waiting on the user's answer and must not be told
  // to continue, and a parked card (state flips to "done") was shelved deliberately.
  // The text rides as the positional [prompt] arg AFTER every flag: a delayed
  // second sendText would race the CLI's startup and land in the SHELL if claude
  // wasn't up yet, which on a big transcript is seconds away. Verified 2026-09-09
  // that `claude --resume <sid> "<prompt>"` parses (it failed on session lookup,
  // not on the argument). Set overlord.resumeContinuePrompt to "" to disable.
  // Setting semantics: unset/empty -> the built-in prompt (VS Code hands back the
  // declared "" default, never undefined, so empty CANNOT mean "off"); the literal
  // "off" -> resume at an empty prompt, the old behaviour; anything else -> that text.
  let text = launch;
  if (session.state === "cutoff") {
    const raw = String(cfg().get("resumeContinuePrompt") || "").trim();
    const p = raw === "" ? RESUME_CONTINUE_PROMPT : raw.toLowerCase() === "off" ? "" : raw;
    if (p) text = launch + ' "' + p.replace(/"/g, "'") + '"';
  }
  term.sendText(text);
}

// 2026-09-28 (the user): Done means finished, so an IDLE Claude session in Done is also
// closed -- with its MCP fleet it held ~1.5 GB for nothing. Called on "Move to done"
// and once per activation for sessions already parked. Busy/waiting sessions and ones
// backing an active loop are left running. The card stays in Done as a dormant card
// (closedParked feeds dormantAgents) and resumes on click. closedParked is set only
// AFTER the tree kill returns, so a poll that still saw it live can't race it back
// out; the terminal is looked up before the kill, while the pid still matches it.
// Patch 84: sweptParked's once-per-activation close of already-parked cards, for Codex.
// Run once its bound terminals are restored -- closeParked disposes the bound one.
function sweepParkedCodex() {
  for (const r of codexCards(Date.now())) if (parked[r.sid]) closeParked(Object.assign({}, r, { state: r.liveState }));
}

// Memory bar actions (the user's plan page + chat, 2026-11-09): the biggest apps by memory, and
// buttons that are disabled while their target is in use. Emulator: no session working and
// under 60 s CPU in 10 min. Browser: tab restore on and not on a call (mic and camera free) --
// not CPU: a runaway graphics process (2.5 cores, 9 Nov) is exactly when a restart helps.
const MEM_NAMES = { "comet.exe": "Comet Browser", "qemu-system-x86_64-headless.exe": "Android emulator",
  "cursor.exe": "Cursor", "claude.exe": "Claude sessions", "chrome.exe": "Chrome Browser", "granola.exe": "Granola",
  "svchost.exe": "Windows services", "python.exe": "Python", "pythonw.exe": "Python", "node.exe": "Node" };
const EMU_EXE = "qemu-system-x86_64-headless.exe", COMET_EXE = "comet.exe";
const COMET_DIR = path.join(process.env.LOCALAPPDATA || "", "Perplexity", "Comet");
const cpuLog = { [EMU_EXE]: [] };   // [ms, total CPU seconds], last ~11 min
let emuPid = 0;
function memTop(cb) {
  cp.execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, maxBuffer: 8e6 }, (err, out) => {
    if (err) return cb(null, 0);
    const by = {};
    for (const line of out.split(/\r?\n/)) {
      const f = line.match(/"([^"]*)"/g); if (!f || f.length < 5) continue;
      const exe = f[0].slice(1, -1).toLowerCase();
      const name = MEM_NAMES[exe] || exe.replace(/\.exe$/, "");
      by[name] = (by[name] || 0) + (parseInt(f[4].replace(/\D/g, ""), 10) || 0);
    }
    const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([name, kb]) => ({ name, mb: Math.round(kb / 1024) }));
    cb(top, Math.round((by["Android emulator"] || 0) / 1024));
  });
}
function sampleCpu(exe, cb) {
  cp.execFile("tasklist", ["/v", "/fo", "csv", "/nh", "/fi", "imagename eq " + exe], { windowsHide: true, maxBuffer: 4e6 }, (err, out) => {
    let total = 0, pid = 0;
    for (const line of (err ? "" : out).split(/\r?\n/)) {
      const f = line.match(/"([^"]*)"/g); if (!f || f.length < 8) continue;
      const [h, m, s] = f[7].slice(1, -1).split(":").map(Number);
      total += h * 3600 + m * 60 + s; pid = pid || Number(f[1].slice(1, -1));
    }
    const now = Date.now();
    cpuLog[exe] = pid ? cpuLog[exe].concat([[now, total]]).filter((x) => now - x[0] <= 11 * 60000) : [];
    if (exe === EMU_EXE) emuPid = pid;
    cb();
  });
}
// CPU seconds a program used over the last `ms`, or null until the log covers that long.
function cpuOver(exe, ms) {
  const log = cpuLog[exe], b = log[log.length - 1], a = b && log.find((x) => b[0] - x[0] <= ms + 15000);
  return a && b[0] - a[0] >= ms - 15000 ? b[1] - a[1] : null;
}
function emuState() {
  if (!emuPid) return { why: "Not running" };
  if ((_lastBoard || []).some((x) => !x.dormant && x.state === "working")) return { why: "A session is working" };
  const c = cpuOver(EMU_EXE, 10 * 60000);
  if (c === null) return { why: "Checking it is idle (10 min)" };
  return c < 60 ? { free: true } : { why: "In use: a walk may be running" };
}
function browserState(cb) {
  let restore = false;
  // Comet's default is "Continue where you left off", and a default is not written to the
  // file (the user's settings screen, 9 Nov): absent means restore is on.
  try { const v = (JSON.parse(fs.readFileSync(path.join(COMET_DIR, "User Data", "Default", "Preferences"), "utf8")).session || {}).restore_on_startup;
    restore = v === undefined || v === 1; } catch (e) {}
  if (!restore) return cb({ why: "Turn on Continue where you left off in the browser first, or tabs are lost" });
  // Windows records each app's mic/camera use; LastUsedTimeStop 0 means in use right now.
  const base = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\";
  let left = 2, call = false;
  for (const cap of ["microphone", "webcam"]) cp.execFile("reg", ["query", base + cap + "\\NonPackaged", "/s"], { windowsHide: true, maxBuffer: 4e6 }, (err, out) => {
    for (const key of (out || "").split(/\r?\n\s*\r?\n/))
      if (/comet\.exe/i.test(key) && /LastUsedTimeStop\s+REG_QWORD\s+0x0\s*$/im.test(key)) call = true;
    if (--left === 0) cb(call ? { why: "On a call: the microphone or camera is in use" } : { free: true });
  });
}

function closeParked(a) {
  // Patch 83: a Codex card's process is its bound terminal (codexTerminals). An idle
  // one is disposed and the card stays a dormant Done card (codexCards reads
  // closedParked); needs-you and working ones keep running, as Claude's do.
  if (a && a.agent === "codex") {
    const t = codexTerminals.get(a.sid);
    if (a.state !== "idle" || !t) return;
    forgetCodexTerminal(a.sid);
    closedParked.add(a.sid);
    t.dispose();
    return;
  }
  if (!a || !a.pid || a.status !== "idle" || !boardSnapshot[a.sessionId] || readLoopMap()[a.sessionId]) return;
  findTerminalFor({ sid: a.sessionId, pid: a.pid }, true).then(t => {
    cp.execFile("taskkill", ["/PID", String(a.pid), "/T", "/F"], { windowsHide: true }, () => {
      closedParked.add(a.sessionId);
      if (t) t.dispose();
    });
  });
}

async function removeSession(session) {
  // Forget the session from the restore snapshot so it can't come back as a dormant
  // card — even if Cursor is quit within a poll of the removal (before snapshotBoard
  // would rebuild). Applies to both a dormant dismiss and a confirmed live kill.
  const forget = () => {
    if (boardSnapshot[session.sid]) { delete boardSnapshot[session.sid]; if (gState) gState.update("boardSnapshot", boardSnapshot); }
    restoreSet.delete(session.sid);
  };
  // Dormant card: no process/terminal to kill — just forget it.
  if (session.dormant) {
    forget();
    if (provider) provider.post(buildSessions(_agentCache, Date.now(), _metaCache));
    return;
  }
  const doKill = async () => {
    forget();
    const t = await findTerminalFor(session, true);   // patch 67: never dispose a guessed terminal
    if (t) { t.dispose(); return; }
    if (session.pid) { try { process.kill(session.pid); } catch (_) { /* already gone */ } }
  };
  // Patch 86: no "It's still working" prompt. The board already held this removal
  // through a 5-second undo before sending it, so a prompt would come after the fact.
  return doKill();
}

async function replyToSession(session, text) {
  text = String(text || "").trim();
  const t = await findTerminalFor(session, true);
  if (!t) {
    vscode.window.showWarningMessage(
      "Overlord: couldn't locate the terminal for " + session.name + " — reply NOT sent (it would have gone to another shell). Jump to it and reply there.");
    return;
  }
  // Empty text is intentional: a bare Enter accepts the default of a native
  // permission dialog (the "Approve ⏎" button).
  t.sendText(text, true);
}

// Patch 52 (2026-09-04): a quick-reply button that says "reload" also reloads the
// Cursor window, AFTER the reply has reached the session — so "Reload now" on a
// card does what it says instead of asking the user to do it by hand. Guarded: with
// persistent terminals off a reload kills every integrated terminal, so while any
// other card is mid-turn it refuses and offers "Reload anyway" in a toast instead.
// A "Skip reload" button says reload too, hence the negative list on the label.
const RELOAD_BTN = /\breload\b/i, RELOAD_NOT = /\b(skip|don'?t|do not|not now|later|no)\b/i;
function wantsReload(msg) {
  return RELOAD_BTN.test(String(msg.label || "") + " " + String(msg.text || "")) &&
         !RELOAD_NOT.test(String(msg.label || ""));
}
async function replyThenReload(session, msg, all) {
  await replyToSession(session, msg.text);
  if (!wantsReload(msg)) return;
  const busy = all.filter((x) => x.sid !== session.sid && !x.dormant && x.state === "working");
  const go = () => setTimeout(() => vscode.commands.executeCommand("workbench.action.reloadWindow"), 600);
  if (!busy.length) { go(); return; }
  const pick = await vscode.window.showWarningMessage(
    "Overlord: " + busy.length + " session" + (busy.length > 1 ? "s" : "") + " still working (" +
    busy.map((x) => x.name).slice(0, 3).join(", ") + ") — a reload cuts them off.", "Reload anyway", "Wait");
  if (pick === "Reload anyway") go();
}

// ---- the Haiku adjudicator + dynamic quick-reply buttons --------------------
// Patch 33 (2026-08-06) INVERTED this. It used to run only after the regex battery
// in agents.js had already ruled "needs you", purely to name the decision and write
// buttons — the dashboard's smartest reader sitting downstream of its dumbest judge.
// Measured, that judge caught 3 of 12 genuinely-blocked sessions, and the misses were
// nine distinct phrasings: enumeration was losing to the tail.
//
// Now one call does both. For a turn-final message the regex battery did NOT flag, it
// also decides the tab; the buttons ride along in the same response, so the marginal
// cost over the old behaviour is only the calls on sessions that turn out to be
// finished. It runs on the user's own `claude` CLI login (no API key).
//
// Precedence is deliberate and one-way: a regex hit is FINAL and promotes instantly
// (free, no spawn latency), and the judge is never asked to demote it — a card that
// flickered Needs-you -> Idle three seconds later would be worse than either judge
// alone. The judge only ever rules on messages the regex layer passed over.
//
// TRANSPORT (measured 2026-08-06, and the reason this isn't a `claude -p` spawn):
//   claude -p, trivial prompt, cwd=vault ......... 12.5s   (CLI boot + CLAUDE.md load)
//   claude -p, trivial prompt, empty cwd + no MCP .. 5.0s
//   claude -p, THIS prompt ...................... 35-42s   (~25k tokens of Claude Code
//                                                           system prompt + tool schemas
//                                                           shipped to classify 4 words)
//   direct Messages API, same prompt ............ 1.3-4.0s  (408 input tokens)
// So the API is the primary transport and the CLI is the fallback. Same OAuth token
// the usage card already uses (readOauth, ~/.claude/.credentials.json, kept fresh by
// Claude Code itself); the token carries a `user:inference` scope, and the Claude Code
// system prompt is required for OAuth-authenticated calls.
const askCache = new Map();   // sid -> {key, pending, ask, buttons}
const judged = new Map();     // sid -> {key, tier, reason} — Haiku verdicts, cached per message
let apiInFlight = 0, cliInFlight = 0;
const JUDGE_MODEL = "claude-haiku-4-5-20251001";

// Cache key: the tail of the closing message. Same message -> never re-judged.
function judgeKey(m) { return String((m && m.lastFull) || "").slice(-400); }

function judgePrompt(text) {
  return 'You triage a dashboard of AI coding sessions. Below is the final message a session wrote before going quiet. Decide what it left for the user, and label reply buttons.\n\n' +
    'Respond with STRICT JSON only, no prose, no code fences:\n' +
    '{"verdict":"blocking|open|none","reason":"<max 5 words>","ask":"<what the user must decide, max 12 words>","buttons":[{"label":"<1-2 words>","send":"<exact short reply to type into the session>"}]}\n\n' +
    'verdict:\n' +
    '- "blocking" — the session CANNOT CONTINUE until the user replies: it asked a question, offered a choice, requested approval, or promised to act once told ("say the word and I\'ll...", "point me at it and I\'ll...").\n' +
    '- "open" — the session FINISHED, but handed over something only the user can close: an action solely theirs (restart, sign, register, send), an unresolved decision, an explicitly flagged loose end.\n' +
    '- "none" — finished work, nothing awaited. A report, a summary, or a status line is "none" even when it mentions unfinished things happening elsewhere or work other people owe. Advice the message itself calls unnecessary ("no action needed") is "none". Text INSIDE a document the session drafted is content, not a request to the user.\n\n' +
    'buttons: 2 or 3, each a DISTINCT action grounded in the message (approve / decline / a named option). First is the primary/affirmative one. For verdict "none", return an empty buttons array.\n---\n' + text;
}

// Primary transport. cb(rawText) on success, cb(null) on ANY failure (no token,
// expired token, network, non-200) so the caller can fall back to the CLI.
// Models that answered "This model does not support the effort parameter". Learned
// at runtime on the first 400 and remembered, so a model that rejects `effort` pays
// the failed round trip once per window rather than on every click — which matters
// as soon as one of the model settings points at Haiku.
// Seeded with the one model verified to reject it (2026-08-06, and again on every
// call of the patch 36 test run), because it is also the DEFAULT simplifyModel — so
// without the seed the first Simplify click of every Cursor window pays two full
// round trips instead of one. Learning still happens at runtime for anything else.
const noEffort = new Set(["claude-haiku-4-5-20251001"]);

function apiCall(model, prompt, maxTokens, cb, opts) {
  const oa = readOauth();                          // re-read every call: Claude Code
  if (!oa || !oa.accessToken) return cb(null);     // refreshes this file in place
  const payload = {
    model,
    max_tokens: maxTokens,
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    messages: [{ role: "user", content: prompt }],
  };
  // output_config carries `effort` and/or a json_schema `format`. Structured output
  // is what makes a JSON answer reliable — see NEXT_STEP_SCHEMA below.
  if (opts && opts.outputConfig) {
    let oc = opts.outputConfig;
    if (oc.effort && noEffort.has(model)) {        // known rejecter: don't send it
      oc = Object.assign({}, oc); delete oc.effort;
    }
    if (Object.keys(oc).length) payload.output_config = oc;
  }
  const body = JSON.stringify(payload);
  let done = false;
  const finish = (v) => { if (!done) { done = true; cb(v); } };
  const req = https.request({
    host: "api.anthropic.com", path: "/v1/messages", method: "POST", timeout: 20000,
    headers: {
      "Authorization": "Bearer " + oa.accessToken,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  }, (r) => {
    let b = ""; r.on("data", (d) => b += d);
    r.on("end", () => {
      if (r.statusCode !== 200) {
        // `effort` is not accepted by every model — Haiku 4.5 rejects it outright
        // ("This model does not support the effort parameter", verified 2026-08-06).
        // Both models here are user-configurable settings, so rather than hard-coding
        // which tier takes which field, drop `effort` and retry once. Without this,
        // pointing overlord.adviseModel at haiku would make the button error forever.
        if (r.statusCode === 400 && /effort/i.test(b) && opts && opts.outputConfig
            && opts.outputConfig.effort && !noEffort.has(model)) {
          noEffort.add(model);                     // remember, so this costs once
          return apiCall(model, prompt, maxTokens, cb, opts);
        }
        return finish(null);
      }
      try {
        const j = JSON.parse(b);
        finish((j.content || []).filter((x) => x.type === "text").map((x) => x.text).join(""));
      } catch (_) { finish(null); }
    });
  });
  req.on("error", () => finish(null));
  req.on("timeout", () => { req.destroy(); finish(null); });
  req.end(body);
}

function judgeViaApi(prompt, cb) {
  apiCall(cfg().get("judgeModel") || JUDGE_MODEL, prompt, 400, cb);
}

// Fallback transport: slow (see the table above) but it does its own auth, so it
// still works when the cached OAuth token has expired and nothing has refreshed it.
function judgeViaCli(prompt, cb) {
  const bin = cfg().get("claudePath") || "claude";
  // ⛔ Strip the API key: it is a persistent User env var on this machine, and a
  // child that inherits it bills API credits instead of the Max subscription.
  const env = Object.assign({}, process.env);
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  const child = cp.exec(`"${bin}" -p --model haiku`,
    { timeout: 90000, windowsHide: true, maxBuffer: 1024 * 1024, env },
    (err, stdout) => cb(err ? null : String(stdout)));
  try { child.stdin.write(prompt); child.stdin.end(); } catch (_) { cb(null); }
}

// judgeToo=false -> buttons only (the regex already decided; don't touch the tab).
// judgeToo=true  -> this message is unflagged and turn-final: decide the tab too.
function judgeAndAsk(sid, m, judgeToo) {
  const text = (m && m.lastFull) || "";
  if (!text) return;
  const key = judgeKey(m);
  const c = askCache.get(sid);
  if (c && c.key === key) return;                    // already generated / generating
  if (apiInFlight + cliInFlight >= 4) return;        // cap concurrency; retry next tick
  askCache.set(sid, { key, pending: true, ask: null, buttons: null });

  // FAIL-SAFE throughout: a failed call, a timeout or a malformed reply leaves the
  // regex verdict standing. The board can never be made WORSE than the free layer.
  const finish = (raw) => {
    const cur = askCache.get(sid);
    if (!cur || cur.key !== key) return;
    cur.pending = false;
    if (raw == null) return;
    try {
      const match = String(raw).match(/\{[\s\S]*\}/);
      const o = JSON.parse(match ? match[0] : "");
      if (!o) return;
      if (judgeToo) {
        const v = o.verdict === "blocking" || o.verdict === "open" ? o.verdict : null;
        const reason = typeof o.reason === "string" && o.reason.trim()
          ? o.reason.trim().slice(0, 40)
          : (v === "open" ? "left you an open item" : "awaiting your reply");
        judged.set(sid, { key, tier: v, reason });   // tier null = judged and cleared
      }
      if (Array.isArray(o.buttons) && o.buttons.length) {
        cur.ask = typeof o.ask === "string" ? o.ask.slice(0, 140) : null;
        cur.buttons = o.buttons.slice(0, 3)
          .filter((b) => b && b.label && typeof b.send === "string")
          .map((b) => ({ label: String(b.label).slice(0, 18), send: String(b.send).slice(0, 200) }));
      }
      if (provider) provider.post(buildSessions(_agentCache, Date.now(), _metaCache));
    } catch (_) { /* malformed -> regex verdict stands, card keeps its summary */ }
  };

  const prompt = judgePrompt(text);
  apiInFlight++;
  judgeViaApi(prompt, (raw) => {
    apiInFlight--;
    if (raw != null) return finish(raw);
    // API unavailable — spawn the CLI, but keep spawns scarcer than HTTP calls.
    if (cliInFlight >= 2) return finish(null);
    cliInFlight++;
    judgeViaCli(prompt, (out) => { cliInFlight--; finish(out); });
  });
}

// ---- card assist: Simplify / Next step (patch 35) ---------------------------
// Two per-card buttons. Both are SIDE CALLS on the transcript — they never type into
// the session, so reading one costs it no turn, no context and no history. Both read
// `transcript.readRecent()` (last ~5 exchanges), not the closing message, because
// "8 fixes shipped" can be summarised but not explained.
//
// Prompt design follows the 2026 guidance rather than the folklore:
//   - NO role-play ("act as a teacher…"). Anthropic's current advice is that heavy
//     role prompting is unnecessary and that stating the perspective plainly beats it,
//     so the prompts name exactly who reads this and what they already know.
//   - "Explain like I'm five" is deliberately NOT used. Simplified-language prompts
//     measurably strip hedges and alternative readings from model output (arXiv
//     2507.11981, "Simplifications are Absolutists"), which for a button whose whole
//     job is building an accurate mental model is the exact failure to avoid. So the
//     prompt constrains VOCABULARY and explicitly protects CERTAINTY.
//   - Say what to do, not what not to do; constrain length and shape explicitly.
const ASSIST_AUDIENCE =
  'The reader owns this work: a product designer, fluent in product, design and AI tooling, who has not written production code. He acts on what you tell him, so it has to be true, not merely clear.';

// Simplify's ANSWER SHAPE was rebuilt 2026-08-07 (patch 36). v1 asked for "3 to 5
// sentences of plain prose" and shipped a wall: measured on a real card, 154 words in
// 5 sentences — 30.8 words per sentence against a 15-20 plain-language target, one
// sentence of 46 words, at ~90 characters per line. The cap was the cause: it
// constrained the sentence COUNT, not the volume, so a paragraph's worth of content
// was loaded into five sentences until it fit.
//
// Bulleting it — the obvious fix — is the one thing that must NOT happen here.
// Bullets strip the connectives (though / because / rather than) that carry causal
// relationships, and causal cohesion is what carries comprehension; the value of a
// line like "registered and usable, THOUGH nested scrollers stop the sweep, and that
// was documented RATHER THAN worked around" is entirely in those joins. So the fix is
// prose, chunked and shortened, with the uncertainty moved somewhere it cannot be
// skimmed past:
//   A  budget WORDS, not sentences
//   C  2-3 short prose chunks instead of one block
//   D  each chunk labelled, with an emoji chosen for what that chunk actually says
//   E  everything unresolved breaks out into its own rail, rendered apart
//
// A is PER-FIELD, and that detail is the whole of it. The first build wrote the same
// budget as an aggregate — "at most 110 words across every field, sentences under 25"
// — and measured 139 words average, one answer at 190, and a 47-word sentence: WORSE
// than the 46-word baseline it was replacing. Restating the identical budget as a
// limit on each field ("body: at most 35 words, sentences under 20"; "caveat: one
// sentence, at most 30") fixed it in a single pass, to 103 words and 14.4 per
// sentence. Per-field limits bind; aggregate ones read as advice.
//
// E is load-bearing, not decoration. Shortening and structuring both push a model
// toward confidence (LLMs overgeneralise their source in 26-73% of cases, and hedged
// wording survives while the SCOPE quietly widens), so the hedges get a dedicated slot
// where they stop competing with the narrative for the word budget and an omission
// shows up as an empty rail instead of a silent rounding-up.
//
// The label and icon are per-session, not a fixed BUILT/FOUND/CAVEAT triptych. Fixed
// slots invite a model to fill them, and an invented "Not settled" is exactly the
// failure this panel exists to avoid. The one deliberate exception is the caveat rail
// itself, whose heading is always the same words — its job is to be recognisable at a
// glance, which a rotating label would cost it.
const SIMPLIFY_ICONS = ['🔨', '🔧', '🐛', '🔍', '🧪', '✅', '📊', '🗑️', '📝', '🔀', '🚀', '🔗', '⚙️', '🧹'];
const SIMPLIFY_ICON_SET = new Set(SIMPLIFY_ICONS);
const SIMPLIFY_ICON_FALLBACK = ['🔨', '🔍', '📝'];

function simplifyPrompt(digest) {
  return 'Below is a digest of the recent work in one AI coding session.\n\n' + ASSIST_AUDIENCE + '\n\n' +
    'Explain what this session has done. The response format is enforced by a schema, so put the answer in its fields rather than describing it.\n\n' +
    '"sections" holds 2 or 3 blocks, ordered the way he needs them: what the session built or changed first, then what came of it, then a third only if something genuinely stands apart from both.\n' +
    '"body" is 2 or 3 sentences and AT MOST 35 WORDS. Every sentence stays under 20 words. Keep the joining words — though, because, so, rather than, since — that show how the facts relate; they are the reason this is prose and not a list. Cut detail to make the limit; do not run sentences together to fit more in.\n' +
    '"label" is a NAME for the block, 1 to 3 words and AT MOST 20 CHARACTERS: "Built", "What it found", "Measured first", "Two retired". If it wants a verb and an object and a qualifier, that belongs in the body, not the label.\n' +
    '"icon" is the one emoji from this list that fits that block: ' +
      '🔨 built · 🔧 fixed · 🐛 bug found · 🔍 investigated · 🧪 tested · ✅ verified · 📊 measured · 🗑️ removed · 📝 documented · 🔀 refactored · 🚀 shipped · 🔗 wired up · ⚙️ configured · 🧹 cleaned up\n' +
    '"caveat" holds what is NOT settled: whatever the session left unverified, partial, intermittent, assumed or knowingly incomplete, in one sentence of AT MOST 30 WORDS and in the session\'s own terms. It renders apart from the prose so it cannot be skimmed past. Return an empty string only when the digest genuinely shows nothing unresolved, and never invent an open question to fill it.\n\n' +
    'Use the vocabulary he already has: a word he would hear in a standup (deploy, commit, API, cache, hook, branch) needs no explanation, and anything below that level (thread, executor, race condition, stdout, mutex) is either replaced with plain words or explained in the same sentence.\n' +
    'A hedge that qualifies one specific claim stays attached to that claim inside the prose — "12 previously undocumented gaps", "passes on the two screens that were checked". The caveat field is for what is unresolved overall, and having it is not permission to state anything else more confidently than the digest does. Do not round an uncertain result up to a clean one, and do not present a fix as confirmed unless the digest shows it was checked.\n' +
    'Lead with what changed and what it means for him. Include mechanism only where he would need it to make a decision.\n' +
    'The per-field limits above are the budget; together they land near 100 words, which is the whole answer. Write short, complete sentences of plain prose — not clipped fragments and not bullet points.\n' +
    'If the digest does not actually show what was done, say that plainly in a single section instead of guessing.\n\n---\n' + digest;
}

// Same reasoning as NEXT_STEP_SCHEMA: the shape is ENFORCED, not requested in prose.
// `icon` is deliberately a plain string rather than a schema enum — the emoji list is
// taught in the prompt and validated in parseSimplify instead, so an unsupported
// keyword can never turn a working button into a 400, and an off-list icon degrades
// to a positional default rather than failing the whole answer.
const SIMPLIFY_SCHEMA = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: { icon: { type: "string" }, label: { type: "string" }, body: { type: "string" } },
        required: ["icon", "label", "body"],
        additionalProperties: false,
      },
    },
    caveat: { type: "string" },
  },
  required: ["sections", "caveat"],
  additionalProperties: false,
};

// Labels get clamped on a WORD boundary, never mid-word. First live run produced
// "CAUGHT THE DEPENDENCY TRAP T" and "SENT OPENING OFFER AND LOGGE" — a plain
// .slice() turns a model that over-wrote its label into a card that looks broken.
// The prompt asks for 1-3 words; this is the backstop for when it doesn't comply.
function clampLabel(s) {
  s = String(s || "").trim().replace(/\s+/g, " ").replace(/[.:;,]+$/, "");
  if (s.length <= 22) return s;
  const words = s.split(" ");
  let out = "";
  for (const w of words) {
    if (out && (out + " " + w).length > 22) break;
    out = out ? out + " " + w : w;
  }
  return (out || words[0].slice(0, 22)) + "…";
}

// Returns {sections, caveat} or null. Null is not an error state — the caller falls
// back to rendering the raw text as prose, because a schema hiccup should cost the
// formatting, never the answer.
function parseSimplify(raw) {
  try {
    const m = String(raw).match(/\{[\s\S]*\}/);
    const o = JSON.parse(m ? m[0] : "");
    const sections = (Array.isArray(o.sections) ? o.sections : []).slice(0, 3)
      .filter((x) => x && typeof x.body === "string" && x.body.trim())
      .map((x, i) => ({
        icon: SIMPLIFY_ICON_SET.has(String(x.icon || "").trim())
          ? String(x.icon).trim() : (SIMPLIFY_ICON_FALLBACK[i] || "•"),
        label: clampLabel(x.label),
        body: String(x.body).trim().slice(0, 600),
      }));
    if (!sections.length) return null;
    return { sections, caveat: String(o.caveat || "").trim().slice(0, 320) };
  } catch (_) { return null; }
}

function nextStepPrompt(digest) {
  return 'Below is a digest of the recent work in one AI coding session.\n\n' + ASSIST_AUDIENCE + '\n\n' +
    'Work out what should happen next. The response format is enforced by a schema, so put the answer in its fields rather than describing it.\n\n' +
    '"you" holds only steps the human can take and the session cannot: a decision, an approval, a credential, something to run or check on his own machine, a judgment call.\n' +
    '"session" holds the logical next work in this thread, each phrased as an instruction that could be sent straight to the session.\n' +
    'Return an EMPTY array for either key when there is genuinely nothing for it. A finished session that owes nothing returns {"you":[],"session":[]}, and that is a correct and expected answer. Never invent a step to fill a slot, never pad with generic advice such as "add tests" or "monitor for issues", and never restate work the digest shows as already done.\n' +
    'At most 3 entries per key, most important first: something blocking or decaying outranks something merely possible.\n' +
    '"step" is an imperative under 14 words. "why" is one short clause, grounded in something the digest actually says.\n\n---\n' + digest;
}

// The Next-step answer is a SCHEMA, not a request for well-behaved prose. First
// build asked for "STRICT JSON only" in the prompt and 2 of 3 live sessions came
// back unparseable — Sonnet 5 runs adaptive thinking by default, `max_tokens` caps
// thinking AND response text together, so a 700-token budget was spent thinking and
// the JSON arrived empty or cut mid-object. Two fixes, both needed: a real token
// budget, and `output_config.format`, which constrains the response to this schema
// instead of hoping the prose instruction holds.
const NEXT_STEP_SCHEMA = {
  type: "object",
  properties: {
    you: {
      type: "array",
      items: {
        type: "object",
        properties: { step: { type: "string" }, why: { type: "string" } },
        required: ["step", "why"],
        additionalProperties: false,
      },
    },
    session: {
      type: "array",
      items: {
        type: "object",
        properties: { step: { type: "string" }, why: { type: "string" } },
        required: ["step", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["you", "session"],
  additionalProperties: false,
};

// sid|kind -> {msgKey, pending, text?, you?, session?, error?}. Keyed on the message
// so a click is spent once per turn; the next turn invalidates it.
const assistCache = new Map();
let assistInFlight = 0;

function assistRead(sid) {
  const p = transcriptPath(sid);
  if (!p) return "";
  try {
    const size = fs.statSync(p).size;
    const len = Math.min(size, 200 * 1024);       // deeper than the 64KB poll read;
    const fd = fs.openSync(p, "r");               // this runs on a click, not a tick
    const buf = Buffer.alloc(len);
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    return T.readRecent(buf.toString("utf8"), { maxTurns: 5 });
  } catch (_) { return ""; }
}

function runAssist(sid, kind, msgKey, webview) {
  const ck = sid + "|" + kind;
  const hit = assistCache.get(ck);
  if (hit && hit.msgKey === msgKey) {                 // already answered for this turn
    if (!hit.pending) webview.postMessage(Object.assign({ type: "assist", sid, kind }, hit));
    return;
  }
  if (assistInFlight >= 3) {
    webview.postMessage({ type: "assist", sid, kind, error: "busy — try again in a moment" });
    return;
  }
  const digest = assistRead(sid);
  if (!digest) {
    webview.postMessage({ type: "assist", sid, kind, error: "no transcript to read yet" });
    return;
  }
  const entry = { msgKey, pending: true };
  assistCache.set(ck, entry);
  assistInFlight++;
  const isSimplify = kind === "simplify";
  const model = isSimplify ? (cfg().get("simplifyModel") || "claude-haiku-4-5-20251001")
                           : (cfg().get("adviseModel") || "claude-sonnet-5");
  // Next step budgets 2500 because thinking is billed against max_tokens too, and
  // runs at `low` effort. That was measured, not assumed (2026-08-06, same three live
  // sessions, same prompt and schema):
  //   sonnet-5 medium, 5 turns .... 7.6s   12 suggestions
  //   sonnet-5 low,    5 turns .... 5.4s   10   <- shipped
  //   sonnet-5 low,    3 turns .... 6.6s    9   (a smaller digest buys nothing)
  //   haiku,           3 turns ... 11.2s   11
  // The lever is EFFORT, not the model tier: dropping to Haiku made the button
  // SLOWER on this workload, because the cost is the 6KB digest and the thinking,
  // not the tier. Low still ranks well here — picking the top 2-3 items out of a
  // digest is not the kind of task that needs deep deliberation.
  // Simplify carries a schema too since patch 36. Its budget went 700 -> 1400 for the
  // same reason Next step needs 2500: max_tokens caps thinking AND response together,
  // and a structured answer costs more of it than loose prose did. `effort` stays on
  // both — apiCall drops it and retries once for a model that rejects it (Haiku 4.5
  // does), keeping `format` intact on the retry.
  const opts = isSimplify
    ? { outputConfig: { effort: "low", format: { type: "json_schema", schema: SIMPLIFY_SCHEMA } } }
    : { outputConfig: { effort: "low", format: { type: "json_schema", schema: NEXT_STEP_SCHEMA } } };
  apiCall(model, isSimplify ? simplifyPrompt(digest) : nextStepPrompt(digest),
    isSimplify ? 1400 : 2500, (raw) => {
      assistInFlight--;
      entry.pending = false;
      // No CLI fallback here, unlike the judge: this is an interactive click, and a
      // 40s spawn behind a spinner is worse than saying so straight away.
      if (raw == null) {
        entry.error = "model unreachable — your Claude Code login may need a refresh";
      } else if (isSimplify) {
        const parsed = parseSimplify(raw);
        if (parsed) { entry.sections = parsed.sections; entry.caveat = parsed.caveat; }
        else entry.text = String(raw).trim();   // schema slipped: show the prose anyway
      } else {
        try {
          const m = String(raw).match(/\{[\s\S]*\}/);
          const o = JSON.parse(m ? m[0] : "");
          const clean = (arr) => (Array.isArray(arr) ? arr : []).slice(0, 3)
            .filter((x) => x && typeof x.step === "string" && x.step.trim())
            .map((x) => ({ step: String(x.step).slice(0, 160), why: String(x.why || "").slice(0, 160) }));
          entry.you = clean(o.you);
          entry.session = clean(o.session);
        } catch (_) { entry.error = "couldn't read the model's answer"; }
      }
      if (webview) webview.postMessage(Object.assign({ type: "assist", sid, kind }, entry));
    }, opts);
}

// A tap on the screen: reveal the session's terminal AND raise the VS Code
// window (best-effort). Looks the session up in the freshest built model.
function handleDeviceJump(sid) {
  const s = buildSessions(_agentCache, Date.now()).find((x) => x.sid === sid);
  if (!s) return;
  jumpToTerminal(s);
  raiseVSCodeWindow();
}

// ---- sound -----------------------------------------------------------------
function playSound() {
  if (!cfg().get("sound")) return;
  const wav = path.join(__dirname, "media", "notify.wav");
  let haveWav = false; try { haveWav = fs.existsSync(wav); } catch (_) {}
  try {
    if (process.platform === "win32") {
      const ps = haveWav
        ? "$p=New-Object Media.SoundPlayer '" + wav.replace(/'/g, "''") + "';$p.PlaySync()"
        : "[console]::beep(880,120)";
      cp.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true });
    } else if (process.platform === "darwin") {
      cp.spawn("afplay", [haveWav ? wav : "/System/Library/Sounds/Ping.aiff"]);
    } else if (haveWav) {
      cp.spawn("aplay", ["-q", wav]);
    }
  } catch (_) { /* sound is optional */ }
}

// Fire a Windows OS-level toast via the user's Claude Code notify script, so a
// "needs you" alert shows even when Cursor is in the background (the built-in
// showWarningMessage popup only appears inside the Cursor window). Reuses
// ~/.claude/hooks/claude-notify.ps1 (same AUMID/icon), passing the session name
// as the toast body. Gated on overlord.osToast; win32 only.
// sid (2026-07-20): the real Claude Code session_id, when known, so the toast's
// click-through can jump to the EXACT terminal via overlord-focus.trigger instead
// of only doing a coarse Cursor-window-level AppActivate.
// cwd (2026-07-20): the session's real working directory. This spawned process has
// no CLAUDE_PROJECT_DIR of its own, so without this claude-notify.ps1's window-title
// search term would resolve to Cursor's own install dir instead of the actual project.
// kind "done" (2026-07-27): the finished toast. Claude Code's own Stop hook can't
// serve this — it exits early by design (toast-audit 2026-07-19) because it fires
// for every session end including headless `claude -p` runs, with no session name.
// Overlord's is filtered (on-board sessions only) and latched (one per episode), so
// claude-notify.ps1 lets it through on -Force. Needs-you has its own switch
// (osToastInput) since Claude Code's Notification hook already toasts that event —
// leave it off to avoid a double toast.
//
// RATE LIMIT (2026-07-27) — the structural backstop. Three separate storms in
// three weeks (patch 24a needs-you flicker, 24b headless finished, 27 duplicate
// sid) all produced the SAME symptom: one toast per poll, forever, because the
// alerts assume the status machine never oscillates and nothing caps them if it
// does. Each was fixed by removing its cause; this caps the blast radius of the
// next cause we haven't met yet. A future oscillation now costs one toast per
// session per TOAST_COOLDOWN_MS instead of one every 2.5s, and the global burst
// cap stops many sessions oscillating at once from adding up to a storm.
// Deliberately NOT applied to the in-Cursor pop-ups — those are one window's
// notification list, dismissible in one click, and the user runs them off anyway.
// The per-key gap ESCALATES, but only when the alert is actually STORMING —
// measured by whether anything was suppressed since the last one got through,
// not by elapsed time. That distinction is what keeps legitimate repeats intact:
// a session that genuinely finishes every few minutes never trips the floor, so
// it never suppresses anything, so it never escalates. A poll-rate oscillation
// suppresses constantly and climbs 15s · 30s · 60s · 2m · 5m within a few minutes.
const TOAST_COOLDOWN_MS = 15000;         // floor: same session + kind
// The ceiling sets BOTH the worst-case storm rate (30/h for one session) and the
// worst-case delay on a genuine alert while a storm is in progress. 2 min favours
// the second: a storm is a bug you'll fix, a late "needs you" is a daily cost.
const TOAST_COOLDOWN_MAX_MS = 120000;    // ceiling for a sustained storm
const TOAST_BURST_MAX = 6;               // across all sessions...
const TOAST_BURST_WINDOW_MS = 60000;     // ...at most 6 per minute
const _toastAt = new Map();              // "kind|sid" -> { at, streak, suppressed }
let _toastBurst = [];                    // ms timestamps inside the burst window
let _burstLoggedAt = 0;
function toastAllowed(kind, sid, label) {
  const now = Date.now();
  for (const [k, v] of _toastAt) if (now - v.at > 600000) _toastAt.delete(k);   // bounded by session count anyway
  const key = kind + "|" + (sid || label || "");
  const rec = _toastAt.get(key);
  let streak = 0;
  if (rec) {
    const need = Math.min(TOAST_COOLDOWN_MS * Math.pow(2, rec.streak), TOAST_COOLDOWN_MAX_MS);
    if (now - rec.at < need) { rec.suppressed++; return false; }
    // Got through after suppressing something -> it's repeating faster than the
    // floor allows, i.e. storming. Otherwise it's a normal cadence: reset.
    streak = rec.suppressed > 0 ? rec.streak + 1 : 0;
  }
  _toastBurst = _toastBurst.filter((t) => now - t < TOAST_BURST_WINDOW_MS);
  if (_toastBurst.length >= TOAST_BURST_MAX) {
    // Log once a minute rather than per suppressed toast — a storm would spam this too.
    if (now - _burstLoggedAt > 60000) {
      _burstLoggedAt = now;
      console.warn(`[overlord] OS toast burst cap hit (${TOAST_BURST_MAX}/min) — suppressing until it settles. Last: ${kind} ${label || sid || "?"}`);
    }
    return false;
  }
  _toastAt.set(key, { at: now, streak, suppressed: 0 });
  _toastBurst.push(now);
  return true;
}

function osToast(kind, label, sid, cwd) {
  if (process.platform !== "win32") return;
  if (cfg().get("osToast") === false) return;
  if (kind !== "done" && kind !== "pace" && cfg().get("osToastInput") === false) return;
  if (!toastAllowed(kind, sid, label)) return;
  const script = path.join(os.homedir(), ".claude", "hooks", "claude-notify.ps1");
  try {
    if (!fs.existsSync(script)) return;
    const title = kind === "pace" ? "Claude weekly limit" : kind === "done" ? "Overlord — finished" : "Overlord — needs you";
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, "-Kind", kind === "pace" ? "done" : kind, "-Title", title, "-Body", String(label || "session"),
    ];
    if (kind === "done" || kind === "pace") args.push("-Force");
    if (sid) args.push("-Sid", String(sid));
    if (cwd) args.push("-Cwd", String(cwd));
    // stdio "ignore" on stdin: claude-notify.ps1 never reads stdin itself (only the
    // Claude-Code-hook entry point does, where Claude Code pipes+closes it) — this
    // just guarantees an unclosed pipe here can never make the script hang.
    cp.spawn("powershell.exe", args, { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] });
  } catch (_) { /* toast is optional */ }
}

// A slash-command UI that THE USER opened himself (/btw, /model, /config, …) makes
// Claude Code report the session as `waiting` with waitingFor "dialog open" —
// the CLI's own `isShowingLocalJSXCommand` branch. That is NOT "the session
// needs you": he's sitting right there, and a `/btw` typed mid-turn used to
// yank a WORKING card into "Needs you" (+ toast) until he pressed Esc.
// Real attention states are unaffected: permission prompts report their own
// reason ("permission prompt" / mapped dialog kind), and sandbox/elicitation/
// worker waits have distinct strings — only the generic "dialog open" is masked.
// Masking = keep the session in the status it had BEFORE the dialog opened, so
// the card stays in its former tab; unknown (first tick) falls back to idle.
const SELF_DIALOG_WAIT = "dialog open";
function maskSelfOpenedDialogs(agents) {
  for (const a of agents || []) {
    if (a.status !== "waiting" || a.waitingFor !== SELF_DIALOG_WAIT) continue;
    a.status = prevStatus[a.sessionId] || "idle";   // prevStatus already holds the masked value while the dialog stays open
    delete a.waitingFor;
  }
}

// Patch 87: the start of a status this run never saw begin (first sight, i.e. after a
// reload), from the transcript rather than from now: a busy session from its last
// prompt, a stopped one from the transcript's last write (the turn's end, or the dialog
// it opened). Unknown -> 0, and the card shows its state without a time.
function firstSince(status, m, now) {
  const t = status === "busy" ? m.lastPromptAtMs : m.mtimeMs;
  return t > 0 && t <= now ? t : 0;
}

// ---- poll + render ---------------------------------------------------------
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    const res = await getAgents();
    const now = Date.now();
    if (!res.ok) {
      lastError = res.err;
      _agentCache = [];
      renderStatus([]);
      // Keep the Codex half visible even when Claude's CLI is unavailable.
      // The two readers are independent; a Claude poll failure must not blank
      // sessions that are already available from ~/.codex/sessions.
      if (provider) provider.post(hideEngagedPredecessors(codexCards(now)), errorText(res.err));
      return;
    }
    lastError = null;
    // Re-resolve the on-screen session each poll: a resumed terminal's claude starts
    // after the focus event, so its card lights here, not on the focus change.
    updateActiveSid(true);
    // Dedupe at the SOURCE (2026-07-27). `dedupeBySid` used to run only inside
    // buildSessions, so the BOARD saw one card while the notify loop below still
    // iterated both raw records — and two live processes sharing a sessionId with
    // DIFFERENT statuses (busy + idle) made it toast "needs you" on every single
    // poll: the busy record re-armed `notifiedWait`, the idle one (promoted to
    // waiting by detectTypedQuestions) fired it again, ~every 2.5s, forever.
    // Patch 24's on-board gate can't catch this — it looks the session up by sid,
    // and the duplicate's sid IS on the board. One record per sid, everywhere.
    res.agents = dedupeBySid(res.agents);
    // A session the process map has not seen yet would make its card click wait for a refresh:
    // refresh in the background now instead (2026-11-09).
    if (procCache.map && Date.now() - procCache.at > 10000 &&
        res.agents.some((a) => a.pid && !procCache.map.has(Number(a.pid)))) refreshProcMapAsync();
    maskSelfOpenedDialogs(res.agents);
    _agentCache = res.agents;
    // First poll after activation: close idle sessions that were parked before
    // closeParked existed, or resumed from Done and left idle (patch 2026-09-28).
    if (!sweptParked) { sweptParked = true; for (const a of res.agents) if (parked[a.sessionId]) closeParked(a); }

    // One tail read per session -> feeds both "needs you" detection and the card
    // sub-line (model / ctx / activity), so we never read a transcript twice a tick.
    const meta = {};
    for (const a of res.agents) meta[a.sessionId] = readMeta(a.sessionId);
    // Also read transcripts for DORMANT sessions (in the snapshot but not live) so
    // their restored cards show real content/title from where they left off.
    const liveSids = new Set(res.agents.map((a) => a.sessionId));
    // Not Codex entries (patch 80): each one re-walked ~/.claude/projects every poll.
    for (const sid in boardSnapshot) { if (!liveSids.has(sid) && !meta[sid] && !isCodexSnap(sid)) meta[sid] = readMeta(sid); }
    _metaCache = meta;

    // A session whose TURN IS OVER but which still holds a background shell or a
    // background subagent is reported "busy" by Claude Code — see agents.js
    // maskFinishedTurns. Demote it to idle here, and the placement is the fix:
    //   AFTER  meta      — the mask reads the transcript tail
    //   BEFORE line ~1390 — so it enters the two-tier needs-you promotion and the
    //                       Haiku judge (both skip anything that isn't idle), which
    //                       is how a finished turn that asks something reaches the
    //                       Needs-you tab instead of vanishing into "working"
    //   BEFORE line ~1424 — so statusSince resets when the TURN ends (the idle clock
    //                       starts at the right moment) and the busy->idle edge fires
    //                       the "finished" toast then too, which is now correct: the
    //                       agent did finish. If the bg job later wakes the model, the
    //                       re-arm at `status === "busy"` lets it toast again.
    if (cfg().get("maskFinishedTurns") !== false) A.maskFinishedTurns(res.agents, meta);

    // Recover idle sessions that actually await you (a typed question or an
    // approval request). Mutate before transition tracking so a busy->awaiting
    // change still fires the "needs you" alert.
    // Two-tier promotion. The free regex battery rules first and instantly; where it
    // found nothing, a cached Haiku verdict (from the previous tick's judgeAndAsk)
    // can still promote. `tier` rides along: "blocking" = cannot continue without
    // the user, "open" = finished but left him an item. Both live in the Needs-you tab;
    // only "blocking" pulses and toasts.
    if (cfg().get("detectTypedQuestions") !== false) {
      for (const a of res.agents) {
        if (a.status !== "idle") continue;
        const m = meta[a.sessionId] || {};
        let tier = m.awaitTier, reason = m.awaitReason;
        if (!tier && cfg().get("judgeWithHaiku") !== false) {
          const j = judged.get(a.sessionId);
          if (j && j.key === judgeKey(m) && j.tier) { tier = j.tier; reason = j.reason; }
        }
        if (tier) { a.status = "waiting"; a.waitingFor = reason; a.tier = tier; a.via = m.awaitTier ? "regex" : "judge"; }   // via: patch 87
      }
    }

    // One Haiku call per closing message, doing double duty (see judgeAndAsk):
    //   waiting + transcript-derived -> buttons only, the tab is already decided
    //   waiting + native dialog      -> canned "Approve ⏎" (text can't drive a menu)
    //   idle + turn-final            -> the judge: decides the tab AND writes buttons
    // Anything else (mid-turn narration, a session still streaming) is never judged,
    // which is what keeps the call volume close to the old behaviour.
    const judgeOn = cfg().get("judgeWithHaiku") !== false;
    for (const a of res.agents) {
      const m = meta[a.sessionId] || {};
      if (a.status === "waiting") {
        if (m.awaitReason || a.tier) judgeAndAsk(a.sessionId, m, false);
        else askCache.set(a.sessionId, { key: "native", pending: false,
          ask: a.waitingFor || "Approval needed in the terminal",
          buttons: [{ label: "Approve ⏎", send: "" }] });
      } else if (a.status === "idle" && judgeOn && m.turnFinal) {
        judgeAndAsk(a.sessionId, m, true);
      } else {
        askCache.delete(a.sessionId);
      }
    }

    const curSids = new Set();
    for (const a of res.agents) {
      curSids.add(a.sessionId);
      restoreSet.delete(a.sessionId);   // it's live now — no longer a dormant candidate
      if (prevStatus[a.sessionId] !== a.status)
        statusSince[a.sessionId] = prevStatus[a.sessionId] === undefined ? firstSince(a.status, meta[a.sessionId] || {}, now) : now;
      if (prevStatus[a.sessionId] === "busy" && a.status === "idle") finishedAt[a.sessionId] = now;
      // Un-park only when the session goes BUSY — i.e. you actually continued it.
      // (Was `!== "idle"`, which cleared the flag for a parked "needs you" card,
      // since needs = waiting; that broke Move-to-done on needs cards.)
      // A handed-off session is exempt on its handoff turn: on the /handoff command
      // path it parks itself while still BUSY finishing that very turn, so the next
      // tick read its own busy-ness as "the user continued it" and un-parked it straight
      // back onto the board — the successor and its predecessor both showing. A
      // LATER turn (prompt newer than the handoff) is the user continuing it, and does
      // un-park (patch 59, 2026-09-14) — A.shouldUnpark holds the rule.
      if (A.shouldUnpark(a.status, !!parked[a.sessionId], handedOff(a.cwd, a.sessionId),
                         handoffAtMs(a.cwd, a.sessionId), (meta[a.sessionId] || {}).lastPromptAtMs,
                         prevStatus[a.sessionId])) {
        delete parked[a.sessionId];
        if (gState) gState.update("parked", parked);
      }
    }

    spendTick();   // token counting gets a fresh read budget once per poll
    const sessions = buildSessions(res.agents, now, meta);
    matchCodexTerminals(sessions, now);
    snapshotBoard(sessions, now);   // remember the live board for cross-restart restore
    // sid -> display name, written for external readers (claude-notify-hook-entry.ps1)
    // that need Overlord's actual board title — not just the project folder name —
    // in the OS toast body. Includes any user rename (renames[sid], folded into
    // s.name by buildSessions already). Plain JSON file since Overlord's real name
    // cache (renames) lives in VS Code's globalState, unreadable from outside.
    try {
      const namesPath = path.join(os.homedir(), ".claude", "overlord-session-names.json");
      const names = {};
      for (const s of sessions) if (s.sid && s.name) names[s.sid] = s.name;
      fs.writeFileSync(namesPath, JSON.stringify(names));
      // The Haiku-resolved glyphs too: the status line can re-derive the keyword
      // table from this file, but not this cache, and a card whose title the table
      // cannot classify would otherwise sit on a different emoji than the line.
      fs.writeFileSync(path.join(os.homedir(), ".claude", "overlord-topic-emoji.json"),
                       JSON.stringify(topicEmojiCache));
    } catch (_) { /* best-effort */ }
    renderStatus(sessions);
    if (provider) provider.post(sessions);
    followPanels();
    try { D.publish(sessions); } catch (_) { /* device is additive */ }

    const doNotify = cfg().get("notifications");
    for (const a of res.agents) {
      const prev = prevStatus[a.sessionId];
      prevStatus[a.sessionId] = a.status;   // record for every agent, even skipped ones
      // Re-arm both alerts only when the session is genuinely continued (goes busy).
      // This survives status flicker — a raw blip, or a racy tail read that briefly
      // loses a typed question — which otherwise re-fired on every rising edge.
      if (a.status === "busy") { delete notifiedWait[a.sessionId]; delete notifiedDone[a.sessionId]; }
      // Only ever notify for a session that's actually ON THE BOARD. buildSessions
      // drops noise / dead / headless agents (isNoiseAgent / isDeadAgent), but this
      // loop reads the RAW live list. Without this guard a hidden headless `claude`
      // session (no project cwd, name "claude", spawned by a hook or job) toasts
      // "finished" on every busy->idle even though it never renders as a card and
      // can't be jumped to — the "🟢 claude finished" storm. If it isn't a card, it
      // doesn't alert; and the label now always comes from the real card, never the
      // raw a.name fallback.
      const s = sessions.find((x) => x.sid === a.sessionId);
      if (!s || !(seeded && prev && prev !== a.status)) continue;
      alertEdge(a.sessionId, a.status, a.tier, prev, s, a.cwd, doNotify);
    }
    alertCodex(sessions, now, curSids, doNotify);
    for (const sid of Object.keys(prevStatus)) {
      if (!curSids.has(sid)) { delete prevStatus[sid]; delete notifiedWait[sid]; delete notifiedDone[sid]; delete finishedAt[sid]; delete statusSince[sid]; termNames.delete(sid); _tPath.delete(sid); askCache.delete(sid); judged.delete(sid); codexSeen.delete(sid); }
    }
    seeded = true;

    resolveTermNames(sessions);
    maybeUpdateUsage();   // fire-and-forget; internally throttled to ~3 min
  } finally {
    polling = false;
  }
}

// One status edge -> its alert, latched per episode. The Claude loop's body, shared
// with Codex cards since patch 83.
function alertEdge(sid, status, tier, prev, s, cwd, doNotify) {
  const label = s.name || "session";
  // An `open` promotion is a session that FINISHED and left an item behind. It
  // belongs in the tab, but the alert stays the quiet "finished" one — a red
  // "needs you" for "worth restarting the bridge sometime" is exactly the kind
  // of noise patches 24-28 spent four rounds removing. Only a blocking hold
  // earns the red toast; open items are seen, not announced.
  if (status === "waiting" && tier === "open") {
    if (prev === "busy" && !notifiedDone[sid]) {
      notifiedDone[sid] = true;
      osToast("done", label, sid, cwd);
      if (doNotify) vscode.window.showInformationMessage(`🟢 ${label} finished`, "Jump to it")
        .then((x) => { if (x) jumpToTerminal(s); });
    }
  } else if (status === "waiting") {
    if (!notifiedWait[sid]) {
      notifiedWait[sid] = true;
      playSound();
      osToast("input", label, sid, cwd);
      if (doNotify) vscode.window.showWarningMessage(`🔴 ${label} needs you`, "Jump to it")
        .then((x) => { if (x) jumpToTerminal(s); });
    }
  } else if (status === "idle" && prev === "busy") {
    // The OS toast is NOT gated on `notifications` (2026-07-27): that setting is
    // the in-Cursor pop-up, and the user runs it off while still wanting the toast.
    if (!notifiedDone[sid]) {
      notifiedDone[sid] = true;
      osToast("done", label, sid, cwd);
      if (doNotify) vscode.window.showInformationMessage(`🟢 ${label} finished`, "Jump to it")
        .then((x) => { if (x) jumpToTerminal(s); });
    }
  }
}

// Patch 83: Codex cards alert through alertEdge, with the Claude loop's latches and
// the same osToast rate limit. Three differences, each forced by the rollout:
//  - the busy edge is the rollout's: a turn can open and close between two polls
//    (patch 80), so a task_complete newer than the last poll counts as busy -> end;
//  - "finished" needs that task_complete. An aborted, cut-off or gone-quiet turn did
//    not finish, as a Claude session that dies is never toasted;
//  - only a turn that ended after this run first saw the card alerts. The judge's
//    verdicts land a poll or two after a reload, and without this every card from the
//    last 24h it promoted would toast at once. A first sighting and a dormant card
//    never alert.
const codexSeen = new Map();   // sid -> { first: when this run first polled it, at: statusSince then }
function alertCodex(sessions, now, curSids, doNotify) {
  for (const c of sessions) {
    if (c.agent !== "codex") continue;
    curSids.add(c.sid);   // its prevStatus and latches are pruned with the Claude ones
    const st = c.state === "working" ? "busy" : c.state === "needs" ? "waiting"
             : c.state === "idle" && c.turnFinal ? "idle" : "other";
    const seen = codexSeen.get(c.sid), prev = prevStatus[c.sid];
    prevStatus[c.sid] = st;
    codexSeen.set(c.sid, { first: seen ? seen.first : now, at: c.statusSince });
    const ended = !!seen && !!c.turnFinal && c.statusSince !== seen.at;
    if (st === "busy" || ended) { delete notifiedWait[c.sid]; delete notifiedDone[c.sid]; }
    const from = ended ? "busy" : prev;
    if (!seen || c.dormant || from === st || !(c.statusSince > seen.first)) continue;
    alertEdge(c.sid, st, c.tier, from, c, c.cwd, doNotify);
  }
}

function errorText(err) {
  const bin = cfg().get("claudePath") || "claude";
  const msg = (err && err.message) || String(err);
  if (/not recognized|ENOENT|not found/i.test(msg)) {
    return `Couldn't run \`${bin} agents\`. Install the Claude Code CLI, or set \`overlord.claudePath\` to its full path.`;
  }
  return `\`${bin} agents --json\` failed: ${msg}`;
}

function renderStatus(sessions) {
  // The eye + 🔴🟡🟢 counter section now lives at the top of the Overlord panel
  // (see html()), not in the status bar. All we keep out here is the activity-bar
  // badge showing how many sessions need you.
  const n = sessions.filter((s) => s.state === "needs").length;
  if (provider && provider._view) {
    provider._view.badge = n > 0 ? { value: n, tooltip: `${n} session(s) need you` } : undefined;
  }
}

// ---- webview ---------------------------------------------------------------
// PR / CI chip (patch 86). The newest PR whose head is the card's branch, read with
// `gh pr list` in the card's own folder. One gh call at a time, each branch re-read at
// most every 3 minutes, and silent on any failure: no gh, offline, not a GitHub repo or
// no PR all leave the card without a chip. Dormant cards are not asked about.
const PR_TTL_MS = 3 * 60 * 1000;
const prCache = new Map();   // cwd + "\n" + branch -> { at, chip }
let prQueue = [], prBusy = false, ghMissing = false;
function prChipOf(pr) {
  if (!pr || !pr.number) return null;
  const st = String(pr.state || "").toUpperCase();
  if (st === "MERGED") return { kind: "merged", n: pr.number, title: pr.title || "" };
  if (st !== "OPEN") return null;   // closed unmerged: nothing left to act on
  // A check run reports status + conclusion; a commit status reports state.
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const res = checks.map((k) => String(k.conclusion || k.state || "").toUpperCase());
  const running = checks.some((k) => k.status ? String(k.status).toUpperCase() !== "COMPLETED"
    : /^(PENDING|EXPECTED)$/.test(String(k.state || "").toUpperCase()));
  const kind = pr.isDraft ? "draft"
    : res.some((r) => /^(FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE)$/.test(r)) ? "failed"
    : running ? "pending" : checks.length ? "passed" : "open";
  return { kind, n: pr.number, title: pr.title || "" };
}
function prChip(s) {
  if (ghMissing || s.dormant || !s.cwd || !s.branch || /^(main|master)$/.test(s.branch)) return null;
  const key = s.cwd + "\n" + s.branch, hit = prCache.get(key);
  if ((!hit || Date.now() - hit.at > PR_TTL_MS) && !prQueue.includes(key)) { prQueue.push(key); prNext(); }
  return hit ? hit.chip : null;
}
function prNext() {
  if (prBusy || !prQueue.length) return;
  const key = prQueue.shift(), [cwd, branch] = key.split("\n");
  const done = (chip) => { prCache.set(key, { at: Date.now(), chip }); prBusy = false; prNext(); };
  // A missing folder also fails as ENOENT, which must not read as "no gh".
  if (!fs.existsSync(cwd)) return done(null);
  prBusy = true;
  cp.execFile("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", "number,state,isDraft,title,statusCheckRollup"],
    { cwd, timeout: 20000, windowsHide: true, maxBuffer: 1 << 20 }, (err, out) => {
      if (err && err.code === "ENOENT") { ghMissing = true; prQueue = []; prBusy = false; return; }
      let chip = null;
      if (!err) { try { chip = prChipOf(JSON.parse(out)[0]); } catch (_) { /* unreadable: no chip */ } }
      done(chip);
    });
}
const withPr = (s) => { const pr = prChip(s); return pr ? Object.assign({}, s, { pr }) : s; };

class OverlordViewProvider {
  constructor() { this._view = null; }
  resolveWebviewView(view) {
    this._view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    // Live memory bar (the user 2026-11-09): the laptop's RAM in use, every 3 s. freemem() on
    // Windows is "available" physical memory, the same figure Task Manager shows.
    const memTick = () => { if (this._view) this._view.webview.postMessage({ type: "mem", total: os.totalmem(), free: os.freemem() }); };
    const memTimer = setInterval(memTick, 3000); memTick();
    // Every 30 s: sample the emulator's CPU, and list the biggest apps while amber or red.
    const topTimer = setInterval(() => sampleCpu(EMU_EXE, () => {
      if (os.freemem() / os.totalmem() < 0.25) this.postMemTop(); }), 30000);
    for (const t of [memTimer, topTimer]) if (t.unref) t.unref();   // never the thing keeping a process alive
    if (view.onDidDispose) view.onDidDispose(() => { clearInterval(memTimer); clearInterval(topTimer); });
    view.webview.onDidReceiveMessage((msg) => {
      if (!msg) return;
      // Patch 89: look the card up on the board last posted (what the user clicked) instead
      // of rebuilding the whole board synchronously on every click.
      const board = () => _lastBoard || buildSessions(_agentCache, Date.now());
      const find = (sid) => board().find((x) => x.sid === sid);
      // Before the first poll the board is the saved snapshot, with no pids: wait for the
      // poll (10 s at most), and say so when the card still isn't there.
      if (msg.type === "jump") (async () => {
        if (!seeded) {
          const wait = (async () => { for (let i = 0; !seeded && i < 40; i++) await new Promise((r) => setTimeout(r, 250)); })();
          vscode.window.setStatusBarMessage("Overlord: reading sessions…", wait);
          await wait;
        }
        const s = find(msg.sid);
        if (s) jumpToTerminal(s); else vscode.window.setStatusBarMessage("Overlord: that session is not on the board", 5000);
      })();
      // Resume a dormant (restored) card: relaunch `claude --resume <sid>`.
      // Until the first poll the board is the saved snapshot, where a session that is in
      // fact still running shows dormant: ask the CLI first rather than resume it twice.
      // Patch 89: after it too -- a resumed card stays dormant until the next poll -- and
      // a session that is live gets its terminal focused instead.
      else if (msg.type === "resume") getAgents().then((r) => {
        const live = r.ok && r.agents.find((a) => a.sessionId === msg.sid), s = find(msg.sid);
        if (live) jumpToTerminal(Object.assign({ name: "session" }, s, { sid: msg.sid, pid: live.pid, cwd: live.cwd || (s && s.cwd) }));
        else if (s) resumeSession(s);
      });
      else if (msg.type === "openHelper" && /^[\w-]+$/.test(String(msg.id || ""))) {
        const t = transcriptPath(msg.sid);
        // Patch 83: a Codex helper row is a subagent thread, and its id is the thread's.
        const log = t ? path.join(path.dirname(t), msg.sid, "subagents", "agent-" + msg.id + ".jsonl") : X.rolloutPath(msg.sid, msg.id);
        if (log && fs.existsSync(log)) openTranscript("helper:" + msg.id, "helper · " + String(msg.name || msg.id).slice(0, 40), log);
      }
      else if (msg.type === "open") { const s = find(msg.sid); openTranscript(msg.sid, s ? s.name : (runNames.get(msg.sid) || "session")); }
      else if (msg.type === "reply") { const all = board(); const s = all.find((x) => x.sid === msg.sid); if (s) replyThenReload(s, msg, all); }
      else if (msg.type === "kill") { const s = find(msg.sid); if (s) removeSession(s); }
      // Patch 86: the error state's Retry, and Pin / Unpin (three at most, kept across reloads).
      else if (msg.type === "retry") refresh();
      else if (msg.type === "pin") {
        const i = pinned.indexOf(msg.sid);
        if (i >= 0) pinned.splice(i, 1); else if (pinned.length < 3) pinned.push(String(msg.sid || ""));
        if (gState) gState.update("pinned", pinned);
        this.post(buildSessions(_agentCache, Date.now(), _metaCache));
      }
      else if (msg.type === "handoff") { const s = find(msg.sid); if (s && this._view) handOff(s, this._view.webview); }
      // Rename: store an override keyed by session id (the supervisor keeps
      // sending its own name every tick, so we re-apply ours in buildSessions).
      // Empty name clears the override, reverting to the default.
      else if (msg.type === "rename") {
        const nm = String(msg.name || "").trim();
        if (nm) renames[msg.sid] = nm; else delete renames[msg.sid];
        if (gState) gState.update("renames", renames);
        this.post(buildSessions(_agentCache, Date.now(), _metaCache));  // reflect immediately, not next tick
      }
      // Patch 84: on the Codex half, a Codex session -- what Ctrl+Shift+C opens (patch 74).
      else if (msg.type === "new") { if (activeAgent === "codex") vscode.commands.executeCommand("overlord.newAgentSession"); else newSession(); }
      // Toggle state, so the new-session shortcut can follow it. The webview owns
      // the value; this is the host's copy, persisted so it survives a reload.
      else if (msg.type === "agent") {
        activeAgent = msg.agent === "codex" ? "codex" : "claude";
        if (gState) gState.update("activeAgent", activeAgent);
      }
      // "Move to done": mark this session user-parked (persisted). buildSessions
      // then renders it in the Done group until it next goes active.
      else if (msg.type === "park" || msg.type === "parkMany") {
        // parkMany (patch 89): right-click on the Idle tab parks every card in it at once.
        const sids = msg.type === "parkMany" ? (msg.sids || []) : [msg.sid];
        // A Codex card as it stood before the park, for closeParked (patch 83).
        const cxs = sids.map(sid => X.isCodexSid(sid) ? find(sid) : null);
        // The VALUE is when it was parked, not just that it was. Claude's paths only
        // ever test truthiness so this is invisible to them, but a Codex card has no
        // live process to prove it woke up -- comparing its rollout's last activity
        // against this timestamp is the only way to know it did.
        for (const sid of sids) parked[sid] = Date.now();
        if (gState) gState.update("parked", parked);
        this.post(buildSessions(_agentCache, Date.now(), _metaCache));  // reflect immediately
        sids.forEach((sid, i) => closeParked(cxs[i] || _agentCache.find(x => x.sessionId === sid)));
      }
      // Memory bar: the top-five list was opened, or Shut down was clicked on the emulator.
      else if (msg.type === "memTop") this.postMemTop();
      else if (msg.type === "emuKill") {
        if (!emuState().free) return this.postMemTop();   // re-checked: never mid-walk
        const adb = path.join(process.env.LOCALAPPDATA || "", "Android", "Sdk", "platform-tools", "adb.exe");
        cp.execFile(adb, ["emu", "kill"], { windowsHide: true, timeout: 15000 }, (err) => {
          if (err) cp.execFile("taskkill", ["/PID", String(emuPid), "/T", "/F"], { windowsHide: true }, () => {});
          cpuLog[EMU_EXE] = []; setTimeout(() => this.postMemTop(), 5000);
        });
      }
      // Restart the browser: ask it to close, force what is left after 10 s, reopen it.
      // Offered only with tab restore on, so the tabs come back.
      else if (msg.type === "browserRestart") browserState((st) => {
        if (!st.free) return this.postMemTop();
        const gone = (cb) => cp.execFile("tasklist", ["/fo", "csv", "/nh", "/fi", "imagename eq " + COMET_EXE], { windowsHide: true }, (e, out) => cb(!/comet\.exe/i.test(out || "")));
        cp.execFile("taskkill", ["/IM", COMET_EXE], { windowsHide: true }, () => {
          let n = 0;
          const wait = setInterval(() => gone((g) => {
            if (!g && ++n < 10) return;
            clearInterval(wait);
            const reopen = () => { cp.spawn(path.join(COMET_DIR, "Application", COMET_EXE), [], { detached: true, stdio: "ignore" }).unref();
              setTimeout(() => this.postMemTop(), 8000); };
            if (g) reopen(); else cp.execFile("taskkill", ["/IM", COMET_EXE, "/T", "/F"], { windowsHide: true }, () => setTimeout(reopen, 1500));
          }), 1000);
        });
      });
      // Manual refresh of the usage card: drop the throttle and re-fetch now.
      else if (msg.type === "refreshUsage") { usageAt = 0; maybeUpdateUsage(); }
      // Concept search: rank the live board by the query's intent (Haiku helper).
      else if (msg.type === "search") {
        const q = String(msg.q || "").trim();
        if (q && this._view) runSessionSearch(q, this._view.webview);
      }
      // Topic-emoji fallback: the webview hit titles its keyword table can't
      // classify — resolve them via Haiku, cache, and re-post.
      else if (msg.type === "emojiReq") { runTopicEmoji(msg.names || []); }
      // Card assist buttons (patch 35): Simplify / Next step. Side call on the
      // transcript — the session itself is never written to.
      else if (msg.type === "assist") {
        if (this._view) runAssist(msg.sid, msg.kind === "next" ? "next" : "simplify",
                                  String(msg.msgKey || ""), this._view.webview);
      }
      // Plan-board write-back (patch 38b). All fail-quiet: a bad edit loses one
      // click, never the board. Every branch re-posts WITH _metaCache (patch 10).
      else if (msg.type === "taskToggle") {
        try { applyTaskToggle(taskRoot(), String(msg.dir || ""), msg.id); } catch (e) { console.error("overlord taskToggle", e); }
        this.post(buildSessions(_agentCache, Date.now(), _metaCache));
      }
      else if (msg.type === "taskSkip") {
        try { applyTaskSkip(taskRoot(), String(msg.dir || ""), msg.id, msg.reason); } catch (e) { console.error("overlord taskSkip", e); }
        this.post(buildSessions(_agentCache, Date.now(), _metaCache));
      }
      else if (msg.type === "taskEvidence") {
        try { applyTaskEvidence(taskRoot(), String(msg.dir || ""), msg.id, msg.text); } catch (e) { console.error("overlord taskEvidence", e); }
      }
      else if (msg.type === "taskGoal") {
        try { applySessionGoal(String(msg.sid || ""), msg.text); } catch (e) { console.error("overlord taskGoal", e); }
      }
      else if (msg.type === "taskAdd") {
        try { applyTaskAdd(taskRoot(), taskDirNamesFor(String(msg.sid || "")), msg.subject); } catch (e) { console.error("overlord taskAdd", e); }
        this.post(buildSessions(_agentCache, Date.now(), _metaCache));
      }
      else if (msg.type === "planGateToggle") {
        try { applyPlanGateToggle(cfg().get("planGateFile") || DEFAULT_PLAN_GATE_FILE, String(msg.sid || "")); } catch (e) { console.error("overlord planGateToggle", e); }
        this.post(buildSessions(_agentCache, Date.now(), _metaCache));
      }
    });
    // First paint from saved state: restored cards need no CLI data, so post them now
    // instead of after `claude agents --json`; the poll's post replaces this one. It only
    // posts -- no notify, snapshot or prune -- and skips the cold Codex scan until then.
    if (!lastError) {
      if (!seeded) for (const sid in boardSnapshot) if (!_metaCache[sid] && !isCodexSnap(sid)) _metaCache[sid] = readMeta(sid);
      this.post(buildSessions(_agentCache, Date.now(), _metaCache, !seeded));
    }
    setTimeout(() => refresh(), 40);
  }
  postMemTop() {
    memTop((top) => browserState((browser) => { if (this._view && top) this._view.webview.postMessage({ type: "memTop", top, emu: emuState(), browser }); }));
  }
  post(sessions, error) {
    _lastBoard = sessions;
    if (this._view) this._view.webview.postMessage({ type: "sessions", sessions: sessions.map(withPr), error: error || null,
      errorCmd: error ? agentsCmd() : "", pinned, activeSid, usage: usageStat, codexUsage: codexUsage() });
  }
  html() {
    // Semantic state tokens: user override (overlord.colors.*) -> VS Code theme
    // variable -> hex fallback. Icon, meta text, card border, and pulse glow all
    // consume the same token. Config changes apply on window reload.
    const oc = (k, fb) => { const v = cfg().get("colors." + k); return v || fb; };
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  :root{--ov-needs:${oc("needs", "var(--vscode-charts-red,#ff5c6c)")};
        --ov-working:${oc("working", "var(--vscode-charts-yellow,#f5b14c)")};
        --ov-done:${oc("done", "var(--vscode-charts-green,#54d6a0)")};
        --ov-cutoff:${oc("cutoff", "var(--vscode-charts-orange,#ff8c42)")};
        --ov-idle:${oc("idle", "var(--vscode-descriptionForeground,#8b8b8b)")};
        /* Patch 85: red means blocking. Usage and context bars get their own scale,
           and over-limit reads as a warning, never as the Needs-you red. */
        --ov-use-ok:var(--vscode-charts-blue,#3794ff);--ov-use-low:var(--vscode-charts-purple,#b180d7);
        --ov-warn:var(--vscode-editorWarning-foreground,#cca700)}
  /* App-shell layout: fixed-height column so the card list scrolls in the middle
     and the usage card stays pinned to the very bottom of the panel (not just
     below the last session card). */
  html,body{height:100%}
  body{margin:0;padding:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground);
       display:flex;flex-direction:column;height:100vh;overflow:hidden}
  #hdr{flex:0 0 auto}
  #root{flex:1 1 auto;min-height:0;overflow-y:auto;padding:6px 0}
  .empty{padding:20px 16px;color:var(--vscode-descriptionForeground);font-size:12px;text-align:center;line-height:1.6}
  .row{display:block;box-sizing:border-box;padding:9px 10px;margin:3px 6px;border-radius:8px;
       background:color-mix(in srgb,var(--vscode-list-hoverBackground) 60%,transparent);
       border:2px solid transparent;border-left:3px solid var(--ov-state,#555);
       cursor:pointer}
  .hdr{display:flex;align-items:center;gap:6px;min-width:0}
  /* Hover (patch 85): the theme's hover colour and no shift. It used the selection
     colour, so a hovered card looked selected. */
  .row:hover{background:var(--vscode-list-hoverBackground)}
  /* Compact row (patch 85): idle, done and resumable cards fold to one line (title,
     state, context %) so needs-you and working cards get the height. The selected
     card unfolds: click, arrow keys, or its terminal taking focus. */
  .cmp{display:none;flex:0 0 auto;font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap}
  .row.cmpt:not(.selected){padding-top:5px;padding-bottom:5px}
  .row.cmpt:not(.selected) .meta>:not(.hdr){display:none!important}
  .row.cmpt:not(.selected) .cmp{display:block}
  /* Selected = the session whose terminal is focused. Thick focusBorder frame on
     top/right/bottom + a thicker state-colour bar on the left, over a brighter
     background, make the current card unmistakable. box-sizing:border-box on
     .row (with default 2px transparent borders) means widening the borders on
     select causes no layout shift, and borders stack cleanly with the needs
     pulse glow (which uses box-shadow). */
  .row.selected{background:var(--vscode-list-activeSelectionBackground);
       border-color:var(--vscode-focusBorder,#007fd4);border-width:3px;
       border-left-color:var(--ov-state,#555);border-left-width:5px}
  .row.selected .nm{color:var(--vscode-list-activeSelectionForeground,var(--vscode-foreground))}
  .row.needs{--ov-state:var(--ov-needs)} .row.working{--ov-state:var(--ov-working)}
  .row.done{--ov-state:var(--ov-done)} .row.idle{--ov-state:var(--ov-idle)}
  .row.cutoff{--ov-state:var(--ov-cutoff)}
  /* Background jobs still running: the rail matches the Working tab the card now
     sits in, so it does not read as an idle card that wandered in. Rail only — the
     icon stays the idle moon, because the MODEL genuinely is not generating. */
  .row.idle.running{--ov-state:var(--ov-working)}
  .row.needs{animation:pulse 1.4s infinite}
  @keyframes pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ov-needs) 33%,transparent)}
                   50%{box-shadow:0 0 0 5px transparent}}
  /* Two tiers inside Needs you (patch 33). BLOCKING keeps the full red + pulse:
     the session can't continue without the user. OPEN is a finished session that left
     him an item — same tab so it can't hide, but muted red, no pulse and no toast,
     so the blocking ones stay scannable at a glance. */
  .row.needs.tier-open{animation:none;
       --ov-state:color-mix(in srgb,var(--ov-needs) 52%,var(--vscode-descriptionForeground))}
  .row.needs.tier-open .icon{opacity:.8}
  /* Dormant (restored) cards: dimmed, and never pulse (their process is dead).
     A small "click to resume" cue sits in the meta line via .st already; here we
     just soften the whole card so live cards stand out. */
  .row.dormant{opacity:.62}
  .row.dormant:hover{opacity:1}
  .row.dormant.needs{animation:none}
  .icon{width:15px;height:15px;flex:0 0 auto;display:flex;align-items:center;justify-content:center;
        color:var(--ov-state,#858585)}
  .icon svg{width:15px;height:15px;display:block;stroke:currentColor;fill:none;
            stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .row.working .icon svg{animation:ovspin 1.2s linear infinite;transform-origin:center}
  @keyframes ovspin{to{transform:rotate(360deg)}}
  .meta{min-width:0}
  /* Topic glyph — an emoji inferred from the title, sits between the state icon
     and the name so the subject reads at a glance. Fixed width, never shrinks. */
  .tg{flex:0 0 auto;font-size:13px;line-height:1;width:16px;text-align:center;
      -webkit-font-smoothing:auto}
  .nm{flex:1;min-width:0;font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .nm input{width:100%;box-sizing:border-box;font-family:inherit;font-size:12.5px;font-weight:600;
       padding:0 4px;margin:0;border-radius:4px;outline:none;
       border:1px solid var(--vscode-focusBorder,#007fd4);
       background:var(--vscode-input-background,#3c3c3c);
       color:var(--vscode-input-foreground,#ccc)}
  /* Context fill rail, directly under the title (2026-08-24). The card already
     carried "ctx 88k · 44%" buried mid-sentence in the meta line, where a number
     that matters only near its ceiling reads as just more text. The rail puts it
     where it is scannable and gives it a shape that changes before the number does.
     Measured against the WORKING CEILING (autocompact trigger), not the raw model
     window — see ctxCapTokens(). Tick marks the 85% red line. */
  .cbar{display:flex;align-items:center;gap:6px;margin-top:5px;font-size:9.5px;line-height:1.3;
       font-variant-numeric:tabular-nums;color:var(--vscode-descriptionForeground);white-space:nowrap}
  /* Fixed 92px rail, not flex:1 — stretched across the whole card it stopped
     reading as a gauge and started reading as a horizontal rule. */
  .cbar .cr{position:relative;flex:0 0 92px;height:3px;border-radius:2px;
       background:color-mix(in srgb,var(--vscode-foreground) 20%,transparent)}
  .cbar .cr u{position:absolute;left:0;top:0;bottom:0;border-radius:2px;display:block;
       background:var(--ov-done);transition:width .25s}
  /* The 85% mark. Sits ABOVE the fill (z-index) and overhangs the rail, or it
     vanishes the moment the fill passes it — which is when it matters most. */
  .cbar .cr s{position:absolute;top:-3px;bottom:-3px;left:85%;width:1px;z-index:2;
       background:var(--vscode-foreground);opacity:.65}
  .cbar .cv{flex:0 0 auto;opacity:.85}
  .cbar .csp{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75}
  /* ⛔ The bird reports FUEL, not quality. It tips over when the session is past
     its compaction ceiling — a measured fact. It is NOT the degradation canary,
     which failed its backtest (lift ~1.0) and is not built. Attaching a verdict
     glyph to a detector that does not exist is the exact failure this avoids. */
  .cbar .cbd{flex:0 0 auto;font-size:10px;line-height:1;filter:grayscale(1);opacity:.5;
       transition:transform .2s}
  .cbar.over .cbd{filter:none;opacity:1;transform:rotate(90deg)}
  /* ⛔ NOT margin-left:auto. Pinned to the right edge it sat inches from the number
     it belongs to on a wide panel, and read as unrelated chrome — the user: "there is no
     clear CTA". It travels WITH the reading instead, immediately after it. */
  .cbar .cta{flex:0 0 auto;margin-left:3px;font-family:inherit;font-size:10px;font-weight:700;
       padding:1px 8px;border-radius:4px;cursor:pointer;letter-spacing:.01em;
       border:1px solid var(--vscode-widget-border,rgba(255,255,255,.22));
       background:transparent;color:var(--vscode-foreground)}
  .cbar .cta:hover{background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.07))}
  .cbar .cta.sent{opacity:.5;pointer-events:none}
  /* Over cap the whole row stops being a readout and becomes a warning: the
     percentage carries the alarm colour too, so the CTA is not the only thing
     doing the work if it is ever missed. */
  .cbar.over .cv{color:var(--ov-warn);font-weight:700;opacity:1}
  .st{font-size:10.5px;margin-top:2px;color:var(--ov-state)}
  .stw{margin-left:5px;color:var(--ov-warn);cursor:help}
  .act{font-size:10px;margin-top:3px;color:var(--vscode-descriptionForeground);
       white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .msg{color:var(--vscode-foreground);opacity:.85}
  .sum{font-size:10.5px;line-height:1.45;margin-top:5px;color:var(--vscode-foreground);opacity:.88;
       white-space:pre-wrap;word-break:break-word;overflow:hidden;
       max-height:calc(1.45em * 2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
       border-left:2px solid var(--vscode-panel-border,rgba(128,128,128,.35));padding-left:7px}
  .sum:empty{display:none}
  .chev{flex:0 0 auto;align-self:flex-start;margin-top:2px;font-size:10px;
        color:var(--vscode-descriptionForeground)}
  .jump{display:inline-block;margin-top:5px;margin-right:10px;font-size:10.5px;cursor:pointer;
        color:var(--vscode-textLink-foreground)}
  .jump:hover{text-decoration:underline}
  /* Quick-reply buttons on "needs you" cards — one click types into the session's
     terminal via the reply handler, so you can unblock a session without jumping. */
  .qr{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
  .qr button{font-family:inherit;font-size:11px;font-weight:600;padding:3px 11px;border:0;
       border-radius:5px;cursor:pointer;
       background:var(--vscode-button-secondaryBackground,#3a3d41);
       color:var(--vscode-button-secondaryForeground,#fff)}
  .qr button:hover{background:var(--vscode-button-secondaryHoverBackground,#45494e)}
  .qr button.go{background:var(--ov-needs);color:#1a1a1a}
  .qr button.sent{opacity:.5;pointer-events:none}
  /* Card assist (patch 35): Simplify / Next step. Quieter than the quick-reply
     row on purpose — those act on a blocked session, these only inform you.
     Hidden until the card has something finished worth explaining. */
  .as{display:flex;gap:6px;margin-top:7px;flex-wrap:wrap}
  .as button{font-family:inherit;font-size:10.5px;font-weight:600;padding:2px 9px;
       border:1px solid var(--vscode-widget-border,rgba(255,255,255,.14));
       border-radius:5px;cursor:pointer;background:transparent;
       color:var(--vscode-descriptionForeground);opacity:.9}
  .as button:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground,rgba(255,255,255,.07));
       color:var(--vscode-foreground)}
  .as button.on{color:var(--vscode-foreground);border-color:var(--vscode-focusBorder,#007fd4)}
  .as button:disabled{opacity:.45;cursor:default}
  /* Answer panel. Prose for Simplify; a two-section list for Next step, where a
     section only renders when it actually has entries — a finished session shows
     nothing rather than an invented task. */
  .ap{display:none;margin-top:7px;padding:7px 9px;border-radius:6px;font-size:11px;line-height:1.5;
      background:var(--vscode-textBlockQuote-background,rgba(255,255,255,.045));
      border-left:2px solid var(--vscode-focusBorder,#007fd4);
      color:var(--vscode-foreground);white-space:pre-wrap}
  .ap.on{display:block}
  .ap .ah{font-size:9px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;
      color:var(--vscode-descriptionForeground);margin:0 0 3px}
  .ap .ah+.ah,.ap ul+.ah{margin-top:7px}
  /* Simplify sections (patch 36): a labelled chunk of prose, its emoji chosen by the
     model for what that chunk says. white-space:normal on the body because .ap stays
     pre-wrap for the legacy prose path, and stray indentation in the generated markup
     must not reach the rendered text. */
  .ap .sh{display:flex;align-items:baseline;gap:5px}
  .ap .si{flex:0 0 auto;font-size:11px;line-height:1}
  .ap .sb{margin:0;white-space:normal}
  .ap .sb+.ah{margin-top:8px}
  /* The caveat rail. Deliberately set apart and deliberately quiet — it is the part a
     shorter answer is most likely to lose, so it gets a boundary of its own rather
     than a sentence at the end of a paragraph. Absent when there is nothing open. */
  .ap .cav{display:flex;gap:6px;margin-top:9px;padding-top:8px;white-space:normal;
      border-top:1px dashed var(--vscode-widget-border,rgba(255,255,255,.18));
      color:var(--vscode-descriptionForeground)}
  .ap .cav .ci{flex:0 0 auto;font-size:11px;line-height:1.5}
  .ap .cav b{font-size:9px;font-weight:700;letter-spacing:.7px;text-transform:uppercase}
  .ap ul{margin:0;padding:0 0 0 15px}
  .ap li{margin:0 0 3px}
  .ap li i{font-style:normal;color:var(--vscode-descriptionForeground)}
  .ap .aerr{color:var(--ov-working)}
  .ap .abusy{color:var(--vscode-descriptionForeground)}
  /* Active auto-loop badge — pinned at the foot of a card whose session owns a
     live poll/grind loop. Mirrors the Claude Code loop statusline: pulsing green
     dot + cyan braille spinner + bold LOOP + slug/detail (ellipsised to fit). */
  .loop{display:none;align-items:center;gap:6px;margin-top:8px;font-size:10px;line-height:1.4;
       font-variant-numeric:tabular-nums;color:var(--vscode-descriptionForeground);
       white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .loop.on{display:flex}
  .loop .ldot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;
       background:var(--ov-done,#89d185);animation:lpulse 1.8s ease-out infinite}
  @keyframes lpulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--ov-done,#89d185) 55%,transparent)}
       70%,100%{box-shadow:0 0 0 5px transparent}}
  .loop .lsp{flex:0 0 auto;width:1ch;text-align:center;
       color:var(--vscode-charts-blue,#4aa3df)}
  .loop .lsp::before{content:"⠿";animation:lspin 900ms steps(1,end) infinite}
  @keyframes lspin{0%{content:"⠋"}12.5%{content:"⠙"}25%{content:"⠹"}37.5%{content:"⠸"}
       50%{content:"⠼"}62.5%{content:"⠴"}75%{content:"⠦"}87.5%{content:"⠧"}100%{content:"⠇"}}
  .loop b{flex:0 0 auto;font-weight:700;letter-spacing:.02em;color:var(--vscode-foreground)}
  .loop .lt{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
  /* RUNNING badge (2026-08-24). Was two grey chips buried in the meta line, which
     the user read as the board having lost track of background work altogether. Same
     construction as the LOOP badge, pitched louder: amber, bold, and MOVING —
     borrowing the run-row bars, whose whole contract is that motion means alive.
     Sits directly under the title so it is the first thing the card says. */
  .run{display:none;align-items:center;gap:6px;margin-top:5px;font-size:10px;line-height:1.4;
       font-variant-numeric:tabular-nums;color:var(--ov-working,#e9a23b);
       white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .run.on{display:flex;cursor:pointer;margin-top:8px}
  .run .rx{margin-left:auto;opacity:.7}
  .runon .rn .rnh{display:none}
  .run .rb{flex:0 0 auto;width:12px;height:11px;display:inline-flex;gap:2px;
       align-items:center;justify-content:center}
  .run .rb i{display:block;width:2px;border-radius:1px;
       background:var(--ov-working,#e9a23b);animation:rbars 900ms ease-in-out infinite}
  .run .rb i:nth-child(2){animation-delay:150ms}
  .run .rb i:nth-child(3){animation-delay:300ms}
  .run b{flex:0 0 auto;font-weight:700;letter-spacing:.02em}
  .run .rt{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;opacity:.85}
  /* Plan-board task panel (patch 38a) — read-only mirror of the session's native
     task list (~/.claude/tasks). Header badge shows done/total; click expands the
     item list. Skipped items are struck through with their skip_reason. */
  /* Background runs launched by this session — same visual weight as TASKS, one
     row each, always expanded (a fan-out is 2-3 runs, not a list worth folding). */
  .rn{display:none;margin-top:8px;font-size:10px;line-height:1.5}
  .rn.on{display:block}
  .rnh{display:flex;align-items:center;gap:5px;cursor:pointer;
       color:var(--vscode-descriptionForeground)}
  .rnh b{font-weight:700;letter-spacing:.02em;color:var(--vscode-foreground)}
  .rnh .rnc{font-variant-numeric:tabular-nums}
  .rnh .rng{color:var(--ov-working,#e9a23b)}
  .rnh .rnx{margin-left:auto;opacity:.7}
  .rni{display:flex;gap:5px;align-items:center;margin:1px 0;cursor:pointer;
       white-space:nowrap;overflow:hidden;color:var(--vscode-descriptionForeground)}
  .rni:hover .rnt{text-decoration:underline;color:var(--vscode-foreground)}
  /* Alive = three bouncing bars; finished = a still, dull dot. Motion means
     running and nothing else, so a finished run must not move at all. */
  .rnd{flex:0 0 auto;width:12px;height:11px;display:inline-flex;gap:2px;
       align-items:center;justify-content:center}
  .rnd i{display:block;width:2px;border-radius:1px;
         background:var(--ov-working,#e9a23b);animation:rbars 900ms ease-in-out infinite}
  @keyframes rbars{0%,100%{height:3px;opacity:.55}50%{height:9px;opacity:1}}
  .rnd i:nth-child(2){animation-delay:150ms}
  .rnd i:nth-child(3){animation-delay:300ms}
  .rni.needs .rnd i{background:var(--ov-needs,#e35d6a)}
  .rnd.dot{display:block;width:5px;height:5px;border-radius:50%;margin:0 3.5px;
       background:var(--vscode-descriptionForeground);opacity:.5}
  .rni.done{opacity:.55}
  .rnt{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
  /* Model chip (2026-09-25). Tier-coloured so a helper on the wrong tier is
     spottable without reading it: cheap green, opus neutral, top-tier amber. */
  .rnk{flex:0 0 auto;font-size:9px;line-height:1.5;padding:0 4px;border-radius:3px;
       opacity:.85;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}
  .rnk.k-cheap{background:var(--ov-done,#4a9)}
  .rnk.k-top{background:var(--ov-working,#d9a441)}
  .rnm{flex:0 0 auto;margin-left:auto;opacity:.7}
  /* Helper rows (2026-09-17): the RUNS look, plus a second line for the latest action. */
  .hpa{padding-left:17px;margin:-1px 0 2px;white-space:nowrap;overflow:hidden;
       text-overflow:ellipsis;opacity:.75;font-style:italic;color:var(--vscode-descriptionForeground)}
  .hpd{padding-left:17px;opacity:.55;color:var(--vscode-descriptionForeground)}
  @media (prefers-reduced-motion:reduce){ .rnd i{animation:none;height:6px;opacity:.9} }
  .tk{display:none;margin-top:8px;font-size:10px;line-height:1.5}
  .tk.on{display:block}
  .tkh{display:flex;align-items:center;gap:5px;cursor:pointer;color:var(--vscode-descriptionForeground)}
  .tkh b{font-weight:700;letter-spacing:.02em;color:var(--vscode-foreground)}
  .tkh .tkc{font-variant-numeric:tabular-nums}
  .tkh .tkg{color:var(--ov-working,#e9a23b)}
  .tkh .tkx{margin-left:auto;opacity:.7}
  .tkl{margin-top:3px;border-left:2px solid var(--vscode-panel-border,rgba(128,128,128,.25));padding-left:7px}
  .tki{display:flex;gap:5px;align-items:baseline;margin:1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tki .tks{flex:0 0 auto}
  .tki .tkt{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
  .tki.done{opacity:.55}
  .tki.done .tks{color:var(--ov-done,#89d185)}
  .tki.prog .tks{color:var(--vscode-charts-blue,#4aa3df)}
  .tki.skip{opacity:.55}
  .tki.skip .tkt{text-decoration:line-through}
  .tki .tkr{font-style:normal;color:var(--vscode-descriptionForeground);flex:0 1 auto;
       overflow:hidden;text-overflow:ellipsis}
  /* Write-back affordances (patch 38b) */
  .tki .tks{cursor:pointer}
  .tki .tkskip{flex:0 0 auto;margin-left:auto;cursor:pointer;opacity:0;transition:opacity .1s;
       color:var(--vscode-descriptionForeground)}
  .tki:hover .tkskip{opacity:.8}
  .tka{cursor:pointer;opacity:.6;margin-top:2px}
  .tka:hover{opacity:1}
  .tkin{width:100%;box-sizing:border-box;font:inherit;padding:1px 4px;border-radius:3px;
       background:var(--vscode-input-background);color:var(--vscode-input-foreground);
       border:1px solid var(--vscode-focusBorder,#007fd4)}
  /* Step loader + sub-step line (patch 38c). The spinner reuses the LOOP badge's
     braille frames (@keyframes lspin) on the step's own glyph. */
  .tki .tkspin{width:1ch;text-align:center;color:var(--vscode-charts-blue,#4aa3df)}
  .tki .tkspin::before{content:"⠿";animation:lspin 900ms steps(1,end) infinite}
  .tki.live .tkt{color:var(--vscode-foreground)}
  .tkw{margin:0 0 2px 16px;font-style:italic;color:var(--vscode-descriptionForeground);
       white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* Session goal, evidence, elapsed and staleness (patch 38e).
     The goal sits OUTSIDE .tkl so it stays visible when the step list is
     collapsed — a goal you have to expand a panel to see is not a goal. */
  .tkgoal{display:flex;gap:5px;align-items:baseline;margin:3px 0 2px;cursor:pointer;
       white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tkgoal .tkgi{flex:0 0 auto;opacity:.75}
  .tkgoal .tkgt{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
       color:var(--vscode-foreground)}
  .tkgoal:hover .tkgt{text-decoration:underline}
  .tkgoal.unset .tkgt{opacity:.45;font-style:italic;text-decoration:none}
  .tki .tkel{flex:0 0 auto;opacity:.45;font-variant-numeric:tabular-nums}
  .tki.stall .tks{color:var(--ov-working,#e9a23b)}
  .tkw.stale{opacity:.4}
  /* Patch 99: icon explanations, shown 500ms after the pointer settles on an icon. */
  #ictip{position:fixed;z-index:1000;max-width:260px;padding:5px 8px;border-radius:4px;font-size:12px;line-height:1.35;
       white-space:normal;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.4);
       background:var(--vscode-editorHoverWidget-background,#252526);color:var(--vscode-editorHoverWidget-foreground,#cccccc);
       border:1px solid var(--vscode-editorHoverWidget-border,#454545)}
  #ictip[hidden]{display:none}
  .tkev{margin:0 0 2px 16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
       color:var(--ov-done,#89d185);opacity:.7}
  .tkev.miss{color:var(--ov-working,#e9a23b);opacity:.65;cursor:pointer;font-style:italic}
  .tkev.miss:hover{opacity:1}
  .tknone{opacity:.55;font-style:italic}
  /* Earlier-run history lines (patch 38d) — hover for the full item list */
  .tkrh{display:flex;align-items:center;gap:5px;cursor:pointer;margin-top:4px;
       color:var(--vscode-descriptionForeground)}
  .tkrh b{font-weight:700;letter-spacing:.02em;color:var(--vscode-foreground);opacity:.8}
  .tkrh .tkrc{font-variant-numeric:tabular-nums}
  .tkrh .tkrx{margin-left:auto;opacity:.7}
  .tkrun{margin-top:3px;opacity:.5;cursor:default;white-space:nowrap;overflow:hidden;
       text-overflow:ellipsis}
  .tkrun:hover{opacity:.85}
  .ctx{position:fixed;z-index:10;display:none;padding:4px;border-radius:6px;font-size:12px;
       background:var(--vscode-menu-background,#252526);color:var(--vscode-menu-foreground,#ccc);
       border:1px solid var(--vscode-menu-border,rgba(128,128,128,.35));box-shadow:0 4px 12px rgba(0,0,0,.4)}
  .ctx div{padding:5px 12px;border-radius:4px;cursor:pointer;white-space:nowrap}
  .ctx div:hover{background:var(--vscode-menu-selectionBackground,#04395e);
                 color:var(--vscode-menu-selectionForeground,#fff)}
  #hdr{padding:6px 8px;border-bottom:1px solid var(--vscode-panel-border,rgba(128,128,128,.25))}
  #tabs{display:flex;align-items:center;gap:3px;flex-wrap:wrap}
  .tab{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border:0;border-radius:6px;
       cursor:pointer;font-family:inherit;font-size:12px;font-weight:600;line-height:1;
       background:transparent;color:var(--vscode-foreground);opacity:.55;
       transition:opacity .1s,background .1s}
  .tab:hover{opacity:.9;background:var(--vscode-list-hoverBackground)}
  .tab.active{opacity:1;background:var(--vscode-list-activeSelectionBackground)}
  .tab.empty:not(.active){opacity:.3}
  .tab .n{font-variant-numeric:tabular-nums}
  .tab i{width:11px;height:11px;display:inline-flex;flex:0 0 auto}
  .tab i svg{width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:2.4;
       stroke-linecap:round;stroke-linejoin:round}
  .tab .eye{display:flex;align-items:center}
  .tab .eye svg{width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:2;
       stroke-linecap:round;stroke-linejoin:round}
  .tab.needs i{color:var(--ov-needs)}
  .tab.working i{color:var(--ov-working)}
  .tab.done i{color:var(--ov-done)}
  .tab.idle i{color:var(--ov-idle)}
  .tab.cutoff i{color:var(--ov-cutoff)}
  /* The Cutoff tab only exists when a session was interrupted mid-work; hidden
     entirely (not just dimmed) when none are cut off. */
  .tab.cutoff{display:none}
  .tab.cutoff.show{display:inline-flex}
  /* Agent toggle (2026-09-21). A bordered trough is what stops it reading as a
     sixth filter tab — the tabs never carry a border. Equal-width halves, because
     the accent bar under the active half is the primary state cue and must not
     change length with the label. bottom:2px keeps that 2px bar on the pixel grid;
     at 1.5px it renders as one lit row between two halos, i.e. a smudge. */
  #agent{margin-left:auto;display:inline-flex;align-items:center;gap:2px;padding:2px;
       border-radius:7px;flex:0 0 auto;
       background:color-mix(in srgb,var(--vscode-foreground) 7%,var(--vscode-sideBar-background,#181818));
       border:1px solid var(--vscode-widget-border,rgba(128,128,128,.35))}
  .ag{position:relative;display:inline-flex;align-items:center;justify-content:center;
       gap:5px;padding:3px 7px 6px;min-width:44px;border:0;border-radius:5px;cursor:pointer;
       font-family:inherit;font-size:11px;font-weight:700;line-height:1;background:transparent;
       color:var(--vscode-foreground);opacity:.72;transition:opacity .12s,background .12s}
  .ag:hover{opacity:.9}
  .ag.on{opacity:1;background:color-mix(in srgb,var(--vscode-foreground) 22%,var(--vscode-sideBar-background,#181818))}
  .ag .gl{font-size:11.5px;line-height:1;color:var(--acc);opacity:.85}
  .ag.on .gl{opacity:1}
  .ag .n{font-variant-numeric:tabular-nums;font-weight:600}
  .ag.on::after{content:"";position:absolute;left:6px;right:6px;bottom:2px;height:2px;
       border-radius:2px;background:var(--acc)}
  .ag.claude{--acc:#d97757}
  .ag.codex{--acc:#10a37f}
  /* Usage card: a compact sticky card at the foot of the panel mirroring Claude's
     own /usage — one row per limit window (5-hour, Weekly, Weekly per model) with
     a "% left" bar + reset time. Live from /api/oauth/usage. green >=50% left ->
     amber >=20% -> red. */
  #usage{flex:0 0 auto;display:none;margin:6px;padding:9px 11px 10px;
       border-radius:10px;font-variant-numeric:tabular-nums;
       background:var(--vscode-editorWidget-background,var(--vscode-sideBar-background,#252526));
       border:1px solid var(--vscode-panel-border,rgba(128,128,128,.3));
       box-shadow:0 2px 12px rgba(0,0,0,.30)}
  #usage.on{display:block}
  #usage .uhead{display:flex;align-items:center;gap:6px;margin-bottom:8px}
  #usage .ulogo{color:#d97757;font-size:13px;line-height:1}
  #usage .uhead b{font-size:12.5px;font-weight:700}
  #usage .uplan{font-size:10px;font-weight:600;padding:1px 7px;border-radius:10px;
       background:var(--vscode-badge-background,#4d4d4d);color:var(--vscode-badge-foreground,#fff)}
  /* Top-right freshness cue: "updated 2m ago ⟳", click to force a re-fetch. Turns
     amber then red if syncs start failing (stale token / offline) so a held-over
     reading never masquerades as live. */
  #usage .uage{margin-left:auto;font-size:9px;white-space:nowrap;cursor:pointer;
       color:var(--vscode-descriptionForeground);opacity:.75}
  #usage .uage:hover{opacity:1;text-decoration:underline}
  #usage .uage.stale{color:var(--ov-working);opacity:1}
  #usage .uage.stale2{color:var(--ov-needs);opacity:1}
  /* Collapse caret + folded one-line summary. */
  #usage .ucaret{margin-left:6px;font-size:9px;cursor:pointer;line-height:1;
       color:var(--vscode-descriptionForeground);opacity:.7}
  #usage .ucaret:hover{opacity:1}
  #usage .usum{display:none;margin-top:4px;gap:5px;flex-wrap:wrap;align-items:center}
  #usage.collapsed .urows{display:none}
  #usage.collapsed .usum{display:flex}
  /* Collapsed summary: one pill per window, filled with its bar colour. */
  #usage .ubadge{font-size:10px;font-weight:700;padding:1px 8px;border-radius:9px;line-height:1.7;
       color:#181818;background:var(--ov-idle);font-variant-numeric:tabular-nums;white-space:nowrap}
  #usage .ubadge.u-ok{background:var(--ov-use-ok)}
  #usage .ubadge.u-low{background:var(--ov-use-low)}
  #usage .ubadge.u-crit{background:var(--ov-warn)}
  #usage .ubadge.g-today{background:color-mix(in srgb,var(--ov-working) 62%,#ffffff)}
  #usage .ubadge.g-renew{background:var(--vscode-charts-blue,#4aa3df)}
  /* #2 Low-limit attention: tint the logo when the worst window runs low. */
  #usage.codex .ulogo{color:#10a37f}
  #usage.warnlow .ulogo{color:var(--ov-use-low)}
  #usage.critlow .ulogo{color:var(--ov-warn)}
  #usage.critlow{border-color:color-mix(in srgb,var(--ov-warn) 55%,var(--vscode-panel-border,#555))}
  /* "Today" bar: today's spend vs a sustainable daily pace, in a lighter
     YELLOW (RED past 100% — today alone is on track to blow the weekly limit
     before reset). Sits directly under the Weekly row (no divider). */
  #usage .utoday{margin-top:8px}
  #usage .utfc{font-size:9.5px;margin-top:3px;color:var(--vscode-descriptionForeground)}
  #usage .utfc.over{color:var(--ov-warn)}
  #usage .utline{display:flex;align-items:baseline;gap:6px;margin-bottom:3px}
  #usage .utlabel{font-size:11px;font-weight:600}
  #usage .utval{font-size:9.5px;color:var(--vscode-descriptionForeground);margin-left:auto}
  #usage .utoday.utover .utval{color:var(--ov-warn)}
  #usage .utbar{height:4px;border-radius:2px;overflow:hidden;
       background:var(--vscode-input-background,rgba(128,128,128,.22))}
  #usage .utfill{height:100%;border-radius:2px;
       background:color-mix(in srgb,var(--ov-working) 60%,#ffffff)}
  #usage .utoday.utover .utfill{background:var(--ov-warn)}
  #usage .urow{margin-top:8px}
  #usage .urow:first-child{margin-top:0}
  #usage .urline{display:flex;align-items:baseline;gap:6px;margin-bottom:3px}
  #usage .urlabel{font-size:11px;font-weight:600;flex:0 0 auto}
  #usage .urreset{font-size:9.5px;color:var(--vscode-descriptionForeground);
       flex:0 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* Countdown to reset, in brackets right after the time. Its own flex item so it
     never gets truncated by the reset time's ellipsis. Minutes granularity. */
  #usage .urcd{flex:0 0 auto;font-size:9.5px;white-space:nowrap;
       color:var(--vscode-foreground);opacity:.7}
  #usage .urpct{flex:0 0 auto;margin-left:auto;font-size:9.5px;color:var(--vscode-descriptionForeground)}
  #usage .urpct b{font-size:13px;font-weight:700;color:var(--vscode-foreground);margin-right:2px}
  #usage .urbar{height:5px;border-radius:3px;overflow:hidden;
       background:var(--vscode-input-background,rgba(128,128,128,.22))}
  #usage .urfill{height:100%;width:0%;border-radius:3px;background:var(--ov-use-ok);
       transition:width .4s ease}
  #usage .urow.u-low .urfill{background:var(--ov-use-low)}
  #usage .urow.u-crit .urfill{background:var(--ov-warn)}
  /* Renewal (next charge) bar — blue; fill = fraction of the billing cycle left. */
  #usage .urow.renew .urfill{background:var(--vscode-charts-blue,#4aa3df)}
  /* Live memory bar — fill = RAM in use; amber under 25% free, red under 10%. */
  #usage .umem{display:none}
  #usage .umem.on{display:block}
  #usage.collapsed .umem{display:none}
  #usage .umem{cursor:pointer}
  #usage .umemhint{font-size:9.5px;color:var(--vscode-descriptionForeground);margin-top:3px}
  #usage .umemhint:empty{display:none}
  #usage .umemtop{display:none;margin-top:4px}
  #usage .umem.open .umemtop{display:block}
  #usage .umemtop .mt{display:flex;align-items:center;gap:6px;font-size:10px;padding:1px 0}
  #usage .umemtop .mtmb{margin-left:auto;color:var(--vscode-descriptionForeground)}
  #usage .umemtop .mtkill{font-size:9.5px;padding:0 6px;cursor:pointer;border-radius:3px;
       border:1px solid var(--vscode-button-border,transparent);
       background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  #usage .umemtop .mtkill:disabled{opacity:.4;cursor:default}
  #usage .umemtop .mtwhy{font-size:9px;color:var(--vscode-descriptionForeground);
       min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  /* ---- concept search bar (above the state tabs) ---------------------------- */
  #srch{display:flex;align-items:center;gap:6px;padding:6px 8px 2px;position:relative}
  #srch .si{flex:0 0 auto;font-size:12px;opacity:.75}
  #srch input{flex:1;min-width:0;background:var(--vscode-input-background);
       color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);
       border-radius:6px;padding:4px 8px;font-family:inherit;font-size:12px;outline:none}
  #srch input::placeholder{color:var(--vscode-input-placeholderForeground,var(--vscode-descriptionForeground))}
  #srch input:focus{border-color:var(--vscode-focusBorder)}
  #srch #qx{flex:0 0 auto;background:none;border:none;color:var(--vscode-descriptionForeground);
       cursor:pointer;font-size:12px;line-height:1;padding:2px 5px;border-radius:4px}
  #srch #qx:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2))}
  /* Scanning underline while Haiku ranks the board. */
  #srch.busy::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;
       background:linear-gradient(90deg,transparent,var(--ov-working),transparent);
       background-size:40% 100%;animation:srchscan 1s linear infinite}
  @keyframes srchscan{0%{background-position:-40% 0}100%{background-position:140% 0}}
  /* "why it matched" line under the title, in search mode only. */
  .why{font-size:11px;color:var(--ov-working);margin:1px 0 0;white-space:nowrap;
       overflow:hidden;text-overflow:ellipsis}
  .why::before{content:"◆ ";opacity:.85;font-size:8px;vertical-align:1px}
  .nm mark{background:color-mix(in srgb,var(--ov-working) 45%,transparent);
       color:inherit;border-radius:2px;padding:0 1px}
  /* Patch 86. Hit areas of at least 24px (WCAG 2.5.8) on the small controls; rows keep
     their patch-85 height. Keyboard focus ring, menu divider, removal toast, empty-state
     actions, pinned strip, PR chip, the Codex app hint. */
  .tab,.ag,.qr button,.cbar .cta,.tkh,#srch #qx,#srch #qv{min-height:24px;box-sizing:border-box}
  .ag,#srch #qx,#srch #qv{min-width:24px}
  .tki{min-height:24px;align-items:center}
  .tki .tks,.tki .tkskip,#usage .ucaret{display:inline-flex;align-items:center;justify-content:center;min-width:24px;min-height:24px}
  .tki .tkskip{opacity:.55}
  .row:focus{outline:none}
  .row:focus-visible{outline:2px solid var(--vscode-focusBorder,#007fd4);outline-offset:1px}
  .ctx div.sep{height:1px;padding:0;margin:4px 6px;pointer-events:none;
       background:var(--vscode-menu-separatorBackground,var(--vscode-menu-border,rgba(128,128,128,.35)))}
  #srch #qv{flex:0 0 auto;background:none;border:none;color:var(--vscode-descriptionForeground);
       cursor:pointer;font-size:12px;line-height:1;padding:2px 5px;border-radius:4px}
  #srch #qv:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2))}
  #toast{position:fixed;left:8px;right:8px;bottom:8px;z-index:11;display:none;align-items:center;gap:8px;
       padding:4px 4px 4px 10px;border-radius:6px;font-size:12px;color:var(--vscode-foreground);
       background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-widget-border,rgba(128,128,128,.35));
       box-shadow:0 2px 8px rgba(0,0,0,.35)}
  #toast span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #toast button,.eact button{font-family:inherit;font-size:11px;font-weight:600;padding:3px 11px;border:0;
       border-radius:5px;cursor:pointer;min-height:24px;
       background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-button-secondaryForeground,#fff)}
  #toast button:hover,.eact button:hover{background:var(--vscode-button-secondaryHoverBackground,#45494e)}
  .eact{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:10px}
  .ecmd{display:block;margin-top:6px;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;
       word-break:break-all;opacity:.85}
  .pn{flex:0 0 auto;font-size:10px;line-height:1}
  .row.pinend{position:relative;margin-bottom:13px}
  .row.pinend::after{content:"";position:absolute;left:0;right:0;bottom:-9px;height:1px;pointer-events:none;
       background:var(--vscode-panel-border,rgba(128,128,128,.35))}
  .prc{flex:0 0 auto;font-size:9.5px;line-height:13px;padding:0 5px;border-radius:7px;white-space:nowrap;
       color:var(--vscode-descriptionForeground);border:1px solid color-mix(in srgb,currentColor 45%,transparent)}
  .prc.pr-passed{color:var(--vscode-charts-green,#89d185)}
  .prc.pr-failed{color:var(--ov-warn)}
  .prc.pr-pending{color:var(--ov-use-ok)}
  .prc.pr-merged{color:var(--ov-use-low)}
  .qrh{font-size:11px;color:var(--vscode-descriptionForeground)}
  /* Patch 87. The hidden half's blocking count on its toggle (red = blocking), the
     "ready for review" dot, a flash on entering Needs you (none under reduced motion,
     as in Agent View), and the "N new above / below" marker. */
  .ag .bd,.eact button[data-bd]::after{min-width:14px;height:14px;padding:0 3px;box-sizing:border-box;border-radius:7px;
       font-size:9.5px;line-height:14px;font-weight:700;color:#fff;background:var(--ov-needs)}
  .eact button[data-bd]::after{content:attr(data-bd);display:inline-block;margin-left:6px;vertical-align:1px}
  .row.review .nm::before{content:"";display:inline-block;width:7px;height:7px;margin-right:5px;border-radius:50%;
       vertical-align:1px;background:var(--ov-use-ok)}
  @keyframes venter{0%{background-color:color-mix(in srgb,var(--ov-needs) 30%,transparent)}}
  @media (prefers-reduced-motion:no-preference){
    .row.enter,.row.needs.tier-open.enter{animation:venter 1s ease-out 2}
    .row.needs.enter:not(.tier-open):not(.dormant){animation:venter 1s ease-out 2,pulse 1.4s infinite}
  }
  .nmk{position:fixed;left:50%;transform:translateX(-50%);z-index:20;min-height:24px;padding:3px 11px;border:0;
       border-radius:12px;cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;
       color:var(--vscode-button-foreground,#fff);background:var(--vscode-button-background,#0e639c);
       box-shadow:0 1px 5px rgba(0,0,0,.35)}
</style></head><body>
<div id="hdr"><div id="srch"><span class="si">🔍</span><input id="q" type="text" placeholder="Search sessions by context…" spellcheck="false" autocomplete="off"><button id="qx" title="Clear (Esc)">✕</button><button id="qv" title="Saved searches" aria-label="Saved searches">★</button></div><div id="tabs">
  <button class="tab all active" data-f="all" title="All sessions"><span class="eye"><svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></span><b class="n">0</b></button>
  <button class="tab needs" data-f="needs" title="Needs you"><i></i><b class="n">0</b></button>
  <button class="tab working" data-f="working" title="Working"><i></i><b class="n">0</b></button>
  <button class="tab idle" data-f="idle" title="Idle"><i></i><b class="n">0</b></button>
  <button class="tab done" data-f="done" title="Done"><i></i><b class="n">0</b></button>
  <button class="tab cutoff" data-f="cutoff" title="Cut off — sessions interrupted by a Cursor restart; click to resume"><i></i><b class="n">0</b></button>
  <div id="agent" role="group" aria-label="Agent">
    <button class="ag claude on" data-a="claude" title="Claude Code sessions" aria-pressed="true"><span class="gl" aria-hidden="true">&#10035;</span><span class="n">0</span><span class="bd" style="display:none"></span></button>
    <button class="ag codex" data-a="codex" title="Codex (GPT) sessions" aria-pressed="false"><span class="gl" aria-hidden="true">&#9672;</span><span class="n">0</span><span class="bd" style="display:none"></span></button>
  </div>
</div></div>
<div id="root" role="list" aria-label="Sessions"><div class="empty">Looking for Claude Code sessions…</div></div>
<button id="nAbove" class="nmk" style="display:none"></button><button id="nBelow" class="nmk" style="display:none"></button>
<div id="usage"><div class="uhead"><span class="ulogo">✳</span><b>Claude</b><span class="uplan"></span><span class="uage" id="uage" title="When the usage card last synced — click to refresh now"></span><span class="ucaret" id="ucaret" title="Collapse / expand">▾</span></div><div class="usum" id="usum"></div><div class="urows"></div><div class="urow umem" id="umem"><div class="urline"><span class="urlabel">Memory</span><span class="urreset"></span><span class="urpct"><b></b>used</span></div><div class="urbar"><div class="urfill"></div></div><div class="umemhint"></div><div class="umemtop"></div></div></div>
<script>
  const api = acquireVsCodeApi();
  // State-filter tabs: click a tab to show only sessions in that state; the eye
  // ("all") shows everything. Counts update live and empty tabs dim. The active
  // filter and the last sessions payload persist across per-tick re-renders so
  // clicking a tab re-filters instantly without waiting for the next poll.
  let filter="all";
  let agent=((api.getState()||{}).agent==="codex")?"codex":"claude";   // which board the tabs and cards describe
  let lastSessions=[];
  let idleSids=[];   // patch 89: what the Idle tab holds right now, for its right-click
  // Concept search state. searchActive flips the board into a ranked results view
  // that spans ALL states (ignoring the tab filter) until cleared. searchOrder is
  // the sid order to show (instant keyword hits first, then Haiku's ranking swaps
  // in); searchReason maps sid -> "why it matched". searchPending gates the empty
  // message between "Searching…" and "no matches".
  let searchActive=false, searchQ="", searchTerms=[], searchOrder=[], searchReason={}, searchPending=false;
  // Patch 86: the s:/a:/p: tokens of the query (parseQuery), the Claude CLI's error and
  // the command behind it, and the pinned sids, the last three from the host's post.
  let searchTok=parseQuery(""), lastErr=null, lastErrCmd="", pinnedSids=new Set();
  const TABN={needs:"Needs you",working:"Working",idle:"Idle",done:"Done",cutoff:"Cut off"};
  // Titles already sent to the host for a Haiku emoji (once each, ever) so a
  // keyword-miss doesn't re-request every poll while its glyph resolves.
  const emojiAsked=new Set();
  // The selected card = the session whose terminal is focused. The host is
  // authoritative (it sends activeSid), but a click also sets it optimistically
  // so the highlight moves the instant you click, before the jump resolves.
  // Persist webview UI prefs (selection, usage-card collapsed) without clobbering
  // each other — merge into the existing state object.
  function saveState(patch){ try{ api.setState(Object.assign({}, api.getState()||{}, patch)); }catch(_){} }
  let selectedSid=(api.getState()&&api.getState().sel)||null, hostSid=null, followSid=null;
  function setSelected(sid){
    if(selectedSid===sid) return;
    selectedSid=sid;
    saveState({sel:sid}); markRead(sid);   // patch 87: selecting a card reads it
    for(const [id,c] of cards){ c.row.classList.toggle("selected", id===selectedSid); if(id===sid) c.row.classList.remove("review"); }
  }
  // Patch 87: where a card sits, in which group, and why, in one function, so the
  // hover's why-line can never disagree with the tab. The tab rule is unchanged (patches
  // 60, 62, 68): a native dialog outranks running work unless parked on, running work
  // outranks the state. rank orders the board: blocking, open, ready for review,
  // working, idle, then dormant / cut off / parked. Ready for review sits in the Idle tab.
  function place(x){
    const runs=(x.runText||"background work")+" running";
    if(x.native&&x.state!=="done") return {tab:"needs",rank:0,why:needsWhy(x)+(x.running?", which outranks "+runs:"")};
    if(x.running) return {tab:"working",rank:3,why:runs+" → Working"+(x.state==="needs"?" (its ask shows once they end)":x.state==="idle"?" (the turn itself is over)":"")};
    if(x.state==="needs") return {tab:"needs",rank:x.tier==="open"?1:0,why:needsWhy(x)};
    if(x.state==="working") return {tab:"working",rank:3,why:x.agent==="codex"?"turn in progress (task_started, no task_complete yet)":"turn in progress (Claude Code reports busy)"};
    if(x.state==="done") return {tab:"done",rank:5,why:"parked by you (Move to done)"};
    if(x.state==="cutoff") return {tab:"cutoff",rank:5,why:x.agent==="codex"?"no terminal + unfinished turn → cut off":"was working when Cursor closed → cut off"};
    if(x.dormant) return {tab:x.state,rank:5,why:"no live process: restored from the last board, click to resume"};
    if(unread(x)) return {tab:x.state,rank:2,review:true,why:"turn finished, not opened since → ready for review"};
    return {tab:x.state,rank:4,why:x.doneAt?"turn finished and opened since; nothing asked":"nothing asked"};
  }
  function needsWhy(x){
    const r=x.reason||"";
    return x.via==="regex"?(r||"ended on a question")+" (regex)"
      :x.via==="judge"?"judge: "+(r||"left you something")+(x.tier==="open"?" (open item)":" (blocking)")
      :x.via==="tool"?"asked via request_user_input"
      :x.via==="dialog"?"Claude Code dialog: "+(r||"permission prompt")
      :x.via==="snapshot"?"was waiting on you when its process ended (restored)"
      :"needs you"+(r?": "+r:"");
  }
  // "Ready for review" = a turn that finished after the card was last opened. Marks
  // (sid -> when) live in the webview state, which survives a reload. A sid never opened
  // counts from readBase, when this first ran, so turns already over are not all flagged.
  const rs0=api.getState()||{}; let readAt=rs0.readAt||{}; const readBase=rs0.readBase||Date.now();
  if(!rs0.readBase) saveState({readBase});
  function unread(x){ return !!x.doneAt&&x.sid!==selectedSid&&x.doneAt>(readAt[x.sid]||readBase); }
  function markRead(sid){
    if(!sid) return;
    const keep={}; for(const x of lastSessions) if(readAt[x.sid]) keep[x.sid]=readAt[x.sid];
    readAt=keep; readAt[sid]=Date.now(); saveState({readAt});
  }
  // Time in state in Agent View's short form ("3m", "2h"), from the host's stateAt (the
  // real state-change time). The word: waiting in Needs you, ready when unread, else the state.
  function age(ms){ const m=Math.floor(Math.max(0,ms)/60000); return m<1?"<1m":m<60?m+"m":m<1440?Math.floor(m/60)+"h":Math.floor(m/1440)+"d"; }
  function inState(s,p){
    const w=p&&p.review?"ready":s.state==="needs"?"waiting":s.state==="done"?"parked":s.state==="cutoff"?"cut off":s.dormant?"dormant":s.state;
    return w+(s.stateAt?" "+age(Date.now()-s.stateAt):"");
  }
  // The status line with the host's head ("needs you", "idle 3m", "parked · idle 3m")
  // swapped for the time in state. A payload without stateAt keeps the host's line.
  function stLine(s,p){
    const g=(s.cardLine||"").split(" · ");
    if(!s.stateAt||!g[0]) return s.cardLine||"";
    g.shift(); if(s.state==="done"&&/^idle /.test(g[0]||"")) g.shift();
    return [inState(s,p)].concat(g).join(" · ");
  }
  // Entering Needs you: the tab each sid had at the last render (both halves, so a half
  // switch is no entry; nothing counts on the first render), and the entered cards still
  // out of view, for "N new above / below". A card leaves the count once seen.
  const lastTab=new Map(), newSids=new Set(); let primed=false;
  const nAbove=document.getElementById("nAbove"), nBelow=document.getElementById("nBelow");
  function markNew(){
    const rb=document.getElementById("root").getBoundingClientRect(); let up=0, dn=0, fu=null, fd=null;
    for(const sid of Array.from(newSids)){
      const c=cards.get(sid); if(!c||!c.row.isConnected){ newSids.delete(sid); continue; }
      const r=c.row.getBoundingClientRect();
      if(r.bottom<=rb.top+4){ up++; fu=fu||c.row; } else if(r.top>=rb.bottom-4){ dn++; fd=fd||c.row; } else newSids.delete(sid);
    }
    [[nAbove,up,fu,"↑ "," new above",rb.top+6],[nBelow,dn,fd,"↓ "," new below",rb.bottom-30]].forEach(([el,n,row,a,b,y])=>{
      el.style.display=n?"":"none"; el.textContent=a+n+b; el.style.top=y+"px";
      el.onclick=()=>{ if(row) row.scrollIntoView({block:"center"}); };
    });
  }
  document.getElementById("root").addEventListener("scroll",markNew,{passive:true});
  const tabs=Array.prototype.slice.call(document.querySelectorAll(".tab"));
  // Each tab carries its state's glyph (patch 85), the shape the cards use, not a dot.
  tabs.forEach(t=>{ const i=t.querySelector("i"); if(i) i.innerHTML=stateIcon(t.dataset.f); });
  tabs.forEach(t=>t.onclick=()=>{ if(searchActive) exitSearch(); filter=t.dataset.f; render(lastSessions); });
  tabs.forEach(t=>{ if(t.dataset.f==="idle") t.oncontextmenu=(ev)=>{ ev.preventDefault(); if(idleSids.length) api.postMessage({type:"parkMany",sids:idleSids.slice()}); }; });
  const agentBtns=Array.from(document.querySelectorAll(".ag"));
  // Patch 86: shared with the a: search token, which switches half without leaving search.
  function setAgent(a){ agent=a; filter="all"; saveState({agent}); api.postMessage({type:"agent",agent}); showUsage(); }
  agentBtns.forEach(b=>b.onclick=()=>{ if(searchActive) exitSearch(); setAgent(b.dataset.a); render(lastSessions); });
  // Restored state is only in the webview; tell the host once so the shortcut agrees
  // with what is on screen from the first keypress after a reload.
  api.postMessage({type:"agent",agent});
  // ---- concept search wiring ----
  // Escape HTML then wrap each query term in <mark> (case-insensitive). Escaping
  // first keeps a session name that contains "<" or "&" safe as innerHTML.
  function esc(s){ return String(s).replace(/[&<>"]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m])); }
  function hl(text){
    // Non-regex, case-insensitive term wrapping (avoids regex-escape + template
    // literal hazards). Walks the string, wrapping the earliest next term hit.
    const src=String(text||""), low=src.toLowerCase();
    let out="", i=0;
    while(i<src.length){
      let best=-1, blen=0;
      for(const t of searchTerms){ if(!t) continue; const j=low.indexOf(t,i);
        if(j>=0 && (best<0||j<best)){ best=j; blen=t.length; } }
      if(best<0){ out+=esc(src.slice(i)); break; }
      out+=esc(src.slice(i,best))+"<mark>"+esc(src.slice(best,best+blen))+"</mark>";
      i=best+blen;
    }
    return out;
  }
  // Instant, literal-substring ordering over the fields the webview already has
  // (title/summary/context). Shown immediately while Haiku ranks the full content.
  function keywordOrder(){
    const out=[];
    for(const s of lastSessions){
      const hay=((s.name||"")+" "+(s.summary||"")+" "+(s.lastMsg||"")+" "+(s.sub||"")+" "+(s.dir||"")+" "+(s.ask||"")).toLowerCase();
      if(searchTerms.every(t=>hay.includes(t))) out.push(s.sid);
    }
    return out;
  }
  // Search tokens (patch 86): s:needs|working|idle|done|cutoff, a:claude|codex and
  // p:<project or folder> filter the board; every other word is free text for the
  // keyword pass and the Haiku ranking.
  function parseQuery(v){
    const t={s:[],a:"",p:[],text:[]};
    for(const w of String(v).split(/\\s+/).filter(Boolean)){
      const m=/^([sap]):(.+)$/i.exec(w), k=m&&m[1].toLowerCase(), val=m&&m[2].toLowerCase();
      if(!m) t.text.push(w); else if(k==="s") t.s.push(val); else if(k==="a") t.a=val; else t.p.push(val);
    }
    return t;
  }
  const qEl=document.getElementById("q"), qxEl=document.getElementById("qx"), srchEl=document.getElementById("srch");
  qxEl.style.display="none";
  function enterSearch(){
    const v=qEl.value.trim();
    if(!v){ exitSearch(); return; }
    // Tokens filter; only the free text goes to the keyword pass and to Haiku. a: switches
    // the half, so the toggle always says which board the results come from.
    searchTok=parseQuery(v);
    if(searchTok.a==="claude"||searchTok.a==="codex") setAgent(searchTok.a);
    const text=searchTok.text.join(" ");
    searchActive=true; searchQ=text; searchTerms=text.toLowerCase().split(/\\s+/).filter(Boolean);
    searchOrder=keywordOrder(); searchReason={}; searchPending=!!text;
    srchEl.classList.toggle("busy",!!text); qxEl.style.display="";
    if(text) api.postMessage({type:"search", q:text});
    render(lastSessions);
  }
  function exitSearch(){
    searchActive=false; searchQ=""; searchTerms=[]; searchOrder=[]; searchReason={}; searchPending=false; searchTok=parseQuery("");
    srchEl.classList.remove("busy"); qEl.value=""; qxEl.style.display="none";
    render(lastSessions);
  }
  qEl.addEventListener("keydown",(e)=>{
    if(e.key==="Enter"){ e.preventDefault(); enterSearch(); }
    else if(e.key==="Escape"){ e.preventDefault(); exitSearch(); qEl.blur(); }
  });
  qxEl.onclick=()=>{ exitSearch(); };
  // One icon per state so the silhouette alone signals the state (colorblind-safe):
  // needs = speech bubble w/ "?", working = spinner arc (rotates via CSS),
  // done = circle-check, idle = crescent moon. Stroke set, 24px grid, currentColor.
  function stateIcon(state,tier,dormant){
    // An open-tier needs-card is a finished session holding an item, not a question
    // waiting on an answer — so it gets a ring, not the ask bubble.
    if(state==="needs"&&tier==="open")
      return '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/>'
           + '<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/></svg>';
    const P={
      needs:'<path d="M5 4.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6.5L8 20v-3.5H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z"/>'
           +'<path d="M10.1 9.2a2.1 2.1 0 0 1 4 .7c0 1.4-2 1.6-2 2.8"/>'
           +'<circle cx="12.1" cy="14.9" r="0.4" fill="currentColor"/>',
      working:'<path d="M12 3a9 9 0 1 1-6.36 2.64"/>',
      done:'<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16.2 9.6"/>',
      idle:'<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>',
      // cutoff = a play triangle in a DASHED circle: "pick this back up". The dashed
      // ring marks every resumable card (patch 85); live states have solid shapes.
      cutoff:'<circle cx="12" cy="12" r="9" stroke-dasharray="3.2 2.6"/><path d="M10 8.5l5 3.5-5 3.5Z"/>',
      // dormant = its process is gone; a power glyph in a dashed ring: "start it again".
      dormant:'<circle cx="12" cy="12" r="9" stroke-dasharray="3.2 2.6"/><path d="M12 7.5v4.5"/><path d="M15 9.2a4 4 0 1 1-6 0"/>'
    };
    const k=(dormant&&state!=="cutoff")?"dormant":state;
    return '<svg viewBox="0 0 24 24">'+(P[k]||P.idle)+'</svg>';
  }
  // Topic emoji inferred from the session title so the subject reads at a glance.
  // PRIMARY = this keyword table (instant, free). First regex to hit wins, so the
  // order is by SUBJECT SALIENCE — the word most likely to be a title's real topic
  // sits above words that tend to be incidental ("document"/"review" above
  // "meeting" so "Review document … meeting" reads as 📄, not 📅). Built from a
  // frequency scan of the user's 800 past session titles. A miss returns "" and the
  // caller falls back to a cached Haiku pick, then 💬.
  const TOPIC=[
    // People / domain-specific work — highest confidence.
    [/\\brose\\b|novel|manuscript|atlantic\\s*books|synops|query letter|writ(?:ing|ers?)\\s+residenc|literary|\\bbook\\b|publisher/i,"📖"],
    [/\\bcv\\b|cover letter|job\\s*(search|app|post|hunt)|application|résumé|\\bresume\\b|interview|vacan|sanofi|recruit|linkedin/i,"💼"],
    [/invoice|timesheet|billing|time\\s*log|\\bhours\\b|payment|expense/i,"🧾"],
    // Media / recording (VLR, Maven lessons, YouTube).
    [/video|recording|screencast|screen\\s*record|youtube|maven|\\blesson|\\bvlr\\b|podcast|\\baudio\\b|transcri/i,"🎥"],
    // Design.
    [/figma|design\\s*system|claude\\s*design|\\bds\\b|component|prototype|\\bui\\b|\\bux\\b|mockup|redesign|wireframe|\\bfooter\\b/i,"🎨"],
    // Dev tools / editor / this app.
    [/overlord|cursor|vs\\s*code|extension|statusline|\\btray\\b|toolkit|keybind|sideload|vsix|\\bmcp\\b|plugin|launcher/i,"🛠️"],
    // Messaging — an explicit channel word ("email X about the report") is the
    // action, so it outranks the noun it's about (report/document/meeting).
    [/e?mail|gmail|inbox|\\breply\\b|gchat|whatsapp|(?<!\\(|via )\\bwa\\b|slack|(?<!error )\\bmessage\\b|\\bdm\\b/i,"📧"],
    // Documents / writing (salient object → above meeting/research).
    [/document|\\bdoc\\b|write-?up|\\bspec\\b|proposal|\\bmemo\\b|synthesis|\\bnotes?\\b|readme|handoff|\\breport\\b|\\b5[\\/.]?15\\b/i,"📄"],
    // Data / metrics — specific tools (BigQuery/Tableau/CVR) beat generic "analysis".
    [/\\bdata\\b|metric|analytics|dashboard|\\bsql\\b|bigquery|\\bbq\\b|\\bquery\\b|tableau|\\bcvr\\b|funnel|\\bchart/i,"📊"],
    // Research.
    [/research|competitor|analysis|benchmark|\\bstudy\\b|explore|investigat|deep[- ]?dive|\\bsource\\b|extractor|searcher|finding/i,"🔬"],
    // Meetings (below documents/research so incidental "meeting" doesn't win; above
    // review since patch 85, so "Review yesterday's 1:1" reads as the meeting it is).
    [/meeting|granola|calendar|reschedul|(?<!tool |api |function )\\bcall\\b|standup|stand-up|\\b1[:\\-]?1\\b|agenda|invite|catch[- ]?up/i,"📅"],
    // Review / audit / usability.
    [/\\breview\\b|\\baudit\\b|usability|think[- ]?aloud|heuristic|critique|proofread/i,"🔎"],
    // Bugs.
    [/\\bbug\\b|\\bfix\\b|error|debug|crash|broken|troublesho|regress|\\bhang\\b|\\bissue/i,"🐛"],
    // Testing / verification (workflow verifier/voter/adversarial sessions land here).
    [/\\btest\\b|verify|verifier|verification|adversarial|\\bvoter\\b|\\bclaim\\b|\\bqa\\b|assert|coverage|\\bjudge\\b/i,"🧪"],
    // Deploy / repo / git.
    [/deploy|vercel|\\brepo\\b|\\bgit\\b|\\bpush\\b|pipeline|\\bci\\b|release|\\bmerge\\b|\\bpr\\b|commit|\\bbranch(?!\\s+manager)/i,"🚀"],
    // Web / scraping / browser.
    [/\\bweb\\b|website|\\burl\\b|https?|scrape|crawl|\\bhtml\\b|browser|playwright|domain/i,"🌐"],
    // Loops / watchers / automation.
    [/\\bloops?\\b|\\bpoll\\b|grind|watchdog|\\bwatch(er)?s?\\b|daemon|\\bschedule[dr]?\\b|\\bcron\\b|automation/i,"🔁"],
    // Security / auth.
    [/security|secret|gitleaks|okta|\\bauth\\b|password|credential|\\bsso\\b|\\blogin\\b|2fa|encrypt/i,"🔒"],
    // Knowledge / vault / memory.
    [/memory|obsidian|vault|knowledge|\\bbrain\\b/i,"🧠"],
    // Strategy / planning.
    [/strateg|roadmap|\\bokr|planning|prioriti|\\bdecision|framework|\\bpitch\\b|\\bvision\\b/i,"🧭"],
    // Tasks.
    [/\\btask(s)?\\b|to[-\\s]?do|things to do|backlog|checklist|asana|\\bticket/i,"📋"],
    // Hardware / machine.
    [/laptop|\\bterminal\\b|hardware|\\bpc\\b|windows|\\bgpu\\b|battery|(?<!daily )driver|\\bbios\\b|keyboard|monitor/i,"💻"],
    // Config / setup.
    [/config|setting|install|setup|\\benv\\b|environment|provision|bootstrap|migrat/i,"⚙️"],
    // Overlord button-labeler noise, if it ever surfaces.
    [/\\blabel(s|ing)?\\b/i,"🏷️"],
    // Personal spillover.
    [/\\bflights?\\b|\\btravel\\b|\\bhotels?\\b|itinerar/i,"✈️"],
    [/real estate|mortgage|banking|\\bbank\\b|residen(?:cy|ce)\\b|insurance|vodafone|paraforma/i,"🏠"],
  ];
  // Keyword pick, or "" when nothing matches (→ Haiku fallback, then 💬).
  function topicEmojiKw(name){
    const t=String(name||"");
    for(const [re,e] of TOPIC) if(re.test(t)) return e;
    return "";
  }
  // Cards are always expanded; clicking a card jumps straight to its session.
  // Right-click opens a small custom menu (webviews can't use VS Code's native
  // context menus). The menu lives on <body>, so per-tick re-renders of #root
  // don't dismiss it.
  const menu=document.createElement("div"); menu.className="ctx"; document.body.appendChild(menu);
  // Inline rename: click the title (or the context-menu entry) to edit in
  // place. Enter saves, Esc/blur cancels. While an edit is open, per-tick
  // re-renders are suspended so the input isn't destroyed mid-typing.
  let editing=false;
  const nmBySid=new Map();   // sid -> title element of the current render
  function startRename(nm,s){
    if(editing||!nm) return;
    editing=true;
    nm.textContent="";
    const inp=document.createElement("input");
    inp.value=s.name; inp.spellcheck=false;
    nm.appendChild(inp);
    inp.focus(); inp.select();
    const done=(save)=>{
      if(!editing) return; editing=false;
      const v=inp.value.trim();
      if(save){ api.postMessage({type:"rename",sid:s.sid,name:v}); nm.textContent=v||s.name; }
      else nm.textContent=s.name;
    };
    inp.onclick=(ev)=>ev.stopPropagation();
    inp.onkeydown=(ev)=>{ ev.stopPropagation();
      if(ev.key==="Enter") done(true);
      else if(ev.key==="Escape") done(false); };
    inp.onblur=()=>done(false);
  }
  function hideMenu(){ menu.style.display="none"; }
  function showMenu(x,y,s){
    menu.innerHTML="";
    const nw=document.createElement("div"); nw.textContent="➕ New session";
    nw.onclick=(ev)=>{ ev.stopPropagation(); hideMenu(); api.postMessage({type:"new"}); };
    menu.appendChild(nw);
    const w=document.createElement("div"); w.textContent="📜 Watch transcript";
    w.onclick=(ev)=>{ ev.stopPropagation(); hideMenu(); markRead(s.sid); api.postMessage({type:"open",sid:s.sid}); };
    menu.appendChild(w);
    const rn=document.createElement("div"); rn.textContent="✏️ Rename";
    rn.onclick=(ev)=>{ ev.stopPropagation(); hideMenu(); startRename(nmBySid.get(s.sid),s); };
    menu.appendChild(rn);
    // Dormant (restored) card: offer Resume. Until 2026-08-06 this was an else-if
    // against "Move to done", so a dormant card could only be resumed or killed —
    // and an old session you're never reopening had to be DELETED to get it off the
    // board. Both are offered now; parking a dormant card keeps it (and its
    // transcript) resumable from the Done tab.
    if(s.dormant){
      const rs=document.createElement("div"); rs.textContent="⏵ Resume session";
      rs.onclick=(ev)=>{ ev.stopPropagation(); hideMenu(); api.postMessage({type:"resume",sid:s.sid}); };
      menu.appendChild(rs);
    }
    // Move to done: force-park the card into the Done section now.
    if(s.state!=="done"){
      const md=document.createElement("div"); md.textContent="🟢 Move to done";
      md.onclick=(ev)=>{ ev.stopPropagation(); hideMenu(); api.postMessage({type:"park",sid:s.sid}); };
      menu.appendChild(md);
    }
    // Plan-gate toggle (patch 38b): flips this session's opt-out flag in the file
    // the Stop-hook gate reads. Authoritative write is the FILE, host-side; the
    // panel's ⛔ badge follows on the next post.
    // Patch 84: not on a Codex card -- the gate is a Claude Code Stop hook.
    if(s.agent!=="codex"){
    const pgOff=!!(s.tasks&&s.tasks.optOut);
    const pg=document.createElement("div");
    pg.textContent=pgOff?"✅ Plan gate: turn back on":"⛔ Plan gate: opt this session out";
    pg.onclick=(ev)=>{ ev.stopPropagation(); hideMenu(); api.postMessage({type:"planGateToggle",sid:s.sid}); };
    menu.appendChild(pg);
    }
    // Pin / Unpin (patch 86): three at most; a fourth is refused here with a note.
    const pinnedNow=pinnedSids.has(s.sid);
    const pn=document.createElement("div"); pn.textContent=pinnedNow?"📌 Unpin":"📌 Pin to top";
    pn.onclick=(ev)=>{ ev.stopPropagation(); hideMenu();
      if(!pinnedNow&&pinnedSids.size>=3){ showToast("<span>Three pins at most. Unpin one first.</span>",3000); return; }
      if(pinnedNow) pinnedSids.delete(s.sid); else pinnedSids.add(s.sid);
      api.postMessage({type:"pin",sid:s.sid}); render(lastSessions); };
    menu.appendChild(pn);
    // Remove sits apart, under a divider (patch 86), and acts only after its undo window.
    const sep=document.createElement("div"); sep.className="sep"; menu.appendChild(sep);
    const it=document.createElement("div"); it.textContent="❌ Remove session";
    it.onclick=(ev)=>{ ev.stopPropagation(); hideMenu(); removeWithUndo(s); };
    menu.appendChild(it);
    placeMenu(x,y);
  }
  function placeMenu(x,y){
    menu.style.display="block";
    const r=menu.getBoundingClientRect();
    menu.style.left=Math.max(0,Math.min(x,window.innerWidth-r.width-6))+"px";
    menu.style.top=Math.max(0,Math.min(y,window.innerHeight-r.height-6))+"px";
  }
  // Remove with undo (patch 86): the card hides at once, and the kill is sent only when
  // the 5-second window closes, so Undo gives back a session nothing has touched. One
  // window at a time: a second removal sends the first. hidden keeps a removed card off
  // the board a little past the kill, until the host's post drops it.
  const hidden=new Map();   // sid -> time the card may show again
  let pendingKill=null, toastTimer=0;
  const toast=document.createElement("div"); toast.id="toast"; toast.setAttribute("role","status"); document.body.appendChild(toast);
  function showToast(html,ms){ toast.innerHTML=html; toast.style.display="flex";
    clearTimeout(toastTimer); toastTimer=setTimeout(()=>{ toast.style.display="none"; },ms); }
  function sendKill(){ if(!pendingKill) return; clearTimeout(pendingKill.timer);
    api.postMessage({type:"kill",sid:pendingKill.sid}); pendingKill=null; }
  function removeWithUndo(s){
    sendKill();
    hidden.set(s.sid,Date.now()+20000);
    pendingKill={sid:s.sid,timer:setTimeout(sendKill,5000)};
    showToast('<span>Removed “'+esc(s.name||"session")+'”</span><button>Undo</button>',5000);
    toast.querySelector("button").onclick=(ev)=>{ ev.stopPropagation(); if(!pendingKill) return;
      clearTimeout(pendingKill.timer); hidden.delete(pendingKill.sid); pendingKill=null;
      toast.style.display="none"; render(lastSessions); };
    render(lastSessions);
  }
  function isHidden(sid){ const t=hidden.get(sid); if(t&&t<Date.now()) hidden.delete(sid); return hidden.has(sid); }
  // Saved searches (patch 86): up to three queries in the webview state, which outlives
  // a reload. ★ lists them in the menu box; the oldest goes when a fourth is saved.
  document.getElementById("qv").onclick=(ev)=>{ ev.stopPropagation();
    const views=(api.getState()||{}).views||[], cur=qEl.value.trim(), r=ev.currentTarget.getBoundingClientRect();
    menu.innerHTML="";
    const add=(label,fn)=>{ const d=document.createElement("div"); d.textContent=label;
      d.onclick=(e2)=>{ e2.stopPropagation(); hideMenu(); fn(); }; menu.appendChild(d); };
    views.forEach(v=>add("🔍 "+v,()=>{ qEl.value=v; enterSearch(); }));
    if(cur&&views.indexOf(cur)<0) add("☆ Save “"+cur+"”",()=>saveState({views:views.concat(cur).slice(-3)}));
    if(views.length) add("✕ Clear saved searches",()=>saveState({views:[]}));
    if(!menu.children.length) add("Search first, then save it here",()=>{});
    placeMenu(r.left,r.bottom+2);
  };
  document.addEventListener("click",hideMenu);
  document.addEventListener("keydown",(e)=>{ if(e.key==="Escape") hideMenu(); });
  // Keyboard navigation: ↑/↓ move the selection through the cards as currently
  // shown (respects the active filter tab), Enter jumps to the selected
  // session's terminal. Suspended while a rename input is open.
  function shownSidsInOrder(){
    const out=[];
    document.querySelectorAll("#root .row").forEach(r=>{
      for(const [sid,c] of cards){ if(c.row===r){ out.push(sid); break; } }
    });
    return out;
  }
  document.addEventListener("keydown",(e)=>{
    if(editing) return;
    // Patch 86: inputs keep their keys and a focused button keeps Enter. A focused card
    // is the one Enter acts on, and the arrows move focus along with the selection.
    const ae=document.activeElement, tag=ae&&ae.tagName, fsid=ae&&ae.dataset&&ae.dataset.sid;
    if(tag==="INPUT"||tag==="TEXTAREA") return;
    if(e.key==="Enter"&&tag==="BUTTON") return;
    if(e.key!=="ArrowDown"&&e.key!=="ArrowUp"&&e.key!=="Enter") return;
    const sids=shownSidsInOrder(); if(!sids.length) return;
    if(e.key==="Enter"){
      const sid=fsid||selectedSid;
      if(sid&&sids.indexOf(sid)>=0){
        e.preventDefault(); setSelected(sid); const cur=bySid.get(sid);
        api.postMessage({type:(cur&&cur.dormant)?"resume":"jump", sid:sid});
      }
      return;
    }
    e.preventDefault();
    let i=sids.indexOf(fsid||selectedSid);
    i = e.key==="ArrowDown" ? Math.min(sids.length-1, i+1) : Math.max(0, (i<0?0:i-1));
    // Arrows move keyboard focus only; Enter opens. Lighting a card it doesn't show
    // was the mismatch (the user 2026-11-09).
    const c=cards.get(sids[i]);
    if(c){ c.row.tabIndex=0; c.row.focus({preventScroll:true}); if(c.row.scrollIntoView) c.row.scrollIntoView({block:"nearest"}); }
  });
  // Incremental card renderer: one persistent DOM card per sid, updated in
  // place. Rebuilding innerHTML on every 2.5s poll made card content visibly
  // flash (and reset quick-reply "sent" states); now a text node is written
  // only when its content actually changed, the icon swaps only on a state
  // change, and rows move only when the sort order really moved.
  // Patch 99 (2026-11-04, the user: hover an icon and after 500ms a tooltip explains it).
  // One delegated listener and one tooltip, because the poll repaint replaces these nodes:
  // the same text under the pointer is the same tooltip, so a repaint neither restarts
  // the wait nor hides it. Native title has its own fixed delay, so it can't do this.
  const ICON_TIP={
    done:"Finished.",
    prog:"In progress. The session isn't actively working on it right now, which is also how a background run looks.",
    live:"In progress. The session is working on it right now.",
    stall:"In progress, but its task record hasn't been updated for 30 minutes. Worth checking: the work may still be running.",
    pend:"Not started.",
    skip:"Skipped on purpose. The reason is beside the step's name.",
    evidence:"Proof this step finished, such as a file or a test count.",
    skipBtn:"Skip this step. It asks for a reason first.",
    goal:"The session's goal: what this session is for.",
    caret:"Open or close this section.",
    add:"Add a new step to this list.",
    planOff:"This session has opted out of tracking steps.",
    noPlan:"This session is working without a step list.",
    newWork:"The session has done new work since its last step list, with no steps for it.",
    stalled:"A step in progress hasn't had its task record updated for 30 minutes. The work may still be running.",
    unevidenced:"These finished steps don't say what proves them."
  };
  (function(){
    const box=document.createElement("div");
    box.id="ictip"; box.hidden=true; document.body.appendChild(box);
    let timer=0, cur="";
    const hide=()=>{ clearTimeout(timer); timer=0; cur=""; box.hidden=true; };
    document.addEventListener("mouseover",(ev)=>{
      const t=ev.target.closest&&ev.target.closest("[data-tip]");
      if(!t){ hide(); return; }
      if(t.dataset.tip===cur) return;
      hide();
      cur=t.dataset.tip;
      const x=ev.clientX, y=ev.clientY;
      timer=setTimeout(()=>{
        box.textContent=cur; box.hidden=false;
        const w=box.offsetWidth, h=box.offsetHeight;
        box.style.left=Math.max(4,Math.min(x+10,window.innerWidth-w-4))+"px";
        box.style.top=(y+18+h>window.innerHeight?Math.max(4,y-h-8):y+18)+"px";
      },500);
    });
    document.addEventListener("mousedown",hide,true);
    document.addEventListener("scroll",hide,true);
    document.documentElement.addEventListener("mouseleave",hide);
    window.addEventListener("blur",hide);
  })();
  const cards=new Map();    // sid -> {row,av,tg,nm,why,st,sum,qr,state,name,btnKey,hlKey,emo}
  const bySid=new Map();    // sid -> latest session payload (for handlers)
  function buildCard(s){
    const sid=s.sid;
    const row=document.createElement("div"); row.className="row "+s.state+(s.tier==="open"?" tier-open":"");
    // Patch 86: a list item to a screen reader, focusable from the keyboard (roving tabindex).
    row.setAttribute("role","listitem"); row.tabIndex=-1; row.dataset.sid=sid;
    const av=document.createElement("div"); av.className="icon"; av.innerHTML=stateIcon(s.state,s.tier);
    const meta=document.createElement("div"); meta.className="meta";
    const hdr=document.createElement("div"); hdr.className="hdr";
    const tg=document.createElement("span"); tg.className="tg";
    const nm=document.createElement("div"); nm.className="nm";
    nm.title="Click to rename";
    // A compact row is mostly title, so its first click falls through to the row and
    // unfolds it (patch 85); renaming starts from the unfolded card or the menu.
    nm.onclick=(ev)=>{ if(row.classList.contains("cmpt")&&!row.classList.contains("selected")) return;
      ev.stopPropagation(); const cur=bySid.get(sid); if(cur) startRename(nm,cur); };
    nmBySid.set(sid,nm);
    // One-line readout (state · context %) shown only while the row is compact.
    const cmp=document.createElement("span"); cmp.className="cmp";
    // Pin mark and PR / CI chip (patch 86), hidden until there is one.
    const pn=document.createElement("span"); pn.className="pn"; pn.textContent="📌"; pn.title="Pinned"; pn.style.display="none";
    const pr=document.createElement("span"); pr.className="prc"; pr.style.display="none";
    hdr.appendChild(av); hdr.appendChild(tg); hdr.appendChild(pn); hdr.appendChild(nm); hdr.appendChild(cmp); hdr.appendChild(pr);
    // RUNNING badge — static chrome plus a text slot we patch, like the LOOP badge.
    const run=document.createElement("div"); run.className="run";
    run.innerHTML='<span class="rb"><i></i><i></i><i></i></span><b>RUNNING</b><span class="rt"></span><span class="rx">▾</span>';
    const rt=run.querySelector(".rt");
    // While it shows, it is the header of the helper + run lists below: one click folds both.
    run.onclick=(ev)=>{ ev.stopPropagation(); const c=cards.get(sid); if(!c) return;
      c.hpOpen=c.rnOpen=!(c.hpOpen&&c.rnOpen); applyHelperFold(c); applyRunFold(c);
      run.querySelector(".rx").textContent=c.hpOpen?"▾":"▸"; };
    // Context fill rail (below the title, above everything describing the work).
    const cbar=document.createElement("div"); cbar.className="cbar"; cbar.style.display="none";
    cbar.innerHTML='<span class="cbd">🐦</span><div class="cr"><u></u><s></s></div>'
                  +'<span class="cv"></span><span class="csp"></span><button class="cta" style="display:none">Hand off</button>';
    const cbu=cbar.querySelector("u"), cbv=cbar.querySelector(".cv"), cbs=cbar.querySelector(".csp");
    const cbc=cbar.querySelector(".cta");
    // Runs the handoff gate for this session (patch 49; was "Compact now" typing
    // /compact until 2026-09-04 — a handoff is a complete turn plus a deterministic
    // snapshot, compaction is a summary at an arbitrary moment). Must not bubble
    // to row.onclick, which would jump to the terminal instead.
    cbc.onclick=(ev)=>{ ev.stopPropagation();
      api.postMessage({type:"handoff",sid:sid});
      cbc.classList.add("sent"); cbc.textContent="handing off…"; };
    // "why it matched" line — populated only in search mode, hidden otherwise.
    const why=document.createElement("div"); why.className="why"; why.style.display="none";
    const stl=document.createElement("div"); stl.className="st";
    const st=document.createElement("span");
    // A card with no steps declared shows this ⚠ instead of an empty TASKS panel (patch 85).
    const stw=document.createElement("span"); stw.className="stw"; stw.textContent="⚠"; stw.style.display="none";
    stl.appendChild(st); stl.appendChild(stw);
    const sum=document.createElement("div"); sum.className="sum";
    // Quick-reply container. Buttons are dynamic — generated per wait from the
    // session's actual pending question (see ensureAsk in the host) — and are
    // injected by render() whenever the generated set changes.
    const qr=document.createElement("div"); qr.className="qr"; qr.style.display="none";
    // Assist row + answer panel (patch 35). Clicks must not bubble to row.onclick,
    // which would jump to the terminal.
    const as=document.createElement("div"); as.className="as"; as.style.display="none";
    const ap=document.createElement("div"); ap.className="ap";
    const mkAssist=(kind,label)=>{
      const b=document.createElement("button"); b.textContent=label; b.dataset.k=kind;
      b.onclick=(ev)=>{ ev.stopPropagation(); toggleAssist(sid,kind); };
      as.appendChild(b); return b;
    };
    mkAssist("simplify","Simplify"); mkAssist("next","Next step");
    // Active auto-loop badge (foot of card). Static chrome + a text slot we patch.
    const loop=document.createElement("div"); loop.className="loop";
    loop.innerHTML='<span class="ldot"></span><span class="lsp"></span><b>LOOP</b><span class="lt"></span>';
    const lt=loop.querySelector(".lt");
    // Plan-board task panel (patch 38a): header badge + collapsible read-only list.
    // Clicks must not bubble to row.onclick (same rule as the assist row).
    const tk=document.createElement("div"); tk.className="tk";
    const tkh=document.createElement("div"); tkh.className="tkh";
    tkh.innerHTML='<b>TASKS</b><span class="tkc"></span><span class="tkg"></span><span class="tkx" data-tip="'+esc(ICON_TIP.caret)+'">▸</span>';
    tkh.onclick=(ev)=>{ ev.stopPropagation(); const c=cards.get(sid); if(!c) return;
      c.tkOpen=!c.tkOpen; c.tkl.style.display=c.tkOpen?"":"none";
      c.tkx.textContent=c.tkOpen?"▾":"▸"; };
    // Session goal (patch 38e): always visible while the panel is on, above the
    // steps, click to edit. Answers "is this still the thing you asked for",
    // which the step counter structurally cannot.
    const tkgoal=document.createElement("div"); tkgoal.className="tkgoal unset";
    tkgoal.innerHTML='<span class="tkgi">◎</span><span class="tkgt"></span>';
    tkgoal.onclick=(ev)=>{ ev.stopPropagation(); const c=cards.get(sid); if(!c) return;
      openTaskInput(c,c.tkgoal,"goal","",""); };
    const tkl=document.createElement("div"); tkl.className="tkl"; tkl.style.display="none";
    // Write-back (patch 38b): delegated clicks — the status glyph toggles, ⊘ opens
    // an inline skip-reason input, the ＋ row opens an inline add input. Open inputs
    // set c.tkEdit so the poll repaint can't clobber them mid-typing.
    tkl.onclick=(ev)=>{ ev.stopPropagation();
      const c=cards.get(sid); if(!c) return;
      if(ev.target.closest(".tkrh")){ c.erOpen=!c.erOpen; applyEarlierFold(c); return; }
      if(ev.target.classList.contains("tka")){ openTaskInput(c,ev.target,"add","",""); return; }
      // Evidence rows sit OUTSIDE .tki, so they carry their own dir/id and are
      // matched before the .tki lookup below.
      if(ev.target.classList.contains("tkev")){
        openTaskInput(c,ev.target,"evi",ev.target.dataset.d,ev.target.dataset.i); return; }
      const it=ev.target.closest(".tki"); if(!it||!it.dataset.i) return;
      if(ev.target.classList.contains("tkskip")){ openTaskInput(c,it,"skip",it.dataset.d,it.dataset.i); return; }
      if(ev.target.classList.contains("tks"))
        api.postMessage({type:"taskToggle",sid:sid,dir:it.dataset.d,id:it.dataset.i});
    };
    tk.appendChild(tkh); tk.appendChild(tkgoal); tk.appendChild(tkl);
    // Background runs this session launched (2026-08-21): a section, not their own
    // cards. They have no terminal, so a click can only ever watch the transcript.
    const rn=document.createElement("div"); rn.className="rn";
    rn.onclick=(ev)=>{ ev.stopPropagation();
      const c=cards.get(sid);
      // Header folds the list, same gesture as TASKS. A row opens its transcript.
      if(c&&ev.target.closest(".rnh")){ c.rnOpen=!c.rnOpen; applyRunFold(c); return; }
      if(c&&ev.target.closest(".rnfh")){ c.rdOpen=!c.rdOpen; applyRunFold(c); return; }
      const it=ev.target.closest(".rni"); if(!it||!it.dataset.s) return;
      api.postMessage({type:"open",sid:it.dataset.s}); };
    // Helpers (subagents) this session is running — header folds, a row opens its log.
    const hp=document.createElement("div"); hp.className="rn";
    hp.onclick=(ev)=>{ ev.stopPropagation();
      const c=cards.get(sid);
      if(c&&ev.target.closest(".rnh")){ c.hpOpen=!c.hpOpen; applyHelperFold(c); return; }
      const it=ev.target.closest(".rni"); if(!it||!it.dataset.h) return;
      api.postMessage({type:"openHelper",sid:sid,id:it.dataset.h,name:it.dataset.n}); };
    // Compact order (2026-09-17, the user picked it): who/where, cost, what it said, then the
    // work — steps, and one activity block where the RUNNING line heads helpers + runs.
    meta.appendChild(hdr); meta.appendChild(stl); meta.appendChild(cbar); meta.appendChild(why); meta.appendChild(sum); meta.appendChild(qr); meta.appendChild(as); meta.appendChild(ap); meta.appendChild(tk); meta.appendChild(run); meta.appendChild(hp); meta.appendChild(rn); meta.appendChild(loop);
    row.appendChild(meta);
    // Live card → jump to its terminal; dormant (restored) card → resume it.
    row.onclick=()=>{ setSelected(sid); const cur=bySid.get(sid);
      api.postMessage({type:(cur&&cur.dormant)?"resume":"jump", sid:sid}); };
    row.oncontextmenu=(ev)=>{ ev.preventDefault(); ev.stopPropagation();
      showMenu(ev.clientX,ev.clientY,bySid.get(sid)||{sid:sid}); };
    return {sid,row,av,tg,nm,cmp,pn,pr,prKey:"",stw,run,rt,runKey:"",cbar,cbu,cbv,cbs,cbc,cbKey:"",why,st,sum,qr,as:as,ap,loop,lt,tk,tkl,tkgoal,rn,rnKey:"",rnOpen:true,rdOpen:false,hp,hpKey:"",hpOpen:true,erOpen:false,tkx:tkh.querySelector(".tkx"),tkc:tkh.querySelector(".tkc"),tkg:tkh.querySelector(".tkg"),tkKey:"",tkOpen:false,tkEdit:false,hlKey:"",emo:"",state:s.state,tier:s.tier,name:"",btnKey:"",loopText:"",msgKey:"",openKind:""};
  }
  // Fold state for the RUNS list. Held on the card, not in the markup, so the
  // 2.5s repaint cannot silently re-open a section the user collapsed.
  function applyRunFold(c){
    const l=c.rn.querySelector(".rnl"), x=c.rn.querySelector(".rnx");
    if(l) l.style.display=c.rnOpen?"":"none";
    if(x) x.textContent=c.rnOpen?"▾":"▸";
    const fl=c.rn.querySelector(".rnfl"), fx=c.rn.querySelector(".rnfx");
    if(fl) fl.style.display=c.rdOpen?"":"none";
    if(fx) fx.textContent=c.rdOpen?"▾":"▸";
  }
  function applyHelperFold(c){
    const l=c.hp.querySelector(".rnl"), x=c.hp.querySelector(".rnx");
    if(l) l.style.display=c.hpOpen?"":"none";
    if(x) x.textContent=c.hpOpen?"▾":"▸";
  }
  // Same, for the earlier task lists — but these default CLOSED: they are history,
  // and on a long session there are three of them pushing the live list off screen.
  function applyEarlierFold(c){
    const l=c.tkl.querySelector(".tkrl"), x=c.tkl.querySelector(".tkrx");
    if(l) l.style.display=c.erOpen?"":"none";
    if(x) x.textContent=c.erOpen?"▾":"▸";
  }
  // ---- card assist (patch 35) ------------------------------------------------
  // Click a button -> ask the host (side call on the transcript, never the session).
  // Click the same button again -> collapse. Answers are cached per turn in the host,
  // so reopening one is free; a new turn invalidates it via msgKey.
  function toggleAssist(sid,kind){
    const c=cards.get(sid); if(!c) return;
    if(c.openKind===kind){ c.openKind=""; paintAssist(c,null); return; }
    c.openKind=kind;
    const cached=c.answers&&c.answers[kind];
    paintAssist(c, cached||{busy:true,kind:kind});
    if(!cached) api.postMessage({type:"assist",sid:sid,kind:kind,msgKey:c.msgKey||""});
  }
  // Inline input for the task panel (patch 38b): skip-reason or new-task subject.
  // window.prompt is unavailable in webviews, so the row itself becomes the input.
  // Enter sends, Escape/blur cancels; tkEdit guards the repaint either way, and
  // clearing tkKey forces a fresh paint from the next host post.
  function openTaskInput(c,el,mode,d,i){
    c.tkEdit=true;
    const ph=mode==="add"?"new task, Enter to save…"
            :mode==="goal"?"what is this session FOR? Enter to save, empty clears…"
            :mode==="evi"?"what proves this is done? Enter to save…"
            :"why skipped? Enter to save…";
    // Goal edits are edits, not replacements — prefill with what is already there.
    const pre=mode==="goal"?(c.goalText||""):"";
    el.innerHTML='<input class="tkin" placeholder="'+ph+'" value="'+esc(pre)+'">';
    const inp=el.querySelector("input"); inp.focus(); inp.select();
    let done=false;
    const close=(send)=>{ if(done) return; done=true; c.tkEdit=false; c.tkKey="";
      const v=inp.value.trim();
      // Every mode needs a value except goal, where an empty box means "clear it".
      if(send&&(v||mode==="goal")){
        if(mode==="add") api.postMessage({type:"taskAdd",sid:c.sid,subject:v});
        else if(mode==="goal") api.postMessage({type:"taskGoal",sid:c.sid,text:v});
        else if(mode==="evi") api.postMessage({type:"taskEvidence",sid:c.sid,dir:d,id:i,text:v});
        else api.postMessage({type:"taskSkip",sid:c.sid,dir:d,id:i,reason:v});
      } };
    inp.onkeydown=(e)=>{ e.stopPropagation();
      if(e.key==="Enter") close(true); else if(e.key==="Escape") close(false); };
    inp.onblur=()=>close(false);
    inp.onclick=(e)=>e.stopPropagation();
  }
  function paintAssist(c,ans){
    c.as.querySelectorAll("button").forEach(b=>b.classList.toggle("on", !!ans && b.dataset.k===c.openKind));
    if(!ans){ c.ap.classList.remove("on"); c.ap.textContent=""; return; }
    c.ap.classList.add("on");
    if(ans.busy){ c.ap.innerHTML='<span class="abusy">'+(c.openKind==="next"?"Working out what is next…":"Reading the session…")+'</span>'; return; }
    if(ans.error){ c.ap.innerHTML='<span class="aerr">'+esc(ans.error)+'</span>'; return; }
    // Simplify: labelled prose chunks + a caveat rail (patch 36). ans.text is the
    // fallback the host leaves when the schema didn't parse — render it as v1 prose
    // rather than showing an error for an answer that actually arrived.
    if(c.openKind==="simplify"){
      if(ans.sections&&ans.sections.length){
        c.ap.innerHTML=ans.sections.map(s=>
            '<div class="ah sh"><span class="si">'+esc(s.icon)+'</span>'+esc(s.label)+'</div>'+
            '<p class="sb">'+esc(s.body)+'</p>').join("")
          +(ans.caveat?'<div class="cav"><span class="ci">⚠️</span>'+
            '<span><b>Not settled</b> '+esc(ans.caveat)+'</span></div>':"");
      } else c.ap.textContent=ans.text||"";
      return;
    }
    // Next step: render a section ONLY when it has entries. A finished session with
    // nothing owed says so in one line instead of padding the panel with invented work.
    const sec=(title,items)=>{
      if(!items||!items.length) return "";
      return '<div class="ah">'+title+'</div><ul>'+items.map(x=>
        "<li>"+esc(x.step)+(x.why?' <i>— '+esc(x.why)+"</i>":"")+"</li>").join("")+"</ul>";
    };
    const html=sec("Needs you",ans.you)+sec("Session can continue with",ans.session);
    c.ap.innerHTML=html||'<span class="abusy">Nothing pending — this one looks finished.</span>';
  }

  function render(sessions){
    if(editing) return;   // a rename is open — don't clobber the input
    if(Array.isArray(sessions)) lastSessions=sessions;   // remember for tab re-filter
    const everySession=lastSessions.filter(x=>!isHidden(x.sid));   // less cards in their undo window (patch 86)
    // Patch 87: the selected card (clicked, or its terminal focused) has been seen. Then
    // one place() per card; the list is sorted by who is waiting (rank), longest in its
    // state first inside a group, and a card with no clock keeps the host's order.
    const sel=selectedSid&&everySession.find(x=>x.sid===selectedSid);
    if(sel&&sel.doneAt>(readAt[sel.sid]||readBase)) markRead(sel.sid);
    const pl=new Map(everySession.map(x=>[x.sid,place(x)]));
    const blockingIn=(a)=>everySession.filter(x=>(x.agent||"claude")===a&&pl.get(x.sid).rank===0).length;
    // The toggle picks the board; everything below — tab counts, the card list,
    // the empty state — then describes only that agent. Rows with no agent field
    // are Claude's (nothing else wrote them), so an older payload still renders.
    const list=everySession.filter(x=>(x.agent||"claude")===agent)
      .sort((a,b)=>(pl.get(a.sid).rank-pl.get(b.sid).rank)||((a.stateAt||9e15)-(b.stateAt||9e15)));
    agentBtns.forEach(b=>{
      const a2=b.dataset.a, n=everySession.filter(x=>(x.agent||"claude")===a2).length;
      const nb=b.querySelector(".n"); if(nb) nb.textContent=n;
      // Patch 87: the hidden half's blocking count. Agent View counts one "awaiting input"
      // figure, so open items get no second number.
      const nk=a2===agent?0:blockingIn(a2), bd=b.querySelector(".bd");
      if(bd){ bd.textContent=nk||""; bd.style.display=nk?"":"none"; }
      b.title=(a2==="codex"?"Codex (GPT) sessions":"Claude Code sessions")+(nk?" — "+nk+" blocking":"");
      b.classList.toggle("on", a2===agent);
      b.setAttribute("aria-pressed", String(a2===agent));
    });
    const emojiWanted=[];   // titles missing a keyword+cached emoji, to ask Haiku
    // Update the filter tabs: live counts, active highlight, dim the empties.
    // The eye/All count is what the All view shows (patch 85): parked and cut-off
    // cards are decluttered out of it (they live under Done and Cutoff), so they are
    // not counted in it either.
    // Which TAB a card lives in — not what it IS. A session whose turn is over but
    // whose background jobs are still running belongs under Working (the user,
    // 2026-08-24: "it should then be shown in the working tab, always"), while its
    // own state stays honest at idle: the MODEL is not generating, and patch 36
    // exists because conflating those two made every finished-but-busy card
    // invisible to the needs-you machinery. Since patch 60 (the user, 2026-09-14: "if any
    // agent is still working they should be in the working tab") EVERY running card
    // is promoted, needs-you included — the ask stays on the card and the card moves
    // to Needs you the moment its jobs end. Parked cards never carry running
    // (patch 58 keeps them idle while jobs run), and dormant ones never do either.
    // A native dialog (patch 62) outranks both: the session is blocked on the user —
    // unless the user parked it on that dialog (patch 68), which leaves it in Done.
    const tabState=(x)=>(pl.get(x.sid)||place(x)).tab;   // patch 87: place() holds the rule
    const inAll=(x)=>x.state!=="done"&&x.state!=="cutoff";
    // Search tokens (patch 86): a card must pass every s:, a: and p: given.
    const tokOk=(x)=>(!searchTok.a||searchTok.a===agent)&&(!searchTok.s.length||searchTok.s.indexOf(tabState(x))>=0)&&
      searchTok.p.every(p=>((x.dir||"")+" "+(x.cwd||"")).toLowerCase().includes(p));
    const countFor=(f)=> f==="all"?list.filter(inAll).length:list.filter(x=>tabState(x)===f).length;
    // If the Cutoff tab was the active filter and it just emptied (everything
    // resumed/removed), fall back to All FIRST — so the tab paint below highlights
    // the right tab in the same frame (no one-render unselected-tab flash).
    if(filter==="cutoff" && countFor("cutoff")===0) filter="all";
    // The session on the right just changed and its card is in another tab: switch to
    // it, so the lit card is always in view (the user 2026-11-09). Only on a change, so
    // browsing other tabs afterwards is not yanked back.
    if(followSid&&!searchActive){ const fs=list.find(x=>x.sid===followSid);
      if(fs&&!pinnedSids.has(fs.sid)&&!(filter==="all"?inAll(fs):tabState(fs)===filter)) filter=inAll(fs)?"all":tabState(fs);
      followSid=null; }
    // Needs you holds two tiers, so its count reads "blocking·open" — a tab showing
    // 9 that is really 1 hold and 8 quiet open items would otherwise read as a queue
    // of urgent things and stop being trusted.
    const needsOpen=list.filter(x=>tabState(x)==="needs"&&x.tier==="open").length;
    tabs.forEach(t=>{
      const f=t.dataset.f, n=countFor(f);
      const b=t.querySelector(".n");
      if(b) b.textContent=(f==="needs"&&needsOpen)?((n-needsOpen)+"·"+needsOpen):n;
      if(f==="needs") t.title=needsOpen?("Needs you — "+(n-needsOpen)+" blocking · "+needsOpen+" open item"+(needsOpen>1?"s":"")):"Needs you";
      if(f==="idle"){ idleSids=list.filter(x=>tabState(x)==="idle").map(x=>x.sid); const rv=list.filter(x=>pl.get(x.sid).review).length; t.title=(rv?"Idle — "+rv+" ready for review":"Idle")+" · right-click to move all to Done"; }
      t.classList.toggle("active", f===filter);
      t.classList.toggle("empty", f!=="all" && n===0);
      // The Cutoff tab appears only when something was interrupted; hidden otherwise.
      if(f==="cutoff") t.classList.toggle("show", n>0);
    });
    const root=document.getElementById("root");
    bySid.clear(); for(const s of list) bySid.set(s.sid,s);
    // Sessions gone from the supervisor: drop their cards entirely.
    for(const [sid,c] of cards){ if(!bySid.has(sid)){ c.row.remove(); cards.delete(sid); nmBySid.delete(sid); } }
    // Search mode overrides the tab filter: show only ranked hits, in rank order,
    // spanning all states. Otherwise the normal state-tab filter applies.
    const listed = searchActive
      ? searchOrder.map(id=>bySid.get(id)).filter(Boolean).filter(tokOk)
      : (filter==="all" ? list.filter(inAll) : list.filter(x=>tabState(x)===filter));
    // Pinned strip (patch 86): pinned cards lead the list whatever the tab; search ranks alone.
    const pins=searchActive?[]:list.filter(x=>pinnedSids.has(x.sid));
    const shown=pins.concat(listed.filter(x=>!pins.includes(x)));
    const entered=new Set();   // patch 87: cards that entered Needs you since the last render
    for(const x of everySession){ const t=pl.get(x.sid).tab, was=lastTab.get(x.sid);
      if(t==="needs"&&was!=="needs"&&(was!==undefined||primed)) entered.add(x.sid); lastTab.set(x.sid,t); }
    if(everySession.length) primed=true;
    if(entered.size||newSids.size) requestAnimationFrame(markNew);
    const oldEmpty=root.querySelector(".empty"); if(oldEmpty) oldEmpty.remove();
    // The error is the Claude CLI's (patch 86), so the Codex half keeps its cards under it.
    const err=agent==="claude"?lastErr:null;
    if(err||!list.length||!shown.length){
      for(const [,c] of cards) c.row.remove();
      const d=document.createElement("div"); d.className="empty";
      d.textContent=err?err:(!list.length
        ?(agent==="codex"?"No Codex sessions in the last 24 hours. Start one in a terminal and it will appear here.":"No active Claude Code sessions. Start one in a terminal and it will appear here.")
        :(searchActive?(searchPending?"Searching…":("No sessions match “"+qEl.value.trim()+"”."))
        :(filter==="all"?(countFor("cutoff")>0?"Interrupted sessions are in the Cutoff tab."
                         :"All sessions are parked — see the Done tab.")
                        :(filter==="cutoff"?"No cut-off sessions.":"No "+filter+" sessions right now."))));
      // Patch 86: the command that failed, and a next step — Retry, New session, or the
      // other half when it has cards.
      if(err&&lastErrCmd){ const p=document.createElement("code"); p.className="ecmd"; p.textContent=lastErrCmd; d.appendChild(p); }
      const other=agent==="codex"?"claude":"codex", on=everySession.filter(x=>(x.agent||"claude")===other).length;
      const acts=(err?[["Retry",(b)=>{ b.textContent="Retrying…"; api.postMessage({type:"retry"}); }]]
                     :!list.length?[["New session",()=>api.postMessage({type:"new"})]]:[])
        .concat((err||!list.length)&&on?[["Switch to "+(other==="codex"?"Codex":"Claude")+" ("+on+")",()=>{ setAgent(other); render(lastSessions); },blockingIn(other)]]:[]);
      if(acts.length){ const a=document.createElement("div"); a.className="eact";
        acts.forEach(([t,fn,k])=>{ const b=document.createElement("button"); b.textContent=t; b.onclick=()=>fn(b);
          if(k){ b.dataset.bd=k; b.title=k+" blocking"; }   // patch 87: the other half's blocking count, as on its toggle
          a.appendChild(b); });
        d.appendChild(a); }
      root.appendChild(d);
      return;
    }
    const seen=new Set(); let prev=null;
    for(const s of shown){
      seen.add(s.sid);
      let c=cards.get(s.sid);
      if(!c){ c=buildCard(s); cards.set(s.sid,c); }
      if(c.state!==s.state||c.tier!==s.tier){ c.state=s.state; c.tier=s.tier;
        c.row.className="row "+s.state+(s.tier==="open"?" tier-open":""); }
      // Patch 87: the entry flash (CSS drops it under reduced motion), and the review dot.
      if(entered.has(s.sid)){ c.row.classList.add("enter"); setTimeout(()=>c.row.classList.remove("enter"),2000); newSids.add(s.sid); }
      c.row.classList.toggle("review", !!pl.get(s.sid).review);
      // The glyph also follows dormancy (patch 85), which flips without a state change.
      const ik=s.state+"|"+s.tier+"|"+!!s.dormant;
      if(c.ik!==ik){ c.ik=ik; c.av.innerHTML=stateIcon(s.state,s.tier,s.dormant); }
      // Dormant (restored) cards get a dim + no-pulse class; toggled every render
      // since a card can de-dormant (on resume) without a state change.
      c.row.classList.toggle("dormant", !!s.dormant);
      // Same reason: background jobs start and stop without the state ever changing.
      c.row.classList.toggle("running", !!s.running);
      // Compact unless it sits in Needs you or Working (patch 85); the selected card
      // unfolds through CSS. Search hits stay full: their why-line is the answer.
      const ts=tabState(s);
      c.row.classList.toggle("cmpt", !searchActive && ts!=="needs" && ts!=="working");
      // Patch 86: the screen-reader name ("Needs you: <title>"), the pin mark and the
      // strip's lower edge, and the PR / CI chip.
      const lab=(pl.get(s.sid).review?"Ready for review":(TABN[ts]||ts))+": "+s.name;
      if(c.row.getAttribute("aria-label")!==lab) c.row.setAttribute("aria-label",lab);
      const pinned=pins.includes(s);
      c.pn.style.display=pinned?"":"none";
      c.row.classList.toggle("pinend", pinned&&s===pins[pins.length-1]);
      const prKey=s.pr?s.pr.kind+"|"+s.pr.n+"|"+s.pr.title:"";
      if(c.prKey!==prKey){ c.prKey=prKey; c.pr.style.display=prKey?"":"none";
        if(s.pr){ c.pr.className="prc pr-"+s.pr.kind; c.pr.textContent="PR "+s.pr.kind;
          c.pr.title="PR #"+s.pr.n+(s.pr.title?" · "+s.pr.title:""); } }
      {
        const cap=s.ctxCapTokens||0, tok=s.ctxTokens||0;
        const t=(s.stateAt?inState(s,pl.get(s.sid)):(s.cardLine||s.state).split(" · ")[0])+((!s.dormant&&tok>0&&cap>0)?" · "+Math.round(tok/cap*100)+"%":"");
        if(c.cmp.textContent!==t) c.cmp.textContent=t;
        const why="Why here: "+pl.get(s.sid).why;   // patch 87: the rule that placed it
        if(c.cmp.title!==why) c.cmp.title=why;
      }
      // Title: plain text normally; in search mode, highlight the query terms.
      // hlKey (name + query) gates re-writing innerHTML so we don't thrash it each
      // poll, and forces a plain-text revert on the first render after exiting.
      const wantKey=searchActive?(s.name+" "+searchQ):"";
      if(c.hlKey!==wantKey){
        c.hlKey=wantKey; c.name=s.name;
        if(searchActive) c.nm.innerHTML=hl(s.name); else c.nm.textContent=s.name;
      } else if(!searchActive && c.name!==s.name){
        c.name=s.name; c.nm.textContent=s.name;
      }
      // Topic glyph: keyword table first (instant, free); else the cached Haiku
      // pick the host filled into s.emoji; else 💬 as a placeholder while it
      // resolves. A title that misses the table AND has no cached pick is queued
      // for a one-off Haiku lookup (batched + posted after the loop).
      const kw=topicEmojiKw(s.name);
      const emo=kw||s.emoji||"💬";
      if(c.emo!==emo){ c.emo=emo; c.tg.textContent=emo; }
      if(!kw && !s.emoji && !emojiAsked.has(s.name)){ emojiAsked.add(s.name); emojiWanted.push(s.name); }
      // "Why it matched" line — only in search mode, only when we have a reason.
      const whyTxt=searchActive?(searchReason[s.sid]||""):"";
      if(c.why.textContent!==whyTxt) c.why.textContent=whyTxt;
      c.why.style.display=whyTxt?"":"none";
      // Status line: state · model · folder. Full folder, branch and uptime on hover.
      const stTxt=stLine(s,pl.get(s.sid))||s.metaLine||s.sub||""; if(c.st.textContent!==stTxt) c.st.textContent=stTxt;
      const stTip="Why here: "+pl.get(s.sid).why+(s.cardTitle?"\\n"+s.cardTitle:"");
      if(c.st.title!==stTip) c.st.title=stTip;
      // RUNNING badge: patch only when the reading changes, so the bars keep their
      // animation phase across poll ticks instead of restarting every 2.5s.
      // Compact card: helpers and runs are counted in it, and their own headers hide.
      {
        const nh=s.helpers?s.helpers.live.length:0;
        const nr=(s.bgRuns||[]).filter((r)=>!r.done).length;
        const age=(s.runText||"").split(" · ").slice(1).join(" · ");
        const parts=[nh?nh+(nh>1?" helpers":" helper"):"", nr?nr+(nr>1?" runs":" run"):""].filter(Boolean);
        const key=s.running?(parts.length?parts.join(" · ")+(age?" · "+age:""):(s.runText||"")):"";
        if(c.runKey!==key){
          c.runKey=key; c.rt.textContent=key; c.run.classList.toggle("on", !!key);
          c.row.classList.toggle("runon", !!key);
          c.run.querySelector(".rx").style.display=parts.length?"":"none";   // nothing to fold
        }
      }
      // Context fill rail. Dormant cards have a dead process, so their token count
      // is a fossil — no rail, same rule the meta line already follows. A session
      // with no reading shows nothing rather than an authoritative-looking 0%.
      {
        const cap=s.ctxCapTokens||0, tok=s.ctxTokens||0;
        const show=!s.dormant && tok>0 && cap>0;
        const key=show?(tok+"/"+cap+"/"+(s.offerHandoff?1:0)+"/"+(s.spendText||"")+"/"+(s.spendTitle||"")):"";
        if(c.cbKey!==key){
          c.cbKey=key;
          c.cbar.style.display=show?"":"none";
          if(show){
            const frac=tok/cap;
            c.cbu.style.width=Math.min(100,Math.round(frac*100))+"%";
            c.cbu.style.background=frac<0.60?"var(--ov-use-ok)":frac<0.85?"var(--ov-use-low)":"var(--ov-warn)";
            c.cbv.textContent=Math.round(frac*100)+"% · "+(tok<1000?tok:Math.round(tok/1000)+"k");
            c.cbs.textContent=s.spendText?"│ "+s.spendText:""; c.cbs.title=s.spendTitle||"";
            // Past the ceiling the row becomes a warning (colour). The Hand off
            // button follows s.offerHandoff — 60%+, turn boundary, not yet handed
            // off (agents.offerHandoff) — and disappears once the gate has run.
            c.cbar.classList.toggle("over",frac>=1);
            if(!s.offerHandoff && c.cbc.classList.contains("sent")){
              c.cbc.classList.remove("sent"); c.cbc.textContent="Hand off";
            }
            c.cbc.style.display=s.offerHandoff?"":"none";
          }
        }
      }
      // Needs-you cards lead with the generated ask (what you must decide);
      // everything else shows the TL;DR summary.
      // Only write when we actually have text: a transient empty summary (e.g. a
      // model built without transcript meta) must never blank a card that already
      // shows content, or all cards flash together on that tick.
      const sumTxt=(s.state==="needs"&&s.ask)?s.ask:(s.summary||s.lastMsg||"");
      if(sumTxt && c.sum.textContent!==sumTxt) c.sum.textContent=sumTxt;
      // Dynamic buttons: rebuild only when the generated set changes; the
      // clicked "✓" state therefore survives poll ticks.
      const btns=(s.state==="needs"&&s.buttons&&s.buttons.length)?s.buttons:null;
      // A Codex app thread has no terminal to type into (patch 86): say where to answer.
      const hint=(!btns&&s.state==="needs"&&s.desktopApp)?"↗ Reply in the Codex app":"";
      const btnKey=btns?JSON.stringify(btns):hint;
      if(btnKey!==c.btnKey){
        c.btnKey=btnKey; c.qr.innerHTML="";
        if(btns){
          btns.forEach((bd,i)=>{
            const b=document.createElement("button"); b.textContent=bd.label; if(i===0) b.className="go";
            b.onclick=(ev)=>{ ev.stopPropagation();
              api.postMessage({type:"reply",sid:s.sid,text:bd.send,label:bd.label});
              b.classList.add("sent"); b.textContent=bd.label+" ✓"; };
            c.qr.appendChild(b);
          });
          c.qr.style.display="flex";
        } else if(hint){ c.qr.innerHTML='<span class="qrh">'+hint+"</span>"; c.qr.style.display="flex"; }
        else c.qr.style.display="none";
      }
      // Assist buttons: only where there is finished work to explain. A card that is
      // mid-turn has nothing to simplify yet (and its "next step" is: keep going), so
      // the row stays hidden until the session stops. Codex cards never get them:
      // both read the Claude transcript for the sid, which a Codex session has none
      // of, so the click could only ever answer "no transcript to read yet".
      const canAssist=s.agent!=="codex" && s.state!=="working" && !!(s.summary||s.lastMsg);
      c.as.style.display=canAssist?"flex":"none";
      // A new turn invalidates last turn's answer: drop the cache and collapse, so a
      // stale explanation can never sit under a card describing newer work.
      if(c.msgKey!==s.msgKey){ c.msgKey=s.msgKey; c.answers=null;
        if(c.openKind){ c.openKind=""; paintAssist(c,null); } }
      if(!canAssist && c.openKind){ c.openKind=""; paintAssist(c,null); }
      // Active auto-loop badge: show/patch only when the text actually changes.
      const loopTxt=s.loop||"";
      if(loopTxt!==c.loopText){ c.loopText=loopTxt; c.lt.textContent=loopTxt; c.loop.classList.toggle("on", !!loopTxt); }
      // Background runs this session launched — one line each, click to watch.
      const rl=s.bgRuns||[];
      const rnKey=JSON.stringify(rl);
      if(rnKey!==c.rnKey){
        c.rnKey=rnKey;
        c.rn.classList.toggle("on", rl.length>0);
        const rdone=rl.filter((r)=>r.done).length;
        const rlive=rl.length-rdone;
        const rrow=(r)=>'<div class="rni '+esc(r.state)+(r.done?" done":"")+'" data-s="'+esc(r.sid)+
                       '" title="Watch its transcript">'+
                       (r.done?'<span class="rnd dot"></span>'
                             :'<span class="rnd"><i></i><i></i><i></i></span>')+
                       '<span class="rnt">'+esc(r.name)+"</span>"+
                       '<span class="rnm">'+esc(r.meta||"")+"</span></div>";
        // Patch 95: finished runs fold under one closed-by-default line, like EARLIER —
        // a long walk session listed 40+ "finished" rows above anything live.
        c.rn.innerHTML=rl.length
          ?'<div class="rnh"><b>RUNS</b><span class="rnc">'+rdone+"/"+rl.length+"</span>"+
           (rlive?'<span class="rng">'+rlive+" running</span>":"")+
           '<span class="rnx">▾</span></div><div class="rnl">'+
           rl.filter((r)=>!r.done).map(rrow).join("")+
           (rdone?'<div class="tkrh rnfh"><b>FINISHED</b><span class="tkrc">'+rdone+"</span>"+
                  '<span class="tkrx rnfx">▸</span></div><div class="rnfl">'+
                  rl.filter((r)=>r.done).map(rrow).join("")+"</div>":"")+"</div>"
          :"";
        applyRunFold(c);
      }
      // Helpers this session is running — who, how long, doing what.
      // Patch 86: was named hl, which shadowed hl() for the whole loop body, so any search
      // threw "Cannot access 'hl' before initialization" and the board stopped painting.
      const hlp=s.helpers||null;
      const hpKey=hlp?JSON.stringify(hlp):"";
      if(hpKey!==c.hpKey){
        c.hpKey=hpKey;
        c.hp.classList.toggle("on", !!hlp);
        c.hp.innerHTML=hlp
          ?'<div class="rnh"><b>HELPERS</b><span class="rnc">'+hlp.live.length+"</span>"+
           (hlp.live.length?'<span class="rng">running</span>':"")+
           '<span class="rnx">▾</span></div><div class="rnl">'+
           hlp.live.map((h)=>'<div class="rni" data-h="'+esc(h.id)+'" data-n="'+esc(h.brief)+'" title="Watch its log">'+
                       '<span class="rnd"><i></i><i></i><i></i></span>'+
                       '<span class="rnt">'+esc((h.type?h.type+" · ":"")+h.brief)+"</span>"+
                       (h.model?'<span class="rnk '+(h.model==="haiku"||h.model==="sonnet"?"k-cheap":h.model==="fable"||h.model==="mythos"?"k-top":"")+'">'+esc(h.model)+"</span>":"")+
                       '<span class="rnm">'+esc(h.age)+(h.tok?" · "+esc(h.tok):"")+"</span></div>"+
                       (h.action?'<div class="hpa">'+esc(h.action)+"</div>":"")).join("")+
           (hlp.done?'<div class="hpd">✓ '+hlp.done+" finished"+(hlp.doneTok?" · "+esc(hlp.doneTok)+" tokens":"")+(hlp.lastDoneAgo?" · last "+esc(hlp.lastDoneAgo)+" ago":"")+"</div>":"")+
           "</div>"
          :"";
        applyHelperFold(c);
      }
      // Plan-board task panel (patch 38a): repaint only when the task set changed
      // — and never while an inline input is open (tkEdit, patch 38b). The card's
      // working-ness is part of the key (patch 38c): the step spinner must appear/
      // stop on state changes even when the task files themselves didn't move.
      // No steps declared: no panel, one ⚠ on the status line (patch 85).
      const np=!!(s.tasks&&s.tasks.noPlan);
      c.stw.style.display=np?"":"none";
      c.stw.title=np?("No steps declared — scope is unwritten. "+(s.tasks.goal?"Goal: "+s.tasks.goal:"No session goal set.")):"";
      const tp=np?null:(s.tasks||null);
      const tkWorking=s.state==="working";
      const tkKey=tp?((tkWorking?"W|":"")+JSON.stringify(tp)):"";
      if(!c.tkEdit && tkKey!==c.tkKey){
        c.tkKey=tkKey;
        if(!tp){ c.tk.classList.remove("on"); c.tkl.innerHTML=""; c.goalText=""; }
        else{
          c.tk.classList.add("on");
          // Archived list (patch 38d): the harness pruned the files after full
          // completion — render the snapshot read-only (no toggle/skip/add).
          const dead=!!tp.archived;
          c.tkc.textContent=(tp.total?(tp.done+"/"+tp.total+(tp.done===tp.total?" ✓":"")):(tp.noPlan?"— none":""))+
                            (dead&&tp.stamp?" · finished "+tp.stamp.slice(11,16):"");
          // Header flags (patch 38e). Everything that should make the user distrust a
          // clean-looking counter is said here, in amber, without expanding.
          const flags=[];
          if(tp.optOut) flags.push(["⛔ plan off",ICON_TIP.planOff]);
          else if(tp.noPlan) flags.push(["⚠ no steps declared",ICON_TIP.noPlan]);
          else if(tp.newWork) flags.push(["⚠ new work since, no steps declared",ICON_TIP.newWork]);
          if(tp.stalledMin) flags.push(["⚠ stalled "+tp.stalledMin+"m",ICON_TIP.stalled]);
          if(tp.unevidenced) flags.push(["⚠ "+tp.unevidenced+" unevidenced",ICON_TIP.unevidenced]);
          c.tkg.innerHTML=flags.map(f=>'<span data-tip="'+esc(f[1])+'">'+esc(f[0])+"</span>").join(" · ");
          // Goal line — always on screen while the panel is, never auto-written.
          c.goalText=tp.goal||"";
          c.tkgoal.className="tkgoal"+(c.goalText?"":" unset");
          c.tkgoal.innerHTML='<span class="tkgi" data-tip="'+esc(ICON_TIP.goal)+'">◎</span><span class="tkgt">'+
            esc(c.goalText||"set the session goal…")+"</span>";
          const paintItems=(items,liveAllowed)=>items.map(t=>{
            // Working + in_progress step (patch 38c): braille spinner instead of the
            // static ◐, plus a sub-step line (model-maintained metadata.sub, falling
            // back to the harness's own activeForm label).
            const live=liveAllowed&&tkWorking&&t.status==="in_progress";
            const g=t.status==="completed"?(t.skipped?"⊘":"✓"):(t.status==="in_progress"?"◐":"○");
            // A step claiming to be in progress whose file has not been touched in
            // half an hour is flagged, not trusted (patch 38e).
            const stall=t.status==="in_progress"&&t.ageMin>=30;
            const tipKey=t.status==="completed"?(t.skipped?"skip":"done"):t.status!=="in_progress"?"pend":stall?"stall":live?"live":"prog";
            const tip=' data-tip="'+esc(ICON_TIP[tipKey]+(liveAllowed?" Click to change its status.":""))+'"';
            const glyph=live?'<span class="tks tkspin"'+tip+'></span>'
                            :'<span class="tks"'+tip+'>'+g+"</span>";
            const cls="tki "+(t.status==="completed"?(t.skipped?"skip":"done"):(t.status==="in_progress"?"prog":"pend"))+(live?" live":"")+(stall?" stall":"");
            const subTxt=live?(t.sub||t.active||""):"";
            const elp=(t.el?'<span class="tkel" title="Time on this step">'+esc(t.el)+"</span>":"")+
                      (t.tok?'<span class="tkel" title="Tokens on this step (helpers launched during it shown separately)">'+esc(t.tok)+"</span>":"");
            let out='<div class="'+cls+'"'+(liveAllowed?' data-d="'+esc(t.dir||"")+'" data-i="'+esc(t.id)+'"':"")+(t.reason?' title="'+esc(t.reason)+'"':"")+
                   ">"+glyph+
                   '<span class="tkt">'+esc(t.subject)+"</span>"+(t.reason?'<i class="tkr">— '+esc(t.reason)+"</i>":"")+elp+
                   (liveAllowed&&t.status!=="completed"?'<span class="tkskip" data-tip="'+esc(ICON_TIP.skipBtn)+'">⊘</span>':"")+"</div>";
            // Sub-step: greyed and age-stamped once it stops being refreshed, so a
            // frozen description cannot keep reading as live activity.
            if(subTxt) out+='<div class="tkw'+(t.ageMin?" stale":"")+'">'+esc(subTxt)+
                            (t.ageMin?" · "+t.ageMin+"m ago":"")+"</div>";
            // Evidence under every finished step — present, or conspicuously absent.
            if(t.status==="completed"&&!t.skipped){
              if(t.evidence) out+='<div class="tkev"><span data-tip="'+esc(ICON_TIP.evidence)+'">✓</span> '+esc(t.evidence)+"</div>";
              else if(liveAllowed) out+='<div class="tkev miss" data-d="'+esc(t.dir||"")+
                                        '" data-i="'+esc(t.id)+'">no evidence — click to add</div>';
            }
            return out;
          }).join("");
          // Finished earlier lists (patch 38d) sit under the current one, behind a
          // COLLAPSED header (2026-08-21, the user: "the card gets very long … same
          // concept … collapsed by default"). Rendered only when there are any —
          // an empty section is worse than an absent one. The rows drop the words
          // "earlier run" now that the header says it, and each keeps its full step
          // list in the tooltip.
          const er=(tp.runs&&tp.runs.length)?tp.runs:null;
          const runsHtml=er
            ?'<div class="tkrh"><b>EARLIER</b><span class="tkrc">'+er.length+"</span>"+
             '<span class="tkrx" data-tip="'+esc(ICON_TIP.caret)+'">▸</span></div><div class="tkrl">'+
             er.map(r=>'<div class="tkrun" title="'+esc(r.items.map(t=>(t.status==="completed"?(t.skipped?"⊘ ":"✓ "):"○ ")+t.subject).join("\\n"))+'">'+
             '✓ '+r.done+"/"+r.total+(r.stamp?" · "+r.stamp.slice(11,16):"")+"</div>").join("")+"</div>"
            :"";
          // No list at all: say so in the panel rather than hiding it. "＋ add task"
          // is deliberately withheld here — the harness owns dir naming, and adding
          // into a guessed dir creates a list nothing will ever read.
          c.tkl.innerHTML=(tp.noPlan
                            ?'<div class="tknone">no steps declared — scope is unwritten</div>'
                            :paintItems(tp.items||[],!dead)+
                             (!dead&&tp.total?'<div class="tka" data-tip="'+esc(ICON_TIP.add)+'">＋ add task</div>':""))+
                          runsHtml;
          applyEarlierFold(c);
        }
      }
      const want=prev?prev.nextSibling:root.firstChild;
      if(want!==c.row) root.insertBefore(c.row,prev?prev.nextSibling:root.firstChild);
      prev=c.row;
    }
    // Ask the host (Haiku) for emojis for any titles the keyword table missed.
    // One request per title ever (emojiAsked); the host caches + re-posts sessions
    // with s.emoji filled, and the next render swaps 💬 for the real glyph.
    if(emojiWanted.length) api.postMessage({type:"emojiReq", names:emojiWanted});
    // Re-assert the selected highlight: a state change above rewrites the card's
    // className, which would otherwise drop the "selected" class each poll.
    // Roving tabindex (patch 86): Tab lands on the selected card, else the first shown.
    const fsid=seen.has(selectedSid)?selectedSid:shown[0].sid;
    for(const [sid,c] of cards){ c.row.classList.toggle("selected", sid===selectedSid); c.row.tabIndex=sid===fsid?0:-1; }
    // Rows filtered out of view: detach but keep the card for when the filter returns.
    for(const [sid,c] of cards){ if(!seen.has(sid)&&c.row.parentNode) c.row.remove(); }
  }
  // Usage card: mirrors Claude's /usage — a row per limit window with a "% left"
  // bar + reset time. Rebuilt only when the payload changes (every few minutes),
  // so it never contributes to the per-tick churn.
  function fmtReset(iso,group){
    if(!iso) return "";
    const d=new Date(iso); if(isNaN(d.getTime())) return "";
    const h=d.getHours(), m=d.getMinutes();
    const ap=h<12?"am":"pm"; let hr=h%12; if(hr===0) hr=12;
    const time=hr+(m?":"+String(m).padStart(2,"0"):"")+ap;
    const sameDay=d.toDateString()===new Date().toDateString();
    if(group==="session"||sameDay) return "Resets "+time;      // 5-hour / today -> time only
    const mon=d.toLocaleString(undefined,{month:"short"});
    return "Resets "+mon+" "+d.getDate()+" at "+time;
  }
  // Adaptive countdown to reset, minutes granularity (no seconds): "(6d 6h)" /
  // "(3h 12m)" / "(47m)". Empty if invalid or already past.
  function fmtCountdown(iso){
    if(!iso) return "";
    const ms=new Date(iso).getTime()-Date.now();
    if(isNaN(ms)||ms<=0) return "";
    const tm=Math.floor(ms/60000), days=Math.floor(tm/1440),
          hrs=Math.floor((tm%1440)/60), mins=tm%60;
    const s = days>0 ? days+"d "+hrs+"h" : hrs>0 ? hrs+"h "+mins+"m" : mins>0 ? mins+"m" : "<1m";
    return "("+s+")";
  }
  // Repaint just the countdown spans (data-reset holds the ISO) — runs on the 20s
  // tick so the numbers stay current without rebuilding the rows.
  function paintCountdowns(){
    const spans=document.querySelectorAll("#usage .urcd");
    for(const sp of spans) sp.textContent=fmtCountdown(sp.getAttribute("data-reset"));
  }
  // Top-right freshness cue. Ticks on its own 20s interval (independent of the
  // 3-min data fetch) so "updated Xm ago" stays honest between syncs, and escalates
  // colour when a held-over reading goes cold.
  let usageAtMs=0;
  function paintAge(){
    const el=document.getElementById("uage"); if(!el) return;
    if(!usageAtMs){ el.textContent=""; return; }
    const age=Date.now()-usageAtMs, s=Math.round(age/1000);
    const txt = s<60 ? s+"s" : s<3600 ? Math.round(s/60)+"m" : Math.floor(s/3600)+"h";
    el.textContent="updated "+txt+" ago ⟳";
    el.classList.toggle("stale", age>=480000 && age<1200000);   // 8–20 min: amber
    el.classList.toggle("stale2", age>=1200000);                // 20 min+: red
  }
  setInterval(function(){ paintAge(); paintCountdowns(); }, 20000);
  (function(){ const el=document.getElementById("uage");
    if(el) el.onclick=()=>{ el.textContent="checking…"; api.postMessage({type:"refreshUsage"}); }; })();
  // #5 Collapse: fold the card to its one-line summary. Patch 85: folded by default,
  // open while a limit is critical. A manual toggle is saved with the critical state
  // it was made under and holds until that state flips, so a fold made on a calm card
  // never hides a limit that later goes critical. New key: the old uCollapsed pref
  // predates the default and is ignored.
  let uCrit=false;
  const uTier=(left)=>left>=50?"u-ok":(left>=20?"u-low":"u-crit");
  function applyCollapsed(){
    const p=(api.getState()||{}).uFold;
    const uCollapsed=(p&&p.crit===uCrit)?!!p.folded:!uCrit;
    const el=document.getElementById("usage"); if(el) el.classList.toggle("collapsed", uCollapsed);
    const c=document.getElementById("ucaret"); if(c) c.textContent=uCollapsed?"▸":"▾";
  }
  (function(){ const c=document.getElementById("ucaret");
    if(c) c.onclick=()=>{ const el=document.getElementById("usage");
      saveState({uFold:{folded:!el.classList.contains("collapsed"),crit:uCrit}}); applyCollapsed(); }; })();
  applyCollapsed();
  function fmtTok(n){ n=n||0; if(n>=1e6) return (n/1e6).toFixed(n>=1e7?0:1)+"M";
                      if(n>=1e3) return Math.round(n/1e3)+"k"; return ""+n; }
  let lastUsageKey="";
  // Live memory bar: its own row after the usage rows, plus a pill when folded.
  let lastMem=null;
  function paintMem(){
    const row=document.getElementById("umem"); if(!row||!lastMem||!lastMem.total) return;
    const gb=(b)=>(b/1073741824).toFixed(1);
    const used=lastMem.total-lastMem.free, usedPct=Math.round(used*100/lastMem.total);
    const freePct=100-usedPct, g=freePct<10?"u-crit":(freePct<25?"u-low":"u-ok");
    row.className="urow umem on "+g+(memOpen?" open":"");
    const top=(memTopData&&memTopData.top)||[];
    row.querySelector(".umemhint").textContent=(g!=="u-ok"&&!memOpen)?top.slice(0,2).map(t=>t.name+" "+gb(t.mb*1048576)+" GB").join(" · "):"";
    row.querySelector(".urreset").textContent=gb(used)+" of "+gb(lastMem.total)+" GB · "+gb(lastMem.free)+" GB free";
    row.querySelector(".urpct b").textContent=usedPct+"% ";
    row.querySelector(".urfill").style.width=usedPct+"%";
    const usum=document.getElementById("usum"); if(!usum) return;
    let p=usum.querySelector(".umempill");
    if(!p){ p=document.createElement("span"); usum.appendChild(p); }
    p.className="ubadge umempill "+g; p.textContent="RAM "+usedPct+"%";
  }
  // Click the Memory row: the five biggest apps; the emulator gets Shut down when free.
  let memTopData=null, memOpen=false;
  function paintMemTop(){
    const list=document.querySelector("#umem .umemtop"); if(!list) return;
    list.innerHTML="";
    const top=(memTopData&&memTopData.top)||[];
    if(!top.length){ list.textContent="Reading…"; return; }
    for(const t of top){
      const d=document.createElement("div"); d.className="mt";
      d.innerHTML='<span class="mtn"></span><span class="mtmb"></span>';
      d.querySelector(".mtn").textContent=t.name;
      d.querySelector(".mtmb").textContent=(t.mb/1024).toFixed(1)+" GB";
      // One button per row Overlord can act on; disabled, with the reason, while it is in use.
      let act=null;
      if(t.name==="Android emulator") act={label:"Shut down",busy:"Shutting down…",st:memTopData.emu,msg:{type:"emuKill"}};
      if(t.name==="Comet Browser") act={label:"Restart",busy:"Restarting…",st:memTopData.browser,msg:{type:"browserRestart"}};
      if(t.name==="Claude sessions") act={label:idleSids.length?"Close "+idleSids.length+" idle":"Close idle",busy:"Closing…",
        st:idleSids.length?{free:true}:{why:"No idle sessions"},msg:{type:"parkMany",sids:idleSids.slice()}};
      if(act){
        const st=act.st||{why:"Checking…"};
        const b=document.createElement("button"); b.className="mtkill"; b.textContent=act.label;
        b.disabled=!st.free;
        if(!st.free){ b.title=st.why||""; const w=document.createElement("span"); w.className="mtwhy"; w.textContent=st.why||""; d.insertBefore(w,d.querySelector(".mtmb")); }
        b.onclick=(e)=>{ e.stopPropagation(); b.disabled=true; b.textContent=act.busy; api.postMessage(act.msg); };
        d.insertBefore(b,d.querySelector(".mtmb"));
      }
      list.appendChild(d);
    }
  }
  (function(){ const r=document.getElementById("umem");
    if(r) r.onclick=()=>{ memOpen=!memOpen; if(memOpen){ paintMemTop(); api.postMessage({type:"memTop"}); } paintMem(); }; })();
  // Patch 84: each half's own meter -- Claude's /usage card, Codex's rate limits.
  const usageBy={claude:null,codex:null};
  function showUsage(){
    const u=usageBy[agent];
    if(u) return renderUsage(u);
    const el=document.getElementById("usage"); if(el) el.classList.remove("on"); lastUsageKey="";
  }
  function renderUsage(u){
    const el=document.getElementById("usage"); if(!el||!u||!u.rows) return;
    usageAtMs=u.at||0;
    const key=JSON.stringify(u); if(key===lastUsageKey){ paintAge(); return; } lastUsageKey=key;
    el.classList.add("on");
    uCrit=u.rows.some(r=>uTier(Math.round(r.leftPct))==="u-crit"); applyCollapsed();
    el.classList.toggle("codex", u.name==="Codex");
    el.querySelector(".ulogo").textContent=u.logo||"✳";
    el.querySelector(".uhead b").textContent=u.name||"Claude";
    el.classList.toggle("warnlow", u.alert==="warn");
    el.classList.toggle("critlow", u.alert==="crit");
    el.querySelector(".uplan").textContent=u.plan||"";
    const rows=el.querySelector(".urows"); rows.innerHTML="";
    for(const r of u.rows){
      const left=Math.round(r.leftPct);
      const g=uTier(left);
      const row=document.createElement("div"); row.className="urow "+g;
      row.innerHTML='<div class="urline"><span class="urlabel"></span>'
        +'<span class="urreset"></span><span class="urcd"></span><span class="urpct"><b></b>left</span></div>'
        +'<div class="urbar"><div class="urfill"></div></div>';
      row.querySelector(".urlabel").textContent=r.label;
      row.querySelector(".urreset").textContent=fmtReset(r.resetsAt,r.group);
      const cd=row.querySelector(".urcd");
      if(r.resetsAt){ cd.setAttribute("data-reset",r.resetsAt); cd.textContent=fmtCountdown(r.resetsAt); }
      row.querySelector(".urpct b").textContent=left+"% ";
      row.querySelector(".urfill").style.width=left+"%";
      rows.appendChild(row);
      // "Today" bar sits directly under the Weekly row (patch 97: the 5-hour row it
      // used to hang off no longer exists on this plan). Fill = today's share of the
      // weekly limit against today's budget; full (red) = over budget.
      if(r.kind==="weekly_all" && u.today && typeof u.today.pacePct==="number"){
        const pp=Math.max(0,Math.round(u.today.pacePct));
        const over=pp>100;
        const t=document.createElement("div"); t.className="utoday"+(over?" utover":"");
        t.innerHTML='<div class="utline"><span class="utlabel">Today</span><span class="utval"></span></div>'
          +'<div class="utbar"><div class="utfill"></div></div>';
        t.querySelector(".utval").textContent=(u.today.exhausted?"at weekly cap":Math.round(u.today.todayPct)+"% of "+Math.round(u.today.budgetPct)+"% budget")+(u.today.tokens?(" · "+fmtTok(u.today.tokens)):"");
        t.querySelector(".utfill").style.width=Math.min(100,pp)+"%";
        const f=u.today.forecast;
        if(f){ const fc=document.createElement("div"); fc.className="utfc"+(f.state==="over"?" over":"");
          fc.textContent=f.state==="over"
            ?"At this pace you run out "+new Date(f.runsOutMs).toLocaleString(undefined,{weekday:"short",hour:"numeric",minute:"2-digit"})
            :"On pace for "+Math.round(f.projected)+"% at reset";
          t.appendChild(fc); }
        rows.appendChild(t);
      }
    }
    // Renewal bar (4th): next charge date, blue, fill = billing cycle remaining.
    if(u.renew && u.renew.at){
      const next=new Date(u.renew.at), msLeft=next.getTime()-Date.now();
      if(!isNaN(next.getTime()) && msLeft>0){
        const prev=u.renew.prevAt?new Date(u.renew.prevAt):null;
        const cycle=(prev&&!isNaN(prev.getTime()))?(next.getTime()-prev.getTime()):0;
        const remainFrac=cycle>0?Math.max(0,Math.min(1,msLeft/cycle)):0;
        const daysLeft=Math.ceil(msLeft/86400000);
        const mon=next.toLocaleString(undefined,{month:"short"});
        const dateTxt="Renews "+mon+" "+next.getDate()
          +(next.getFullYear()!==new Date().getFullYear()?", "+next.getFullYear():"");
        const rw=document.createElement("div"); rw.className="urow renew";
        rw.innerHTML='<div class="urline"><span class="urlabel">Plan</span>'
          +'<span class="urreset"></span><span class="urpct"><b></b>left</span></div>'
          +'<div class="urbar"><div class="urfill"></div></div>';
        rw.querySelector(".urreset").textContent=dateTxt;
        rw.querySelector(".urpct b").textContent=daysLeft+"d ";
        rw.querySelector(".urfill").style.width=Math.round(remainFrac*100)+"%";
        rows.appendChild(rw);
      }
    }
    // #5 folded summary: a colour-filled pill for EVERY stat — 5h · Today · wk ·
    // Fable · Plan, matching the expanded order and colours.
    const usum=document.getElementById("usum");
    if(usum){
      usum.innerHTML="";
      const pill=(cls,txt)=>{ const b=document.createElement("span"); b.className="ubadge "+cls;
        b.textContent=txt; usum.appendChild(b); };
      for(const r of u.rows){
        const left=Math.round(r.leftPct);
        const g=uTier(left);
        const lbl=r.group==="session"?"5h":(/\\((.*)\\)/.test(r.label)?r.label.replace(/^.*\\((.*)\\)$/,"$1"):"wk");
        pill(g, lbl+" "+left+"%");
        if(r.kind==="weekly_all" && u.today && typeof u.today.pacePct==="number"){
          const pp=Math.round(u.today.pacePct);
          pill(pp>100?"u-crit":"g-today",u.today.exhausted?"Today cap":"Today "+pp+"%");
        }
      }
      if(u.renew && u.renew.at){ const ms=new Date(u.renew.at).getTime()-Date.now();
        if(!isNaN(ms)&&ms>0) pill("g-renew","Plan "+Math.ceil(ms/86400000)+"d"); }
    }
    paintMem();
    paintAge();
  }
  window.addEventListener("message",e=>{ const m=e.data; if(!m) return;
    if(m.type==="mem"){ lastMem=m; paintMem(); return; }
    if(m.type==="memTop"){ memTopData=m; paintMem(); paintMemTop(); return; }
    if(m.type==="sessions"){
      // Host is authoritative on selection: the lit card is the session on the right,
      // and none is lit when the right side isn't a card (the user 2026-11-09). A change of
      // on-screen session also brings its tab into view (followSid, read in render).
      const a=m.activeSid||null;
      if(a!==hostSid){ hostSid=a; followSid=a; }
      selectedSid=a;
      if(m.usage) usageBy.claude=m.usage;
      if(m.codexUsage) usageBy.codex=m.codexUsage;
      lastErr=m.error||null; lastErrCmd=m.errorCmd||"";
      if(Array.isArray(m.pinned)) pinnedSids=new Set(m.pinned);
      showUsage();
      render(m.sessions);
    }
    // Haiku ranking arrived. Ignore if stale (a newer/cleared query) — otherwise
    // swap the instant keyword order for the concept ranking + reasons. ranked===
    // null means the helper was unavailable: keep the keyword order already shown.
    else if(m.type==="assist"){
      const c=cards.get(m.sid); if(!c) return;
      c.answers=c.answers||{}; c.answers[m.kind]=m;
      if(c.openKind===m.kind) paintAssist(c,m);
    }
    else if(m.type==="handoff"){ const c=cards.get(m.sid); if(c) c.cbc.textContent=m.text; }
    else if(m.type==="searchResults"){
      if(!searchActive||m.q!==searchQ) return;
      searchPending=false; srchEl.classList.remove("busy");
      if(m.ranked){
        searchOrder=m.ranked.map(r=>r.sid);
        searchReason={}; m.ranked.forEach(r=>{ searchReason[r.sid]=r.reason||""; });
      }
      render(lastSessions);
    }
  });
</script></body></html>`;
  }
}

// ---- usage card: real plan limits from Claude's own /usage endpoint ----------
// The board's footer mirrors Claude Code's /usage card. Claude doesn't cache the
// limits to disk, so we call the same OAuth endpoint the CLI uses, reusing the
// access token Claude Code keeps fresh in ~/.claude/.credentials.json. Read-only,
// your own account, throttled to a few minutes. The `limits[]` array is the
// curated per-window list (5-hour session, weekly-all, weekly-scoped per model),
// each carrying a used `percent` and `resets_at`.
const https = require("https");
const CREDS_PATH = path.join(os.homedir(), ".claude", ".credentials.json");

function readOauth() {
  try { return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")).claudeAiOauth || null; }
  catch (_) { return null; }
}

// Today's usage has no dedicated API window, so we sum it (and this week's) from
// the transcripts — input+cache-creation+output, cache-read excluded. Only used to
// derive today's SHARE of the week, which we then scale by the real weekly % from
// the API. Reads only files touched this week; regex, no JSON.parse (files hit 30MB).
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
function dayStart(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
function lineTok(line) {
  const i = line.match(/"input_tokens":(\d+)/);
  const c = line.match(/"cache_creation_input_tokens":(\d+)/);
  const o = line.match(/"output_tokens":(\d+)/);
  return (i ? +i[1] : 0) + (c ? +c[1] : 0) + (o ? +o[1] : 0);
}
// `cycleStartMs` = the real quota-week boundary (weekly row's resetsAt minus 7d),
// NOT local Monday — the two rarely coincide (the user's resets Wed 6pm), and summing
// from the wrong start pulls in tokens from the PREVIOUS cycle, wrecking any ratio
// built on top of this.
// Patch 89: this used to read every transcript touched this quota week in full on each
// fetch -- 1.84 GB (2026-10-09), split and regex-scanned on the extension host, where
// one 142 MB file blocked it for 1-2 s. Now each file keeps its sums on disk: unchanged
// -> no read; grown in place (the bytes before the old end still match) -> only the new
// bytes; anything else -> from 0. Reads go in 1 MB chunks, so the host gets its loop
// back between them. Sums are kept per local day, so midnight needs no re-read; lines
// within an hour of the week boundary are kept one by one, because resets_at drifts
// per fetch (15:59:59.709 vs 16:00:00.402, measured) and each line must land on the
// same side of it as when the whole file was read. Tied to the parser's source and the
// timezone, like codex.js's cache; a missing or corrupt file is just a full scan.
const USAGE_CACHE = path.join(os.homedir(), ".claude", "overlord-usage-cache.json");
const USAGE_NEAR_MS = 3600000;
let usageDisk = null;
function usageLine(line, acc, lo, hi) {
  if (line.indexOf('"usage"') === -1) return;
  const tm = line.match(/"timestamp":"([^"]+)"/);
  const t = tm ? Date.parse(tm[1]) : 0;
  if (!t || t < lo) return;
  const tok = lineTok(line);
  if (!tok) return;
  if (t < hi) acc.near.push([t, tok]);
  else { const k = dayStart(t); acc.days[k] = (acc.days[k] || 0) + tok; }
}
// One file's entry, brought up to date. `tail` gets the unterminated last line: the full
// read counted it too, but it may still be being written, so it is never committed.
async function usageScanFile(fp, st, e, tail, lo, hi) {
  if (e && e.size === st.size && e.mtimeMs === st.mtimeMs && e.off === st.size) return e;
  const fh = await fs.promises.open(fp, "r");
  try {
    if (e && !(e.size === st.size && e.mtimeMs === st.mtimeMs)) {
      const n = Math.min(64, e.off), b = Buffer.alloc(n);
      if (st.size < e.off || (await fh.read(b, 0, n, e.off - n)).bytesRead !== n || b.toString("base64") !== e.tail) e = null;
    }
    if (!e) e = { off: 0, tail: "", days: {}, near: [] };
    const buf = Buffer.allocUnsafe(1 << 20);
    let pos = e.off, done = e.off, pend = [];
    while (pos < st.size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, st.size - pos), pos);
      if (!bytesRead) break;
      const chunk = buf.subarray(0, bytesRead), nl = chunk.lastIndexOf(10);
      pos += bytesRead;
      if (nl === -1) { pend.push(Buffer.from(chunk)); continue; }
      pend.push(chunk.subarray(0, nl));
      for (const line of Buffer.concat(pend).toString("utf8").split("\n")) usageLine(line, e, lo, hi);
      pend = [Buffer.from(chunk.subarray(nl + 1))];
      done = pos - bytesRead + nl + 1;
    }
    usageLine(Buffer.concat(pend).toString("utf8"), tail, lo, hi);
    if (done !== e.off) {
      const n = Math.min(64, done), b = Buffer.alloc(n);
      await fh.read(b, 0, n, done - n);
      e.tail = b.toString("base64");
    }
    e.off = done; e.size = st.size; e.mtimeMs = st.mtimeMs;
    return e;
  } finally { await fh.close(); }
}
const USAGE_V = require("crypto").createHash("sha1").update(String(lineTok) + String(usageLine) +
  String(usageScanFile) + String(dayStart) + Intl.DateTimeFormat().resolvedOptions().timeZone).digest("hex");
async function sumTodayWeek(cycleStartMs) {
  const wk = cycleStartMs, dy = dayStart(Date.now());
  let today = 0, week = 0;
  if (!usageDisk) {
    try { usageDisk = JSON.parse(await fs.promises.readFile(USAGE_CACHE, "utf8")); } catch (_) {}
    if (!usageDisk || usageDisk.v !== USAGE_V) usageDisk = { v: USAGE_V, lo: 0, hi: 0, files: {} };
  }
  if (wk < usageDisk.lo || wk >= usageDisk.hi)
    usageDisk = { v: USAGE_V, lo: wk - USAGE_NEAR_MS, hi: wk + USAGE_NEAR_MS, files: {} };
  const { lo, hi } = usageDisk, files = {};
  let dirs; try { dirs = await fs.promises.readdir(PROJECTS_DIR); } catch (_) { return { today, week }; }
  for (const d of dirs) {
    const pd = path.join(PROJECTS_DIR, d);
    let names; try { names = await fs.promises.readdir(pd); } catch (_) { continue; }
    for (const f of names) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(pd, f);
      let st; try { st = await fs.promises.stat(fp); } catch (_) { continue; }
      if (st.mtimeMs < wk) continue;                 // whole file predates this week
      const tail = { days: {}, near: [] };
      let e; try { e = await usageScanFile(fp, st, usageDisk.files[fp], tail, lo, hi); } catch (_) { continue; }
      files[fp] = e;
      for (const a of [e, tail]) {
        for (const k in a.days) { week += a.days[k]; if (+k >= dy) today += a.days[k]; }
        for (const [t, n] of a.near) if (t >= wk) { week += n; if (t >= dy) today += n; }
      }
    }
  }
  usageDisk.files = files;
  const tmp = USAGE_CACHE + "." + process.pid;
  try { await fs.promises.writeFile(tmp, JSON.stringify(usageDisk)); await fs.promises.rename(tmp, USAGE_CACHE); } catch (_) {}
  return { today, week };
}

function fetchUsage() {
  return new Promise((resolve) => {
    const oa = readOauth();
    if (!oa || !oa.accessToken) return resolve(null);
    const req = https.request({
      host: "api.anthropic.com", path: "/api/oauth/usage", method: "GET", timeout: 8000,
      headers: {
        "Authorization": "Bearer " + oa.accessToken,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
        "User-Agent": "overlord",
      },
    }, (res) => {
      let b = ""; res.on("data", (d) => b += d);
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(null);   // 401 (stale token) etc -> keep last good
        try { resolve(JSON.parse(b)); } catch (_) { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Billing has no API window (no renews_at anywhere), so we read the plan's
// subscription_created_at from /profile and project the next charge forward on a
// monthly cadence. Settings can override the interval or pin an exact date.
function fetchProfile() {
  return new Promise((resolve) => {
    const oa = readOauth();
    if (!oa || !oa.accessToken) return resolve(null);
    const req = https.request({
      host: "api.anthropic.com", path: "/api/oauth/profile", method: "GET", timeout: 8000,
      headers: {
        "Authorization": "Bearer " + oa.accessToken,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json", "User-Agent": "overlord",
      },
    }, (res) => {
      let b = ""; res.on("data", (d) => b += d);
      res.on("end", () => { if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// Next charge date + the cycle it closes. `createdIso` = subscription_created_at;
// `months` = billing interval (1 monthly, 12 annual); `overrideIso` pins it.
function computeRenew(createdIso, months, overrideIso) {
  const iv = Math.max(1, months || 1);
  let next, prev;
  if (overrideIso) {
    next = new Date(overrideIso); if (isNaN(next.getTime())) return null;
    prev = new Date(next); prev.setMonth(prev.getMonth() - iv);
  } else {
    if (!createdIso) return null;
    const c = new Date(createdIso); if (isNaN(c.getTime())) return null;
    const now = Date.now();
    next = new Date(c);
    while (next.getTime() <= now) next.setMonth(next.getMonth() + iv);
    prev = new Date(next); prev.setMonth(prev.getMonth() - iv);
  }
  return { at: next.toISOString(), prevAt: prev.toISOString() };
}

// Full plan name for the card header. rateLimitTier carries the tier
// ("default_claude_max_20x" -> "Max 20x"); fall back to subscriptionType.
function planLabel(oa) {
  const tier = (oa && oa.rateLimitTier) || "";
  const m = tier.match(/max_(\d+)x/i);
  if (m) return "Max " + m[1] + "x";
  const sub = (oa && oa.subscriptionType) || "";
  if (/max/i.test(sub)) return "Max";
  return sub ? sub.charAt(0).toUpperCase() + sub.slice(1) : "";   // Pro / Free / Team…
}

// One limit record -> a display row. Label mirrors the /usage card.
function usageLabel(l) {
  if (l.kind === "weekly_scoped" && l.scope && l.scope.model && l.scope.model.display_name)
    return "Weekly (" + l.scope.model.display_name + ")";
  if (l.group === "session" || l.kind === "session") return "5-hour";
  if (l.group === "weekly" || l.kind === "weekly_all") return "Weekly";
  return l.kind || "Limit";
}

// Patch 97: the server's weekly % is the only exact number there is, and each fetch used to
// throw it away. Kept here so "today" can be a real difference between two readings.
const USAGE_HISTORY = path.join(os.homedir(), ".claude", "overlord-usage-history.jsonl");
const USAGE_PACE = path.join(os.homedir(), ".claude", "overlord-usage-pace.json");
function usageReadings(now, pct, reset) {
  let rows = [];
  try {
    for (const l of fs.readFileSync(USAGE_HISTORY, "utf8").split("\n")) {
      try { if (l) rows.push(JSON.parse(l)); } catch (_) { /* a torn line costs one reading */ }
    }
  } catch (_) { /* first run */ }
  const last = rows[rows.length - 1];
  if (!last || last.pct !== pct || now - last.at >= 3600000) {
    try { fs.appendFileSync(USAGE_HISTORY, JSON.stringify({ at: now, pct, reset }) + "\n"); } catch (_) {}
  }
  return rows;
}
// One toast per weekly window. The state file also feeds the prompt hook.
function paceAlert(pace, usedPct, resetMs, now) {
  const f = pace.forecast, key = Math.round(resetMs / 3600000);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(USAGE_PACE, "utf8")); } catch (_) {}
  const over = !!(f && f.state === "over");
  if (over && prev.alerted !== key) {
    const fmt = (ms) => new Date(ms).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
    osToast("pace", "At this pace you run out " + fmt(f.runsOutMs) + ". Resets " + fmt(resetMs) + ".");
  }
  try {
    fs.writeFileSync(USAGE_PACE, JSON.stringify({ at: now, usedPct, state: f ? f.state : "",
      projected: f ? f.projected : null, runsOutMs: f ? f.runsOutMs : null, resetMs,
      alerted: over ? key : prev.alerted }));
  } catch (_) {}
}

async function maybeUpdateUsage() {
  const now = Date.now();
  const throttle = Math.max(60000, (cfg().get("usage.refreshSeconds") || 180) * 1000);
  if (usageBusy || (usageAt && now - usageAt < throttle)) return;
  usageBusy = true;     // patch 89: one at a time, throttle stamped when it ends
  try {
    const data = await fetchUsage();
    if (!data) return;                                  // unreachable/stale -> keep last good card
    const src = Array.isArray(data.limits) ? data.limits : [];
    const rows = src
      .filter((l) => l && typeof l.percent === "number")
      .map((l) => ({
        label: usageLabel(l),
        kind: l.kind || "",
        leftPct: Math.max(0, Math.min(100, 100 - l.percent)),
        severity: l.severity || "normal",
        resetsAt: l.resets_at || null,
        group: l.group || l.kind || "",
      }));
    if (!rows.length) return;

    // #2 Low-limit attention: alert level from the worst-off window.
    const warnBelow = Math.max(1, cfg().get("usage.warnBelowPercent") || 15);
    const minLeft = Math.min.apply(null, rows.map((r) => r.leftPct));
    const alert = minLeft < warnBelow ? "crit" : minLeft < warnBelow * 2 ? "warn" : "";

    // Today bar: today's spend vs a SUSTAINABLE DAILY PACE for the rest of this
    // quota cycle — "at today's rate, do I run out before reset?" — rather than
    // the old "today's slice of the whole week", which was ~always near-zero by
    // construction (two small fractions multiplied) and didn't say anything
    // about whether today was heavy or light. A lighter companion under the
    // Weekly bar.
    let today = null;
    const wRow = rows.find((r) => r.kind === "weekly_all");
    if (wRow && wRow.resetsAt) {
      const resetMs = Date.parse(wRow.resetsAt);
      if (!isNaN(resetMs)) {
        const cycleStart = resetMs - 7 * 86400000;       // weekly cadence, confirmed by patch 13a
        const tw = await sumTodayWeek(cycleStart);
        const usedPct = 100 - wRow.leftPct;               // weekly quota consumed so far this cycle
        const todayPct = tw.week > 0 ? usedPct * (tw.today / tw.week) : 0;  // today's slice, weekly-quota scale
        const pace = A.weeklyPace({ usedPct, resetMs, nowMs: now, dayStartMs: dayStart(now),
          readings: usageReadings(now, usedPct, resetMs), proxyTodayPct: todayPct });
        today = Object.assign({ tokens: tw.today, exhausted: wRow.leftPct <= 0 }, pace);
        paceAlert(pace, usedPct, resetMs, now);
      }
    }

    // Renewal bar: next charge date, projected from subscription_created_at
    // (fetched once from /profile) on the configured monthly cadence.
    if (subCreatedAt === null) {
      const prof = await fetchProfile();
      if (prof) subCreatedAt = (prof.organization && prof.organization.subscription_created_at) || "";
    }
    const renew = computeRenew(subCreatedAt || "",
      cfg().get("usage.billingIntervalMonths") || 1,
      cfg().get("usage.renewsAt") || "");

    const oa = readOauth();
    usageStat = { plan: planLabel(oa), rows, at: now, alert, today, renew };
    if (provider) provider.post(buildSessions(_agentCache, Date.now(), _metaCache));
  } catch (_) { /* usage is additive — never break the poll */ }
  finally { usageBusy = false; usageAt = Date.now(); }
}

// Codex's plan meter (patch 84), in the Claude card's shape. Its rate limits ride on
// every token_count in the rollouts (codex.js planUsage), so this costs no fetch. A
// window whose reset has passed since that reading has started over: 0% used.
function codexUsage() {
  const r = X.planUsage();
  if (!r) return null;
  const rows = [r.limits.primary, r.limits.secondary].filter((w) => w && typeof w.used_percent === "number").map((w) => {
    const min = w.window_minutes || 0, reset = w.resets_at ? w.resets_at * 1000 : 0;
    return { label: min >= 10080 ? "Weekly" : Math.round(min / 60) + "-hour", kind: "",
      leftPct: reset && reset <= Date.now() ? 100 : Math.max(0, Math.min(100, 100 - w.used_percent)),
      severity: "normal", resetsAt: reset ? new Date(reset).toISOString() : null, group: min <= 300 ? "session" : "weekly" };
  });
  if (!rows.length) return null;
  const warnBelow = Math.max(1, cfg().get("usage.warnBelowPercent") || 15);
  const minLeft = Math.min.apply(null, rows.map((x) => x.leftPct));
  return { name: "Codex", logo: "◈", plan: r.limits.plan_type || "", rows, at: r.at,
    alert: minLeft < warnBelow ? "crit" : minLeft < warnBelow * 2 ? "warn" : "" };
}

function activate(context) {
  gState = context.globalState;
  // Clear the v1 map once: it may already point a live sid at a blank terminal.
  // Future v2 mappings remain restorable across extension-host reloads.
  if (gState.get("codexTerminalMapVersion") !== CODEX_TERMINAL_MAP_VERSION) {
    codexTerminalPids = {};
    gState.update("codexTerminalPids", codexTerminalPids);
    gState.update("codexTerminalMapVersion", CODEX_TERMINAL_MAP_VERSION);
  } else codexTerminalPids = gState.get("codexTerminalPids") || {};
  activeAgent = gState.get("activeAgent") === "codex" ? "codex" : "claude";
  renames = gState.get("renames") || {};
  codexHandoffNames = gState.get("codexHandoffNames") || {};
  parked = gState.get("parked") || {};
  pinned = gState.get("pinned") || [];
  bgRunSids = gState.get("bgRunSids") || {};
  loadTaskArchive();   // task-history archive from the vault file (patch 38d)
  topicEmojiCache = gState.get("topicEmojiCache") || {};
  boardSnapshot = gState.get("boardSnapshot") || {};   // restore last-known board (dormant cards)
  restoreSet = new Set(Object.keys(boardSnapshot));    // only these may show as dormant this run
  provider = new OverlordViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("overlord.board", provider,
      { webviewOptions: { retainContextWhenHidden: true } }));

  // Status-bar items removed: the counter section moved to the top of the panel
  // (html()), and the "New YOLO Session" button was retired — start a session via
  // a card's right-click menu or the "Overlord: New Session" command.

  if (cfg().get("device.enabled") !== false) {
    try {
      D.start({
        port: Math.max(1, cfg().get("device.port") || 7331),
        onJump: handleDeviceJump,
        log: (m) => console.log("[overlord] " + m),
      });
    } catch (e) { console.log("[overlord] device start failed: " + (e && e.message)); }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("overlord.refresh", () => refresh()),
    vscode.commands.registerCommand("overlord.newSession", () => newSession()),
    // New session in whichever agent the board toggle is showing. Bound to the
    // shortcut that used to open Claude unconditionally.
    vscode.commands.registerCommand("overlord.newAgentSession", async () => {
      if (activeAgent !== "codex") {
        return vscode.commands.executeCommand("workbench.action.terminal.newWithProfile",
          { profileName: "Claude" });
      }
      const openedAt = Date.now();
      const knownSessions = X.listSessions(openedAt);
      const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
      const opened = vscode.window.createTerminal(codexTerminalOptions(
        "GPT", folder && folder.uri && folder.uri.fsPath));
      trackCodexTerminal(opened, openedAt, knownSessions);
      opened.show(false);
    }),
    vscode.commands.registerCommand("overlord.toggleSound", async () => {
      const on = cfg().get("sound");
      await cfg().update("sound", !on, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage("Overlord sound " + (!on ? "ON 🔊" : "OFF 🔇"));
    }));

  const firstPost = refresh();
  const every = Math.max(1000, cfg().get("pollMs") || 2500);
  timer = setInterval(refresh, every);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Track which session's terminal is focused so the board can highlight the
  // selected card. Fires on manual terminal switches too, not just card jumps.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal(() => updateActiveSid()),
    vscode.window.onDidCloseTerminal((term) => {
      pendingCodexTerminals = pendingCodexTerminals.filter((p) => p.term !== term);
      for (const [sid, mapped] of codexTerminals) {
        if (mapped === term) forgetCodexTerminal(sid);
      }
    }));
  // Patch 88: after the board's first post, not ahead of it -- its codexCards scan
  // blocked the host before the first paint. The first refresh leaves that scan warm.
  Promise.all([restoreCodexTerminals(), firstPost.catch(() => {})]).then(sweepParkedCodex);
  setTimeout(() => updateActiveSid(), 2500);

  // Reveal the board when the window opens, in whichever side bar it lives.
  // Delayed so the workbench finishes restoring its own layout first (Cursor
  // otherwise re-activates its chat pane over us); preserveFocus keeps the
  // caret in the editor/terminal.
  if (cfg().get("openOnStartup") !== false) {
    setTimeout(() => {
      vscode.commands.executeCommand("overlord.board.focus", { preserveFocus: true })
        .then(undefined, () => {});
    }, 2000);
  }

  // ── Remote open-session trigger (LOCKED-SCREEN PROOF) ──────────────────────
  // A background poller (wa_command_router.py, driven by a WhatsApp note-to-self)
  // touches this file to ask Cursor to open a NEW Claude session. We run it here
  // in the extension host — which keeps running while the screen is LOCKED — so it
  // works when the user is away (synthetic keystrokes can't cross the secure desktop).
  // We do NOT reuse the Ctrl+Shift+C keybinding: that runs the "Claude" terminal profile
  // (bare `claude`, NOT phone-visible). We createTerminal with an explicit
  // `claude --remote-control "<title>"` — that flag is what makes it show on the phone.
  try {
    const trigPath = path.join(os.homedir(), ".claude", "overlord-open-session.trigger");
    let lastTrig = 0;
    try { lastTrig = fs.statSync(trigPath).mtimeMs; } catch (_) {}  // ignore pre-existing file
    const trigTimer = setInterval(() => {
      let m = 0;
      try { m = fs.statSync(trigPath).mtimeMs; } catch (_) { return; }
      if (m > lastTrig) {
        lastTrig = m;
        // The trigger file's CONTENT is JSON: {"title": "...", "prompt": "..."} (written by
        // wa_command_router.py). `title` names the Cursor tab AND is passed as the Remote
        // Control session name, so the session is identifiable in Cursor and on the phone
        // app. `prompt`, when non-empty, is passed as claude's POSITIONAL arg so the session
        // starts already working on it — the point of sending the task in the same WhatsApp
        // message instead of retyping it here.
        // BACK-COMPAT: older routers wrote the bare title as plain text. If the content is
        // not valid JSON we treat the whole string as the title and seed no prompt, so a
        // stale router (or a hand-written trigger) still opens a session.
        let title = "Opened via WA";
        let prompt = "";
        // Patch 63 (2026-09-14): {"resume": "<sid>"} reopens an EXISTING session in a
        // Cursor tab instead of starting a new one — the only way to bring a session
        // back into Cursor from outside it (a session forked to a background daemon
        // has no terminal to jump to). UUID-only, so nothing else can ride the arg.
        let resume = "";
        try {
          const raw = fs.readFileSync(trigPath, "utf8").trim();
          // sanitise for the quoted cmd arg: quotes/newlines AND cmd metachars (% expands
          // even inside quotes; & | < > ^ could chain commands if quoting ever breaks)
          const clean = (s, n) => String(s || "").replace(/["\r\n%&|<>^]/g, "").slice(0, n);
          let obj = null;
          if (raw.startsWith("{")) { try { obj = JSON.parse(raw); } catch (_) {} }
          if (obj && typeof obj === "object") {
            if (obj.title) title = clean(obj.title, 80);
            prompt = clean(obj.prompt, 900);
            if (/^[0-9a-f-]{36}$/i.test(String(obj.resume || ""))) resume = String(obj.resume);
          } else if (raw) {
            title = clean(raw, 80);
          }
        } catch (_) {}
        try {
          const ws = (vscode.workspace.workspaceFolders || [])[0];
          // Arg order (verified 2026-07-28): claude --remote-control "<title>" "<prompt>" —
          // --remote-control takes the optional name, the trailing positional is the prompt.
          // PASS EACH ARG SEPARATELY. Pre-joining them into one "cmd string" looks equivalent
          // but is not: cmd.exe re-parses the quotes and shreds it (measured — a title+prompt
          // pair split into 17 argv entries, so claude's positional [prompt] got only the
          // first stray token and the remote-control name was truncated to `"Test`). As
          // separate elements the OS does the quoting and spaces survive intact.
          const shellArgs = resume ? ["/k", "claude", "--resume", resume, "--permission-mode", "bypassPermissions", "--remote-control", title]
                                   : ["/k", "claude", "--remote-control", title];
          if (prompt) shellArgs.push(prompt);
          const term = vscode.window.createTerminal({
            name: title,
            shellPath: "cmd.exe",
            shellArgs: shellArgs,
            cwd: ws ? ws.uri.fsPath : undefined,
          });
          term.show(false);
          console.log("[overlord] opened WA session: " + title + (resume ? " (resume " + resume.slice(0, 8) + ")" : "") + (prompt ? " (+seeded prompt)" : ""));
        } catch (e) { console.log("[overlord] WA session open failed: " + (e && e.message)); }
      }
    }, 1500);
    context.subscriptions.push({ dispose: () => clearInterval(trigTimer) });
  } catch (e) { console.log("[overlord] open-session watcher setup failed: " + (e && e.message)); }

  // ── Send-to-session trigger (Anti-Raycast "Ask Claude → existing session") ──
  // Content: JSON {"sessionId":"...","text":"..."}. Written by the Anti-Raycast
  // launcher's Ask Claude mode; we type the text into that session's Claude prompt
  // via replyToSession (same path as the board's quick-reply buttons).
  try {
    const sendPath = path.join(os.homedir(), ".claude", "overlord-send.trigger");
    let lastSend = 0;
    try { lastSend = fs.statSync(sendPath).mtimeMs; } catch (_) {}
    const sendTimer = setInterval(() => {
      let m = 0;
      try { m = fs.statSync(sendPath).mtimeMs; } catch (_) { return; }
      if (m > lastSend) {
        lastSend = m;
        try {
          const payload = JSON.parse(fs.readFileSync(sendPath, "utf8"));
          const a = (_agentCache || []).find((x) => x.sessionId === payload.sessionId);
          if (a && payload.text) {
            replyToSession({ name: a.name, pid: a.pid, cwd: a.cwd }, String(payload.text));
            console.log("[overlord] send-trigger -> " + a.name);
          } else {
            console.log("[overlord] send-trigger: session not found: " + payload.sessionId);
          }
        } catch (e) { console.log("[overlord] send-trigger failed: " + (e && e.message)); }
      }
    }, 1500);
    context.subscriptions.push({ dispose: () => clearInterval(sendTimer) });
  } catch (e) { console.log("[overlord] send watcher setup failed: " + (e && e.message)); }

  // ── Focus-from-toast trigger (2026-07-20) ──────────────────────────────
  // Content: JSON {"sessionId":"..."}. Written by focus-cursor-window.ps1 when
  // a "Needs your input" toast is clicked, so the click can jump to the EXACT
  // terminal instead of just bringing some Cursor window forward. Mirrors the
  // send-trigger watcher above exactly, same poll cadence.
  //
  // Every open Cursor window runs its own Overlord instance and _agentCache is
  // system-wide (from `claude agents --json`), so every window's watcher will
  // see this trigger. Only findTerminalFor (a LOCAL lookup against this
  // window's own vscode.window.terminals) decides whether to act — if the
  // session isn't in this window, do nothing silently. Using the bare
  // find-and-show here (not the full jumpToTerminal) deliberately skips its
  // QuickPick fallback, which would otherwise pop up in every OTHER window
  // that doesn't have the session, on every click.
  try {
    const focusPath = path.join(os.homedir(), ".claude", "overlord-focus.trigger");
    let lastFocus = 0;
    try { lastFocus = fs.statSync(focusPath).mtimeMs; } catch (_) {}
    const focusTimer = setInterval(async () => {
      let m = 0;
      try { m = fs.statSync(focusPath).mtimeMs; } catch (_) { return; }
      if (m > lastFocus) {
        lastFocus = m;
        try {
          const payload = JSON.parse(fs.readFileSync(focusPath, "utf8"));
          const sessions = buildSessions(_agentCache, Date.now(), _metaCache);
          const s = sessions.find((x) => x.sid === payload.sessionId);
          if (!s) return;  // not tracked at all (rare) — nothing to do
          const t = await findTerminalFor(s, true);   // pid only: a same-folder guess showed another session
          if (t) {
            t.show(false);
            updateActiveSid();
            console.log("[overlord] focus-trigger -> " + s.name);
          }
          // else: session exists but isn't in THIS window's terminals —
          // silently defer to whichever window actually has it.
        } catch (e) { console.log("[overlord] focus-trigger failed: " + (e && e.message)); }
      }
    }, 1500);
    context.subscriptions.push({ dispose: () => clearInterval(focusTimer) });
  } catch (e) { console.log("[overlord] focus watcher setup failed: " + (e && e.message)); }
}

function deactivate() {
  if (timer) clearInterval(timer);
  // Final snapshot on shutdown so the board restores accurately after a restart.
  try { if (gState) gState.update("boardSnapshot", boardSnapshot); } catch (_) {}
  try { D.stop(); } catch (_) {}
}

module.exports = { activate, deactivate };
