import { describe, expect, it, vi } from "vitest";
import {
  buildReleaseTarballUrl,
  buildUpgradeCommand,
  resolveUpgradeTag,
  upgrade,
} from "../../src/commands/upgrade.js";

describe("upgrade command", () => {
  it("defaults stable and prerelease versions to latest", () => {
    expect(resolveUpgradeTag("0.5.12")).toBe("latest");
    expect(resolveUpgradeTag("0.6.17-agy.1")).toBe("latest");
  });

  it("normalizes explicit release tags and versions with leading v", () => {
    expect(resolveUpgradeTag("0.6.17", "latest")).toBe("latest");
    expect(resolveUpgradeTag("0.6.17", "v0.6.18")).toBe("v0.6.18");
    expect(resolveUpgradeTag("0.6.17", "0.6.17-agy.1")).toBe("v0.6.17-agy.1");
  });

  it("rejects shell-shaped tags", () => {
    expect(() => resolveUpgradeTag("0.5.12", "latest && rm -rf /")).toThrow(
      /Invalid release tag\/version/,
    );
  });

  it("builds GitHub Release tarball URLs for latest and tagged releases", () => {
    expect(buildReleaseTarballUrl("latest", "wkd2234/Trellis")).toBe(
      "https://github.com/wkd2234/Trellis/releases/latest/download/trellis-cli.tgz",
    );
    expect(buildReleaseTarballUrl("v0.6.17-agy.1", "wkd2234/Trellis")).toBe(
      "https://github.com/wkd2234/Trellis/releases/download/v0.6.17-agy.1/trellis-cli.tgz",
    );
  });

  it("builds POSIX npm global install command without shell", () => {
    expect(
      buildUpgradeCommand(
        { tag: "v0.6.18" },
        "0.6.17",
        "darwin",
        "wkd2234/Trellis",
      ),
    ).toMatchObject({
      command: "npm",
      args: [
        "install",
        "-g",
        "https://github.com/wkd2234/Trellis/releases/download/v0.6.18/trellis-cli.tgz",
      ],
      spawnOptions: { stdio: "inherit", shell: false },
      displayCommand:
        "npm install -g https://github.com/wkd2234/Trellis/releases/download/v0.6.18/trellis-cli.tgz",
      target:
        "https://github.com/wkd2234/Trellis/releases/download/v0.6.18/trellis-cli.tgz",
      tag: "v0.6.18",
      binaryCheckCommand: "which trellis",
    });
  });

  it("builds Windows command through cmd.exe", () => {
    expect(
      buildUpgradeCommand(
        { tag: "latest" },
        "0.6.17",
        "win32",
        "wkd2234/Trellis",
      ),
    ).toMatchObject({
      command: "cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "npm install -g https://github.com/wkd2234/Trellis/releases/latest/download/trellis-cli.tgz",
      ],
      spawnOptions: { stdio: "inherit", shell: false },
      displayCommand:
        "npm install -g https://github.com/wkd2234/Trellis/releases/latest/download/trellis-cli.tgz",
      target:
        "https://github.com/wkd2234/Trellis/releases/latest/download/trellis-cli.tgz",
      tag: "latest",
      binaryCheckCommand: "where trellis",
    });
  });

  it("dry-run does not execute npm", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runner = vi.fn();

    await upgrade({ dryRun: true, tag: "latest" }, runner);

    expect(runner).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Run: npm install -g https://github.com/wkd2234/Trellis/releases/latest/download/trellis-cli.tgz",
      ),
    );

    log.mockRestore();
  });

  it("executes npm install for real upgrades", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runner = vi.fn(() => ({ status: 0, signal: null }));

    await upgrade({ tag: "latest" }, runner);

    const expectedUrl =
      "https://github.com/wkd2234/Trellis/releases/latest/download/trellis-cli.tgz";
    if (process.platform === "win32") {
      expect(runner).toHaveBeenCalledWith(
        "cmd.exe",
        ["/d", "/s", "/c", `npm install -g ${expectedUrl}`],
        { stdio: "inherit", shell: false },
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("where trellis"),
      );
    } else {
      expect(runner).toHaveBeenCalledWith(
        "npm",
        ["install", "-g", expectedUrl],
        { stdio: "inherit", shell: false },
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("which trellis"),
      );
    }
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("trellis --version"),
    );

    log.mockRestore();
  });

  it("fails when npm exits non-zero", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const runner = vi.fn(() => ({ status: 1, signal: null }));

    await expect(upgrade({ tag: "latest" }, runner)).rejects.toThrow(
      /npm install failed with exit code 1\.[\s\S]*Troubleshooting:[\s\S]*Manual command: npm install -g https:\/\/github\.com\/wkd2234\/Trellis\/releases\/latest\/download\/trellis-cli\.tgz[\s\S]*npm config get prefix/,
    );

    log.mockRestore();
  });
});
