#!/usr/bin/env python3
"""Proactive documentation sync checks around context compaction.

Supports two complementary, non-blocking layers across Antigravity (AGY) and
Claude Code:
1. Pre-compaction high-watermark check (`Stop` hook): nudges the live agent once
   when active context tokens cross `watermark_tokens` and recent turns contain
   unsaved work, while full conversation memory is still in context.
2. Post-compaction check (`PreCompact` + `SessionStart: compact` on Claude Code;
   `PreInvocation` compaction-boundary detector on Antigravity): injects a
   one-shot verification prompt pointing at the on-disk transcript so any detail
   summarized away can still be recovered and persisted.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .active_task import resolve_active_task, resolve_context_key
from .io import read_json, write_json
from .trellis_config import read_trellis_config

DIR_COMPACTION_SYNC = "compaction-sync"
TAIL_READ_BYTES = 524_288  # 512 KB tail window keeps hook latency <10ms on large logs

DEFAULT_WATERMARK_TOKENS = 120_000
DEFAULT_COOLDOWN_TOKENS = 50_000
DEFAULT_MIN_TURNS_SINCE_DOC_WRITE = 2

_TRUTHY = {"true", "yes", "1", "on"}
_FALSY = {"false", "no", "0", "off"}
_SAFE_KEY_RE = re.compile(r"[^A-Za-z0-9._-]+")

_AGY_COMPACT_STEP_TYPES = {
    "CHECKPOINT",
    "COMPACTION",
    "CONVERSATION_SUMMARY",
    "CONTEXT_COMPACTION",
}
_AGY_WRITE_TOOLS = {
    "write_file",
    "edit_file",
    "replace_file_content",
    "multi_replace_file_content",
}
_CLAUDE_WRITE_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}


@dataclass(frozen=True)
class CompactionSyncConfig:
    """Resolved project configuration from `.trellis/config.yaml`."""

    enabled: bool = True
    watermark_tokens: int = DEFAULT_WATERMARK_TOKENS
    cooldown_tokens: int = DEFAULT_COOLDOWN_TOKENS
    min_turns_since_doc_write: int = DEFAULT_MIN_TURNS_SINCE_DOC_WRITE


@dataclass(frozen=True)
class TranscriptSnapshot:
    """Bounded summary of the active conversation segment from transcript JSONL."""

    context_tokens: int = 0
    checkpoint_marker: str | None = None
    turns_since_doc_write: int = 0
    user_turns_in_segment: int = 0
    has_substantive_activity: bool = False
    transcript_path: str | None = None


def _parse_bool(raw: Any, default: bool) -> bool:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    if isinstance(raw, str):
        norm = raw.strip().lower()
        if norm in _TRUTHY:
            return True
        if norm in _FALSY:
            return False
    return default


def _parse_non_negative_int(raw: Any, default: int) -> int:
    if isinstance(raw, bool):
        return default
    if isinstance(raw, int):
        return max(0, raw)
    if isinstance(raw, str):
        stripped = raw.strip().replace("_", "")
        if stripped.isdigit():
            return int(stripped)
    return default


def load_compaction_sync_config(repo_root: Path) -> CompactionSyncConfig:
    """Load `compaction_doc_sync` settings from `.trellis/config.yaml`."""
    cfg = read_trellis_config(repo_root)
    section = cfg.get("compaction_doc_sync") if isinstance(cfg, dict) else None
    if not isinstance(section, dict):
        return CompactionSyncConfig()

    return CompactionSyncConfig(
        enabled=_parse_bool(section.get("enabled"), True),
        watermark_tokens=_parse_non_negative_int(
            section.get("watermark_tokens"), DEFAULT_WATERMARK_TOKENS
        ),
        cooldown_tokens=_parse_non_negative_int(
            section.get("cooldown_tokens"), DEFAULT_COOLDOWN_TOKENS
        ),
        min_turns_since_doc_write=_parse_non_negative_int(
            section.get("min_turns_since_doc_write"),
            DEFAULT_MIN_TURNS_SINCE_DOC_WRITE,
        ),
    )


def _state_file_for_key(repo_root: Path, context_key: str) -> Path | None:
    """Chokepoint path builder for `.trellis/.runtime/compaction-sync/<key>.json`."""
    cleaned = _SAFE_KEY_RE.sub("_", context_key.strip()).strip("._")
    if not cleaned:
        return None
    digest = hashlib.sha256(context_key.encode("utf-8")).hexdigest()[:12]
    safe_name = f"{cleaned[:96]}-{digest}.json"
    return repo_root / ".trellis" / ".runtime" / DIR_COMPACTION_SYNC / safe_name


def _load_state(state_path: Path) -> dict[str, Any]:
    data = read_json(state_path)
    return data if isinstance(data, dict) else {}


def _save_state(state_path: Path, data: dict[str, Any]) -> None:
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
        write_json(state_path, data)
    except OSError:
        return  # Best-effort runtime marker; never fail hook execution.


def _safe_int(val: Any) -> int:
    if isinstance(val, bool):
        return 0
    if isinstance(val, int):
        return max(0, val)
    if isinstance(val, float):
        return max(0, int(val))
    if isinstance(val, str) and val.strip().isdigit():
        return int(val.strip())
    return 0


def _unwrap_arg_string(raw: Any) -> str:
    """Unwrap plain or JSON-stringified tool argument strings (AGY transcripts)."""
    if not isinstance(raw, str):
        return ""
    val = raw.strip()
    if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
        try:
            parsed = json.loads(val)
            if isinstance(parsed, str):
                return parsed.strip()
        except (json.JSONDecodeError, ValueError):
            return val[1:-1].strip()
    return val


def _extract_transcript_path(input_data: dict[str, Any]) -> str | None:
    for key in ("transcriptPath", "transcript_path", "transcript"):
        raw = input_data.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


def _read_tail_jsonl(path: Path, max_bytes: int = TAIL_READ_BYTES) -> list[dict[str, Any]]:
    """Read and parse JSONL records from the tail of `path`."""
    try:
        with open(path, "rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            if size <= 0:
                return []
            if size > max_bytes:
                handle.seek(size - max_bytes, os.SEEK_SET)
                handle.readline()  # Drop partial leading line after mid-file seek
            else:
                handle.seek(0, os.SEEK_SET)
            raw_text = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return []

    records: list[dict[str, Any]] = []
    for line in raw_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        try:
            parsed = json.loads(stripped)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(parsed, dict):
            records.append(parsed)
    return records


def _is_doc_path(raw_path: str, repo_root: Path) -> bool:
    """Return True if `raw_path` targets a persisted Trellis or project doc file."""
    if not raw_path:
        return False
    norm = raw_path.replace("\\", "/").strip()
    lower = norm.lower()

    excluded_markers = (
        "/.gemini/",
        "/.claude/settings",
        "/.trellis/.runtime/",
        "/node_modules/",
        "/scratch/",
    )
    if any(marker in lower for marker in excluded_markers):
        return False
    if lower.startswith((".gemini/", ".trellis/.runtime/", "node_modules/")):
        return False

    # Resolve relative to repo_root when possible to reject external temp/brain files.
    rel_posix = norm
    try:
        candidate = Path(raw_path)
        if candidate.is_absolute():
            resolved = candidate.resolve()
            root_resolved = repo_root.resolve()
            try:
                rel_posix = resolved.relative_to(root_resolved).as_posix()
            except ValueError:
                return False
        else:
            while rel_posix.startswith("./"):
                rel_posix = rel_posix[2:]
    except OSError:
        return False

    rel_lower = rel_posix.lower()
    if rel_lower.startswith((".trellis/tasks/", ".trellis/spec/", "docs/", "docs-site/")):
        return True

    basename = rel_posix.rsplit("/", 1)[-1].lower()
    if basename.startswith(("readme", "changelog", "contributing", "agents.md", "claude.md")):
        return True
    return rel_lower.endswith((".md", ".mdx")) and not rel_lower.startswith(".trellis/workspace/")


def _inspect_antigravity_records(
    records: list[dict[str, Any]], repo_root: Path, transcript_path: str | None
) -> TranscriptSnapshot:
    last_checkpoint_idx = -1
    checkpoint_marker: str | None = None

    for idx, rec in enumerate(records):
        step_type = str(rec.get("type") or "").strip().upper()
        if step_type in _AGY_COMPACT_STEP_TYPES or "CHECKPOINT" in step_type:
            last_checkpoint_idx = idx
            step_no = rec.get("step_index", idx)
            checkpoint_marker = f"step:{step_no}:{step_type}"

    segment = records[last_checkpoint_idx + 1 :]
    context_tokens = 0
    turns_since_doc_write = 0
    user_turns = 0
    has_activity = False

    for rec in segment:
        step_type = str(rec.get("type") or "").strip().upper()
        if step_type == "USER_INPUT":
            source = str(rec.get("source") or "USER_EXPLICIT").strip().upper()
            if source == "USER_EXPLICIT":
                user_turns += 1
                turns_since_doc_write += 1
                if user_turns >= 2:
                    has_activity = True
            continue

        if step_type == "PLANNER_RESPONSE":
            inp = _safe_int(rec.get("input_tokens"))
            cache = _safe_int(rec.get("cache_read_tokens"))
            if inp > 0 or cache > 0:
                context_tokens = inp + cache

        tool_calls = rec.get("tool_calls")
        if isinstance(tool_calls, list) and tool_calls:
            has_activity = True
            for tc in tool_calls:
                if not isinstance(tc, dict):
                    continue
                tname = str(tc.get("name") or "").strip().lower()
                if tname not in _AGY_WRITE_TOOLS:
                    continue
                args = tc.get("args")
                if not isinstance(args, dict):
                    continue
                target = (
                    _unwrap_arg_string(args.get("Path"))
                    or _unwrap_arg_string(args.get("TargetFile"))
                    or _unwrap_arg_string(args.get("path"))
                    or _unwrap_arg_string(args.get("file_path"))
                )
                if _is_doc_path(target, repo_root):
                    turns_since_doc_write = 0

    return TranscriptSnapshot(
        context_tokens=context_tokens,
        checkpoint_marker=checkpoint_marker,
        turns_since_doc_write=turns_since_doc_write,
        user_turns_in_segment=user_turns,
        has_substantive_activity=has_activity,
        transcript_path=transcript_path,
    )


def _is_claude_real_user_turn(rec: dict[str, Any]) -> bool:
    if rec.get("type") != "user" or rec.get("isCompactSummary") is True:
        return False
    msg = rec.get("message")
    if not isinstance(msg, dict) or msg.get("role") != "user":
        return False
    content = msg.get("content")
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        has_text = False
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "tool_result":
                return False
            if block.get("type") == "text" and str(block.get("text") or "").strip():
                has_text = True
        return has_text
    return False


def _inspect_claude_records(
    records: list[dict[str, Any]], repo_root: Path, transcript_path: str | None
) -> TranscriptSnapshot:
    last_checkpoint_idx = -1
    checkpoint_marker: str | None = None

    for idx, rec in enumerate(records):
        if rec.get("type") == "user" and rec.get("isCompactSummary") is True:
            last_checkpoint_idx = idx
            ident = rec.get("uuid") or rec.get("timestamp") or idx
            checkpoint_marker = f"compact:{ident}"

    segment = records[last_checkpoint_idx + 1 :]
    context_tokens = 0
    turns_since_doc_write = 0
    user_turns = 0
    has_activity = False

    for rec in segment:
        if _is_claude_real_user_turn(rec):
            user_turns += 1
            turns_since_doc_write += 1
            if user_turns >= 2:
                has_activity = True
            continue

        if rec.get("type") != "assistant":
            continue
        msg = rec.get("message")
        if not isinstance(msg, dict):
            continue

        usage = msg.get("usage")
        if isinstance(usage, dict):
            total_inp = (
                _safe_int(usage.get("input_tokens"))
                + _safe_int(usage.get("cache_creation_input_tokens"))
                + _safe_int(usage.get("cache_read_input_tokens"))
            )
            if total_inp > 0:
                context_tokens = total_inp

        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            has_activity = True
            tname = str(block.get("name") or "").strip()
            if tname not in _CLAUDE_WRITE_TOOLS:
                continue
            inp_obj = block.get("input")
            if not isinstance(inp_obj, dict):
                continue
            target = str(
                inp_obj.get("file_path") or inp_obj.get("notebook_path") or inp_obj.get("path") or ""
            ).strip()
            if _is_doc_path(target, repo_root):
                turns_since_doc_write = 0

    return TranscriptSnapshot(
        context_tokens=context_tokens,
        checkpoint_marker=checkpoint_marker,
        turns_since_doc_write=turns_since_doc_write,
        user_turns_in_segment=user_turns,
        has_substantive_activity=has_activity,
        transcript_path=transcript_path,
    )


def inspect_transcript(
    repo_root: Path, input_data: dict[str, Any], platform: str | None
) -> TranscriptSnapshot:
    """Inspect the tail of the current session's transcript JSONL."""
    tpath_str = _extract_transcript_path(input_data)
    if not tpath_str:
        return TranscriptSnapshot()
    tpath = Path(tpath_str)
    if not tpath.is_file():
        return TranscriptSnapshot(transcript_path=tpath_str)

    records = _read_tail_jsonl(tpath)
    if not records:
        return TranscriptSnapshot(transcript_path=tpath_str)

    if platform == "antigravity":
        return _inspect_antigravity_records(records, repo_root, tpath_str)
    return _inspect_claude_records(records, repo_root, tpath_str)


def _resolve_active_task_path(
    repo_root: Path, input_data: dict[str, Any], platform: str | None
) -> str | None:
    active = resolve_active_task(repo_root, input_data, platform=platform)
    if not active.task_path or active.stale:
        return None
    task_dir = Path(active.task_path)
    if not task_dir.is_absolute():
        task_dir = repo_root / task_dir
    if not (task_dir / "task.json").is_file():
        return None
    try:
        return task_dir.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return active.task_path.replace("\\", "/")


def _build_doc_scope_lines(active_task_rel: str | None) -> str:
    if active_task_rel:
        return (
            f"Active task: `{active_task_rel}`\n"
            "Check whether any in-memory findings or decisions need to be written to:\n"
            f"1. Active task artifacts under `{active_task_rel}/` (`prd.md`, `design.md`, `implement.md`, `research/*.md`).\n"
            "2. Project coding guidelines under `.trellis/spec/` (newly discovered conventions, pitfalls, or architectural decisions).\n"
            "3. Affected project documentation (`docs/`, `README.md`, etc.) if behavior or interfaces discussed/changed impact them."
        )
    return (
        "Active task: none (`no_task`).\n"
        "Check only whether reusable conventions belong in `.trellis/spec/` or whether changes made/agreed in this session require updating affected project documentation (`docs/`, `README.md`, etc.).\n"
        "Do NOT create temporary scratch/handoff files or force Trellis task creation."
    )


def build_pre_compact_watermark_prompt(
    active_task_rel: str | None, context_tokens: int, watermark_tokens: int
) -> str:
    """Build the `<pre-compact-doc-check>` prompt for the `Stop` watermark hook."""
    scope_text = _build_doc_scope_lines(active_task_rel)
    return (
        "<pre-compact-doc-check>\n"
        f"Context usage is high (~{context_tokens:,} tokens; threshold {watermark_tokens:,}) and automatic compaction may run soon.\n"
        "While full conversation memory is still intact, review whether any unsaved knowledge needs to be persisted now:\n"
        f"{scope_text}\n"
        "Rules: Do NOT run `git commit`, `task.py archive`, or `add_session.py` during this check. "
        "If documentation is already up to date, reply briefly in one line and stop.\n"
        "</pre-compact-doc-check>"
    )


def build_post_compact_prompt(
    active_task_rel: str | None,
    platform: str | None,
    transcript_path: str | None,
    session_id: str | None = None,
) -> str:
    """Build the `<post-compact-doc-check>` prompt injected right after compaction."""
    scope_text = _build_doc_scope_lines(active_task_rel)
    recovery_lines: list[str] = []
    if transcript_path:
        recovery_lines.append(
            f"- Full pre-compaction dialogue remains on disk at `{transcript_path}` (inspect tail/entries only if specific details were summarized away)."
        )
    if platform == "claude":
        mem_cmd = (
            f"trellis mem context {session_id}"
            if session_id
            else "trellis mem list --platform claude"
        )
        recovery_lines.append(
            f"- You can also query pre-compaction turns via `{mem_cmd}` if needed."
        )
    recovery_block = "\n".join(recovery_lines)
    if recovery_block:
        recovery_block = f"\nRecovery sources if details are missing from the summary:\n{recovery_block}"

    return (
        "<post-compact-doc-check>\n"
        "Context compaction just occurred. Before proceeding, verify that no pre-compaction decisions, research findings, or spec updates were left unsaved:\n"
        f"{scope_text}"
        f"{recovery_block}\n"
        "Rules: Do NOT run `git commit`, `task.py archive`, or `add_session.py` as part of this check. "
        "Persist any missing updates first, then continue with the user's request.\n"
        "</post-compact-doc-check>"
    )


def evaluate_stop_watermark(
    repo_root: Path, input_data: dict[str, Any], platform: str | None
) -> str | None:
    """Return a continuation prompt if `Stop` crossed the token watermark, else None."""
    cfg = load_compaction_sync_config(repo_root)
    if not cfg.enabled or cfg.watermark_tokens <= 0:
        return None

    context_key = resolve_context_key(input_data, platform=platform)
    if not context_key:
        return None
    state_path = _state_file_for_key(repo_root, context_key)
    if state_path is None:
        return None

    snapshot = inspect_transcript(repo_root, input_data, platform)
    state = _load_state(state_path)

    prev_checkpoint = state.get("last_checkpoint_marker")
    prev_tokens = _safe_int(state.get("last_seen_tokens"))
    last_watermark = _safe_int(state.get("last_watermark_tokens"))
    if snapshot.checkpoint_marker and snapshot.checkpoint_marker != prev_checkpoint:
        last_watermark = 0
    elif last_watermark > 0 and snapshot.context_tokens > 0 and snapshot.context_tokens < int(last_watermark * 0.6):
        # Context shrank substantially (compaction occurred); re-arm watermark.
        last_watermark = 0

    if (
        platform == "antigravity"
        and prev_tokens >= 40_000
        and 0 < snapshot.context_tokens < int(prev_tokens * 0.55)
    ):
        state["pending_post_compact"] = True

    state["initialized"] = True
    if snapshot.context_tokens > 0:
        state["last_seen_tokens"] = snapshot.context_tokens

    if snapshot.context_tokens < cfg.watermark_tokens:
        state["last_watermark_tokens"] = last_watermark
        _save_state(state_path, state)
        return None

    if last_watermark > 0:
        if cfg.cooldown_tokens <= 0:
            _save_state(state_path, state)
            return None
        if snapshot.context_tokens - last_watermark < cfg.cooldown_tokens:
            _save_state(state_path, state)
            return None

    if snapshot.turns_since_doc_write < cfg.min_turns_since_doc_write:
        _save_state(state_path, state)
        return None

    active_task_rel = _resolve_active_task_path(repo_root, input_data, platform)
    if active_task_rel is None and not snapshot.has_substantive_activity:
        _save_state(state_path, state)
        return None

    state["last_watermark_tokens"] = snapshot.context_tokens
    _save_state(state_path, state)
    return build_pre_compact_watermark_prompt(
        active_task_rel, snapshot.context_tokens, cfg.watermark_tokens
    )


def record_pre_compact(
    repo_root: Path, input_data: dict[str, Any], platform: str | None
) -> None:
    """Record a pending post-compaction check before Claude Code compacts context."""
    cfg = load_compaction_sync_config(repo_root)
    if not cfg.enabled:
        return

    context_key = resolve_context_key(input_data, platform=platform)
    if not context_key:
        return
    state_path = _state_file_for_key(repo_root, context_key)
    if state_path is None:
        return

    state = _load_state(state_path)
    state["initialized"] = True
    state["pending_post_compact"] = True
    state["last_watermark_tokens"] = 0
    trigger = input_data.get("trigger")
    if isinstance(trigger, str) and trigger.strip():
        state["last_compact_trigger"] = trigger.strip()
    tpath = _extract_transcript_path(input_data)
    if tpath:
        state["transcript_path"] = tpath
    _save_state(state_path, state)


def consume_post_compact_notice(
    repo_root: Path,
    input_data: dict[str, Any],
    platform: str | None,
    *,
    is_compact_event: bool = False,
) -> str | None:
    """Consume or detect a compaction boundary and return a one-shot check prompt."""
    cfg = load_compaction_sync_config(repo_root)
    if not cfg.enabled:
        return None

    context_key = resolve_context_key(input_data, platform=platform)
    state_path = _state_file_for_key(repo_root, context_key) if context_key else None
    state = _load_state(state_path) if state_path else {}

    snapshot = inspect_transcript(repo_root, input_data, platform)
    tpath = snapshot.transcript_path or _extract_transcript_path(input_data)
    if not tpath and isinstance(state.get("transcript_path"), str):
        tpath = state["transcript_path"]

    compacted = False
    if is_compact_event or state.get("pending_post_compact") is True:
        compacted = True
    elif platform == "antigravity":
        was_initialized = bool(state.get("initialized"))
        prev_marker = state.get("last_checkpoint_marker")
        prev_steps = _safe_int(state.get("last_initial_num_steps"))
        prev_tokens = _safe_int(state.get("last_seen_tokens"))
        curr_steps = _safe_int(input_data.get("initialNumSteps"))

        if snapshot.checkpoint_marker and snapshot.checkpoint_marker != prev_marker:
            if was_initialized or snapshot.user_turns_in_segment <= 1:
                compacted = True
        elif was_initialized:
            if prev_steps > 4 and curr_steps > 0 and curr_steps + 2 < prev_steps:
                compacted = True
            elif (
                prev_tokens >= 40_000
                and 0 < snapshot.context_tokens < int(prev_tokens * 0.55)
            ):
                compacted = True

    if state_path is not None:
        state["initialized"] = True
        state["pending_post_compact"] = False
        if snapshot.checkpoint_marker:
            state["last_checkpoint_marker"] = snapshot.checkpoint_marker
        curr_steps = _safe_int(input_data.get("initialNumSteps"))
        if curr_steps > 0:
            state["last_initial_num_steps"] = curr_steps
        if snapshot.context_tokens > 0:
            state["last_seen_tokens"] = snapshot.context_tokens
        elif compacted:
            state["last_seen_tokens"] = 0
        if tpath:
            state["transcript_path"] = tpath
        if compacted:
            state["last_watermark_tokens"] = 0
        _save_state(state_path, state)

    if not compacted:
        return None

    active_task_rel = _resolve_active_task_path(repo_root, input_data, platform)
    session_id = input_data.get("session_id") or input_data.get("sessionId")
    sid_str = session_id.strip() if isinstance(session_id, str) and session_id.strip() else None
    return build_post_compact_prompt(active_task_rel, platform, tpath, session_id=sid_str)
