// Headless harness for public/nori-file-gate.js.
// Mocks just enough browser surface to verify the two gate branches.
import fs from "node:fs";
import vm from "node:vm";

const code = fs.readFileSync(new URL("../public/nori-file-gate.js", import.meta.url), "utf8");

class FakeMessageEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.data = init.data;
    this.origin = init.origin || "";
    this.lastEventId = init.lastEventId || "";
    this.source = init.source || null;
    this.ports = init.ports || [];
  }
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor() {
    this.readyState = 1;
    this.onmessage = null;
    this.sent = [];
    this.listeners = [];
  }
  addEventListener(type, fn) { if (type === "message") this.listeners.push(fn); }
  send(data) { this.sent.push(String(data)); }
}
FakeWebSocket.prototype.send = function (data) { this.sent.push(String(data)); };

const store = new Map();
const manifest = {
  version: 1,
  files: {
    file_secret_log: {
      bodyUrl: "/gated/file_secret_log.json",
      recoverWhen: "recover.secret_log",
      threshold: null,
    },
    file_compute_log: {
      bodyUrl: "/gated/file_compute_log.json",
      recoverWhen: "",
      threshold: 1000,
    },
  },
};
const gatedBody = { body_md: "SECRET BODY —— 解锁后才应出现" };

const events = {};
const sandbox = {
  WebSocket: FakeWebSocket,
  MessageEvent: FakeMessageEvent,
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  fetch: async (url) => {
    if (url === "/gated/manifest.json") return { ok: true, json: async () => manifest };
    if (url === "/gated/file_secret_log.json") return { ok: true, json: async () => gatedBody };
    if (url === "/gated/file_compute_log.json") return { ok: true, json: async () => ({ body_md: "COMPUTE BODY" }) };
    return { ok: false };
  },
  localStorage: {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, v),
  },
  window: {
    WebSocket: FakeWebSocket,
    dispatchEvent: (e) => { (events[e.type] ||= []).push(e); return true; },
    addEventListener: (type, fn) => { (events[type] ||= []).push(fn); },
  },
  console,
  setTimeout,
  Symbol,
  Object,
  JSON,
  Math,
  Number,
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

// allow async manifest prefetch to settle
await new Promise((r) => setTimeout(r, 20));

function rawArtifacts(body) {
  const data = { display_path: "文稿/机密记录.txt", mime: "text/plain", contentKey: "file_secret_log", cipher: "GATED" };
  if (body !== undefined) data.body_md = body;
  return JSON.stringify({
    type: "manifold.artifacts.response",
    payload: { ok: true, artifacts: [{ id: "file.secret_log", type: "file", data }] },
  });
}

// Rebuild the patched socket to capture the wrapped message listener.
const GatedWS = sandbox.window.WebSocket;
assert(GatedWS !== FakeWebSocket, "WebSocket constructor should be wrapped");

const socket = new GatedWS("/ws");
let received = null;
socket.addEventListener("message", (event) => { received = event.data; });
assert(socket.listeners.length === 1, "wrapped socket should register the listener");

// --- Branch 1: locked file body is stripped even if the server sent one ---
const lockedEvent = new FakeMessageEvent("message", { data: rawArtifacts("LEAKED BODY") });
socket.listeners[0](lockedEvent);
let msg = JSON.parse(received);
let art = msg.payload.artifacts[0];
assert(art.data.body_md === undefined, "locked file must have body_md stripped");
assert(art.data.contentKey === "file_secret_log", "locked file keeps contentKey");

// --- Branch 2: emitting the unlock fact unlocks the file ---
const GatedWSProto = GatedWS.prototype;
const sendFn = GatedWSProto.send;
sendFn.call(socket, JSON.stringify({
  type: "event",
  channel: "manifold.command.request",
  payload: { command: "client.emitFact", payload: { factId: "recover.secret_log" } },
}));
await new Promise((r) => setTimeout(r, 20));

const unlockedEvent = new FakeMessageEvent("message", { data: rawArtifacts(undefined) });
socket.listeners[0](unlockedEvent);
msg = JSON.parse(received);
art = msg.payload.artifacts[0];
assert(art.data.body_md === "SECRET BODY —— 解锁后才应出现", "unlocked file body should be injected");
assert(JSON.parse(store.get("nori.file-gate.v1")).includes("file_secret_log"), "unlock persisted to storage");

// --- Branch 3: compute threshold unlock via idle.sync ---
sendFn.call(socket, JSON.stringify({
  type: "event",
  channel: "idle.sync",
  payload: { maxComputeThisRun: 1500, computeCap: 1e9 },
}));
await new Promise((r) => setTimeout(r, 20));
assert(JSON.parse(store.get("nori.file-gate.v1")).includes("file_compute_log"), "compute threshold should unlock");

const computeRaw = JSON.stringify({
  type: "manifold.artifacts.response",
  payload: { ok: true, artifacts: [{
    id: "file.compute_log", type: "file",
    data: { display_path: "compute.txt", contentKey: "file_compute_log" },
  }] },
});
socket.listeners[0](new FakeMessageEvent("message", { data: computeRaw }));
msg = JSON.parse(received);
assert(msg.payload.artifacts[0].data.body_md === "COMPUTE BODY", "compute-unlocked body should be injected");

console.log("PASS: gate strips locked bodies, injects after fact unlock, and unlocks by compute threshold");

function assert(cond, label) {
  if (!cond) {
    console.error("FAIL:", label);
    process.exitCode = 1;
    throw new Error(label);
  }
}
