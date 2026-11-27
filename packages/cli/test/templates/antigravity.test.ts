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

  it("wires SessionStart, PreInvocation, PreToolUse, and Stop in hooks.json", () => {
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
        Stop: { type: string; command: string; timeout: number }[];
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
    expect(parsed.trellis.Stop).toEqual([
      {
        type: "command",
        command: "{{PYTHON_CMD}} ./hooks/compaction-doc-sync.py",
        timeout: 15,
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
      files.has(".agents/plugins/trellis/hooks/compaction-doc-sync.py"),
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

  it("shell-ticket bridge supports task.py create (skipping --no-start) so planning state activates immediately", () => {
    const taskScript = path.join(tmpDir, ".trellis", "scripts", "task.py");

    // 1. `create --no-start` must NOT write a shell ticket.
    const outNoStart = runHook("inject-shell-session-context.py", {
      conversationId: "conv-create-1",
      workspacePaths: [tmpDir],
      cwd: tmpDir,
      hookEventName: "PreToolUse",
      toolCall: {
        id: "toolu_create_0",
        name: "run_command",
        args: {
          CommandLine: `${pythonCmd} ./.trellis/scripts/task.py create "No Start Task" --slug no-start-demo --no-start`,
          Cwd: tmpDir,
        },
      },
    });
    expect(JSON.parse(outNoStart)).toEqual({ decision: "allow" });
    expect(
      fs.existsSync(path.join(tmpDir, ".trellis", ".runtime", "shell-tickets")),
    ).toBe(false);

    // 2. Normal `create` (even chained with `; git status`) writes a create ticket
    //    and real `task.py create` consumes it to activate the planning pointer.
    const outCreate = runHook("inject-shell-session-context.py", {
      conversationId: "conv-create-1",
      workspacePaths: [tmpDir],
      cwd: tmpDir,
      hookEventName: "PreToolUse",
      toolCall: {
        id: "toolu_create_1",
        name: "run_command",
        args: {
          CommandLine: `${pythonCmd} ./.trellis/scripts/task.py create "AGY; Planning && Demo" --description "Demo planning task" --slug agy-plan; git status`,
          Cwd: tmpDir,
        },
      },
    });
    expect(JSON.parse(outCreate)).toEqual({ decision: "allow" });

    execFileSync(
      pythonCmd,
      [
        taskScript,
        "create",
        "AGY; Planning && Demo",
        "--description",
        "Demo planning task",
        "--slug",
        "agy-plan",
      ],
      { cwd: tmpDir, encoding: "utf-8", env: cleanHookEnv() },
    );

    const sessionFile = path.join(
      tmpDir,
      ".trellis",
      ".runtime",
      "sessions",
      "antigravity_conv-create-1.json",
    );
    expect(fs.existsSync(sessionFile)).toBe(true);
    const sessionData = JSON.parse(fs.readFileSync(sessionFile, "utf-8")) as {
      current_task: string;
    };
    expect(sessionData.current_task).toContain("agy-plan");

    // PreInvocation immediately sees planning state instead of no_task.
    const wfOut = runHook("inject-workflow-state.py", {
      conversationId: "conv-create-1",
      workspacePaths: [tmpDir],
      artifactDirectoryPath: path.join(tmpDir, ".artifacts"),
      hookEventName: "PreInvocation",
      invocationNum: 0,
      lastUserInput: "write the prd",
      cwd: tmpDir,
    });
    const wfParsed = JSON.parse(wfOut) as {
      injectSteps: { systemMessage: { systemMessage: string } }[];
    };
    expect(wfParsed.injectSteps[0].systemMessage.systemMessage).toContain(
      "agy-plan (planning)",
    );
  });

  it("shell-ticket bridge strips compound shell separators (; && || {}) so chained task.py start/current/finish work", () => {
    const taskScript = path.join(tmpDir, ".trellis", "scripts", "task.py");

    const outCompound = runHook("inject-shell-session-context.py", {
      conversationId: "conv-compound-1",
      workspacePaths: [tmpDir],
      cwd: tmpDir,
      hookEventName: "PreToolUse",
      toolCall: {
        id: "toolu_compound_1",
        name: "run_command",
        args: {
          CommandLine:
            `${pythonCmd} ./.trellis/scripts/task.py start --allow-empty-context .trellis/tasks/01-agy-demo; ` +
            `if ($LASTEXITCODE -eq 0) { ${pythonCmd} ./.trellis/scripts/task.py current}; ` +
            `${pythonCmd} ./.trellis/scripts/task.py finish&& echo done`,
          Cwd: tmpDir,
        },
      },
    });
    expect(JSON.parse(outCompound)).toEqual({ decision: "allow" });

    const ticketDir = path.join(tmpDir, ".trellis", ".runtime", "shell-tickets");
    const [ticketFile] = fs.readdirSync(ticketDir);
    const ticket = JSON.parse(
      fs.readFileSync(path.join(ticketDir, ticketFile), "utf-8"),
    ) as { subcommands: { name: string; task_ref?: string }[] };
    expect(ticket.subcommands).toEqual([
      { name: "start", task_ref: ".trellis/tasks/01-agy-demo" },
      { name: "current" },
      { name: "finish" },
    ]);

    // Real task.py start / current / finish all match the ticket cleanly.
    const startOut = execFileSync(
      pythonCmd,
      [taskScript, "start", "--allow-empty-context", ".trellis/tasks/01-agy-demo"],
      { cwd: tmpDir, encoding: "utf-8", env: cleanHookEnv() },
    );
    expect(startOut).toContain("Source: session:antigravity_conv-compound-1");

    const currentOut = execFileSync(
      pythonCmd,
      [taskScript, "current", "--source"],
      { cwd: tmpDir, encoding: "utf-8", env: cleanHookEnv() },
    );
    expect(currentOut).toContain("Current task: .trellis/tasks/01-agy-demo");
    expect(currentOut).toContain("Source: session:antigravity_conv-compound-1");

    const finishOut = execFileSync(pythonCmd, [taskScript, "finish"], {
      cwd: tmpDir,
      encoding: "utf-8",
      env: cleanHookEnv(),
    });
    expect(finishOut).toContain("Cleared current task");
  });

  it("handles bare TRELLIS_CONTEXT_ID=<conversationId> without prefix mismatch or cross-session bleed", () => {
    const taskScript = path.join(tmpDir, ".trellis", "scripts", "task.py");
    const bareConvId = "bf44cf96-1111-2222-3333-444455556666";

    // Case A (no ticket): manual bare TRELLIS_CONTEXT_ID writes `<uuid>.json`,
    // and AGY PreInvocation hook still resolves it via exact-ID fallback.
    execFileSync(
      pythonCmd,
      [taskScript, "start", ".trellis/tasks/01-agy-demo"],
      {
        cwd: tmpDir,
        encoding: "utf-8",
        env: { ...cleanHookEnv(), TRELLIS_CONTEXT_ID: bareConvId },
      },
    );
    const bareSessionPath = path.join(
      tmpDir,
      ".trellis",
      ".runtime",
      "sessions",
      `${bareConvId}.json`,
    );
    expect(fs.existsSync(bareSessionPath)).toBe(true);

    const wfSame = runHook("inject-workflow-state.py", {
      conversationId: bareConvId,
      workspacePaths: [tmpDir],
      artifactDirectoryPath: path.join(tmpDir, ".artifacts"),
      hookEventName: "PreInvocation",
      invocationNum: 0,
      cwd: tmpDir,
    });
    expect(
      (
        JSON.parse(wfSame) as {
          injectSteps: { systemMessage: { systemMessage: string } }[];
        }
      ).injectSteps[0].systemMessage.systemMessage,
    ).toContain("Task: 01-agy-demo (in_progress)");

    // Different conversationId must NOT inherit the bare session file.
    const wfOther = runHook("inject-workflow-state.py", {
      conversationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      workspacePaths: [tmpDir],
      artifactDirectoryPath: path.join(tmpDir, ".artifacts"),
      hookEventName: "PreInvocation",
      invocationNum: 0,
      cwd: tmpDir,
    });
    expect(
      (
        JSON.parse(wfOther) as {
          injectSteps: { systemMessage: { systemMessage: string } }[];
        }
      ).injectSteps[0].systemMessage.systemMessage,
    ).toContain("Status: no_task");

    // Case B (with ticket): bare TRELLIS_CONTEXT_ID canonicalizes to
    // `antigravity_<uuid>.json` and removes the stale bare `<uuid>.json`.
    runHook("inject-shell-session-context.py", {
      conversationId: bareConvId,
      workspacePaths: [tmpDir],
      cwd: tmpDir,
      hookEventName: "PreToolUse",
      toolCall: {
        id: "toolu_bare_canon",
        name: "run_command",
        args: {
          CommandLine: `${pythonCmd} ./.trellis/scripts/task.py start .trellis/tasks/01-agy-demo`,
          Cwd: tmpDir,
        },
      },
    });
    const canonOut = execFileSync(
      pythonCmd,
      [taskScript, "start", ".trellis/tasks/01-agy-demo"],
      {
        cwd: tmpDir,
        encoding: "utf-8",
        env: { ...cleanHookEnv(), TRELLIS_CONTEXT_ID: bareConvId },
      },
    );
    expect(canonOut).toContain(`Source: session:antigravity_${bareConvId}`);
    expect(
      fs.existsSync(
        path.join(
          tmpDir,
          ".trellis",
          ".runtime",
          "sessions",
          `antigravity_${bareConvId}.json`,
        ),
      ),
    ).toBe(true);
    expect(fs.existsSync(bareSessionPath)).toBe(false);
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

  it("Stop hook triggers watermark doc check once, respects continuationActive, cooldown, and recent doc writes", () => {
    const sessionDir = path.join(tmpDir, ".trellis", ".runtime", "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "antigravity_conv-stop-1.json"),
      JSON.stringify({
        platform: "antigravity",
        current_task: ".trellis/tasks/01-agy-demo",
      }),
      "utf-8",
    );

    const transcriptPath = path.join(tmpDir, "transcript-agy.jsonl");
    const writeJsonl = (rows: Record<string, unknown>[]): void => {
      fs.writeFileSync(
        transcriptPath,
        rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf-8",
      );
    };

    // 1. Below watermark (40k + 30k = 70k < 120k): no-op `{}`
    writeJsonl([
      { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "q1" },
      { step_index: 1, type: "PLANNER_RESPONSE", input_tokens: 40000, cache_read_tokens: 30000 },
      { step_index: 2, type: "USER_INPUT", source: "USER_EXPLICIT", content: "q2" },
      { step_index: 3, type: "PLANNER_RESPONSE", input_tokens: 20000, cache_read_tokens: 55000 },
    ]);
    const lowOut = runHook("compaction-doc-sync.py", {
      conversationId: "conv-stop-1",
      workspacePaths: [tmpDir],
      transcriptPath,
      hookEventName: "Stop",
      terminationReason: "NO_TOOL_CALL",
      continuationActive: false,
      cwd: tmpDir,
    });
    expect(JSON.parse(lowOut)).toEqual({});

    // 2. Crosses watermark via input_tokens + cache_read_tokens (25k + 100k = 125k >= 120k)
    //    Writing to external `.gemini/.../scratch/` does NOT count as persisting repo docs.
    writeJsonl([
      { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "q1" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        input_tokens: 20000,
        cache_read_tokens: 40000,
        tool_calls: [
          {
            name: "write_file",
            args: { Path: JSON.stringify("C:/Users/me/.gemini/antigravity-cli/brain/x/scratch/note.md") },
          },
        ],
      },
      { step_index: 2, type: "USER_INPUT", source: "USER_EXPLICIT", content: "q2" },
      { step_index: 3, type: "PLANNER_RESPONSE", input_tokens: 25000, cache_read_tokens: 100000 },
    ]);

    // Guard check: if continuationActive is true, must no-op immediately
    const loopGuardOut = runHook("compaction-doc-sync.py", {
      conversationId: "conv-stop-1",
      workspacePaths: [tmpDir],
      transcriptPath,
      hookEventName: "Stop",
      terminationReason: "NO_TOOL_CALL",
      continuationActive: true,
      cwd: tmpDir,
    });
    expect(JSON.parse(loopGuardOut)).toEqual({});

    // Normal completion: emits `decision: "continue"` with active task scope
    const trigOut = runHook("compaction-doc-sync.py", {
      conversationId: "conv-stop-1",
      workspacePaths: [tmpDir],
      transcriptPath,
      hookEventName: "Stop",
      terminationReason: "NO_TOOL_CALL",
      continuationActive: false,
      cwd: tmpDir,
    });
    const trigParsed = JSON.parse(trigOut) as { decision?: string; reason?: string };
    expect(trigParsed.decision).toBe("continue");
    expect(trigParsed.reason).toContain("<pre-compact-doc-check>");
    expect(trigParsed.reason).toContain(".trellis/tasks/01-agy-demo");
    expect(trigParsed.reason).toContain(".trellis/spec/");

    // 3. Cooldown check: next turn at 135k (+10k < 50k cooldown) suppresses repeat
    writeJsonl([
      { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "q1" },
      { step_index: 2, type: "USER_INPUT", source: "USER_EXPLICIT", content: "q2" },
      { step_index: 4, type: "USER_INPUT", source: "USER_EXPLICIT", content: "q3" },
      { step_index: 5, type: "PLANNER_RESPONSE", input_tokens: 35000, cache_read_tokens: 100000 },
    ]);
    const cooldownOut = runHook("compaction-doc-sync.py", {
      conversationId: "conv-stop-1",
      workspacePaths: [tmpDir],
      transcriptPath,
      hookEventName: "Stop",
      terminationReason: "NO_TOOL_CALL",
      continuationActive: false,
      cwd: tmpDir,
    });
    expect(JSON.parse(cooldownOut)).toEqual({});

    // 4. Recent doc write suppression on a fresh session (`conv-stop-doc-written`):
    //    JSON-stringified `Path` pointing at repo `.trellis/tasks/01-agy-demo/prd.md` resets turn counter.
    const prdAbs = path.join(tmpDir, ".trellis", "tasks", "01-agy-demo", "prd.md");
    writeJsonl([
      { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "q1" },
      { step_index: 2, type: "USER_INPUT", source: "USER_EXPLICIT", content: "q2" },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        input_tokens: 30000,
        cache_read_tokens: 100000,
        tool_calls: [{ name: "write_file", args: { Path: JSON.stringify(prdAbs) } }],
      },
    ]);
    const recentDocOut = runHook("compaction-doc-sync.py", {
      conversationId: "conv-stop-doc-written",
      workspacePaths: [tmpDir],
      transcriptPath,
      hookEventName: "Stop",
      terminationReason: "NO_TOOL_CALL",
      continuationActive: false,
      cwd: tmpDir,
    });
    expect(JSON.parse(recentDocOut)).toEqual({});
  });

  it("PreInvocation injects one-shot <post-compact-doc-check> after a CHECKPOINT compaction boundary", () => {
    const transcriptPath = path.join(tmpDir, "transcript-compact.jsonl");
    const writeJsonl = (rows: Record<string, unknown>[]): void => {
      fs.writeFileSync(
        transcriptPath,
        rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
        "utf-8",
      );
    };

    // Turn 1 before compaction: normal workflow-state only
    writeJsonl([
      { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "start" },
      { step_index: 1, type: "PLANNER_RESPONSE", input_tokens: 50000, cache_read_tokens: 0 },
    ]);
    const turn1 = JSON.parse(
      runHook("inject-workflow-state.py", {
        conversationId: "conv-compact-agy",
        workspacePaths: [tmpDir],
        transcriptPath,
        hookEventName: "PreInvocation",
        invocationNum: 0,
        initialNumSteps: 6,
        cwd: tmpDir,
      }),
    ) as { injectSteps: { systemMessage: { systemMessage: string } }[] };
    expect(turn1.injectSteps[0].systemMessage.systemMessage).not.toContain(
      "<post-compact-doc-check>",
    );

    // Compaction writes a CHECKPOINT step; next user turn (invocationNum=0) receives one-shot check
    writeJsonl([
      { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "start" },
      { step_index: 1, type: "PLANNER_RESPONSE", input_tokens: 50000, cache_read_tokens: 0 },
      { step_index: 2, type: "CHECKPOINT", content: "Compacted summary" },
      { step_index: 3, type: "USER_INPUT", source: "USER_EXPLICIT", content: "next" },
    ]);
    const turn2 = JSON.parse(
      runHook("inject-workflow-state.py", {
        conversationId: "conv-compact-agy",
        workspacePaths: [tmpDir],
        transcriptPath,
        hookEventName: "PreInvocation",
        invocationNum: 0,
        initialNumSteps: 2,
        cwd: tmpDir,
      }),
    ) as { injectSteps: { systemMessage: { systemMessage: string } }[] };
    const msg2 = turn2.injectSteps[0].systemMessage.systemMessage;
    expect(msg2).toContain("<post-compact-doc-check>");
    expect(msg2).toContain(transcriptPath);
    expect(msg2).toContain("Active task: none (`no_task`)");
    expect(msg2).toContain("Do NOT create temporary scratch/handoff files");

    // Turn 3 after compaction (same CHECKPOINT): does NOT repeat <post-compact-doc-check>
    writeJsonl([
      { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "start" },
      { step_index: 1, type: "PLANNER_RESPONSE", input_tokens: 50000, cache_read_tokens: 0 },
      { step_index: 2, type: "CHECKPOINT", content: "Compacted summary" },
      { step_index: 3, type: "USER_INPUT", source: "USER_EXPLICIT", content: "next" },
      { step_index: 4, type: "PLANNER_RESPONSE", input_tokens: 12000, cache_read_tokens: 0 },
      { step_index: 5, type: "USER_INPUT", source: "USER_EXPLICIT", content: "follow up" },
    ]);
    const turn3 = JSON.parse(
      runHook("inject-workflow-state.py", {
        conversationId: "conv-compact-agy",
        workspacePaths: [tmpDir],
        transcriptPath,
        hookEventName: "PreInvocation",
        invocationNum: 0,
        initialNumSteps: 4,
        cwd: tmpDir,
      }),
    ) as { injectSteps: { systemMessage: { systemMessage: string } }[] };
    expect(turn3.injectSteps[0].systemMessage.systemMessage).not.toContain(
      "<post-compact-doc-check>",
    );
  });
});
