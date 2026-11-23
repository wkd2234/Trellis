#!/usr/bin/env python3
"""Pre-shell hook: bridge the host's session identity into task.py.

No researched platform exports a session id into its shell tool's child
process, but every hook-capable one puts that id on hook stdin. So the hook
that fires just before a shell command writes a short-lived runtime ticket
whenever the pending command calls `task.py start/current/finish`, and the
task script consumes it when it has no native session environment.

Registered on whichever pre-shell event the host provides — Cursor's
`beforeShellExecution`, Claude-shaped `PreToolUse`, Gemini's `BeforeTool` —
which is why the only thing here that knows about payload variation is
`_pending_shell_command`.
"""
from __future__ import annotations

import hashlib
import json
import os
import shlex
import sys
import time
from pathlib import Path
from typing import Any

# Hook hosts send UTF-8 JSON regardless of the process locale.
_stdin_reconfigure = getattr(sys.stdin, "reconfigure", None)
if callable(_stdin_reconfigure):
    try:
        _stdin_reconfigure(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        pass


DIR_WORKFLOW = ".trellis"
DIR_RUNTIME = ".runtime"
DIR_SHELL_TICKETS = "shell-tickets"
SESSION_SUBCOMMANDS = {"create", "start", "current", "finish"}
TICKET_TTL_SECONDS = 30
CONTEXT_IDENTITY_KEYS = (
    "session_id",
    "sessionId",
    "sessionID",
    "conversation_id",
    "conversationId",
    "conversationID",
    "transcript_path",
    "transcriptPath",
    "transcript",
)
# Tool-call payloads nest the command one level down; same casing spread as
# CONTEXT_IDENTITY_KEYS above.
TOOL_INPUT_KEYS = ("tool_input", "toolInput")
# Answering a shell-execution event with an explicit allow is what keeps
# Cursor from re-prompting for a command Trellis itself asked for. Tool-call
# hosts read a different response schema, so they get no answer at all rather
# than a key they would have to ignore. Antigravity PreToolUse requires a JSON
# decision object on stdout (`{"decision": "allow"}`).
SHELL_EVENT_RESPONSE = {"permission": "allow"}
AGY_TOOL_ALLOW_RESPONSE = {"decision": "allow"}


def _is_antigravity_payload(hook_input: dict[str, Any]) -> bool:
    return (
        isinstance(hook_input.get("toolCall"), dict)
        or isinstance(hook_input.get("workspacePaths"), list)
        or isinstance(hook_input.get("artifactDirectoryPath"), str)
    )


def _string_value(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def _resolve_trellis_root(hook_input: dict[str, Any]) -> Path | None:
    """Locate the project root, trying the payload cwd and then our own.

    Hosts disagree about what `cwd` means. CodeBuddy IDE 4.10.4 sends `"/"` for
    every PreToolUse event, so trusting the payload alone finds no `.trellis`
    and the bridge silently does nothing — the hook is invoked, writes no
    ticket, and `task.py start` degrades. Observed with a wildcard probe:

        {"cwd": "/", "tool_name": "Bash", "tool_input": {"command": "ls …"}}

    The hook's own cwd is reliable where the payload is not: hosts launch it
    from the project root, which is why a relative `command` in settings.json
    resolves at all. Try the payload first (it is right on hosts that set it,
    and survives a host that runs hooks from elsewhere), then fall back.
    """
    candidates: list[Path] = []
    tool_call = hook_input.get("toolCall")
    if isinstance(tool_call, dict):
        args = tool_call.get("args")
        if isinstance(args, dict):
            tool_cwd = _string_value(args.get("Cwd") or args.get("cwd"))
            if tool_cwd:
                candidates.append(Path(tool_cwd))
    payload_cwd = _string_value(hook_input.get("cwd"))
    if payload_cwd:
        candidates.append(Path(payload_cwd))
    ws_paths = hook_input.get("workspacePaths")
    if isinstance(ws_paths, list):
        for ws in ws_paths:
            ws_str = _string_value(ws)
            if ws_str:
                candidates.append(Path(ws_str))
    try:
        candidates.append(Path(os.getcwd()))
    except OSError:
        pass

    for candidate in candidates:
        root = _find_trellis_root(candidate)
        if root is not None:
            return root
    return None


def _find_trellis_root(start: Path) -> Path | None:
    current = start.resolve()
    while True:
        if (current / DIR_WORKFLOW).is_dir():
            return current
        if current == current.parent:
            return None
        current = current.parent


def _runtime_ticket_dir(root: Path) -> Path:
    return root / DIR_WORKFLOW / DIR_RUNTIME / DIR_SHELL_TICKETS


def _pending_shell_command(hook_input: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    """Read the pending shell command out of either hook payload shape.

    Returns the command plus the response envelope that shape expects:

    - shell-execution event (Cursor `beforeShellExecution`) — the command sits
      at the top level and the host wants a permission decision back;
    - Antigravity `PreToolUse` (`toolCall.args.CommandLine`) — the host expects
      `{"decision": "allow"}` on stdout;
    - tool-call event (`PreToolUse`, `BeforeTool`) — the command sits under
      `tool_input`, and the host reads a schema this hook has no opinion on.

    An ordered fallback, not a platform switch: a third payload shape extends
    the same function. Anything else yields ("", None) so main() no-ops.
    """
    command = _string_value(hook_input.get("command"))
    if command:
        return command, SHELL_EVENT_RESPONSE

    tool_call = hook_input.get("toolCall")
    if isinstance(tool_call, dict):
        args = tool_call.get("args")
        if isinstance(args, dict):
            command = _string_value(args.get("CommandLine") or args.get("command"))
            if command:
                return command, AGY_TOOL_ALLOW_RESPONSE
        return "", AGY_TOOL_ALLOW_RESPONSE

    for key in TOOL_INPUT_KEYS:
        tool_input = hook_input.get(key)
        if not isinstance(tool_input, dict):
            continue
        command = _string_value(tool_input.get("command"))
        if command:
            return command, None

    return "", None


def _host_platform_name(hook_input: dict[str, Any] | None = None) -> str | None:
    """Name the host from the payload or the config directory this hook was installed into.

    Antigravity plugins may live under `.agents/plugins/trellis/hooks/` or
    globally under `~/.gemini/config/plugins/trellis/hooks/`, so payload
    detection runs first before falling back to path-segment inference.
    """
    if isinstance(hook_input, dict) and _is_antigravity_payload(hook_input):
        return "antigravity"
    script_parts = Path(sys.argv[0]).parts
    if ".agent" in script_parts or ".agents" in script_parts:
        return "antigravity"
    for part in reversed(script_parts):
        if part.startswith(".") and part not in (".", "..") and len(part) > 1:
            return part[1:]
    return None


def _load_active_task_resolver(root: Path):
    scripts_dir = root / DIR_WORKFLOW / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    from common.active_task import resolve_context_key  # type: ignore[import-not-found]

    return resolve_context_key


_SHELL_SEPARATORS = frozenset({";", "&&", "||", "|", "&", "(", ")", "{", "}", "\n", "\r"})
_SHELL_REDIR_TOKENS = frozenset({">", ">>", "<", "<<", "<&", ">&", "2>", "2>>", "1>", "1>>", "&>", "&>>"})


def _unquote_token(token: str) -> str:
    """Strip one layer of matching outer single/double quotes (Windows posix=False)."""
    if len(token) >= 2 and token[0] == token[-1] and token[0] in ("'", '"'):
        return token[1:-1]
    return token


def _is_separator_token(token: str) -> bool:
    if token in _SHELL_SEPARATORS:
        return True
    # shlex may group adjacent newlines/separators like "\r\n" or ";;"
    return bool(token) and all(ch in ";|&(){}\r\n" for ch in token)


def _tokenize_shell_segments(command: str) -> list[list[str]]:
    """Split a compound shell/PowerShell command into per-command token lists.

    Unlike plain ``shlex.split(command)`` (which leaves ``;`` / ``&&`` glued
    onto adjacent arguments like ``11-23-foo;`` or ``current;``), enabling
    ``punctuation_chars`` separates shell operators outside quotes while
    keeping quoted strings (including ``;`` / ``&&`` inside a task title) intact.
    """
    lex = shlex.shlex(
        command,
        posix=os.name != "nt",
        punctuation_chars=";&|(){}<>\r\n",
    )
    lex.whitespace = " \t"
    lex.whitespace_split = True
    lex.commenters = ""

    segments: list[list[str]] = []
    current: list[str] = []
    while True:
        try:
            token = lex.get_token()
        except ValueError:
            # Recover any complete segments parsed before a trailing unmatched quote.
            break
        if token is None or token == lex.eof:
            break
        if _is_separator_token(token):
            if current:
                segments.append(current)
                current = []
            continue
        current.append(token)
    if current:
        segments.append(current)
    return segments


def _is_task_script_token(token: str) -> bool:
    unquoted = _unquote_token(token)
    if not unquoted:
        return False
    return unquoted.replace("\\", "/").rsplit("/", 1)[-1] == "task.py"


def _extract_start_task_ref(args: list[str]) -> str | None:
    """Extract the positional task_ref from ``task.py start`` arguments."""
    skip_next = False
    for raw in args:
        if skip_next:
            skip_next = False
            continue
        token = _unquote_token(raw)
        if not token:
            continue
        if token in _SHELL_REDIR_TOKENS or token.endswith(">") or token.endswith("<"):
            skip_next = True
            continue
        if token.startswith("-"):
            continue
        return token
    return None


def _extract_task_subcommands(command: str) -> list[dict[str, str]]:
    subcommands: list[dict[str, str]] = []
    for segment in _tokenize_shell_segments(command):
        for index, token in enumerate(segment[:-1]):
            if not _is_task_script_token(token):
                continue
            name = _unquote_token(segment[index + 1])
            if name not in SESSION_SUBCOMMANDS:
                continue
            rest = segment[index + 2 :]
            if name == "create":
                if any(_unquote_token(arg) == "--no-start" for arg in rest):
                    break
                subcommands.append({"name": "create"})
                break
            item = {"name": name}
            if name == "start":
                task_ref = _extract_start_task_ref(rest)
                if task_ref:
                    item["task_ref"] = task_ref
            subcommands.append(item)
            break
    return subcommands


def _cleanup_expired_tickets(ticket_dir: Path, now: float) -> None:
    if not ticket_dir.is_dir():
        return
    for ticket_path in ticket_dir.glob("*.json"):
        try:
            data = json.loads(ticket_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        expires_at = data.get("expires_at_epoch")
        if isinstance(expires_at, (int, float)) and expires_at < now:
            try:
                ticket_path.unlink()
            except OSError:
                pass


def _has_context_identity(hook_input: dict[str, Any]) -> bool:
    return any(_string_value(hook_input.get(key)) for key in CONTEXT_IDENTITY_KEYS)


def _write_ticket(
    root: Path,
    hook_input: dict[str, Any],
    context_key: str,
    command: str,
    platform_name: str | None,
    subcommands: list[dict[str, str]],
) -> None:
    now = time.time()
    ticket_dir = _runtime_ticket_dir(root)
    ticket_dir.mkdir(parents=True, exist_ok=True)
    _cleanup_expired_tickets(ticket_dir, now)

    digest = hashlib.sha256(
        f"{context_key}\0{command}\0{now}".encode("utf-8"),
    ).hexdigest()[:16]
    ticket_path = ticket_dir / f"{int(now * 1000)}-{digest}.json"

    payload = {
        # Debugging metadata. The consumer accepts a ticket on freshness, repo
        # and subcommand — never on this field.
        "platform": platform_name,
        "context_key": context_key,
        "conversation_id": _string_value(
            hook_input.get("conversation_id") or hook_input.get("conversationId")
        ),
        "session_id": _string_value(
            hook_input.get("session_id") or hook_input.get("sessionId")
        ),
        "generation_id": _string_value(hook_input.get("generation_id")),
        # The resolved project root, not the payload's cwd. The consumer
        # rejects a ticket whose cwd is outside the repo, and CodeBuddy IDE
        # 4.10.4 reports "/" for every PreToolUse event — a ticket carrying
        # that is written correctly and then discarded on arrival. Recording
        # the root we actually resolved keeps the containment check meaningful
        # without trusting a field the host may not populate.
        "cwd": str(root),
        # Kept separately so a wrong host cwd stays visible when debugging.
        "host_cwd": _string_value(hook_input.get("cwd")),
        "command": command,
        "subcommands": subcommands,
        "created_at_epoch": now,
        "expires_at_epoch": now + TICKET_TTL_SECONDS,
    }
    ticket_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _emit_agy_allow_if_needed(is_agy: bool) -> None:
    if is_agy:
        print(json.dumps(AGY_TOOL_ALLOW_RESPONSE, ensure_ascii=False))


def main() -> int:
    if os.environ.get("TRELLIS_HOOKS") == "0" or os.environ.get("TRELLIS_DISABLE_HOOKS") == "1":
        return 0

    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        hook_input = {}
    if not isinstance(hook_input, dict):
        hook_input = {}

    is_agy = _is_antigravity_payload(hook_input)
    command, response = _pending_shell_command(hook_input)
    subcommands = _extract_task_subcommands(command)
    if not subcommands:
        _emit_agy_allow_if_needed(is_agy)
        return 0

    root = _resolve_trellis_root(hook_input)
    if root is None:
        _emit_agy_allow_if_needed(is_agy)
        return 0

    if not _has_context_identity(hook_input):
        _emit_agy_allow_if_needed(is_agy)
        return 0

    platform_name = _host_platform_name(hook_input)
    resolve_context_key = _load_active_task_resolver(root)
    context_key = resolve_context_key(hook_input, platform=platform_name)
    if not context_key:
        _emit_agy_allow_if_needed(is_agy)
        return 0

    try:
        _write_ticket(root, hook_input, context_key, command, platform_name, subcommands)
    except OSError:
        _emit_agy_allow_if_needed(is_agy)
        return 0

    if response is not None:
        print(json.dumps(response, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
