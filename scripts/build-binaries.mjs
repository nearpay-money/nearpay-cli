#!/usr/bin/env node
/**
 * Single-file `nearpay` binary for the host platform (sdks-and-tools §3: `bun build --compile`).
 * The OS keychain addon (`@napi-rs/keyring-<platform>`) is embedded, so each platform is built on its
 * own runner (CI matrix) — pnpm installs only the host's prebuilt addon. Smoke-tests `--version`.
 *
 *   node scripts/build-binaries.mjs            → dist-bin/nearpay-<platform>-<arch>[.exe]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const ext = process.platform === "win32" ? ".exe" : "";
const out = join(root, "dist-bin", `nearpay-${process.platform}-${process.arch}${ext}`);
mkdirSync(dirname(out), { recursive: true });
execFileSync("bun", ["build", "--compile", "--minify", "--sourcemap", join(root, "src", "cli.ts"), "--outfile", out], {
  cwd: root,
  stdio: "inherit",
});
const reported = execFileSync(out, ["--version"], { encoding: "utf8" }).trim();
if (reported !== version) {
  console.error(`binary reports ${reported}, package.json says ${version}`);
  process.exit(1);
}
console.log(`built ${out} (${version})`);
