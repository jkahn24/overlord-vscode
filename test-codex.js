// Unit checks for the Codex reader and for the agent filter the webview applies.
// Run: node test-codex.js
const assert = require("assert");
const X = require("./codex");

const BS = "\\";                       // one backslash, kept out of the literals below

// --- parse: a two-turn rollout whose second turn is still open ---
const rows = [
  {timestamp:"2026-09-21T15:15:03.693Z",type:"session_meta",
   payload:{session_id:"sid-1",cwd:["C:","a","b","my-repo"].join(BS),timestamp:"2026-09-21T15:15:03.278Z"}},
  {timestamp:"2026-09-21T15:15:03.702Z",type:"event_msg",payload:{type:"task_started",turn_id:"t1"}},
  {timestamp:"2026-09-21T15:15:09.000Z",type:"event_msg",
   payload:{type:"token_count",info:{total_token_usage:{total_tokens:15200},model_context_window:258400}}},
  {timestamp:"2026-09-21T15:15:09.378Z",type:"event_msg",
   payload:{type:"task_complete",turn_id:"t1",last_agent_message:"first answer"}},
  {timestamp:"2026-09-21T15:16:00.000Z",type:"event_msg",payload:{type:"task_started",turn_id:"t2"}},
];
const lines = rows.map(o => JSON.stringify(o)).join("\n");

const p = X.parseRollout(lines);
assert.strictEqual(p.sid, "sid-1");
assert.strictEqual(p.openTurns, 1, "second turn is still open");
assert.strictEqual(p.turns, 2);
assert.strictEqual(p.lastMessage, "first answer");
assert.strictEqual(p.tokens, 15200);
assert.strictEqual(p.ctxWindow, 258400);

const s = X.toSession(p, "rollout-sid-1.jsonl");
assert.strictEqual(s.agent, "codex");
assert.strictEqual(s.state, "working", "an open turn means working");
assert.strictEqual(s.name, "my-repo");
assert.strictEqual(s.ctxPct, 6);

// closing the second turn drops it to idle; a Codex card can never be needs-you
const closed = X.parseRollout(lines + "\n" + JSON.stringify(
  {timestamp:"2026-09-21T15:16:30.000Z",type:"event_msg",
   payload:{type:"task_complete",turn_id:"t2",last_agent_message:"second answer"}}));
const s2 = X.toSession(closed, "rollout-sid-1.jsonl");
assert.strictEqual(s2.state, "idle");
assert.strictEqual(s2.summary, "second answer");
assert.ok(s2.state !== "needs", "Codex rollouts carry no human-wait signal");

// --- malformed input must never throw ---
assert.doesNotThrow(() => X.parseRollout("not json\n{bad\n"));
assert.doesNotThrow(() => X.parseRollout(""));
assert.doesNotThrow(() => X.parseRollout(null));

// --- shortCwd: last two segments, Windows long-path prefix stripped ---
assert.strictEqual(X.shortCwd([BS + BS + "?" + BS + "C:","x","y","z"].join(BS)), "y/z");
assert.strictEqual(X.shortCwd("/home/j/vault/notes"), "vault/notes");
assert.strictEqual(X.shortCwd(""), "");

// --- the filter the webview applies: untagged rows belong to Claude ---
const board = [{agent:"claude"}, {agent:"codex"}, {}];
const pick = (a) => board.filter(x => (x.agent || "claude") === a).length;
assert.strictEqual(pick("claude"), 2, "an untagged row stays on the Claude board");
assert.strictEqual(pick("codex"), 1);

// --- card title: the first thing the user typed, not the injected AGENTS.md turn ---
const CWD = ["C:", "Users", "j", "Vault", "MyVault"].join(BS);
const NL = String.fromCharCode(10);
const titled = X.parseRollout([
  JSON.stringify({type:"session_meta", timestamp:"2026-09-22T09:00:00Z",
                  payload:{session_id:"sid-t", cwd:CWD}}),
  JSON.stringify({type:"response_item", timestamp:"2026-09-22T09:00:01Z",
                  payload:{role:"user", content:[{text:"# AGENTS.md instructions for the vault" + NL + "rules..."}]}}),
  JSON.stringify({type:"response_item", timestamp:"2026-09-22T09:00:02Z",
                  payload:{role:"user", content:[{text:"are you able to view my vault?"}]}}),
].join(NL));
assert.strictEqual(titled.firstPrompt, "are you able to view my vault?",
                   "the replayed AGENTS.md turn must not become the title");
assert.strictEqual(X.toSession(titled, "rollout-sid-t.jsonl").name, "are you able to view my vault?");

// two sessions in one folder must not end up with the same title
const plain = X.parseRollout(JSON.stringify({type:"session_meta", timestamp:"2026-09-22T09:00:00Z",
  payload:{session_id:"sid-u", cwd:CWD}}));
assert.strictEqual(X.toSession(plain, "rollout-sid-u.jsonl").name, "MyVault",
                   "with no prompt yet the folder name is still the fallback");
assert.notStrictEqual(X.toSession(titled, "a.jsonl").name, X.toSession(plain, "b.jsonl").name);

// Codex also opens sessions with a <recommended_plugins> envelope -- also not a title
const enveloped = X.parseRollout([
  JSON.stringify({type:"session_meta", timestamp:"2026-09-21T17:15:00Z",
                  payload:{session_id:"sid-v", cwd:CWD}}),
  JSON.stringify({type:"response_item", timestamp:"2026-09-21T17:15:01Z",
                  payload:{role:"user", content:[{text:"<recommended_plugins>" + NL + "- Dropbox" + NL + "</recommended_plugins>"}]}}),
  JSON.stringify({type:"response_item", timestamp:"2026-09-21T17:15:02Z",
                  payload:{role:"user", content:[{text:"Reply with exactly: enumeration probe ok"}]}}),
].join(NL));
assert.strictEqual(enveloped.firstPrompt, "Reply with exactly: enumeration probe ok");
assert.ok(X.injectedTurn("<recommended_plugins>"));
assert.ok(X.injectedTurn("# AGENTS.md instructions for the vault"));
assert.ok(!X.injectedTurn("are you able to view my vault?"));

// --- firstLine: one line, collapsed whitespace, clipped ---
assert.strictEqual(X.firstLine("  hello   world " + NL + "second line"), "hello world");
assert.strictEqual(X.firstLine(NL + NL + "  second is first  "), "second is first");
assert.strictEqual(X.firstLine(""), "");
assert.strictEqual(X.firstLine(null), "");
const longTitle = X.firstLine("x".repeat(80));
assert.ok(longTitle.length <= 48 && longTitle.charCodeAt(longTitle.length - 1) === 8230,
          "a long prompt is clipped with an ellipsis");

// --- listSessions fails closed: always an array, never a throw ---
assert.ok(Array.isArray(X.listSessions()));

console.log("codex tests passed");
