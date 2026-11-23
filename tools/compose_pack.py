"""Compose a local live-world pack from human-editable content files.

No network access and no source archive required. Content lives in `content/`:

    content/
      meta.json              world_id, variables, facts, chip_status, cartridges
      mail/*.md              one email per file; front matter in an HTML comment
      files/**/*.md          one virtual file per file; path mirrors display_path
      signal/<thread>.json   one conversation; messages inline
      pages/*.html           one browser page; front matter in an HTML comment
      assets/**              copied to public/webAssets/**

Front matter is a JSON object inside the first HTML comment:

    <!--
    {"id": "mail.welcome", "subject": "Welcome", "from": "Nore <nore@x.io>",
     "read_fact": "mail.welcome.read"}
    -->
    Body text starts here and is everything after the comment.

For pages, the HTML file itself IS the body_html; front matter only supplies
url/title/id/aliases/read_fact/allowed_commands.

Gated files (front matter with `recover_when` or `threshold`) get their body
split out to `public/gated/<key>.json`; the pack keeps only metadata plus a
`contentKey`. The browser-side `nori-file-gate.js` injects the body back only
after the matching fact or compute threshold is reached. This is a
presentation-layer lock — the gated bodies are still served as static files.

Run:

    python tools/compose_pack.py            # build -> backend/data/live_world_pack.json
    python tools/compose_pack.py --check    # validate only, do not write
    python tools/compose_pack.py --out X    # write to a custom path
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content"
DEFAULT_PACK = ROOT / "backend" / "data" / "live_world_pack.json"
PUBLIC_ASSETS = ROOT / "public" / "webAssets"
GATED_DIR = ROOT / "public" / "gated"

FRONT_MATTER_RE = re.compile(r"^\s*<!--\s*(\{.*?\})\s*-->\s*\n?", re.S)

# Module-level accumulators reset on every build. Gated bodies are written to
# public/gated/ next to the pack; the manifest tells the browser gate which
# fact / compute threshold unlocks each body and how to fetch it.
_GATED_BODIES: dict[str, str] = {}
_GATED_MANIFEST: dict[str, Any] = {}


def safe_gate_key(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", value).strip("._") or "gated"


def warn(msg: str) -> None:
    print(f"[warn] {msg}", file=sys.stderr)


def read_with_meta(path: Path) -> tuple[dict[str, Any], str]:
    text = path.read_text(encoding="utf-8")
    meta: dict[str, Any] = {}
    match = FRONT_MATTER_RE.match(text)
    if match:
        try:
            meta = json.loads(match.group(1))
        except json.JSONDecodeError as exc:
            raise ValueError(f"{path}: invalid front matter JSON: {exc}") from exc
        text = text[match.end():]
    elif path.suffix.lower() == ".html":
        warn(f"{path.name}: no front matter comment; using filename as URL")
    return meta, text.strip() + "\n"


def now_ms() -> int:
    return int(time.time() * 1000)


def load_meta() -> dict[str, Any]:
    path = CONTENT / "meta.json"
    if not path.is_file():
        warn("content/meta.json missing; using minimal defaults")
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def build_mail() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for path in sorted((CONTENT / "mail").glob("*.md")):
        meta, body = read_with_meta(path)
        stem = path.stem
        item_id = meta.get("id", f"mail.{stem}")
        out.append({
            "id": item_id,
            "type": "mail",
            "data": {
                "read_fact": meta.get("read_fact", f"{item_id}.read"),
                "subject": meta.get("subject", stem),
                "from": meta.get("from", ""),
                "body_md": body,
            },
            "surfacedAt": meta.get("surfacedAt", now_ms()),
        })
    return out


def build_files() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    root = CONTENT / "files"
    if not root.exists():
        return out
    for path in sorted(root.rglob("*.md")):
        meta, body = read_with_meta(path)
        rel = path.relative_to(root).as_posix()[:-3]  # strip .md
        display_path = meta.get("display_path", rel)
        folder = meta.get("folder") or (display_path.split("/")[0] if "/" in display_path else "")
        item_id = meta.get("id", f"file.{path.stem}")
        data: dict[str, Any] = {
            "display_path": display_path,
            "mime": meta.get("mime", "text/plain"),
            "folder": folder,
            "modified_at": meta.get("modified_at", time.strftime("%Y-%m-%dT%H:%M:%S")),
        }

        # A file is gated when the author declares either a recovery fact or a
        # compute threshold. Its body is removed from the pack and served from
        # public/gated/ only after the browser gate unlocks it.
        gate_fact = meta.get("recover_when") if isinstance(meta.get("recover_when"), str) else ""
        gate_threshold = meta.get("threshold") if isinstance(meta.get("threshold"), (int, float)) else None
        if gate_fact or gate_threshold is not None:
            key = safe_gate_key(meta.get("gate_key") or item_id)
            _GATED_BODIES[key] = body
            _GATED_MANIFEST[key] = {
                "bodyUrl": f"/gated/{key}.json",
                "recoverWhen": gate_fact,
                "threshold": gate_threshold,
            }
            data["contentKey"] = key
            data["cipher"] = meta.get("cipher", "GATED")
            if gate_fact:
                data["recover_when"] = gate_fact
            if gate_threshold is not None:
                data["threshold"] = gate_threshold
        else:
            data["body_md"] = body

        out.append({
            "id": item_id,
            "type": "file",
            "data": data,
            "surfacedAt": meta.get("surfacedAt", now_ms()),
        })
    return out


def build_signal() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    threads: list[dict[str, Any]] = []
    messages: list[dict[str, Any]] = []
    root = CONTENT / "signal"
    if not root.exists():
        return threads, messages
    for path in sorted(root.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        thread_id = data.get("thread_id", path.stem)
        tid = f"signal.{thread_id}"
        surfaced = data.get("surfacedAt", now_ms())
        threads.append({
            "id": tid,
            "type": "signal_thread",
            "data": {
                "thread_id": thread_id,
                "title": data.get("title", thread_id),
                "participants": data.get("participants", []),
                "avatar_path": data.get("avatar_path", ""),
                "unread_from": data.get("unread_from", ""),
                "read_fact": data.get("read_fact", f"{tid}.read"),
                "reread": data.get("reread", {}),
                "service": data.get("service", True),
            },
            "surfacedAt": surfaced,
        })
        for index, msg in enumerate(data.get("messages", []), start=1):
            message_id = msg.get("message_id", f"m{index:02d}")
            messages.append({
                "id": f"{tid}.{message_id}",
                "type": "signal_message",
                "data": {
                    "thread_id": thread_id,
                    "message_id": message_id,
                    "sender": msg.get("sender", ""),
                    "kind": msg.get("kind", "text"),
                    "timestamp": msg.get("timestamp", ""),
                    "body_md": msg.get("body_md", "").strip() + "\n",
                },
                "surfacedAt": surfaced,
            })
    return threads, messages


def canonical_url(url: str) -> str:
    from urllib.parse import urlsplit
    u = (url or "").split("#")[0].strip()
    parts = urlsplit(u)
    if not parts.netloc:
        return u.lower()
    path = re.sub(r"/{2,}", "/", parts.path)
    query = f"?{parts.query}" if parts.query else ""
    return f"{parts.scheme}://{parts.netloc.lower()}{path}{query}"


def build_pages() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    root = CONTENT / "pages"
    if not root.exists():
        return out
    for path in sorted(root.glob("*.html")):
        meta, _ = read_with_meta(path)
        url = meta.get("url", f"https://localhost/{path.stem}/")
        key = canonical_url(url)
        aliases = sorted({canonical_url(a) for a in meta.get("aliases", [])} | {key})
        out.append({
            "key": key,
            "id": meta.get("id", f"browser.{path.stem}"),
            "data": {
                "url": url,
                "supported_locales": meta.get("supported_locales", ["zh-CN"]),
                "title": meta.get("title", path.stem),
                "body_html": path.read_text(encoding="utf-8"),
                "allowed_commands": meta.get("allowed_commands", ["client.emitFact"]),
                "read_fact": meta.get("read_fact", ""),
            },
            "aliases": [a for a in aliases if a],
        })
    return out


def copy_assets() -> int:
    src = CONTENT / "assets"
    if not src.exists():
        return 0
    count = 0
    for path in src.rglob("*"):
        if not path.is_file():
            continue
        dst = PUBLIC_ASSETS / path.relative_to(src)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, dst)
        count += 1
    return count


def build_pack() -> dict[str, Any]:
    global _GATED_BODIES, _GATED_MANIFEST
    _GATED_BODIES = {}
    _GATED_MANIFEST = {}
    meta = load_meta()
    threads, messages = build_signal()
    pack = {
        "_meta": {
            "source": "locally composed content (tools/compose_pack.py)",
            "imported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "world_id": meta.get("world_id", "wi_local_composed"),
        },
        "mail_artifacts": build_mail(),
        "file_artifacts": build_files(),
        "signal_thread_artifacts": threads,
        "signal_message_artifacts": messages,
        "browser_pages": build_pages(),
        "facts": meta.get("facts", {}),
        "variables": meta.get("variables", {}),
        "world_id": meta.get("world_id", "wi_local_composed"),
        "mounted_cartridges": meta.get("mounted_cartridges", ["chat", "manifold.web"]),
        "chip_status": meta.get("chip_status", {"capacity": 5, "heat": 0, "coolEveryMs": 300000}),
    }
    return pack


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate only, do not write")
    parser.add_argument("--out", type=Path, default=DEFAULT_PACK, help="output pack path")
    args = parser.parse_args()

    if not CONTENT.is_dir():
        print(f"error: content directory not found: {CONTENT}", file=sys.stderr)
        return 1

    pack = build_pack()
    summary = (
        f"composed: mails={len(pack['mail_artifacts'])} "
        f"files={len(pack['file_artifacts'])} "
        f"threads={len(pack['signal_thread_artifacts'])} "
        f"messages={len(pack['signal_message_artifacts'])} "
        f"pages={len(pack['browser_pages'])} "
        f"facts={len(pack['facts'])}"
    )
    print(summary)

    if args.check:
        print("check passed; nothing written")
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(pack, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    size_mb = args.out.stat().st_size / 1024 / 1024
    print(f"pack written: {args.out} ({size_mb:.3f} MB)")

    # Gated bodies + manifest: static assets the browser gate fetches on unlock.
    if _GATED_MANIFEST:
        GATED_DIR.mkdir(parents=True, exist_ok=True)
        for key, body in _GATED_BODIES.items():
            (GATED_DIR / f"{key}.json").write_text(
                json.dumps({"body_md": body}, ensure_ascii=False), encoding="utf-8"
            )
        (GATED_DIR / "manifest.json").write_text(
            json.dumps({"version": 1, "files": _GATED_MANIFEST}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"gated bodies written: {len(_GATED_BODIES)} -> {GATED_DIR}")

    copied = copy_assets()
    if copied:
        print(f"assets copied to {PUBLIC_ASSETS}: {copied}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
