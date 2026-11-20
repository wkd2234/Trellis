#!/usr/bin/env node

/**
 * Pack self-contained GitHub Release tarballs (`trellis-core.tgz` + `trellis-cli.tgz`).
 *
 * Usage:
 *   node packages/cli/scripts/pack-release.js --tag v0.6.17-agy.1 [--repo wkd2234/Trellis] [--out release-assets]
 *
 * When `--tag` is provided, the packed `trellis-cli.tgz` rewrites its
 * `@mindfoldhq/trellis-core` dependency to the matching GitHub Release URL
 * (`https://github.com/<repo>/releases/download/<tag>/trellis-core.tgz`) so
 * `npm install -g trellis-cli.tgz` works even when `@mindfoldhq/trellis-core`
 * has fork-only changes not published to npm.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const corePkgDir = path.join(repoRoot, "packages/core");
const cliPkgDir = path.join(repoRoot, "packages/cli");
const cliPkgJsonPath = path.join(cliPkgDir, "package.json");

function parseArgs(argv) {
  const opts = {
    tag: "",
    repo: "wkd2234/Trellis",
    out: path.join(repoRoot, "release-assets"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--tag" && argv[i + 1]) {
      opts.tag = argv[++i];
    } else if (arg === "--repo" && argv[i + 1]) {
      opts.repo = argv[++i];
    } else if (arg === "--out" && argv[i + 1]) {
      opts.out = path.resolve(argv[++i]);
    }
  }
  return opts;
}

function runPnpm(args, cwd) {
  const cmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
    shell: process.platform === "win32",
  });
}

function packTo(pkgDir, outDir, targetName) {
  const before = new Set(fs.readdirSync(outDir));
  runPnpm(["pack", "--pack-destination", outDir], pkgDir);
  const created = fs
    .readdirSync(outDir)
    .filter((f) => f.endsWith(".tgz") && !before.has(f));
  if (created.length !== 1) {
    throw new Error(
      `Expected 1 tarball from pnpm pack in ${pkgDir}, found: ${created.join(", ")}`,
    );
  }
  const src = path.join(outDir, created[0]);
  const dest = path.join(outDir, targetName);
  fs.rmSync(dest, { force: true });
  fs.renameSync(src, dest);
  return dest;
}

const { tag, repo, out } = parseArgs(process.argv.slice(2));
fs.mkdirSync(out, { recursive: true });

// 1. Pack @mindfoldhq/trellis-core
const coreTarball = packTo(corePkgDir, out, "trellis-core.tgz");
console.log(`Packed core -> ${coreTarball}`);

// 2. Pack @mindfoldhq/trellis (optionally pointing core dep to GitHub Release URL)
const originalCliPkg = fs.readFileSync(cliPkgJsonPath, "utf-8");
try {
  if (tag) {
    const pkg = JSON.parse(originalCliPkg);
    pkg.dependencies["@mindfoldhq/trellis-core"] =
      `https://github.com/${repo}/releases/download/${tag}/trellis-core.tgz`;
    fs.writeFileSync(cliPkgJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf-8");
  }
  const cliTarball = packTo(cliPkgDir, out, "trellis-cli.tgz");
  console.log(`Packed cli  -> ${cliTarball}`);
} finally {
  fs.writeFileSync(cliPkgJsonPath, originalCliPkg, "utf-8");
}
