#!/usr/bin/env python3
"""Trellis compaction documentation sync hook (`Stop` and `PreCompact`).

Registered on:
- Antigravity (`Stop`): checks transcript token watermark before auto-compaction
  and returns `{"decision": "continue", "reason": ...}` once when unsaved turns
  exist (`continuationActive` prevents loops).
- Claude Code (`Stop` + `PreCompact`):
  - `Stop`: returns `{"decision": "block", "reason": ...}` once when context
    crosses the watermark (`stop_hook_active` prevents loops).
  - `PreCompact`: records a non-blocking snapshot marker so the post-compaction
    `SessionStart(compact)` / `UserPromptSubmit` hook can prompt verification
    and point at `transcript_path` / `trellis mem`.
"""
from __future__ import annotations

import json
import os
import queue
import re
import sys
import threading
from pathlib import Path

if sys.platform.startswith("win"):
    import io as _io

    for _stream_name in ("stdin", "stdout", "stderr"):
        _stream = getattr(sys, _stream_name, None)
        if _stream is None:
            continue
        if hasattr(_stream, "reconfigure"):
            try:
                _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
            except Exception:
                pass  # Optional Windows stream setup; keep hook startup non-fatal.
        elif hasattr(_stream, "detach"):
            try:
                setattr(
                    sys,
                    _stream_name,
                    _io.TextIOWrapper(
                        _stream.detach(), encoding="utf-8", errors="replace"
                    ),
                )
            except Exception:
                pass  # Optional Windows stream setup; keep hook startup non-fatal.


def _should_skip() -> bool:
    if os.environ.get("TRELLIS_HOOKS") == "0":
        return True
    if os.environ.get("TRELLIS_DISABLE_HOOKS") == "1":
        return True
    non_interactive_vars = (
        "CLAUDE_NON_INTERACTIVE",
        "ANTIGRAVITY_NON_INTERACTIVE",
        "QODER_NON_INTERACTIVE",
        "CODEBUDDY_NON_INTERACTIVE",
        "FACTORY_NON_INTERACTIVE",
        "CURSOR_NON_INTERACTIVE",
        "GEMINI_NON_INTERACTIVE",
        "KIRO_NON_INTERACTIVE",
        "COPILOT_NON_INTERACTIVE",
        "TRAE_NON_INTERACTIVE",
        "ZCODE_NON_INTERACTIVE",
    )
    return any(os.environ.get(var) == "1" for var in non_interactive_vars)


def _normalize_windows_shell_path(path_str: str) -> str:
    if not isinstance(path_str, str) or not path_str:
        return path_str
    if not sys.platform.startswith("win"):
        return path_str
    p = path_str.strip()
    if re.match(r"^[A-Za-z]:[\\/]", p):
        return p
    for pattern in (
        r"^/([A-Za-z])/(.*)",
        r"^/cygdrive/([A-Za-z])/(.*)",
        r"^/mnt/([A-Za-z])/(.*)",
    ):
        m = re.match(pattern, p)
        if m:
            drive, rest = m.group(1).upper(), m.group(2).replace("/", "\\")
            return f"{drive}:\\{rest}"
    return path_str


def _is_antigravity_payload(input_data: dict) -> bool:
    return (
        isinstance(input_data.get("workspacePaths"), list)
        or isinstance(input_data.get("artifactDirectoryPath"), str)
        or isinstance(input_data.get("terminationReason"), str)
        or "continuationActive" in input_data
    )


def _detect_platform(input_data: dict) -> str | None:
    if _is_antigravity_payload(input_data):
        return "antigravity"
    if os.environ.get("CLAUDE_PROJECT_DIR"):
        return "claude"
    script_parts = set(Path(sys.argv[0]).parts)
    if ".agent" in script_parts or ".agents" in script_parts:
        return "antigravity"
    if ".claude" in script_parts:
        return "claude"
    return None


def _find_trellis_root(start: Path) -> Path | None:
    try:
        cur = start.resolve()
    except OSError:
        return None
    while True:
        if (cur / ".trellis").is_dir():
            return cur
        if cur == cur.parent:
            return None
        cur = cur.parent


def _resolve_repo_root(input_data: dict) -> Path | None:
    candidates: list[str] = []
    env_dir = os.environ.get("CLAUDE_PROJECT_DIR")
    if env_dir:
        candidates.append(env_dir)
    cwd_val = input_data.get("cwd")
    if isinstance(cwd_val, str) and cwd_val.strip():
        candidates.append(cwd_val)
    ws_paths = input_data.get("workspacePaths")
    if isinstance(ws_paths, list):
        for ws in ws_paths:
            if isinstance(ws, str) and ws.strip():
                candidates.append(ws)
    candidates.append(os.getcwd())

    for candidate in candidates:
        found = _find_trellis_root(Path(_normalize_windows_shell_path(candidate)))
        if found is not None:
            return found
    return None


def _load_hook_input() -> dict:
    result_queue: "queue.Queue[str | Exception]" = queue.Queue(maxsize=1)

    def _read() -> None:
        try:
            result_queue.put(sys.stdin.read())
        except Exception as exc:
            result_queue.put(exc)

    reader = threading.Thread(target=_read, daemon=True)
    reader.start()
    try:
        raw = result_queue.get(timeout=0.2)
    except queue.Empty:
        return {}

    if isinstance(raw, Exception):
        return {}
    try:
        data = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _emit_noop(platform: str | None) -> int:
    if platform == "antigravity":
        print("{}", flush=True)
    return 0


def main() -> int:
    data = _load_hook_input()
    platform = _detect_platform(data)

    if _should_skip():
        return _emit_noop(platform)

    root = _resolve_repo_root(data)
    if root is None:
        return _emit_noop(platform)

    event_name = str(
        data.get("hookEventName") or data.get("hook_event_name") or ""
    ).strip()

    scripts_dir = root / ".trellis" / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))

    try:
        from common.compaction_sync import (  # type: ignore[import-not-found]
            evaluate_stop_watermark,
            record_pre_compact,
        )
    except Exception:
        return _emit_noop(platform)  # Fail open if project scripts predate compaction_sync.

    if event_name == "PreCompact":
        try:
            record_pre_compact(root, data, platform or "claude")
        except Exception:
            return 0  # Fail open; never block compaction on hook errors.
        return 0

    # Default / Stop event handling
    if platform == "antigravity":
        if bool(data.get("continuationActive")):
            return _emit_noop(platform)
        term_reason = str(data.get("terminationReason") or "").strip().upper()
        if term_reason and term_reason != "NO_TOOL_CALL":
            return _emit_noop(platform)
    else:
        if bool(data.get("stop_hook_active")):
            return 0

    try:
        reason = evaluate_stop_watermark(root, data, platform)
    except Exception:
        return _emit_noop(platform)  # Fail open on transcript parse/state errors.

    if not reason:
        return _emit_noop(platform)

    if platform == "antigravity":
        print(
            json.dumps(
                {"decision": "continue", "reason": reason},
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0

    print(
        json.dumps(
            {"decision": "block", "reason": reason},
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
