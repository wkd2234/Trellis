import { spawnSync } from "node:child_process";
import chalk from "chalk";
import { VERSION } from "../constants/version.js";

export const DEFAULT_UPGRADE_REPO = "wkd2234/Trellis";
export const RELEASE_ASSET_NAME = "trellis-cli.tgz";
export const DEFAULT_NPM_MIRROR_REGISTRY = "https://registry.npmmirror.com";

export function resolveUpgradeRepo(): string {
  const envRepo = process.env.TRELLIS_UPGRADE_REPO?.trim();
  if (envRepo && envRepo.length > 0) {
    return envRepo;
  }
  return DEFAULT_UPGRADE_REPO;
}

export const UPGRADE_REPO = resolveUpgradeRepo();

export interface UpgradeOptions {
  tag?: string;
  registry?: string | boolean;
  npmRegistry?: string | boolean;
  dryRun?: boolean;
}

interface SpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

interface SpawnOptions {
  stdio: "inherit";
  shell: false;
}

type SpawnRunner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => SpawnResult;

export interface UpgradeCommandPlan {
  command: string;
  args: string[];
  spawnOptions: SpawnOptions;
  displayCommand: string;
  target: string;
  tag: string;
  registry?: string;
  binaryCheckCommand: string;
}

const RELEASE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNSAFE_REGISTRY_CHARS_RE = /[\s"'`;&|<>^%!\r\n()]/;

export function resolveNpmRegistry(
  requestedRegistry?: string | boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (requestedRegistry === false) {
    return undefined;
  }
  if (
    requestedRegistry === true ||
    (typeof requestedRegistry === "string" && requestedRegistry.trim() === "")
  ) {
    return DEFAULT_NPM_MIRROR_REGISTRY;
  }

  const raw = (requestedRegistry ?? env.TRELLIS_NPM_REGISTRY)?.trim();
  if (!raw) {
    return undefined;
  }

  if (UNSAFE_REGISTRY_CHARS_RE.test(raw)) {
    throw new Error(
      `Invalid npm registry URL "${raw}". Provide a clean http(s) URL such as ${DEFAULT_NPM_MIRROR_REGISTRY} or https://registry.npmjs.org.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `Invalid npm registry URL "${raw}". Provide a valid http(s) URL such as ${DEFAULT_NPM_MIRROR_REGISTRY} or https://registry.npmjs.org.`,
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `Unsupported npm registry protocol "${parsed.protocol}" in "${raw}". Use http:// or https://.`,
    );
  }

  if (!parsed.hostname) {
    throw new Error(`Invalid npm registry URL "${raw}". Hostname is required.`);
  }

  return raw;
}

export function formatUpgradeCommandHint(registry?: string): string {
  return registry
    ? `trellis upgrade --registry ${registry}`
    : "trellis upgrade";
}

export function resolveUpgradeTag(
  _currentVersion: string = VERSION,
  requestedTag?: string,
): string {
  if (!requestedTag || requestedTag === "latest") {
    return "latest";
  }

  if (!RELEASE_TAG_RE.test(requestedTag)) {
    throw new Error(
      `Invalid release tag/version "${requestedTag}". Use "latest" or a GitHub release tag such as v0.6.18 or 0.6.17-agy.1.`,
    );
  }
  return requestedTag.startsWith("v") ? requestedTag : `v${requestedTag}`;
}

export function buildReleaseTarballUrl(
  tag: string,
  repo: string = resolveUpgradeRepo(),
): string {
  if (tag === "latest") {
    return `https://github.com/${repo}/releases/latest/download/${RELEASE_ASSET_NAME}`;
  }
  return `https://github.com/${repo}/releases/download/${tag}/${RELEASE_ASSET_NAME}`;
}

function binaryCheckCommand(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? "where trellis" : "which trellis";
}

export function buildUpgradeCommand(
  options: UpgradeOptions = {},
  currentVersion: string = VERSION,
  platform: NodeJS.Platform = process.platform,
  repo: string = resolveUpgradeRepo(),
  env: NodeJS.ProcessEnv = process.env,
): UpgradeCommandPlan {
  const tag = resolveUpgradeTag(currentVersion, options.tag);
  const registry = resolveNpmRegistry(
    options.npmRegistry ?? options.registry,
    env,
  );
  const target = buildReleaseTarballUrl(tag, repo);
  const npmArgs = registry
    ? ["install", "-g", target, "--registry", registry]
    : ["install", "-g", target];
  const displayCommand = `npm ${npmArgs.join(" ")}`;
  const spawnOptions: SpawnOptions = { stdio: "inherit", shell: false };

  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", displayCommand],
      spawnOptions,
      displayCommand,
      target,
      tag,
      registry,
      binaryCheckCommand: binaryCheckCommand(platform),
    };
  }

  return {
    command: "npm",
    args: npmArgs,
    spawnOptions,
    displayCommand,
    target,
    tag,
    registry,
    binaryCheckCommand: binaryCheckCommand(platform),
  };
}

function troubleshooting(plan: UpgradeCommandPlan): string {
  const lines = [
    "",
    "Troubleshooting:",
    `- Manual command: ${plan.displayCommand}`,
    "- Check npm global prefix and PATH: npm config get prefix",
    `- Check which Trellis binary your shell resolves: ${plan.binaryCheckCommand}`,
    "- If this is a permissions error, fix your Node/npm install or npm prefix; Trellis does not run sudo.",
    "- If npm reports an existing binary or locked file, resolve that npm error manually; Trellis does not run --force.",
  ];
  if (!plan.registry) {
    lines.push(
      `- If an internal/corporate .npmrc mirror fails to resolve dependencies, retry with: trellis upgrade -r (uses ${DEFAULT_NPM_MIRROR_REGISTRY}) or trellis upgrade -r https://registry.npmjs.org`,
    );
  }
  return lines.join("\n");
}

export async function upgrade(
  options: UpgradeOptions = {},
  runner: SpawnRunner = spawnSync,
): Promise<void> {
  const plan = buildUpgradeCommand(options);

  console.log(chalk.cyan(`Upgrading Trellis CLI to ${plan.target}`));
  console.log(chalk.gray(`Run: ${plan.displayCommand}`));

  if (options.dryRun) {
    console.log(chalk.gray("Dry run: no changes made."));
    return;
  }

  const result = runner(plan.command, plan.args, plan.spawnOptions);
  if (result.error) {
    throw new Error(
      `Failed to run npm. Install npm or run manually: ${plan.displayCommand}${troubleshooting(plan)}`,
    );
  }
  if (result.signal) {
    throw new Error(
      `npm install was interrupted by ${result.signal}.${troubleshooting(plan)}`,
    );
  }
  if (result.status === null) {
    throw new Error(
      `npm install failed without an exit status.${troubleshooting(plan)}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `npm install failed with exit code ${result.status}.${troubleshooting(plan)}`,
    );
  }

  console.log(chalk.green("\n✓ Trellis CLI upgrade completed"));
  console.log(chalk.gray("Run: trellis --version"));
  console.log(chalk.gray(`Run: ${plan.binaryCheckCommand}`));
}
