(() => {
  "use strict";

  // Story scheduler: reveal delayed content (e.g. a follow-up email) after a
  // trigger event such as reading an earlier email, plus an optional delay.
  //
  // Content is authored in `content/mail/*.md` with front matter:
  //   "reveal_after": "read:mail.welcome"   (or "fact:some.fact.id")
  //   "reveal_delay_ms": 8000
  // The compose tool writes public/gated/story-manifest.json. This script
  // hides those artifacts from the bundle until the trigger is observed on
  // the wire and the delay elapses, then refreshes the app's artifact list.
  //
  // Presentation-layer only: this times the *reveal*, it is not a security
  // boundary. The authored content is still present in the pack.

  const STORAGE_KEY = "nori.story-reveals.v1";
  const MANIFEST_URL = "/gated/story-manifest.json";
  const INSTALLED = Symbol("noriStorySchedulerInstalled");

  let reveals = null;               // { [artifactId]: {kind, trigger, delayMs} }
  let revealed = loadRevealed();    // Set of artifactId that are now visible
  const timers = new Map();         // trigger -> timeout id (dedupe)
  let activeSocket = null;

  function safeParse(value) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function loadRevealed() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  }

  function saveRevealed() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...revealed]));
    } catch {
      // storage optional
    }
  }

  async function loadManifest() {
    try {
      const response = await fetch(MANIFEST_URL, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      if (data && typeof data.reveals === "object") {
        reveals = data.reveals;
      }
    } catch {
      // No manifest: scheduler inactive (e.g. built-in archive).
    }
  }

  // Trigger normalization: mailId may arrive with or without a prefix.
  function readTrigger(mailId) {
    if (typeof mailId !== "string" || !mailId) return "";
    if (mailId.startsWith("read:")) return mailId;
    return `read:${mailId}`;
  }

  function factTrigger(factId) {
    if (typeof factId !== "string" || !factId) return "";
    if (factId.startsWith("fact:")) return factId;
    return `fact:${factId}`;
  }

  function fireTrigger(trigger) {
    if (!reveals || !trigger) return;
    // Avoid scheduling the same trigger twice (mail.read can be repeated).
    if (timers.has(trigger)) return;

    const matches = Object.entries(reveals)
      .filter(([, spec]) => spec && spec.trigger === trigger && !revealed.has(keyOf(spec)));
    if (!matches.length) return;

    let maxDelay = 0;
    for (const [artifactId, spec] of matches) {
      const delay = Number.isFinite(spec.delayMs) ? Math.max(0, spec.delayMs) : 0;
      if (delay > maxDelay) maxDelay = delay;
    }

    const commit = () => {
      timers.delete(trigger);
      let changed = false;
      for (const [artifactId, spec] of matches) {
        if (!revealed.has(artifactId)) {
          revealed.add(artifactId);
          changed = true;
        }
      }
      if (changed) {
        saveRevealed();
        refreshArtifacts();
      }
    };

    if (maxDelay > 0) {
      timers.set(trigger, setTimeout(commit, maxDelay));
    } else {
      commit();
    }
  }

  function keyOf(spec) {
    return spec && typeof spec.__id === "string" ? spec.__id : "";
  }

  // Patch reveals with their own artifact id so matching is unambiguous.
  function annotateReveals() {
    if (!reveals) return;
    for (const [id, spec] of Object.entries(reveals)) {
      if (spec && typeof spec === "object") spec.__id = id;
    }
  }

  function inspectOutbound(data) {
    const message = safeParse(data);
    if (!message) return;
    const payload = message.payload;
    if (!payload || typeof payload !== "object") return;
    const channel = typeof message.channel === "string" ? message.channel : "";

    // Shipped bundle marks a mail read via manifold.command.request {command:"mail.read", payload:{mailId}}
    if (channel === "manifold.command.request" || channel === "event") {
      if (payload.command === "mail.read" || payload.command === "mail.markRead" || payload.command === "mark_mail_read") {
        const mailId = (payload.payload && (payload.payload.mailId || payload.payload.id)) || "";
        fireTrigger(readTrigger(mailId));
      }
      if (payload.command === "client.emitFact") {
        const factId = payload.payload && payload.payload.factId;
        fireTrigger(factTrigger(factId));
      }
    }

    if (channel === "client.emitFact") {
      fireTrigger(factTrigger(payload.factId));
    }
  }

  function rewriteInbound(raw) {
    if (!reveals) return raw;
    const message = safeParse(raw);
    if (!message || message.type !== "manifold.artifacts.response") return raw;
    const artifacts = message.payload && message.payload.artifacts;
    if (!Array.isArray(artifacts)) return raw;

    let changed = false;
    const next = artifacts.filter((artifact) => {
      if (!artifact || typeof artifact.id !== "string") return true;
      const spec = reveals[artifact.id];
      if (!spec) return true; // not a scheduled artifact
      if (revealed.has(artifact.id)) return true; // already revealed
      changed = true; // hide until trigger + delay
      return false;
    });
    return changed
      ? JSON.stringify({ ...message, payload: { ...message.payload, artifacts: next } })
      : raw;
  }

  function wrapMessageEvent(event) {
    if (typeof event.data !== "string") return event;
    const rewritten = rewriteInbound(event.data);
    if (rewritten === event.data) return event;
    try {
      return new MessageEvent("message", {
        data: rewritten,
        origin: event.origin,
        lastEventId: event.lastEventId,
        source: event.source,
        ports: event.ports,
      });
    } catch {
      return event;
    }
  }

  function refreshArtifacts() {
    try {
      if (!activeSocket || activeSocket.readyState !== NativeWebSocket.OPEN) return;
      const requestId = `story-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      nativeSend.call(activeSocket, JSON.stringify({
        type: "event",
        channel: "manifold.artifacts.request",
        payload: {},
        requestId,
      }));
    } catch {
      // best-effort
    }
  }

  function attachSocket(socket) {
    if (!socket || socket.__noriStoryAttached) return;
    socket.__noriStoryAttached = true;
    const nativeAdd = socket.addEventListener.bind(socket);
    socket.addEventListener = function (type, listener, options) {
      if (type === "message" && typeof listener === "function") {
        const wrapped = function (event) { return listener.call(this, wrapMessageEvent(event)); };
        return nativeAdd(type, wrapped, options);
      }
      return nativeAdd(type, listener, options);
    };
    try {
      let handler = socket.onmessage;
      Object.defineProperty(socket, "onmessage", {
        configurable: true,
        enumerable: true,
        get() { return handler; },
        set(value) {
          handler = typeof value === "function"
            ? function (event) { return value.call(this, wrapMessageEvent(event)); }
            : value;
        },
      });
    } catch {
      // addEventListener hook is enough
    }
  }

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === "function" && !NativeWebSocket[INSTALLED]) {
    function GatedWebSocket(url, protocols) {
      const socket = protocols === undefined
        ? new NativeWebSocket(url)
        : new NativeWebSocket(url, protocols);
      attachSocket(socket);
      return socket;
    }
    GatedWebSocket.prototype = NativeWebSocket.prototype;
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      Object.defineProperty(GatedWebSocket, name, { value: NativeWebSocket[name] });
    }
    Object.defineProperty(GatedWebSocket, INSTALLED, { value: true });
    window.WebSocket = GatedWebSocket;
  }

  const nativeSend = NativeWebSocket.prototype.send;
  NativeWebSocket.prototype.send = function noriStorySend(data) {
    try {
      activeSocket = this;
      inspectOutbound(data);
    } catch {
      // never break app traffic
    }
    return nativeSend.call(this, data);
  };

  void loadManifest().then(annotateReveals);
})();
