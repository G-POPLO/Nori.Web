(() => {
  "use strict";

  // Source-owned safety net for the Codenames clue-reveal overlay.
  //
  // The historical GameScreen bundle dismisses the clue reveal with a
  // setTimeout(3s) inside a React effect whose dependency list includes the
  // whole gameState object. Any state broadcast that does not grow the
  // history (e.g. the player's first guess arriving within the 3s window)
  // runs the effect cleanup, kills the pending timer, and early-returns
  // without re-arming it — the reveal overlay then covers the board
  // forever. This watchdog re-enforces the intended 3s auto-dismiss from
  // the outside so the game stays playable even if the bundle is replaced
  // by an upstream copy that still carries the bug. Once the Codenames
  // game controller is migrated into frontend-src (FRONTEND_CUTOVER.md,
  // boundary 4), the effect should depend only on the history length and
  // this script can be retired.

  const DISMISS_AFTER_MS = 3500;
  const POLL_INTERVAL_MS = 400;
  const OVERLAY_SELECTOR = "div.absolute.inset-0.z-30.pointer-events-none";
  const REVEAL_SELECTOR = "div.absolute.inset-0.flex.items-center.justify-center";
  const BOARD_SELECTOR = "[data-codenames-board]";
  const tracked = new WeakMap();

  function isClueRevealRoot(root) {
    return Boolean(root.querySelector(REVEAL_SELECTOR));
  }

  function inCodenamesContext(root) {
    let node = root.parentElement;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
      if (typeof node.querySelector === "function" && node.querySelector(BOARD_SELECTOR)) {
        return true;
      }
    }
    return false;
  }

  function stop(tracker) {
    if (tracker.timer !== null) {
      window.clearInterval(tracker.timer);
      tracker.timer = null;
    }
  }

  function scan() {
    const roots = document.querySelectorAll(OVERLAY_SELECTOR);
    for (const root of roots) {
      if (!isClueRevealRoot(root) || !inCodenamesContext(root)) continue;
      const text = root.textContent || "";
      let tracker = tracked.get(root);
      if (!tracker) {
        tracker = { lastText: text, hideAt: Date.now() + DISMISS_AFTER_MS, timer: null };
        tracked.set(root, tracker);
        root.style.display = "";
        tracker.timer = window.setInterval(() => {
          if (!root.isConnected || !isClueRevealRoot(root)) {
            stop(tracker);
            return;
          }
          if (Date.now() >= tracker.hideAt) {
            stop(tracker);
            root.style.display = "none";
          }
        }, POLL_INTERVAL_MS);
      } else if (tracker.lastText !== text) {
        // The overlay node is reused for a new clue; restart the window.
        tracker.lastText = text;
        tracker.hideAt = Date.now() + DISMISS_AFTER_MS;
        root.style.display = "";
      }
    }
  }

  if (window.__noriCodenamesOverlayWatchdog) return;
  window.__noriCodenamesOverlayWatchdog = true;

  const start = () => {
    scan();
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  };

  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
