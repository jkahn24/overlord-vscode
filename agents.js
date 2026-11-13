// Pure, dependency-free logic for Overlord's data source.
//
// Overlord reads Claude Code's own session supervisor via `claude agents --json`
// (no hooks, no state files). This module turns those native records into the
// display model the extension paints. It touches no VS Code APIs so it can be
// unit-tested in plain Node.
//
// Native record shape (from `claude agents --json`):
//   { pid, cwd, kind, startedAt, sessionId, name, status, waitingFor? }
//   status ∈ { "busy", "waiting", "idle" }; waitingFor is set when waiting
//   (e.g. "permission prompt").

// Hex fallbacks (device screen / non-webview consumers). The webview resolves
// theme-aware tokens in extension.js html(); idle intentionally shares the
// done green — no grey state.
// "cutoff" = a session that was WORKING when Cursor last closed and is now dormant
// (its process died with the terminal). Restored from the on-disk transcript and
// resumable on click. Orange, its own tab, hidden when empty.
const COLOR = { needs: "#ff5c6c", working: "#f5b14c", cutoff: "#ff8c42", done: "#54d6a0", idle: "#54d6a0" };
const LABEL = { needs: "Needs you", working: "Working", cutoff: "Cut off", done: "Done", idle: "Idle" };
const ORDER = { needs: 0, working: 1, idle: 3, cutoff: 4, done: 2 };
const JUMP_LABEL = { needs: "Answer now", working: "Watch / interrupt", cutoff: "Resume", done: "Continue", idle: "Continue" };

// ---- card sub-line formatters (pure) --------------------------------------
function shortModel(model) { return String(model || "").replace(/^claude-/, ""); }

function fmtTokens(n) {
  n = Number(n) || 0;
  if (n <= 0) return "";
  return n < 1000 ? String(n) : Math.round(n / 1000) + "k";
}

function fmtDuration(ms) {
  let s = Math.floor((Number(ms) || 0) / 1000);
  if (s < 0) s = 0;
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  return Math.floor(m / 60) + "h" + (m % 60) + "m";
}

// ⛔ Was: `window = tokens > 200000 ? 1000000 : 200000`, which made the reading
// COLLAPSE across the boundary — 199k showed 100%, 201k showed 20% — so the number
// fell off a cliff exactly where it should have been raising its voice. Measured
// against the working ceiling (the autocompact trigger) there is no boundary at all.
function ctxPct(tokens, capTokens) {
  tokens = Number(tokens) || 0;
  if (tokens <= 0) return null;
  const cap = Number(capTokens) || 200000;
  return Math.round((tokens / cap) * 100);
}

function jumpLabel(state) { return JUMP_LABEL[state] || "Open"; }

function folderName(cwd) {
  if (!cwd) return "";
  const parts = String(cwd).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.length ? parts[parts.length - 1] : "";
}

function parseAgents(stdout) {
  const data = JSON.parse(stdout || "[]");
  return Array.isArray(data) ? data : [];
}

// Last assistant text from a JSONL transcript tail (pure; caller reads the file).
// Claude Code marks a session `idle` whether it finished OR ended its turn on a
// typed question. We use this to tell the two apart.
function lastAssistantText(jsonlTail) {
  const lines = String(jsonlTail || "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch (_) { continue; }
    if (o.type !== "assistant") continue;
    const c = (o.message || {}).content;
    let t = "";
    if (Array.isArray(c)) { for (const b of c) if (b && b.type === "text") t += b.text || ""; }
    else if (typeof c === "string") t = c;
    if (t.trim()) return t.trim();
  }
  return "";
}

// Does this turn end on a GENUINE question that needs the user's answer, as
// opposed to a rhetorical question the assistant answers itself
// ("How does it work? Like this: ...")? Agent View reports both a finished turn
// and a plain typed question as `idle`; this is how we tell a typed question
// apart. (Tool-based questions like AskUserQuestion already surface natively as
// `waiting`, so they never reach here.)
//
// Heuristic: peel trailing ASIDES — parenthetical remarks and option-list
// items — then check whether the turn ends on a question. This catches a real
// question followed by a "(or we could pause)" note, while still rejecting a
// question with a substantive self-answer after it.
function isUserQuestion(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  // Last substantive line, skipping trailing list items that hold no question
  // (e.g. an enumerated set of options presented before the closing question).
  const lines = t.split(/\r?\n/);
  let line = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^(\d+[.)]|[-*•])\s+/.test(l) && !l.includes("?")) continue;
    line = l; break;
  }
  // Peel trailing parenthetical asides: "Which approach? (or pause…)" -> "Which approach?"
  let prev;
  do { prev = line; line = line.replace(/\s*\([^()]*\)\s*$/, "").trim(); } while (line !== prev);
  return /\?["')\]]*\s*$/.test(line);
}

// Some turns need you without any "?" — an approval / go-ahead request phrased
// as an imperative ("say go and I'll…", "give me the green light"). These read
// as `idle` to Agent View and carry no question mark, so we match a curated set
// of high-precision asks. "let me know" only counts when it's directive
// (followed by a choice), never as a bare closing courtesy.
const APPROVAL = [
  /\bsay (go|the word)\b/i,
  /\byour (go[- ]?ahead|sign[- ]?off|approval)\b/i,
  /\bgive (me |us )?(the |a |your )?(go[- ]?ahead|green[- ]?light)\b/i,
  /\byour green[- ]?light\b/i,
  /\bgreen[- ]?light (and i'?ll|to (go|proceed|start|ship))\b/i,
  /\b(confirm|approve|approved|say go|sign off)\b[^.?!\n]{0,40}\band i'?ll\b/i,
  /\bif you'?re (good|happy|ok|okay|fine|cool|on board) with (this|that|it|the)\b/i,
  /\bready when you are\b/i,
  /\bstanding by\b/i,
  /\baw(ait|aiting) your\b/i,
  // Imperative "need your <ok>" family — an ask with no "?" ("Need your one OK
  // on X before I…", "needs your sign-off"). {0,30} spans a filler word like
  // "one" between "your" and the approval noun. High-precision nouns only.
  /\bneed(s|ing)? your\b[^.?!\n]{0,30}\b(ok|okay|go|go[- ]?ahead|sign[- ]?off|approval|confirm(ation)?|yes|nod|blessing|thumbs[- ]?up|green[- ]?light|call|decision|word)\b/i,
  // "waiting on your reply/call/decision/go" — sibling of "awaiting your".
  /\bwait(ing)? on your\b/i,
  // "before I build/migrate/ship…" — a hold pending the user's go, common when
  // the ask itself carries no "?" ("…before I build + migrate + retire").
  /\bbefore i (build|migrate|start|ship|proceed|go ahead|kick off|wire|retire|apply|send|submit|run it|make the)\b/i,
  // A hold stated as a status line rather than a request: "Still pending you:
  // **Reload Window**", "pending your review". Second person only — "pending the
  // deploy" is work, "pending you" is a blocked turn.
  /\bpending (you|your)\b/i,
];
const LET_ME_KNOW_DIRECTIVE =
  /\blet me know\b[\s,]*(which|what|whether|how you'?d|how you would|your (choice|preference|call|answer|thoughts)|if you'?d? (like|want|prefer|rather))/i;
// Sibling of LET_ME_KNOW_DIRECTIVE: "tell me which / what / whether…".
const TELL_ME_DIRECTIVE =
  /\btell me\b[\s,]*(which|what|whether|how you'?d|how you would|your (choice|preference|call|answer|thoughts)|if you'?d? (like|want|prefer|rather))/i;
// The turn hands a CHOICE back and promises the follow-up action, with no "?"
// anywhere — "Say PRSN vs DM and I'll send", "Tell me **the space** and I'll
// send it", "Confirm the staging folder … and I'll place it there". Both
// question paths miss these (no "?"), and the existing `confirm…and I'll`
// pattern is capped at 40 chars, too short for a real sentence.
//
// Anchored at a clause boundary (optionally through a bullet/number marker and
// markdown bold) so ONLY an imperative counts: a narrated "I'd say the build is
// green and I'll ship it" has a word before the verb and cannot match. Verb list
// is curated to asks that only make sense aimed at the user — "send me … and I'll"
// is deliberately absent, since that's a conditional offer about something
// arriving later ("send me the conf # when the email lands"), not a hold on
// this turn.
// Widened 2026-08-06 (patch 33). The corpus measurement showed this class is the
// single biggest miss: the turn ends by naming something the user must hand over, then
// promises the follow-up. Three changes, each drawn from a real missed transcript:
//   - verb list generalised beyond the original six ("get the doc and I'll redo it",
//     "point me at them and I'll redraft", "paste them and I'll draft from that")
//   - a COMMA counts as a clause boundary ("…if they exist somewhere, point me at
//     them and I'll…") — the old boundary class missed every mid-sentence handover
//   - a filler adverb may sit between the boundary and the verb ("; just say 'run 11'
//     … and I'll execute it")
// `send me` stays excluded (patch 29's reasoning: a conditional offer about something
// arriving later, not a hold on this turn).
const IMPERATIVE_CHOICE =
  /(?:^|[\n.!?;:,—–]\s*)(?:[-*•]\s+|\d+[.)]\s+)?\*{0,2}(?:just |then |so |now |simply |or |and )?\*{0,2}(tell me|say|pick|choose|confirm|name|get|paste|point me at|drop|share|read|give me|check|send(?! me))\b[^.?!\n]{0,90}\band (i|we)'?ll\b/i;

// A hold that waits on the user's WORD (as opposed to his action — that's the `open`
// tier below). All blocking: the session literally cannot continue.
const AWAITS_WORD = [
  /\bsay so\b/i,                                            // "if you'd rather X, say so"
  /\bwaits? on (you|your)\b/i,                              // "waits on your review" — `wait(ing)?` missed the -s form
  /\bneeds? (a |an )?(decision|answer|call|steer|verdict|word|view|opinion) from you\b/i,
  /\b(when|once) you'?re (happy|ready|good|done|ok|okay|satisfied)\b/i,   // "when you're happy, I'll do Phase 2"
  /\b(when|once) you (say|confirm|approve|give|decide|pick|choose)\b/i,
  /\buntil you (say|confirm|approve|tell|give|decide)\b/i,   // "nothing activates until you say so"
  /\bunless you'?d? (rather|prefer|want|say)\b/i,            // "I'll start on X unless you'd rather reorder"
  /\bcheck your\b[^.?!\n]{0,80}\b(right now|now)\b/i,        // "check your app … right now"
  /\b(flag|ping|shout at|tell) me if\b/i,                     // "flag me if you'd rather I remove that 1h30"
  /\bwhichever you (pick|choose|prefer|go with|land on)\b/i,  // "Whichever you pick … then I'll send the confirmation"
];

// The turn is FINISHED, but it handed the user an item only he can close — no promised
// follow-up, nobody blocked. Rendered in the same tab, dimmed, and never toasted.
// The action/word split is the line: waiting on a WORD blocks, waiting on an ACTION
// is open ("SSH clones fail until you add the key" — true, but nothing is waiting).
//
// `secondPerson: true` marks a phrase that a long report also uses NARRATIVELY about
// other people ("component mapping … still open as of that meeting", "four action
// items were still open as of the 07-29 note"). Those only count as an item for the user
// when a you/your sits near the hit. The rest are inherently addressed at him.
const OPEN_ITEM = [
  { re: /\bstill (outstanding|open|unresolved|pending)\b/i, secondPerson: true },
  { re: /\bloose end\b/i, secondPerson: true },
  { re: /\bleft open\b/i, secondPerson: true },
  { re: /\byou (now )?own\b/i },
  { re: /\b(they'?re|that'?s|it'?s) yours\b/i },
  { re: /\byours to (decide|do|call|sign|send|close|finish|book|fix)\b/i },
  { re: /\bonly you can\b/i },
  { re: /\b(when|whenever) you get (a chance|round to it)\b/i },
  { re: /\baction(s)? for you\b/i },
  { re: /\byou'?ll need to\b/i },
  { re: /\bopen (thread|item|loop|question)s?\b/i, secondPerson: true },
  // The single most common action-for-the-user in this vault: a change that is on disk
  // but inert until he restarts something. Patch 29 caught one phrasing of this
  // ("Still pending you: **Reload Window**"); these are the rest of them.
  { re: /\b(reload|restart|relaunch) (claude|cursor|the window|the app|vs ?code)\b/i },
  { re: /\b(needs?|requires?) (a |an )?[^.?!\n]{0,40}(reload|restart|relaunch)\b/i },
  // "worth checking / restarting / asking" = an action for the user. Two exclusions keep
  // finished report cards out of the tab: FYI verbs ("worth knowing / noting /
  // surfacing"), and a past-tense frame ("your question WAS worth asking" is a
  // compliment, not a task).
  { re: /(?<!\b(?:was|were|is|been|not)\s)\bworth (?!knowing|noting|remembering|mentioning|saying|flagging|surfacing|bearing|keeping)\w+ing\b/i },
  { re: /(?<!\b(?:was|were|is|been|not)\s)\bworth (a|one|your) \w+/i },   // "worth one line on the call", "worth a look"
];

// Where a hand-back actually lives: the sign-off. Scanning the whole message makes a
// long report flag itself on its own narration — measured, it was 5 false alarms in
// 15 finished sessions. The closing ~1200 characters (cut to a line boundary) cover
// the TL;DR plus the paragraphs that precede it, which is where every real hand-back
// in the corpus sat.
function closingBlock(text) {
  const t = String(text || "");
  if (t.length <= 1200) return t;
  const cut = t.slice(-1200);
  const nl = cut.indexOf("\n");
  return nl > -1 ? cut.slice(nl + 1) : cut;
}

// Named so a verdict can say WHICH rule fired (`explain()` below). Debugging a
// mis-tabbed card by eyeballing 40 anonymous regexes is how the last three patches
// went; a name and the matched substring turn that into one line of output.
const BLOCKING_RULES = [].concat(
  [{ name: "let-me-know", re: LET_ME_KNOW_DIRECTIVE }, { name: "tell-me", re: TELL_ME_DIRECTIVE },
   { name: "imperative-choice", re: IMPERATIVE_CHOICE }],
  AWAITS_WORD.map((re, i) => ({ name: "awaits-word/" + i, re })),
  APPROVAL.map((re, i) => ({ name: "approval/" + i, re })));

function asksApproval(text) {
  const t = String(text || "");
  if (!t.trim()) return false;
  return BLOCKING_RULES.some((r) => r.re.test(t));
}

// {tier, rule, hit} for the rule that decided this text, or null. Same order as
// awaitVerdict, so it always agrees with the verdict the board acted on.
function explain(text) {
  const t = String(text || "");
  if (!t.trim()) return null;
  if (declaredNothing(t)) return null;
  if (isUserQuestion(t)) return { tier: "blocking", rule: "trailing-question", hit: "" };
  if (asksDirectiveQuestion(t)) return { tier: "blocking", rule: "directive-question", hit: "" };
  for (const r of BLOCKING_RULES) {
    const m = t.match(r.re);
    if (m) return { tier: "blocking", rule: r.name, hit: m[0] };
  }
  const c = closingBlock(t);
  if (handsBackItem(t)) {
    for (const p of OPEN_ITEM) {
      const m = c.match(p.re);
      if (m) return { tier: "open", rule: "open-item", hit: m[0] };
    }
  }
  return null;
}

function handsBackItem(text) {
  const full = String(text || "");
  const t = closingBlock(full);
  if (!t.trim()) return false;
  // A turn whose whole output is a DOCUMENT (a drafted meeting note: heading-driven,
  // no TL;DR sign-off) is not the session addressing the user — advisory lines inside the
  // artifact ("Worth reconciling before using either date") are its content, not a
  // hand-back. A document that DOES end in a TL;DR is a draft plus a sign-off, and the
  // sign-off is judged normally.
  if (!isTurnFinal(full) && (full.match(/^##\s/gm) || []).length >= 2) return false;
  return OPEN_ITEM.some((p) => {
    const hit = t.match(p.re);
    if (!hit) return false;
    // An explicit "no action needed" INVERTS the phrase it sits next to: "whenever
    // you next restart Cursor … no need to do it on purpose" is the session telling
    // the user to ignore it, not to act. Checked before anything else — a negated hit is
    // never an open item, however it was matched.
    const near = t.slice(Math.max(0, hit.index - 110), hit.index + hit[0].length + 110);
    if (/\bno (need|action|rush)\b|\bn'?t need\b|\bnot needed\b|\bnothing (to do|from you|further)\b|\bno further action\b|\bsorts? (itself|themselves) out\b/i.test(near)) return false;
    if (!p.secondPerson) return true;
    // A you/your within ~160 chars of the hit is what separates "still open — the
    // meeting YOU postponed" from "still open as of that meeting".
    const from = Math.max(0, hit.index - 160);
    return /\byou\b|\byour\b|\byou'?(re|ll|d|ve)\b/i.test(t.slice(from, hit.index + hit[0].length + 160));
  });
}

// A message that ends in a TL;DR is turn-FINAL by construction (the user's global
// CLAUDE.md rule puts one at the end of every closing reply), as opposed to the
// mid-turn narration a busy session streams. The Haiku adjudicator uses this to
// decide what is worth spending a judgment on.
function isTurnFinal(text) { return /TL;?DR/i.test(String(text || "")); }

// A DIRECTIVE question buried mid-paragraph still needs you, even when a
// courtesy sentence follows the "?" ("Want me to proceed…? Either is quick.").
// isUserQuestion can't peel trailing statements without breaking its
// rhetorical-question guard, so this matches a curated set of second-person
// asks that are never rhetorical — but only inside the FINAL paragraph, so a
// mid-turn "want me to…?" followed by more narrated work stays quiet.
const DIRECTIVE_Q = [
  /\bwant me to\b/i,
  /\bwould you (rather|prefer|like me to)\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\bdo you want (me|us) to\b/i,
];
function asksDirectiveQuestion(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const paras = t.split(/\n\s*\n/);
  const last = paras[paras.length - 1];
  // Question-ending fragments of the last paragraph ("?" cut at sentence ends);
  // a "?" inside a URL never pairs with a directive phrase, so it can't match.
  const frags = last.match(/[^.!?\n]*\?/g) || [];
  return frags.some((f) => DIRECTIVE_Q.some((re) => re.test(f)));
}

// The session's OWN declaration of its end state, and it outranks every rule below.
// the user's TL;DR format gives the closing block a fixed `Next` slot, and "Nothing" in
// that slot means nothing is owed — so a card is not allowed to sit in Needs you
// against its own sign-off (the user, 2026-08-20: "if you are in nothing state, then why
// are you in the needs you tab"). Inference is what the rules below do; a declaration
// beats an inference. The trigger was "Nothing — tell me if you see it again", which
// matched a rule written for "flag me if you'd RATHER x" — a present choice — while
// this was a standing invitation about a future event.
const NEXT_NOTHING = /\bNext\*{0,2}\s*\n+\s*\*{0,2}Nothing\b/i;
function declaredNothing(text) {
  return isTurnFinal(text) && NEXT_NOTHING.test(closingBlock(String(text || "")));
}

// Why the session needs you, and how hard. Returns {tier, reason} or null.
//   tier "blocking" -> the session cannot continue until you answer (solid dot, toasts)
//   tier "open"     -> it finished, but left an item only you can close (hollow dot, silent)
// Blocking always wins over open.
function awaitVerdict(text) {
  if (declaredNothing(text)) return null;
  if (isUserQuestion(text)) return { tier: "blocking", reason: "typed a question" };
  if (asksDirectiveQuestion(text)) return { tier: "blocking", reason: "typed a question" };
  if (asksApproval(text)) return { tier: "blocking", reason: "awaiting your reply" };
  if (handsBackItem(text)) return { tier: "open", reason: "left you an open item" };
  return null;
}

// Back-compat: the subtitle string alone. Kept because `test-transcript.js` asserts
// on it and readTail still surfaces it as `awaitReason`.
function awaitReason(text) { const v = awaitVerdict(text); return v ? v.reason : null; }

function awaitsUser(text) { return awaitReason(text) !== null; }

// "working" must mean the MODEL is working (patch 36, 2026-08-10).
//
// Claude Code reports status "busy" for a session that still has outstanding
// background work — a `run_in_background` shell, or a background subagent — even
// though its turn is over and the prompt is accepting input. the user could not tell
// those cards from a genuinely streaming one: on 2026-08-10 a session read
// `working 15m` while its own pane read `Worked for 20s · 1 shell still running`,
// its turn having closed 2 minutes earlier.
//
// Worse than the wrong tab: BOTH the two-tier needs-you promotion and the Haiku
// adjudicator start with `if (a.status !== "idle") continue`. A session pinned at
// busy is invisible to them, so a finished turn that ends on a question could never
// reach the Needs-you tab no matter how good patch 33's vocabulary got. Un-pinning
// the status is what lets that machinery see it at all.
//
// Same shape as extension.js's maskSelfOpenedDialogs (patch 25): rewrite an upstream
// status that is technically true but misleading on a board. Only ever busy -> idle,
// NEVER the reverse — so the failure mode is today's behaviour, not a card that goes
// quiet while the model is still typing. A tail with no turn_duration marker (a very
// long turn overflowing readMeta's 64KB window) simply yields turnOver=false.
function maskFinishedTurns(agents, meta) {
  for (const a of agents || []) {
    if (a.status !== "busy") continue;
    const m = (meta && meta[a.sessionId]) || {};
    if (!m.turnOver) continue;
    a.status = "idle";
    // If the CLI still calls it busy once the turn is over, work IS outstanding —
    // that is the definition of this state. So the card earns its "bg" chip without
    // a per-tick process-tree walk, which at a 2.5s poll is not affordable.
    a._bgWork = true;
  }
}

// Map one native record -> display session.
//   status "waiting" -> red   "needs you"   (subtitle shows waitingFor)
//   status "busy"    -> amber "working"
//   status "idle"    -> grey "idle" — ALWAYS. A session only becomes "done"
//                       (green, PARKED) when the user manually right-clicks "Move to
//                       done"; that override is applied in buildSessions. There is
//                       NO time-based auto-park (removed 2026-07-15): an idle
//                       session stays idle no matter how long it sits.
// opts: { nowMs, statusSinceMs, termName }  (doneAfterMs no longer used here)
// A DORMANT record (a._dormant) is a session restored from a snapshot after a
// Cursor restart — its process is dead. Its state is fixed by the snapshot's last
// state (a._dormantState: idle/needs/cutoff), it carries dormant:true (webview
// dims it + resumes on click instead of jumping), and it has no live pid.
function toSession(a, opts = {}) {
  const raw = a.status || "idle";
  const dormant = !!a._dormant;
  let state;
  if (dormant) state = a._dormantState || "idle";
  else if (raw === "waiting") state = "needs";
  else if (raw === "busy") state = "working";
  else state = "idle";   // never auto-park; only the manual override sets "done"
  const sub =
    state === "cutoff" ? "cut off — click to resume" :
    dormant ? "resume where you left off" :
    state === "needs" ? (a.waitingFor ? "needs you · " + a.waitingFor : "needs you") :
    state === "working" ? "working" :
    state === "done" ? "parked" : "idle";
  return {
    sid: a.sessionId,
    pid: a.pid || 0,
    // "blocking" (cannot continue without you) vs "open" (finished, left you an
    // item). Only meaningful on a needs card; a native permission dialog has no
    // tier and defaults to blocking, which is what it is.
    tier: state === "needs" ? (a.tier === "open" ? "open" : "blocking") : null,
    name: opts.termName || folderName(a.cwd) || a.name || "session",
    cwd: a.cwd || "",
    raw,
    state,
    dormant,
    color: COLOR[state],
    label: LABEL[state],
    sub,
    jumpLabel: JUMP_LABEL[state] || "Open",
    bg: !!a._bgWork,          // turn over, background work still running (maskFinishedTurns)
    model: shortModel(opts.model),
    ctxTokens: Number(opts.ctxTokens) || 0,
    ctxPct: ctxPct(opts.ctxTokens, opts.ctxCapTokens),
    ctxCapTokens: Number(opts.ctxCapTokens) || 0,
    sinceMs: opts.statusSinceMs ? Math.max(0, (opts.nowMs || 0) - opts.statusSinceMs) : 0,
    uptimeMs: opts.startedAtMs ? Math.max(0, (opts.nowMs || 0) - opts.startedAtMs) : 0,
    lastTurnMs: Number(opts.lastTurnMs) || 0,   // duration of the last completed turn (patch 51)
  };
}

// Compose the sidebar sub-line: "working 41s · fable-5 · ctx 268k · 27% · up 3h45m".
// The head bit keeps the needs-you reason; other segments append only when present.
function metaLine(s) {
  // Dormant (restored) cards have a dead process, so live metrics (ctx, uptime,
  // status clock) are meaningless — show a short static line instead.
  if (s.dormant) return s.state === "cutoff" ? "cut off · click to resume"
                      : s.state === "done" ? "parked · click to resume"    // dormant + user-parked
                      : "dormant · click to resume";
  const bits = [];
  if (s.state === "needs") bits.push(s.sub);
  else if (s.state === "done") bits.push("parked" + (s.sinceMs ? " · idle " + fmtDuration(s.sinceMs) : ""));
  else bits.push((s.state === "working" ? "working" : "idle") +
                 (s.sinceMs ? " " + fmtDuration(s.sinceMs) : ""));
  // Last completed turn (patch 51) — only when the model is NOT mid-turn; a working
  // card already shows the live clock and the previous turn is stale news there.
  if (s.state !== "working" && s.lastTurnMs) bits.push("last turn " + fmtDuration(s.lastTurnMs));
  if (s.model) bits.push(s.model);
  // ctx moved OUT of this line 2026-08-24 — it is drawn as the fill rail under the
  // title now. Leaving it here too would state the same number twice on one card.
  // `bg` and `⚙ N` moved out the same evening, for the same reason and one more:
  // as grey chips mid-line they were missable enough that the user read the board as
  // having stopped tracking background work entirely. They are the RUNNING badge
  // now — see runText/running in extension.js — and the card must not say it twice.
  if (s.uptimeMs) bits.push("up " + fmtDuration(s.uptimeMs));
  return bits.join(" · ");
}

// The RUNNING badge's text, or "" when nothing is running. Lives next to metaLine
// because it is the other half of the same split: what the card says about its
// background work, just louder and out of the sentence.
//
// Either source alone is enough and neither sees the other's blind spot — `bg`
// catches an in-process subagent, which spawns no shell at all; `workers` catches
// a shell whose session already closed its turn. A dormant card's process is dead,
// so nothing it once ran is running now.
function runBadge(s) {
  if (!s || s.dormant) return "";
  const wn = s.workers || 0;
  if (!s.bg && !wn) return "";
  return wn
    ? wn + " background job" + (wn > 1 ? "s" : "") +
      (s.workerAgeMs ? " · " + fmtDuration(s.workerAgeMs) : "")
    : "background work";
}

// Hand off button (extension patch 49). Offered past 60% of the working ceiling,
// at a turn boundary, to a session that has not handed off yet. Working cards get
// none — a mid-turn handoff is exactly what the Stop-hook gate exists to avoid —
// and below 60% there is nothing to offer, so there is no button to ignore. The
// gate itself fires at 400k (80%) on its own; this is the earlier, on-purpose way.
const HANDOFF_OFFER_PCT = 60;
function offerHandoff(s, handedOff) {
  return !s.dormant && !handedOff && (s.state === "idle" || s.state === "needs")
      && (Number(s.ctxCapTokens) || 0) > 0
      && (Number(s.ctxTokens) || 0) / s.ctxCapTokens * 100 >= HANDOFF_OFFER_PCT;
}

// ── Handoff card naming (patch 57, 2026-09-12) ──────────────────────────────────
// A successor card's name has TWO halves: the THREAD's identity, then what THIS
// session is doing. Before this, a card inherited the predecessor's whole name, and
// because the board strips the ↻ before re-adding it, one string was copied down
// every generation. A rename the user made on 9 Sep was still on the card 17 handoffs
// later, on completely different work, beside dead cards from the same chain wearing
// it too -- which read as sessions being mixed together.
const HANDOFF_SEP = " · ";

// The thread half of a card name: everything before the first separator. Splitting is
// what stops the two halves concatenating each generation into a topic history.
function threadOf(cardTitle) {
  // Strip the continuation marker HERE rather than trusting the caller to have done
  // it. extension.js's boardTitle() happens to strip it first, and relying on that
  // silently is the same implicit coupling that produced the bug above: composing a
  // name from an unstripped one grows a ↻ per generation.
  return String(cardTitle || "").replace(/^(?:[↻✳]\s*)+/, "")
    .split(HANDOFF_SEP)[0].trim();
}

// Compose the successor's name. `doing` is the title the gate derived for this
// handoff; when it is missing or just repeats the thread, the thread stands alone.
function handoffName(thread, doing) {
  const t = threadOf(thread);
  const d = String(doing || "").trim();
  return "↻ " + t + (d && d !== t ? HANDOFF_SEP + d : "");
}

// ── Un-park rule (patch 59, 2026-09-14) ─────────────────────────────────────────
// A parked card un-parks when the user continues the session, i.e. it goes BUSY. A
// handed-off session is parked while still busy finishing the handoff turn, so for
// those the busy-ness must belong to a LATER turn: the newest human prompt must be
// newer than the handoff itself. Unknown times (old records, prompt outside the
// transcript window) keep the card parked — the failure mode is today's behaviour.
// A parked card that goes WAITING un-parks unconditionally (patch 66, 2026-09-14): it
// is blocked on the user, and a card that needs him can never be hidden in Done. Patch 65
// stopped auto-parking but left stale parks to clear "when the session goes busy" — a
// waiting session never does, so 4d0e87f2 sat in Done on "input needed".
// Patch 68 (2026-09-15, the user: Needs-you cards "hide for a second, but then it appears
// again"): only a NEW wait un-parks. A card parked while already waiting was parked
// deliberately on that very ask, and the old rule threw it back on the next poll.
// prevStatus unknown (board just loaded) is not a transition — the park is kept.
function shouldUnpark(status, isParked, handedOff, handoffAtMs, lastPromptAtMs, prevStatus) {
  if (!isParked) return false;
  if (status === "waiting") return !!prevStatus && prevStatus !== "waiting";
  if (status !== "busy") return false;
  if (!handedOff) return true;
  return !!handoffAtMs && !!lastPromptAtMs && lastPromptAtMs > handoffAtMs;
}

// Patch 97: the weekly limit is now the only one, so pace against it. Today = the server's
// weekly % now minus its last reading before midnight (token share only until a reading
// exists). Budget = what is left above a 10% reserve, split over the days to reset. Forecast =
// week-average rate, held back for 48h: it warned by day 2 in all 3 limit weeks since September.
function weeklyPace({ usedPct, resetMs, nowMs, dayStartMs, readings, proxyTodayPct }) {
  const H = 3600000, windowStart = resetMs - 7 * 24 * H;
  const before = (readings || []).filter((r) => Math.abs(r.reset - resetMs) < H && r.at < dayStartMs);
  const startPct = windowStart >= dayStartMs ? 0
    : before.length ? before[before.length - 1].pct
    : Math.max(0, usedPct - (proxyTodayPct || 0));
  const todayPct = Math.max(0, usedPct - startPct);
  const daysLeft = Math.max((resetMs - Math.max(dayStartMs, windowStart)) / (24 * H), 1 / 24);
  const budgetPct = Math.max(0, 100 - 10 - startPct) / daysLeft;
  const pacePct = budgetPct > 0 ? (todayPct / budgetPct) * 100 : (todayPct > 0 ? 999 : 0);
  const elapsedH = (nowMs - windowStart) / H;
  let forecast = null;
  if (elapsedH >= 48) {
    const rate = usedPct / elapsedH;
    const projected = usedPct + rate * Math.max(0, (resetMs - nowMs) / H);
    forecast = { projected, state: projected >= 100 ? "over" : projected >= 90 ? "tight" : "ok",
      runsOutMs: projected >= 100 && rate > 0 ? nowMs + ((100 - usedPct) / rate) * H : null };
  }
  return { todayPct, budgetPct, pacePct, forecast };
}

module.exports = { weeklyPace, shouldUnpark, HANDOFF_SEP, threadOf, handoffName, HANDOFF_OFFER_PCT, offerHandoff, COLOR, LABEL, ORDER, JUMP_LABEL, folderName, parseAgents, toSession, maskFinishedTurns, lastAssistantText, isUserQuestion, asksApproval, asksDirectiveQuestion, handsBackItem, isTurnFinal, explain, awaitVerdict, awaitReason, awaitsUser, shortModel, fmtTokens, fmtDuration, ctxPct, jumpLabel, metaLine, runBadge };
