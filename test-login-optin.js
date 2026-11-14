// Login reuse is opt-in: with overlord.useClaudeCodeLogin off (the default), a model
// call must not read ~/.claude/.credentials.json or open an HTTPS request, and the
// Python helpers must not be told to use the login.
// Run: node test-login-optin.js
const assert = require("assert");
const fs = require("fs");
const https = require("https");
const Module = require("module");
const path = require("path");

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
assert.strictEqual(pkg.contributes.configuration.properties["overlord.useClaudeCodeLogin"].default, false,
  "the setting ships off");

// Load extension.js against a stub `vscode`, with its private helpers exposed.
let setting;                                  // what overlord.useClaudeCodeLogin returns
const vscodeStub = { workspace: { getConfiguration: () => ({
  get: (k) => (k === "useClaudeCodeLogin" ? setting : undefined) }) } };
const realLoad = Module._load;
Module._load = function (req, ...rest) { return req === "vscode" ? vscodeStub : realLoad.call(this, req, ...rest); };
const file = path.join(__dirname, "extension.js");
const ext = new Module(file, module);
ext.filename = file; ext.paths = Module._nodeModulePaths(__dirname);
ext._compile(fs.readFileSync(file, "utf8") + "\nmodule.exports.__t = { apiCall, helperEnv };", file);
Module._load = realLoad;
const { apiCall, helperEnv } = ext.exports.__t;

// Mock the credentials file and the network: record, never touch the real ones.
const reads = [], requests = [];
const realRead = fs.readFileSync;
fs.readFileSync = function (p, ...r) {
  if (String(p).includes(".credentials.json")) { reads.push(p); return '{"claudeAiOauth":{"accessToken":"fake"}}'; }
  return realRead.call(this, p, ...r);
};
https.request = (o) => { requests.push(o); return { on() {}, end() {} }; };

process.env.OVERLORD_USE_CLAUDE_LOGIN = "1";  // an inherited value must not leak through

for (const off of [undefined, false]) {
  setting = off;
  let got = "unset";
  apiCall("claude-haiku-4-5-20251001", "hi", 10, (v) => { got = v; });
  assert.strictEqual(got, null, `setting ${off}: falls through to the CLI`);
  assert.strictEqual(reads.length, 0, `setting ${off}: credentials never read`);
  assert.strictEqual(requests.length, 0, `setting ${off}: no OAuth request`);
  assert.ok(!("OVERLORD_USE_CLAUDE_LOGIN" in helperEnv()), `setting ${off}: helpers stay on the CLI`);
}

setting = true;
apiCall("claude-haiku-4-5-20251001", "hi", 10, () => {});
assert.strictEqual(reads.length, 1, "setting on: reads the login");
assert.strictEqual(requests.length, 1, "setting on: calls the API");
assert.strictEqual(requests[0].host, "api.anthropic.com");
assert.strictEqual(helperEnv().OVERLORD_USE_CLAUDE_LOGIN, "1", "setting on: helpers may use the login");

fs.readFileSync = realRead;
console.log("login opt-in tests passed");
