import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAllAgents,
  getHooksConfig,
  getPluginManifest,
} from "../../src/templates/antigravity/index.js";
import { collectAntigravityTemplates } from "../../src/configurators/antigravity.js";
import {
  getAllScripts,
  workflowMdTemplate,
} from "../../src/templates/trellis/index.js";
import { AI_TOOLS } from "../../src/types/ai-tools.js";

const EXPECTED_AGENT_NAMES = [
  "trellis-check",
  "trellis-implement",
  "trellis-research",
];

const pythonCmd =
  process.env.PYTHON_CMD || (process.platform === "win32" ? "python" : "python3");

function cleanHookEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) =>
        !k.endsWith("_PROJECT_DIR") &&
        k !== "TRELLIS_CONTEXT_ID" &&
        k !== "TRELLIS_HOOKS" &&
        k !== "TRELLIS_DISABLE_HOOKS",
    ),
  );
}

describe("antigravity plugin templates", () => {
  it("exposes a valid AGY plugin manifest", () => {
    const manifest = JSON.parse(getPluginManifest()) as Record<string, unknown>;
    expect(manifest.name).toBe("trellis");
    expect(manifest.displayName).toBe("Trellis");
    expect(typeof manifest.version).toBe("string");
    expect(typeof manifest.description).toBe("string");
  });

  it("wires SessionStart, PreInvocation, and PreToolUse (run_command + invoke_subagent) in hooks.json", () => {
    const cfg = getHooksConfig();
    expect(cfg.targetPath).toBe("hooks.json");
    const parsed = JSON.parse(cfg.content) as {
      trellis: {
        SessionStart: { type: string; command: string; timeout: number }[];
        PreInvocation: { type: string; command: string; timeout: number }[];
        PreToolUse: {
          matcher: string;
          hooks: { type: string; command: string; timeout: number }[];
        }[];
      };
    };

    expect(parsed.trellis).toBeDefined();
    expect(parsed.trellis.SessionStart).toEqual([
      {
        type: "command",
        command: "{{PYTHON_CMD}} ./hooks/session-start.py",
        timeout: 30,
      },
    ]);
    expect(parsed.trellis.PreInvocation).toEqual([
      {
        type: "command",
        command: "{{PYTHON_CMD}} ./hooks/inject-workflow-state.py",
        timeout: 15,
      },
    ]);
    expect(parsed.trellis.PreToolUse).toEqual([
      {
        matcher: "run_command",
        hooks: [
          {
            type: "command",
            command: "{{PYTHON_CMD}} ./hooks/inject-shell-session-context.py",
            timeout: 5,
          },
        ],
      },
      {
        matcher: "invoke_subagent",
        hooks: [
          {
            type: "command",
            command: "{{PYTHON_CMD}} ./hooks/inject-subagent-context.py",
            timeout: 30,
          },
        ],
      },
    ]);
  });

  it("returns the expected custom subagents with AGY frontmatter and class-1 fallback protocol", () => {
    const agents = getAllAgents();
    expect(agents.map((a) => a.name)).toEqual(EXPECTED_AGENT_NAMES);

    for (const agent of agents) {
      const content = agent.content.replace(/\r\n/g, "\n");
      expect(content).toMatch(/^---\n/);
      expect(content).toContain(`name: ${agent.name}`);
      expect(content).toContain("subagent: true");
      expect(content).toContain("mainAgent: false");
      expect(content).toContain("model: inherit");
      if (
        agent.name === "trellis-implement" ||
        agent.name === "trellis-check"
      ) {
        expect(content).toContain("<!-- trellis-hook-injected -->");
        expect(content).toContain("Trellis Context Loading Protocol");
        expect(content).not.toContain("Load Trellis Context First");
      } else {
        expect(content).toContain("{TASK_DIR}/research/");
      }
    }
  });

  it("collectAntigravityTemplates ships plugin files, workflows, and bundled skills", () => {
    const files = collectAntigravityTemplates();

    expect(AI_TOOLS.antigravity.hasPythonHooks).toBe(true);
    expect(AI_TOOLS.antigravity.templateContext.hasHooks).toBe(true);
    expect(AI_TOOLS.antigravity.templateContext.agentCapable).toBe(true);

    expect(files.has(".agents/plugins/trellis/plugin.json")).toBe(true);
    expect(files.has(".agents/plugins/trellis/hooks.json")).toBe(true);
    expect(files.has(".agents/plugins/trellis/hooks/session-start.py")).toBe(true);
    expect(
      files.has(".agents/plugins/trellis/hooks/inject-workflow-state.py"),
    ).toBe(true);
    expect(
      files.has(".agents/plugins/trellis/hooks/inject-shell-session-context.py"),
    ).toBe(true);
    expect(
      files.has(".agents/plugins/trellis/hooks/inject-subagent-context.py"),
    ).toBe(true);
    expect(
      files.has(".agents/plugins/trellis/agents/trellis-implement.md"),
    ).toBe(true);
    expect(
      files.has(".agents/plugins/trellis/agents/trellis-check.md"),
    ).toBe(true);
    expect(
      files.has(".agents/plugins/trellis/agents/trellis-research.md"),
    ).toBe(true);
    expect(
      files.has(
        ".agent/skills/trellis-meta/references/local-architecture/overview.md",
      ),
    ).toBe(true);
    // SessionStart hook replaces manual start.md workflow
    expect(files.has(".agent/workflows/start.md")).toBe(false);
    expect(files.has(".agent/workflows/continue.md")).toBe(true);
    expect(files.has(".agent/workflows/finish-work.md")).toBe(true);
  });
});

describe("antigravity plugin hooks runtime contract", () => {
  let tmpDir: string;
  let pluginDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-agy-hooks-"));
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });

    // Stage .trellis/scripts + workflow.md + sample task + spec
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
    fs.writeFileSync(
      path.join(tmpDir, ".trellis", ".developer"),
      "name=tester\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(tmpDir, ".trellis", "spec", "guides"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tmpDir, ".trellis", "spec", "guides", "index.md"),
      "# Guides\nFollow AGY spec.\n",
      "utf-8",
    );

    const taskDir = path.join(tmpDir, ".trellis", "tasks", "01-agy-demo");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "task.json"),
      JSON.stringify({
        id: "01-agy-demo",
        title: "AGY Plugin Demo",
        status: "in_progress",
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(taskDir, "prd.md"),
      "# PRD\nImplement AGY hooks.\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(taskDir, "implement.jsonl"),
      `${JSON.stringify({ file: ".trellis/spec/guides/index.md", reason: "core guide" })}\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(taskDir, "check.jsonl"),
      `${JSON.stringify({ file: ".trellis/spec/guides/index.md", reason: "check guide" })}\n`,
      "utf-8",
    );

    // Stage AGY plugin from collected templates
    const templates = collectAntigravityTemplates();
    for (const [relPath, content] of templates) {
      const target = path.join(tmpDir, ...relPath.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf-8");
    }
    pluginDir = path.join(tmpDir, ".agents", "plugins", "trellis");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function runHook(
    scriptName: string,
    payload: Record<string, unknown>,
    cwd = pluginDir,
    scriptOverride?: string,
  ): string {
    const scriptPath =
      scriptOverride ?? path.join(pluginDir, "hooks", scriptName);
    return execFileSync(pythonCmd, [scriptPath], {
      cwd,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: cleanHookEnv(),
    });
  }

  it("SessionStart returns AGY injectSteps envelope and fails open on non-Trellis workspaces", () => {
    const out = runHook("session-start.py", {
      conversationId: "conv-agy-1",
      workspacePaths: [tmpDir],
      artifactDirectoryPath: path.join(tmpDir, ".artifacts"),
      hookEventName: "SessionStart",
      cwd: tmpDir,
    });
    const parsed = JSON.parse(out) as {
      injectSteps: { systemMessage: { systemMessage: string } }[];
    };
    expect(parsed.injectSteps).toHaveLength(1);
    expect(parsed.injectSteps[0].systemMessage.systemMessage).toContain(
      "<session-context>",
    );
    expect(parsed.injectSteps[0].systemMessage.systemMessage).toContain(
      "<trellis-workflow>",
    );

    // Non-Trellis workspace (e.g. globally installed plugin): returns {}
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "non-trellis-"));
    try {
      const emptyOut = runHook("session-start.py", {
        conversationId: "conv-agy-empty",
        workspacePaths: [emptyDir],
        artifactDirectoryPath: path.join(emptyDir, ".artifacts"),
        hookEventName: "SessionStart",
        cwd: emptyDir,
      });
      expect(JSON.parse(emptyOut)).toEqual({});
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("PreInvocation injects workflow-state on invocationNum=0, skips mid-turn loops and skip keyword", () => {
    const sessionDir = path.join(tmpDir, ".trellis", ".runtime", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "antigravity_conv-agy-2.json"),
      JSON.stringify({
        platform: "antigravity",
        current_task: ".trellis/tasks/01-agy-demo",
      }),
      "utf-8",
    );

    const out0 = runHook("inject-workflow-state.py", {
      conversationId: "conv-agy-2",
      workspacePaths: [tmpDir],
      artifactDirectoryPath: path.join(tmpDir, ".artifacts"),
      hookEventName: "PreInvocation",
      invocationNum: 0,
      lastUserInput: "continue working on the feature",
      cwd: tmpDir,
    });
    const parsed0 = JSON.parse(out0) as {
      injectSteps: { systemMessage: { systemMessage: string } }[];
    };
    expect(parsed0.injectSteps).toHaveLength(1);
    const msg = parsed0.injectSteps[0].systemMessage.systemMessage;
    expect(msg).toContain("<workflow-state>");
    expect(msg).toContain("Task: 01-agy-demo (in_progress)");

    // Mid-turn invocation (> 0) returns {} so tool loops do not duplicate steps
    const out1 = runHook("inject-workflow-state.py", {
      conversationId: "conv-agy-2",
      workspacePaths: [tmpDir],
      artifactDirectoryPath: path.join(tmpDir, ".artifacts"),
      hookEventName: "PreInvocation",
      invocationNum: 1,
      lastUserInput: "continue working on the feature",
      cwd: tmpDir,
    });
    expect(JSON.parse(out1)).toEqual({});

    // Skip keyword in lastUserInput opts out cleanly with {}
    const outSkip = runHook("inject-workflow-state.py", {
      conversationId: "conv-agy-2",
      workspacePaths: [tmpDir],
      artifactDirectoryPath: path.join(tmpDir, ".artifacts"),
      hookEventName: "PreInvocation",
      invocationNum: 0,
      lastUserInput: "quick question no-trellis",
      cwd: tmpDir,
    });
    expect(JSON.parse(outSkip)).toEqual({});
  });

  it("PreToolUse run_command writes shell ticket for task.py and always returns allow", () => {
    const outNonTask = runHook("inject-shell-session-context.py", {
      conversationId: "conv-agy-3",
      workspacePaths: [tmpDir],
      cwd: tmpDir,
      hookEventName: "PreToolUse",
      toolCall: {
        id: "toolu_1",
        name: "run_command",
        args: { CommandLine: "git status", Cwd: tmpDir },
      },
    });
    expect(JSON.parse(outNonTask)).toEqual({ decision: "allow" });
    expect(
      fs.existsSync(path.join(tmpDir, ".trellis", ".runtime", "shell-tickets")),
    ).toBe(false);

    const outTask = runHook("inject-shell-session-context.py", {
      conversationId: "conv-agy-3",
      workspacePaths: [tmpDir],
      cwd: tmpDir,
      hookEventName: "PreToolUse",
      toolCall: {
        id: "toolu_2",
        name: "run_command",
        args: {
          CommandLine: `${pythonCmd} ./.trellis/scripts/task.py start .trellis/tasks/01-agy-demo`,
          Cwd: tmpDir,
        },
      },
    });
    expect(JSON.parse(outTask)).toEqual({ decision: "allow" });

    const ticketDir = path.join(tmpDir, ".trellis", ".runtime", "shell-tickets");
    const [ticketFile] = fs.readdirSync(ticketDir);
    const ticket = JSON.parse(
      fs.readFileSync(path.join(ticketDir, ticketFile), "utf-8"),
    ) as { platform: string; context_key: string; conversation_id: string };
    expect(ticket.platform).toBe("antigravity");
    expect(ticket.context_key).toBe("antigravity_conv-agy-3");
    expect(ticket.conversation_id).toBe("conv-agy-3");
  });

  it("PreToolUse invoke_subagent overwrites Prompt (single) and Subagents (batch), and passes through non-Trellis agents", () => {
    const sessionDir = path.join(tmpDir, ".trellis", ".runtime", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "antigravity_conv-agy-4.json"),
      JSON.stringify({
        platform: "antigravity",
        current_task: ".trellis/tasks/01-agy-demo",
      }),
      "utf-8",
    );

    // Single-subagent shape (CLI schema)
    const outSingle = runHook("inject-subagent-context.py", {
      conversationId: "conv-agy-4",
      workspacePaths: [tmpDir],
      cwd: tmpDir,
      hookEventName: "PreToolUse",
      toolCall: {
        id: "toolu_sub_1",
        name: "invoke_subagent",
        args: {
          TypeName: "trellis-implement",
          Role: "Implement Agent",
          Prompt: "Implement the feature",
        },
      },
    });
    const parsedSingle = JSON.parse(outSingle) as {
      decision: string;
      overwrite?: { Prompt?: string };
    };
    expect(parsedSingle.decision).toBe("allow");
    expect(parsedSingle.overwrite?.Prompt).toContain(
      "<!-- trellis-hook-injected -->",
    );
    expect(parsedSingle.overwrite?.Prompt).toContain("Follow AGY spec.");
    expect(parsedSingle.overwrite?.Prompt).toContain("Implement AGY hooks.");

    // Batch `Subagents` array shape (documented AGY hooks schema)
    const outBatch = runHook("inject-subagent-context.py", {
      conversationId: "conv-agy-4",
      workspacePaths: [tmpDir],
      cwd: tmpDir,
      hookEventName: "PreToolUse",
      toolCall: {
        id: "toolu_sub_2",
        name: "invoke_subagent",
        args: {
          Subagents: [
            {
              TypeName: "trellis-check",
              Role: "Check Agent",
              Prompt: "Check my changes",
            },
            {
              TypeName: "research",
              Role: "Built-in Researcher",
              Prompt: "Leave untouched",
            },
          ],
        },
      },
    });
    const parsedBatch = JSON.parse(outBatch) as {
      decision: string;
      overwrite?: { Subagents?: { TypeName: string; Prompt: string }[] };
    };
    expect(parsedBatch.decision).toBe("allow");
    expect(parsedBatch.overwrite?.Subagents).toHaveLength(2);
    expect(parsedBatch.overwrite?.Subagents?.[0].Prompt).toContain(
      "<!-- trellis-hook-injected -->",
    );
    expect(parsedBatch.overwrite?.Subagents?.[1].Prompt).toBe("Leave untouched");

    // Non-Trellis subagent passes through with no overwrite
    const outPass = runHook("inject-subagent-context.py", {
      conversationId: "conv-agy-4",
      workspacePaths: [tmpDir],
      cwd: tmpDir,
      hookEventName: "PreToolUse",
      toolCall: {
        id: "toolu_sub_3",
        name: "invoke_subagent",
        args: {
          TypeName: "self",
          Role: "Helper",
          Prompt: "Do something",
        },
      },
    });
    expect(JSON.parse(outPass)).toEqual({ decision: "allow" });
  });

  it("detects antigravity (not gemini) even when hooks are installed globally under ~/.gemini/config/plugins/trellis/", () => {
    const fakeGlobalHooksDir = path.join(
      tmpDir,
      "home",
      ".gemini",
      "config",
      "plugins",
      "trellis",
      "hooks",
    );
    fs.mkdirSync(fakeGlobalHooksDir, { recursive: true });
    const src = fs.readFileSync(
      path.join(pluginDir, "hooks", "inject-workflow-state.py"),
      "utf-8",
    );
    const globalScript = path.join(
      fakeGlobalHooksDir,
      "inject-workflow-state.py",
    );
    fs.writeFileSync(globalScript, src, "utf-8");

    const out = runHook(
      "inject-workflow-state.py",
      {
        conversationId: "conv-global-1",
        workspacePaths: [tmpDir],
        artifactDirectoryPath: path.join(tmpDir, ".artifacts"),
        hookEventName: "PreInvocation",
        invocationNum: 0,
        cwd: tmpDir,
      },
      path.dirname(fakeGlobalHooksDir),
      globalScript,
    );
    const parsed = JSON.parse(out) as {
      injectSteps?: { systemMessage?: { systemMessage?: string } }[];
      hookSpecificOutput?: unknown;
    };
    expect(parsed.injectSteps).toHaveLength(1);
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });
});
