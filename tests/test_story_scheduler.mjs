// Headless harness for public/nori-story-scheduler.js.
import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync(new URL("../public/nori-story-scheduler.js", import.meta.url), "utf8");

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
const reveals = {
  "mail.followup": { kind: "mail", trigger: "read:mail.welcome", delayMs: 30 },
};

// controllable timers
const scheduled = [];
const sandbox = {
  WebSocket: FakeWebSocket,
  MessageEvent: FakeMessageEvent,
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i?.detail; } },
  fetch: async (url) => url.includes("story-manifest")
    ? { ok: true, json: async () => ({ version: 1, reveals }) }
    : { ok: false },
  localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
  window: {
    WebSocket: FakeWebSocket,
    dispatchEvent() { return true; },
    addEventListener() {},
  },
  console, Symbol, Object, JSON, Math, Number,
  setTimeout: (fn, ms) => { const id = scheduled.push({ fn, ms }) - 1; return id; },
  clearTimeout: (id) => { scheduled[id] = null; },
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

await new Promise((r) => setTimeout(r, 20));
const S = sandbox.window.WebSocket;
const socket = new S("/ws");
let received = null;
socket.addEventListener("message", (e) => { received = e.data; });

function artifactsPayload() {
  return JSON.stringify({
    type: "manifold.artifacts.response",
    payload: { ok: true, artifacts: [
      { id: "mail.welcome", type: "mail", data: { subject: "welcome" } },
      { id: "mail.followup", type: "mail", data: { subject: "followup" } },
    ] },
  });
}

function deliver() {
  socket.listeners[0](new FakeMessageEvent("message", { data: artifactsPayload() }));
  return JSON.parse(received).payload.artifacts.map((a) => a.id);
}

// Branch 1: before trigger, the delayed mail is hidden.
let ids = deliver();
assert(!ids.includes("mail.followup"), "delayed mail hidden before trigger");
assert(ids.includes("mail.welcome"), "non-scheduled mail still visible");

// Branch 2: read the welcome mail -> schedules a 30ms timer, nothing revealed yet.
socket.send(JSON.stringify({
  type: "event", channel: "manifold.command.request",
  payload: { command: "mail.read", payload: { mailId: "mail.welcome" } },
}));
ids = deliver();
assert(!ids.includes("mail.followup"), "delayed mail still hidden during the wait");
assert(scheduled.length === 1, "one timer scheduled after read trigger");

// Branch 3: fire the timer -> mail appears and is persisted.
scheduled[0].fn();
ids = deliver();
assert(ids.includes("mail.followup"), "delayed mail revealed after timer");
assert(JSON.parse(store.get("nori.story-reveals.v1")).includes("mail.followup"), "reveal persisted");

console.log("PASS: scheduler hides delayed mail, reveals after read trigger + delay");
function assert(cond, label) {
  if (!cond) { console.error("FAIL:", label); process.exitCode = 1; throw new Error(label); }
}
