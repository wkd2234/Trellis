import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createChannel } from "../../src/commands/channel/create.js";
import { channelKill } from "../../src/commands/channel/kill.js";
import { channelSend } from "../../src/commands/channel/send.js";
import { channelSpawn } from "../../src/commands/channel/spawn.js";
import { readChannelEvents } from "../../src/commands/channel/store/events.js";
import {
  eventsPath,
  projectKey,
  workerFile,
} from "../../src/commands/channel/store/paths.js";

const noop = (): void => undefined;

function writeStubSupervisor(
  dir: string,
  name: string,
  body: string,
): string {
  const scriptPath = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(scriptPath, body, "utf-8");
  return scriptPath;
}

describe("channelSpawn readiness, stderr capture, and foreground mode", () => {
  let tmpDir: string;
  let projectDir: string;
  let oldRoot: string | undefined;
  let oldProject: string | undefined;
  let oldPath: string | undefined;
  const spawnedPids: number[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "trellis-channel-spawn-test-"),
    );
    projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(projectDir);
    oldRoot = process.env.TRELLIS_CHANNEL_ROOT;
    oldProject = process.env.TRELLIS_CHANNEL_PROJECT;
    oldPath = process.env.PATH;
    process.env.TRELLIS_CHANNEL_ROOT = path.join(tmpDir, "channels");
    delete process.env.TRELLIS_CHANNEL_PROJECT;
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
  });

  afterEach(() => {
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already dead
      }
    }
    vi.restoreAllMocks();
    if (oldRoot === undefined) delete process.env.TRELLIS_CHANNEL_ROOT;
    else process.env.TRELLIS_CHANNEL_ROOT = oldRoot;
    if (oldProject === undefined) delete process.env.TRELLIS_CHANNEL_PROJECT;
    else process.env.TRELLIS_CHANNEL_PROJECT = oldProject;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    process.exitCode = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("waits for durable spawned event so immediate strict send does not race", async () => {
    await createChannel("ready-race", { by: "main" });
    const proj = projectKey(projectDir);
    const evFile = eventsPath("ready-race", proj);

    const stub = writeStubSupervisor(
      tmpDir,
      "delayed-spawned",
      `
import fs from "node:fs";
const evFile = ${JSON.stringify(evFile)};
setTimeout(() => {
  const ev = {
    seq: 2,
    ts: new Date().toISOString(),
    kind: "spawned",
    by: "main",
    as: "cx-ready",
    provider: "codex",
    pid: process.pid,
    inboxPolicy: "explicitOnly",
  };
  fs.appendFileSync(evFile, JSON.stringify(ev) + "\\n");
}, 200);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );

    const res = await channelSpawn("ready-race", {
      provider: "codex",
      as: "cx-ready",
      cwd: projectDir,
      readyTimeoutMs: 5_000,
      supervisorLaunch: {
        command: process.execPath,
        args: () => [stub],
      },
    });
    spawnedPids.push(res.pid);

    const eventsBeforeSend = await readChannelEvents("ready-race", proj);
    expect(
      eventsBeforeSend.some(
        (e) => e.kind === "spawned" && e.as === "cx-ready",
      ),
    ).toBe(true);

    // Must succeed immediately with zero sleep and zero undeliverable events.
    await channelSend("ready-race", {
      as: "main",
      to: "cx-ready",
      text: "hello immediately after spawn",
      deliveryMode: "requireRunningWorker",
    });

    const eventsAfterSend = await readChannelEvents("ready-race", proj);
    expect(eventsAfterSend.some((e) => e.kind === "undeliverable")).toBe(false);

    await channelKill("ready-race", { as: "cx-ready", force: true });
  });

  it("captures startup stderr into worker log and rejects when supervisor exits before spawned", async () => {
    await createChannel("early-crash", { by: "main" });
    vi.mocked(console.log).mockClear();
    const proj = projectKey(projectDir);

    const stub = writeStubSupervisor(
      tmpDir,
      "crash-early",
      `
process.stderr.write("fatal bootstrap failure: missing runtime dep\\n");
process.exit(1);
`,
    );

    await expect(
      channelSpawn("early-crash", {
        provider: "codex",
        as: "cx-crash",
        cwd: projectDir,
        readyTimeoutMs: 3_000,
        supervisorLaunch: {
          command: process.execPath,
          args: () => [stub],
        },
      }),
    ).rejects.toThrow(/fatal bootstrap failure: missing runtime dep/);

    // Must not print fake success JSON.
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();

    // Forensic log is preserved with stderr; ephemeral sidecars are cleaned up.
    const logPath = workerFile("early-crash", "cx-crash", "log", proj);
    expect(fs.readFileSync(logPath, "utf-8")).toContain(
      "fatal bootstrap failure: missing runtime dep",
    );
    expect(
      fs.existsSync(workerFile("early-crash", "cx-crash", "pid", proj)),
    ).toBe(false);
    expect(
      fs.existsSync(workerFile("early-crash", "cx-crash", "config", proj)),
    ).toBe(false);
    expect(
      fs.existsSync(workerFile("early-crash", "cx-crash", "reservation", proj)),
    ).toBe(false);
  });

  it("rejects with supervisor error event when provider launch fails", async () => {
    await createChannel("provider-error", { by: "main" });
    const proj = projectKey(projectDir);
    const evFile = eventsPath("provider-error", proj);

    const stub = writeStubSupervisor(
      tmpDir,
      "emit-error",
      `
import fs from "node:fs";
const evFile = ${JSON.stringify(evFile)};
const ev = {
  seq: 2,
  ts: new Date().toISOString(),
  kind: "error",
  by: "supervisor:cx-enoent",
  message: "worker spawn failed: spawn codex ENOENT",
  provider: "codex",
};
fs.appendFileSync(evFile, JSON.stringify(ev) + "\\n");
process.exit(1);
`,
    );

    await expect(
      channelSpawn("provider-error", {
        provider: "codex",
        as: "cx-enoent",
        cwd: projectDir,
        readyTimeoutMs: 3_000,
        supervisorLaunch: {
          command: process.execPath,
          args: () => [stub],
        },
      }),
    ).rejects.toThrow(/worker spawn failed: spawn codex ENOENT/);

    expect(
      fs.existsSync(workerFile("provider-error", "cx-enoent", "pid", proj)),
    ).toBe(false);
  });

  it("times out and cleans up when supervisor hangs without emitting spawned", async () => {
    await createChannel("hang-startup", { by: "main" });
    const proj = projectKey(projectDir);

    const stub = writeStubSupervisor(
      tmpDir,
      "hang-forever",
      `
process.stderr.write("waiting forever...\\n");
setInterval(() => {}, 1000);
`,
    );

    await expect(
      channelSpawn("hang-startup", {
        provider: "codex",
        as: "cx-hang",
        cwd: projectDir,
        readyTimeoutMs: 250,
        supervisorLaunch: {
          command: process.execPath,
          args: () => [stub],
        },
      }),
    ).rejects.toThrow(/Timed out after 250ms.*waiting forever/s);

    expect(
      fs.existsSync(workerFile("hang-startup", "cx-hang", "pid", proj)),
    ).toBe(false);
    expect(
      fs.existsSync(workerFile("hang-startup", "cx-hang", "reservation", proj)),
    ).toBe(false);
  });

  it("keeps supervisor attached in --foreground mode, releases spawn lock on ready, and exits when killed", async () => {
    await createChannel("fg-chan", { by: "main" });
    vi.mocked(console.log).mockClear();
    const proj = projectKey(projectDir);
    const evFile = eventsPath("fg-chan", proj);

    const stub = writeStubSupervisor(
      tmpDir,
      "fg-worker",
      `
import fs from "node:fs";
const evFile = ${JSON.stringify(evFile)};
const ev = {
  seq: 2,
  ts: new Date().toISOString(),
  kind: "spawned",
  by: "main",
  as: "cx-fg",
  provider: "codex",
  pid: process.pid,
  inboxPolicy: "explicitOnly",
};
fs.appendFileSync(evFile, JSON.stringify(ev) + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );

    let settled = false;
    const fgPromise = channelSpawn("fg-chan", {
      provider: "codex",
      as: "cx-fg",
      cwd: projectDir,
      foreground: true,
      readyTimeoutMs: 5_000,
      supervisorLaunch: {
        command: process.execPath,
        args: () => [stub],
      },
    }).finally(() => {
      settled = true;
    });

    // Wait for ready JSON to be emitted on stdout while foreground stays alive.
    await vi.waitUntil(() => vi.mocked(console.log).mock.calls.length > 0, {
      timeout: 4_000,
    });
    const readyPayload = JSON.parse(
      String(vi.mocked(console.log).mock.calls[0]?.[0]),
    ) as { pid: number; worker: string; log: string };
    spawnedPids.push(readyPayload.pid);
    expect(readyPayload.worker).toBe("cx-fg");
    expect(settled).toBe(false);

    // Locks are released once ready, so strict send and kill both work concurrently.
    await channelSend("fg-chan", {
      as: "main",
      to: "cx-fg",
      text: "work in foreground",
      deliveryMode: "requireRunningWorker",
    });

    await channelKill("fg-chan", { as: "cx-fg", force: true });
    const result = await fgPromise;
    expect(result.worker).toBe("cx-fg");
    expect(settled).toBe(true);
  });

  it("boots real supervisor entry end-to-end with a stubbed codex shim", async () => {
    const realBuiltCli = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "dist",
      "cli",
      "index.js",
    );
    expect(fs.existsSync(realBuiltCli)).toBe(true);

    // Create a local node_modules/.bin codex shim so resolveProviderPath()
    // spawns our fast stub instead of a real network CLI.
    const binDir = path.join(projectDir, "node_modules", ".bin");
    const fakePkgDir = path.join(binDir, "node_modules", "fake-codex");
    fs.mkdirSync(fakePkgDir, { recursive: true });
    const fakeCodexJs = path.join(fakePkgDir, "codex.js");
    fs.writeFileSync(
      fakeCodexJs,
      `
process.stdin.resume();
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf-8",
    );
    if (process.platform === "win32") {
      fs.writeFileSync(
        path.join(binDir, "codex.cmd"),
        `"%_prog%"  "%dp0%\\node_modules\\fake-codex\\codex.js" %*\r\n`,
        "utf-8",
      );
    } else {
      const shPath = path.join(binDir, "codex");
      fs.writeFileSync(
        shPath,
        `#!/bin/sh\nexec "${process.execPath}" "${fakeCodexJs}" "$@"\n`,
        { mode: 0o755 },
      );
      process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    }

    await createChannel("real-supervisor", { by: "main" });
    const proj = projectKey(projectDir);

    const res = await channelSpawn("real-supervisor", {
      provider: "codex",
      as: "cx-real",
      cwd: projectDir,
      readyTimeoutMs: 10_000,
    });
    spawnedPids.push(res.pid);

    const events = await readChannelEvents("real-supervisor", proj);
    expect(events.some((e) => e.kind === "spawned" && e.as === "cx-real")).toBe(
      true,
    );
    expect(fs.readFileSync(res.log, "utf-8")).toContain(
      "[supervisor] starting codex",
    );

    await channelSend("real-supervisor", {
      as: "main",
      to: "cx-real",
      text: "ready check",
      deliveryMode: "requireRunningWorker",
    });

    await channelKill("real-supervisor", { as: "cx-real", force: true });
  });
});
