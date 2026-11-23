// Headless harness for public/nori-content-gate.js (unified gate).
// Mocks browser surface including synchronous XHR for manifest loading.
import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync(new URL("../public/nori-content-gate.js", import.meta.url), "utf8");

class FakeMessageEvent {
  constructor(type, init = {}) {
    this.type = type; this.data = init.data; this.origin = init.origin || "";
    this.lastEventId = init.lastEventId || ""; this.source = init.source || null; this.ports = init.ports || [];
  }
}
class FakeWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  constructor() { this.readyState = 1; this.onmessage = null; this.listeners = []; this.sent = []; }
  addEventListener(type, fn) { if (type === "message") this.listeners.push(fn); }
}
FakeWebSocket.prototype.send = function (data) { this.sent.push(String(data)); };

const store = new Map();
const gateManifest = {
  version: 1,
  files: {
    file_secret_log: { bodyUrl: "/gated/file_secret_log.json", recoverWhen: "read:mail.welcome", threshold: null },
    file_compute_log: { bodyUrl: "/gated/file_compute_log.json", recoverWhen: "", threshold: 1000 },
  },
};
const storyManifest = {
  version: 1,
  reveals: { "mail.followup": { kind: "mail", trigger: "read:mail.welcome", delayMs: 25 } },
};
const gatedBodies = {
  "/gated/file_secret_log.json": { body_md: "SECRET BODY" },
  "/gated/file_compute_log.json": { body_md: "COMPUTE BODY" },
};

class FakeXHR {
  open(method, url) { this.url = url; }
  send() {
    const docs = {
      "/gated/manifest.json": gateManifest,
      "/gated/story-manifest.json": storyManifest,
    };
    this.status = docs[this.url] ? 200 : 404;
    this.responseText = docs[this.url] ? JSON.stringify(docs[this.url]) : "";
  }
}

const timers = [];
const sandbox = {
  WebSocket: FakeWebSocket,
  MessageEvent: FakeMessageEvent,
  XMLHttpRequest: FakeXHR,
  fetch: async (url) => {
    const body = gatedBodies[url];
    return body ? { ok: true, json: async () => body } : { ok: false };
  },
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  window: { WebSocket: FakeWebSocket, dispatchEvent() { return true; }, addEventListener() {} },
  console, Symbol, Object, JSON, Math, Number, Map, Set, Array, Promise,
  setTimeout: (fn, ms) => timers.push({ fn, ms, dead: false }) - 1,
  clearTimeout: () => {},
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const S = sandbox.window.WebSocket;
assert(S !== FakeWebSocket, "WebSocket wrapped by unified gate");

const socket = new S("/ws");
let received = null;
socket.addEventListener("message", (e) => { received = e.data; });
const send = S.prototype.send;

function deliver(artifacts) {
  const raw = JSON.stringify({ type: "manifold.artifacts.response", payload: { ok: true, artifacts } });
  socket.listeners[0](new FakeMessageEvent("message", { data: raw }));
  return JSON.parse(received).payload.artifacts;
}

// 1. Both file body and delayed mail hidden before any trigger.
let arts = deliver([
  { id: "mail.welcome", type: "mail", data: { subject: "welcome" } },
  { id: "mail.followup", type: "mail", data: { subject: "followup" } },
  { id: "file.secret_log", type: "file", data: { contentKey: "file_secret_log", body_md: "LEAK" } },
]);
assert(!arts.find((a) => a.id === "mail.followup"), "delayed mail hidden before trigger");
const locked = arts.find((a) => a.id === "file.secret_log");
assert(locked.data.body_md === undefined, "locked file body stripped");

// 2. Reading welcome mail unlocks the file AND schedules the delayed mail.
send.call(socket, JSON.stringify({
  type: "event", channel: "manifold.command.request",
  payload: { command: "mail.read", payload: { mailId: "mail.welcome" } },
}));
await new Promise((r) => setTimeout(r, 10));

arts = deliver([
  { id: "mail.welcome", type: "mail", data: {} },
  { id: "mail.followup", type: "mail", data: {} },
  { id: "file.secret_log", type: "file", data: { contentKey: "file_secret_log" } },
]);
assert(arts.find((a) => a.id === "file.secret_log").data.body_md === "SECRET BODY", "mail.read unlocks file body");
assert(!arts.find((a) => a.id === "mail.followup"), "delayed mail still hidden during wait");

// 3. After the delay, the follow-up mail is revealed.
const pending = timers.find((t) => !t.dead && t.ms === 25);
assert(pending, "a 25ms reveal timer was scheduled");
pending.fn();
arts = deliver([
  { id: "mail.welcome", type: "mail", data: {} },
  { id: "mail.followup", type: "mail", data: {} },
]);
assert(arts.find((a) => a.id === "mail.followup"), "delayed mail revealed after timer");
assert(JSON.parse(store.get("nori.story-reveals.v1")).includes("mail.followup"), "reveal persisted");

// 4. Compute threshold unlock.
send.call(socket, JSON.stringify({
  type: "event", channel: "idle.sync", payload: { maxComputeThisRun: 2000, computeCap: 1e9 },
}));
await new Promise((r) => setTimeout(r, 10));
arts = deliver([{ id: "file.compute_log", type: "file", data: { contentKey: "file_compute_log" } }]);
assert(arts[0].data.body_md === "COMPUTE BODY", "compute threshold unlocks file");

console.log("PASS: unified gate hides locked file + delayed mail, unlocks via mail.read, reveals after delay, compute gate works");
function assert(cond, label) {
  if (!cond) { console.error("FAIL:", label); process.exitCode = 1; throw new Error(label); }
}
