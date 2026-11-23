(() => {
  "use strict";

  // Presentation-layer file gate for locally composed worlds.
  //
  // The composed pack ships gated files WITHOUT body_md; the real body is a
  // static asset under /gated/ with a manifest declaring which fact / compute
  // threshold unlocks it. This script hooks the Arcade WebSocket so the
  // shipped bundle never receives a locked body, and injects it only after the
  // unlock condition has been observed on the wire.
  //
  // This is NOT a security boundary: the bodies are static files any client can
  // fetch directly. It only guarantees that normal gameplay never renders a
  // locked body, including through the app's own network responses.

  const STORAGE_KEY = "nori.file-gate.v1";
  const MANIFEST_URL = "/gated/manifest.json";
  const INSTALLED = Symbol("noriFileGateInstalled");
  const seenOnSocket = new WeakSet();

  let manifest = null;              // { version, files: { key -> spec } }
  let unlocked = loadUnlocked();    // Set of contentKey
  let activeSocket = null;          // captured from the app's own send() calls
  const bodyCache = new Map();      // contentKey -> body string

  function safeParse(value) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function loadUnlocked() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return new Set(Array.isArray(raw) ? raw.filter((k) => typeof k === "string") : []);
    } catch {
      return new Set();
    }
  }

  function saveUnlocked() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...unlocked]));
    } catch {
      // Storage may be disabled; the gate still works for this page session.
    }
  }

  async function loadManifest() {
    try {
      const response = await fetch(MANIFEST_URL, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      if (data && typeof data.files === "object") {
        manifest = data.files;
        prefetchUnlocked();
      }
    } catch {
      // No manifest: gate is inactive (e.g. running the built-in archive).
    }
  }

  function specFor(key) {
    return manifest && typeof key === "string" ? manifest[key] : null;
  }

  function hasUnlockSpec(spec) {
    return Boolean(spec && (spec.recoverWhen || typeof spec.threshold === "number"));
  }

  function isUnlocked(key, spec) {
    if (unlocked.has(key)) return true;
    // A spec with no condition is decorative; treat it as open.
    return !hasUnlockSpec(spec);
  }

  function unlock(key) {
    if (!specFor(key) || unlocked.has(key)) return;
    unlocked.add(key);
    saveUnlocked();
    fetchBody(key);
  }

  async function fetchBody(key) {
    if (bodyCache.has(key)) return bodyCache.get(key);
    const spec = specFor(key);
    if (!spec || typeof spec.bodyUrl !== "string") return undefined;
    try {
      const response = await fetch(spec.bodyUrl, { cache: "no-store" });
      if (!response.ok) return undefined;
      const payload = await response.json();
      const body = typeof payload.body_md === "string" ? payload.body_md : undefined;
      if (body !== undefined) bodyCache.set(key, body);
      return body;
    } catch {
      return undefined;
    }
  }

  function prefetchUnlocked() {
    for (const key of unlocked) {
      if (specFor(key)) void fetchBody(key);
    }
  }

  function grantByFact(factId) {
    if (typeof factId !== "string" || !manifest) return;
    for (const [key, spec] of Object.entries(manifest)) {
      if (spec.recoverWhen === factId) unlock(key);
    }
  }

  function grantByCompute(maxCompute, cap) {
    if (!Number.isFinite(maxCompute) || !manifest) return;
    const reached = Number.isFinite(cap) ? Math.min(maxCompute, cap) : maxCompute;
    for (const [key, spec] of Object.entries(manifest)) {
      if (typeof spec.threshold === "number" && reached >= spec.threshold) unlock(key);
    }
  }

  // --------------------------------------------------------------------------
  // Outbound: watch for fact emissions and idle compute reports.
  // --------------------------------------------------------------------------
  function inspectOutbound(data) {
    const message = safeParse(data);
    if (!message) return;

    const payload = message.payload;
    if (!payload || typeof payload !== "object") return;

    const channel = typeof message.channel === "string" ? message.channel : "";

    // manifold.command.request wraps { command: "client.emitFact", payload: {...} }
    if (channel === "manifold.command.request" || channel === "event") {
      if (payload.command === "client.emitFact") {
        grantByFact(payload.payload && payload.payload.factId);
      }
    }

    // A bare client.emitFact event channel (used by some screens).
    if (channel === "client.emitFact") {
      grantByFact(payload.factId);
    }

    // Idle compute reports vary by build. Scan any outbound frame whose
    // channel mentions idle for the largest numeric compute-like value.
    if (channel.toLowerCase().includes("idle")) {
      const values = collectComputeValues(payload);
      if (values.length) grantByCompute(Math.max(...values), undefined);
    }
  }

  function collectComputeValues(value, out = [], depth = 0) {
    if (depth > 6 || !value || typeof value !== "object") return out;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "number" && Number.isFinite(item) && item > 0 &&
          /compute|max|peak|total/i.test(key)) {
        out.push(item);
      } else if (item && typeof item === "object") {
        collectComputeValues(item, out, depth + 1);
      }
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Inbound: rewrite manifold.artifacts.response before the bundle sees it.
  // --------------------------------------------------------------------------
  function rewriteInbound(raw) {
    if (!manifest) return raw;
    const message = safeParse(raw);
    if (!message || message.type !== "manifold.artifacts.response") return raw;
    const artifacts = message.payload && message.payload.artifacts;
    if (!Array.isArray(artifacts)) return raw;

    let changed = false;
    const next = artifacts.map((artifact) => {
      if (!artifact || artifact.type !== "file" || !artifact.data) return artifact;
      const key = artifact.data.contentKey;
      const spec = specFor(key);
      if (!spec) return artifact; // not a gated file

      if (!isUnlocked(key, spec)) {
        // Locked: strip every field that could carry the body.
        const data = { ...artifact.data };
        delete data.body_md;
        delete data.binary_asset_path;
        delete data.asset_path;
        delete data.trainlog;
        changed = true;
        return { ...artifact, data };
      }

      // Unlocked: body may already be cached from a prior fetch.
      const body = bodyCache.get(key);
      if (typeof body === "string") {
        changed = true;
        return { ...artifact, data: { ...artifact.data, body_md: body } };
      }
      // Not cached yet: kick off a fetch; a later artifacts refresh will fill it.
      void fetchBody(key).then((value) => {
        if (typeof value === "string" && unlocked.has(key)) {
          window.dispatchEvent(new CustomEvent("nori:file-gate-ready", { detail: { key } }));
        }
      });
      return artifact;
    });

    return changed ? JSON.stringify({ ...message, payload: { ...message.payload, artifacts: next } }) : raw;
  }

  function wrapMessageEvent(event) {
    if (typeof event.data !== "string") return event;
    const rewritten = rewriteInbound(event.data);
    if (rewritten === event.data) return event;
    // MessageEvent.data is read-only, so clone the event with rewritten data.
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

  function attachSocket(socket) {
    if (!socket || seenOnSocket.has(socket)) return;
    seenOnSocket.add(socket);

    // addEventListener('message', fn) — wrap the listener so it receives a
    // rewritten event. Using capture=true ensures we are installed early.
    const nativeAdd = socket.addEventListener.bind(socket);
    socket.addEventListener = function (type, listener, options) {
      if (type === "message" && typeof listener === "function") {
        const wrapped = function (event) {
          return listener.call(this, wrapMessageEvent(event));
        };
        return nativeAdd(type, wrapped, options);
      }
      return nativeAdd(type, listener, options);
    };

    // onmessage = fn — define an accessor that wraps assignments.
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
      // Non-configurable onmessage is rare; addEventListener hook still applies.
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
    Object.defineProperty(GatedWebSocket, "CONNECTING", { value: NativeWebSocket.CONNECTING });
    Object.defineProperty(GatedWebSocket, "OPEN", { value: NativeWebSocket.OPEN });
    Object.defineProperty(GatedWebSocket, "CLOSING", { value: NativeWebSocket.CLOSING });
    Object.defineProperty(GatedWebSocket, "CLOSED", { value: NativeWebSocket.CLOSED });
    Object.defineProperty(GatedWebSocket, INSTALLED, { value: true });
    window.WebSocket = GatedWebSocket;
  }

  const nativeSend = NativeWebSocket.prototype.send;
  NativeWebSocket.prototype.send = function noriFileGateSend(data) {
    try {
      activeSocket = this;
      inspectOutbound(data);
    } catch {
      // Never let gating break the app's own traffic.
    }
    return nativeSend.call(this, data);
  };

  // A newly unlocked body may arrive after the bundle already rendered the
  // locked state. Ask the app to refresh file artifacts via its own event bus.
  window.addEventListener("nori:file-gate-ready", () => {
    try {
      if (activeSocket && activeSocket.readyState === NativeWebSocket.OPEN) {
        nativeSend.call(activeSocket, JSON.stringify({
          type: "event",
          channel: "manifold.artifacts.request",
          payload: { artifactType: "file" },
          requestId: `file-gate-${Date.now()}`,
        }));
      }
    } catch {
      // Best-effort refresh only.
    }
  });

  void loadManifest();
})();
