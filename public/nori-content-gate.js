(() => {
  "use strict";

  // Unified presentation-layer content gate for locally composed worlds.
  //
  // One WebSocket hook handles both concerns that used to be two scripts:
  //   1. file gate  - gated file bodies live in /gated/*.json and are injected
  //                  into the artifact stream only after their unlock trigger.
  //   2. story reveal - reveal-gated mails are hidden until a read/fact trigger
  //                  fires plus an optional delay.
  //
  // Both manifests are loaded SYNCHRONOUSLY at script-eval time (tiny local
  // JSON files). This removes the race where the app requested artifacts
  // before an async fetch() had populated the gate tables. A single hook also
  // avoids the double-wrap conflict that silently dropped one script's logic.
  //
  // Not a security boundary: gated bodies are static files. This only ensures
  // normal gameplay never renders locked content, including via the app's own
  // network responses.

  const FILE_STORAGE = "nori.file-gate.v1";
  const STORY_STORAGE = "nori.story-reveals.v1";
  const GATE_MANIFEST_URL = "/gated/manifest.json";
  const STORY_MANIFEST_URL = "/gated/story-manifest.json";
  const INSTALLED = Symbol("noriContentGateInstalled");

  let fileManifest = null;   // { key -> {bodyUrl, recoverWhen, threshold} }
  let storyReveals = null;   // { artifactId -> {kind, trigger, delayMs} }
  let unlockedFiles = loadSet(FILE_STORAGE);
  let revealedItems = loadSet(STORY_STORAGE);
  const bodyCache = new Map();
  const timers = new Map();
  let activeSocket = null;

  function safeParse(value) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function loadSet(key) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "[]");
      return new Set(Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  }

  function saveSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* optional */ }
  }

  // Synchronous fetch of a tiny local manifest. Returns null on any failure.
  function loadJsonSync(url) {
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false); // synchronous
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) return safeParse(xhr.responseText);
    } catch { /* ignore */ }
    return null;
  }

  const gateDoc = loadJsonSync(GATE_MANIFEST_URL);
  if (gateDoc && typeof gateDoc.files === "object") fileManifest = gateDoc.files;
  const storyDoc = loadJsonSync(STORY_MANIFEST_URL);
  if (storyDoc && typeof storyDoc.reveals === "object") {
    storyReveals = storyDoc.reveals;
    for (const [id, spec] of Object.entries(storyReveals)) {
      if (spec && typeof spec === "object") spec.__id = id;
    }
  }

  // ------------------------------------------------------------------------
  // File gate
  // ------------------------------------------------------------------------
  function fileSpec(key) {
    return fileManifest && typeof key === "string" ? fileManifest[key] : null;
  }

  function hasUnlockSpec(spec) {
    return Boolean(spec && (spec.recoverWhen || typeof spec.threshold === "number"));
  }

  function isFileUnlocked(key, spec) {
    if (unlockedFiles.has(key)) return true;
    return !hasUnlockSpec(spec);
  }

  function fetchBody(key) {
    if (bodyCache.has(key)) return Promise.resolve(bodyCache.get(key));
    const spec = fileSpec(key);
    if (!spec || typeof spec.bodyUrl !== "string") return Promise.resolve(undefined);
    return fetch(spec.bodyUrl, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((payload) => {
        const body = payload && typeof payload.body_md === "string" ? payload.body_md : undefined;
        if (body !== undefined) bodyCache.set(key, body);
        return body;
      })
      .catch(() => undefined);
  }

  function unlockFile(key) {
    if (!fileSpec(key) || unlockedFiles.has(key)) return;
    unlockedFiles.add(key);
    saveSet(FILE_STORAGE, unlockedFiles);
    void fetchBody(key).then((body) => {
      if (typeof body === "string") refreshArtifacts();
    });
  }

  function prefetchUnlocked() {
    for (const key of unlockedFiles) if (fileSpec(key)) void fetchBody(key);
  }

  function grantFileByFact(factId) {
    if (typeof factId !== "string" || !fileManifest) return;
    for (const [key, spec] of Object.entries(fileManifest)) {
      if (spec.recoverWhen === factId || spec.recoverWhen === `fact:${factId}`) unlockFile(key);
    }
  }

  function grantFileByMail(mailId) {
    if (typeof mailId !== "string" || !fileManifest) return;
    const trigger = `read:${mailId}`;
    for (const [key, spec] of Object.entries(fileManifest)) {
      if (spec.recoverWhen === trigger) unlockFile(key);
    }
  }

  function grantFileByCompute(value) {
    if (!Number.isFinite(value) || !fileManifest) return;
    for (const [key, spec] of Object.entries(fileManifest)) {
      if (typeof spec.threshold === "number" && value >= spec.threshold) unlockFile(key);
    }
  }

  function collectComputeValues(value, out = [], depth = 0) {
    if (depth > 6 || !value || typeof value !== "object") return out;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "number" && Number.isFinite(item) && item > 0 && /compute|max|peak|total/i.test(key)) {
        out.push(item);
      } else if (item && typeof item === "object") {
        collectComputeValues(item, out, depth + 1);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------------
  // Story reveals
  // ------------------------------------------------------------------------
  function readTrigger(mailId) {
    if (typeof mailId !== "string" || !mailId) return "";
    return mailId.startsWith("read:") ? mailId : `read:${mailId}`;
  }

  function factTrigger(factId) {
    if (typeof factId !== "string" || !factId) return "";
    return factId.startsWith("fact:") ? factId : `fact:${factId}`;
  }

  function fireTrigger(trigger) {
    if (!storyReveals || !trigger || timers.has(trigger)) return;
    const matches = Object.values(storyReveals)
      .filter((spec) => spec && spec.trigger === trigger && !revealedItems.has(spec.__id));
    if (!matches.length) return;

    let maxDelay = 0;
    for (const spec of matches) {
      const delay = Number.isFinite(spec.delayMs) ? Math.max(0, spec.delayMs) : 0;
      if (delay > maxDelay) maxDelay = delay;
    }

    const commit = () => {
      timers.delete(trigger);
      let changed = false;
      for (const spec of matches) {
        if (!revealedItems.has(spec.__id)) {
          revealedItems.add(spec.__id);
          changed = true;
        }
      }
      if (changed) {
        saveSet(STORY_STORAGE, revealedItems);
        refreshArtifacts();
      }
    };

    if (maxDelay > 0) timers.set(trigger, setTimeout(commit, maxDelay));
    else commit();
  }

  // ------------------------------------------------------------------------
  // Outbound inspection
  // ------------------------------------------------------------------------
  function inspectOutbound(data) {
    const message = safeParse(data);
    if (!message) return;
    const payload = message.payload;
    if (!payload || typeof payload !== "object") return;
    const channel = typeof message.channel === "string" ? message.channel : "";
    const inner = payload.payload && typeof payload.payload === "object" ? payload.payload : payload;

    if (channel === "manifold.command.request" || channel === "event") {
      const command = payload.command;
      if (command === "client.emitFact") {
        const factId = inner.factId;
        grantFileByFact(factId);
        fireTrigger(factTrigger(factId));
      }
      if (command === "mail.read" || command === "mail.markRead" || command === "mark_mail_read") {
        const mailId = inner.mailId || inner.id;
        grantFileByMail(mailId);
        fireTrigger(readTrigger(mailId));
      }
    }

    if (channel === "client.emitFact") {
      grantFileByFact(payload.factId);
      fireTrigger(factTrigger(payload.factId));
    }

    if (channel.toLowerCase().includes("idle")) {
      const values = collectComputeValues(payload);
      if (values.length) grantFileByCompute(Math.max(...values));
    }
  }

  // ------------------------------------------------------------------------
  // Inbound rewrite
  // ------------------------------------------------------------------------
  function rewriteInbound(raw) {
    const message = safeParse(raw);
    if (!message || message.type !== "manifold.artifacts.response") return raw;
    const artifacts = message.payload && message.payload.artifacts;
    if (!Array.isArray(artifacts)) return raw;

    let changed = false;

    // Story reveal: drop not-yet-revealed artifacts entirely.
    let visible = artifacts;
    if (storyReveals) {
      visible = artifacts.filter((artifact) => {
        if (!artifact || typeof artifact.id !== "string") return true;
        const spec = storyReveals[artifact.id];
        if (!spec) return true;
        if (revealedItems.has(artifact.id)) return true;
        changed = true;
        return false;
      });
    }

    // File gate: strip locked bodies / inject unlocked cached bodies.
    const next = visible.map((artifact) => {
      if (!artifact || artifact.type !== "file" || !artifact.data) return artifact;
      const key = artifact.data.contentKey;
      const spec = fileSpec(key);
      if (!spec) return artifact;

      if (!isFileUnlocked(key, spec)) {
        const data = { ...artifact.data };
        delete data.body_md;
        delete data.binary_asset_path;
        delete data.asset_path;
        delete data.trainlog;
        changed = true;
        return { ...artifact, data };
      }

      const body = bodyCache.get(key);
      if (typeof body === "string") {
        changed = true;
        return { ...artifact, data: { ...artifact.data, body_md: body } };
      }
      void fetchBody(key).then((value) => {
        if (typeof value === "string" && unlockedFiles.has(key)) refreshArtifacts();
      });
      return artifact;
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
        data: rewritten, origin: event.origin, lastEventId: event.lastEventId,
        source: event.source, ports: event.ports,
      });
    } catch {
      return event;
    }
  }

  function refreshArtifacts() {
    try {
      if (!activeSocket || activeSocket.readyState !== NativeWebSocket.OPEN) return;
      nativeSend.call(activeSocket, JSON.stringify({
        type: "event", channel: "manifold.artifacts.request", payload: {},
        requestId: `content-gate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      }));
    } catch { /* best-effort */ }
  }

  function attachSocket(socket) {
    if (!socket || socket.__noriContentGateAttached) return;
    socket.__noriContentGateAttached = true;
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
        configurable: true, enumerable: true,
        get() { return handler; },
        set(value) {
          handler = typeof value === "function"
            ? function (event) { return value.call(this, wrapMessageEvent(event)); }
            : value;
        },
      });
    } catch { /* addEventListener hook is enough */ }
  }

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === "function" && !NativeWebSocket[INSTALLED]) {
    function GatedWebSocket(url, protocols) {
      const socket = protocols === undefined
        ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
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
  NativeWebSocket.prototype.send = function noriContentGateSend(data) {
    try { activeSocket = this; inspectOutbound(data); } catch { /* never break app traffic */ }
    return nativeSend.call(this, data);
  };

  prefetchUnlocked();
})();
