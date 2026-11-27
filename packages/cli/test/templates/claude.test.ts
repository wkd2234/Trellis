import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  settingsTemplate,
  getAllAgents,
  getSettingsTemplate,
} from "../../src/templates/claude/index.js";
import { collectClaudeTemplates } from "../../src/configurators/claude.js";
import {
  getAllScripts,
  workflowMdTemplate,
} from "../../src/templates/trellis/index.js";

const pythonCmd =
  process.env.PYTHON_CMD ?? (process.platform === "win32" ? "python" : "python3");

function cleanClaudeHookEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.endsWith("_PROJECT_DIR") &&
        k !== "TRELLIS_CONTEXT_ID" &&
        k !== "TRELLIS_HOOKS" &&
        k !== "TRELLIS_DISABLE_HOOKS" &&
        k !== "CLAUDE_NON_INTERACTIVE",
    ),
  );
}

// =============================================================================
// settingsTemplate — module-level constant
// =============================================================================

describe("settingsTemplate", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(settingsTemplate)).not.toThrow();
  });

  it("is a non-empty string", () => {
    expect(settingsTemplate.length).toBeGreaterThan(0);
  });

  // v0.5.0-beta.8: pin CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1 at the project
  // level so Bash tool cwd changes don't leak into subsequent hook invocations.
  // Without this, a user who runs `cd frontend/` via Bash tool leaves cwd stuck
  // in `frontend/`, and the next UserPromptSubmit hook (which resolves
  // `.claude/hooks/inject-workflow-state.py` relative to cwd) crashes with
  // ENOENT. We can't fix this via command-string rewriting because
  // $CLAUDE_PROJECT_DIR doesn't expand on Windows shells (see CC issue #6023).
  // The env-var approach is read by CC internally, identical on all platforms.
  it("sets CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1 in env", () => {
    const settings = JSON.parse(settingsTemplate) as {
      env?: Record<string, string>;
    };
    expect(settings.env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
  });
});

// =============================================================================
// settingsTemplate — SessionStart hook matchers
// =============================================================================

describe("settingsTemplate SessionStart matchers", () => {
  const settings = JSON.parse(settingsTemplate);
  const sessionStartEntries = settings.hooks.SessionStart as {
    matcher: string;
    hooks: { type: string; command: string; timeout: number }[];
  }[];

  it("includes startup, clear, and compact matchers", () => {
    const matchers = sessionStartEntries.map((e) => e.matcher);
    expect(matchers).toContain("startup");
    expect(matchers).toContain("clear");
    expect(matchers).toContain("compact");
  });

  it("all SessionStart entries invoke the same session-start.py hook", () => {
    for (const entry of sessionStartEntries) {
      expect(entry.hooks).toHaveLength(1);
      expect(entry.hooks[0].command).toContain("session-start.py");
    }
  });

  it("all SessionStart entries use {{PYTHON_CMD}} placeholder", () => {
    for (const entry of sessionStartEntries) {
      expect(entry.hooks[0].command).toContain("{{PYTHON_CMD}}");
    }
  });
});

// Commands are now sourced from common/ templates and tested in platforms.test.ts

// =============================================================================
// getAllAgents — reads agent templates
// =============================================================================

describe("getAllAgents", () => {
  it("each agent has name and content", () => {
    const agents = getAllAgents();
    for (const agent of agents) {
      expect(agent.name.length).toBeGreaterThan(0);
      expect(agent.content.length).toBeGreaterThan(0);
    }
  });
});

// =============================================================================
// getSettingsTemplate — returns settings as SettingsTemplate
// =============================================================================

describe("getSettingsTemplate", () => {
  it("returns correct shape with valid JSON", () => {
    const result = getSettingsTemplate();
    expect(result.targetPath).toBe("settings.json");
    expect(result.content.length).toBeGreaterThan(0);
    expect(() => JSON.parse(result.content)).not.toThrow();
  });

  it("wires PreCompact and Stop to compaction-doc-sync.py with two-token commands", () => {
    const parsed = JSON.parse(settingsTemplate) as {
      hooks: {
        PreCompact?: { hooks: { type: string; command: string; timeout: number }[] }[];
        Stop?: { hooks: { type: string; command: string; timeout: number }[] }[];
      };
    };
    expect(parsed.hooks.PreCompact).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: "{{PYTHON_CMD}} .claude/hooks/compaction-doc-sync.py",
            timeout: 15,
          },
        ],
      },
    ]);
    expect(parsed.hooks.Stop).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: "{{PYTHON_CMD}} .claude/hooks/compaction-doc-sync.py",
            timeout: 15,
          },
        ],
      },
    ]);
  });
});

describe("claude compaction-doc-sync runtime contract", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-claude-compact-"));
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });

    for (const [relPath, content] of getAllScripts()) {
      const target = path.join(tmpDir, ".trellis", "scripts", relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf-8");
    }
    fs.writeFileSync(
      path.join(tmpDir, ".trellis", "workflow.md"),
      workflowMdTemplate,
      "utf-8",
    );
    for (const [relPath, content] of collectClaudeTemplates()) {
      const target = path.join(tmpDir, ...relPath.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf-8");
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runClaudeHook(
    scriptName: string,
    payload: Record<string, unknown>,
  ): string {
    const scriptPath = path.join(tmpDir, ".claude", "hooks", scriptName);
    return execFileSync(pythonCmd, [scriptPath], {
      cwd: tmpDir,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: cleanClaudeHookEnv(),
    });
  }

  it("PreCompact exits 0 without blocking and SessionStart(compact) injects <post-compact-doc-check> while startup/clear do not", () => {
    const transcriptPath = path.join(tmpDir, "claude-session.jsonl");
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "Discuss architecture" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            usage: { input_tokens: 90000, cache_read_input_tokens: 40000 },
            content: [{ type: "text", text: "Key decision made" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    // 1. Vanilla startup does NOT inject <post-compact-doc-check>
    const startupOut = JSON.parse(
      runClaudeHook("session-start.py", {
        session_id: "sess-claude-1",
        transcript_path: transcriptPath,
        cwd: tmpDir,
        source: "startup",
      }),
    ) as { hookSpecificOutput: { additionalContext: string } };
    expect(startupOut.hookSpecificOutput.additionalContext).not.toContain(
      "<post-compact-doc-check>",
    );

    // 2. PreCompact records snapshot and exits 0 with empty stdout (never blocks)
    const preOut = runClaudeHook("compaction-doc-sync.py", {
      session_id: "sess-claude-1",
      transcript_path: transcriptPath,
      cwd: tmpDir,
      hook_event_name: "PreCompact",
      trigger: "manual",
    });
    expect(preOut.trim()).toBe("");

    // 3. SessionStart(compact) injects <post-compact-doc-check> with transcript_path + trellis mem hint
    const compactOut = JSON.parse(
      runClaudeHook("session-start.py", {
        session_id: "sess-claude-1",
        transcript_path: transcriptPath,
        cwd: tmpDir,
        source: "compact",
      }),
    ) as { hookSpecificOutput: { additionalContext: string } };
    const ctx = compactOut.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("<post-compact-doc-check>");
    expect(ctx).toContain(transcriptPath);
    expect(ctx).toContain("trellis mem context sess-claude-1");

    // 4. Subsequent `clear` does NOT emit <post-compact-doc-check> (pending flag consumed)
    const clearOut = JSON.parse(
      runClaudeHook("session-start.py", {
        session_id: "sess-claude-1",
        transcript_path: transcriptPath,
        cwd: tmpDir,
        source: "clear",
      }),
    ) as { hookSpecificOutput: { additionalContext: string } };
    expect(clearOut.hookSpecificOutput.additionalContext).not.toContain(
      "<post-compact-doc-check>",
    );
  });

  it("Stop hook sums Claude usage tokens, blocks once for doc check, and honors stop_hook_active + config.yaml overrides", () => {
    const taskDir = path.join(tmpDir, ".trellis", "tasks", "01-claude-demo");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({
        id: "01-claude-demo",
        title: "Claude Demo",
        status: "planning",
      }),
      "utf-8",
    );
    const sessionDir = path.join(tmpDir, ".trellis", ".runtime", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "claude_sess-stop-1.json"),
      JSON.stringify({
        platform: "claude",
        current_task: ".trellis/tasks/01-claude-demo",
      }),
      "utf-8",
    );

    const transcriptPath = path.join(tmpDir, "claude-stop.jsonl");
    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "Turn 1" },
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "Turn 2" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            usage: {
              input_tokens: 15000,
              cache_creation_input_tokens: 30000,
              cache_read_input_tokens: 80000,
            },
            content: [{ type: "text", text: "Response" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    // Loop guard: stop_hook_active=true exits silently
    expect(
      runClaudeHook("compaction-doc-sync.py", {
        session_id: "sess-stop-1",
        transcript_path: transcriptPath,
        cwd: tmpDir,
        hook_event_name: "Stop",
        stop_hook_active: true,
      }).trim(),
    ).toBe("");

    // First Stop at 125k tokens: emits decision="block" with active task path
    const blocked = JSON.parse(
      runClaudeHook("compaction-doc-sync.py", {
        session_id: "sess-stop-1",
        transcript_path: transcriptPath,
        cwd: tmpDir,
        hook_event_name: "Stop",
        stop_hook_active: false,
      }),
    ) as { decision?: string; reason?: string };
    expect(blocked.decision).toBe("block");
    expect(blocked.reason).toContain("<pre-compact-doc-check>");
    expect(blocked.reason).toContain(".trellis/tasks/01-claude-demo");

    // Config override: `enabled: false` disables Stop check on a new session
    fs.writeFileSync(
      path.join(tmpDir, ".trellis", "config.yaml"),
      "compaction_doc_sync:\n  enabled: false\n",
      "utf-8",
    );
    expect(
      runClaudeHook("compaction-doc-sync.py", {
        session_id: "sess-stop-disabled",
        transcript_path: transcriptPath,
        cwd: tmpDir,
        hook_event_name: "Stop",
        stop_hook_active: false,
      }).trim(),
    ).toBe("");
  });
});
