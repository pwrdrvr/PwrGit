import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";

const repo = new URL("../../../", import.meta.url);

// Oracle: exposing Cargo directly and exposing only Rustup's active-toolchain
// lookup must produce the same host build, compiler lookup and license check.
async function compareDiscovery(directoryName, args = ["--host"]) {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "pwrgit-cargo-")));
  try {
    const root = path.join(temporary, directoryName);
    const shims = path.join(root, "shims");
    const toolchain = path.join(root, "active toolchain", "bin");
    const desktop = path.join(root, "apps/desktop/scripts");
    const release = path.join(root, "crates/pwrgit-mcp/target/release");
    for (const dir of [shims, toolchain, desktop, release]) await mkdir(dir, { recursive: true });
    await cp(new URL("scripts/lib/", repo), path.join(root, "scripts/lib"), { recursive: true });
    await cp(new URL("apps/desktop/scripts/build-mcp.mjs", repo), path.join(desktop, "build-mcp.mjs"));
    const executable = async (file, code) => writeFile(file, `#!${process.execPath}\n${code}`, { mode: 0o755 });
    await executable(path.join(shims, "rustup"), `
      if (process.argv.slice(2).join(' ') !== 'which cargo') process.exit(99);
      console.log(${JSON.stringify(path.join(toolchain, "cargo"))});
    `);
    await executable(path.join(toolchain, "rustc"), "console.log('fixture compiler')");
    await executable(path.join(toolchain, "cargo"), `
      const {spawnSync} = require('node:child_process');
      const fs = require('node:fs');
      const args = process.argv.slice(2);
      if (args[0] === '--version') process.exit(0);
      const compiler = spawnSync('rustc', ['--version'], {encoding:'utf8'});
      if (compiler.status !== 0) process.exit(98);
      fs.appendFileSync(process.env.CARGO_TEST_LOG, JSON.stringify(args)+'\\n');
    `);
    await writeFile(path.join(release, "pwrgit-mcp"), "fixture host binary");
    // Exercise the environment passed to the real build's child license checker.
    await writeFile(path.join(root, "scripts/check-mcp-rust-licenses.mjs"), `
      import {spawnSync} from 'node:child_process';
      const result = spawnSync('cargo', ['license-probe'], {stdio:'inherit'});
      if (result.error) throw result.error;
      process.exitCode = result.status;
    `);
    const run = async (lookupPath, name) => {
      const log = path.join(root, name);
      const result = spawnSync(process.execPath, [path.join(desktop, "build-mcp.mjs"), ...args], {
        env: { ...process.env, PATH: lookupPath, CARGO_TEST_LOG: log }, encoding: "utf8"
      });
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(path.join(root, "apps/desktop/build/mcp/pwrgit-mcp"), "utf8")).toBe("fixture host binary");
      return (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    };
    const direct = await run([toolchain, shims].join(path.delimiter), "direct.jsonl");
    const discovered = await run(shims, "discovered.jsonl");
    expect(discovered).toEqual(direct);
    expect(discovered).toEqual([
      ["build", "--locked", "--release", "--manifest-path", path.join(root, "crates/pwrgit-mcp/Cargo.toml")],
      ["license-probe"]
    ]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

it.skipIf(process.platform === "win32")("finds active Cargo without proxy shims (Homebrew layout regression)", async () => {
  await compareDiscovery("checkout with spaces");
});

it.skipIf(process.platform === "win32")("defaults to the host without installing cross targets", async () => {
  await compareDiscovery("default host build", []);
});

it.skipIf(process.platform === "win32")("host builds agree for direct Cargo and Rustup discovery across checkout paths", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom("a", "Z", "9", " ", "-", "_", "é"), { minLength: 1, maxLength: 20 }).map((parts) => `repo ${parts.join("")}`),
    (directory) => compareDiscovery(directory)
  ), { numRuns: 8 });
});

it.skipIf(process.platform !== "darwin")("the universal relay passes strict signature verification before packaging", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pwrgit universal relay-"));
  try {
    const desktop = path.join(root, "apps/desktop");
    const shims = path.join(root, "bin");
    await mkdir(path.join(desktop, "scripts"), { recursive: true });
    await mkdir(shims);
    // Use real linker output and Apple signing tools without compiling Rust in the test suite.
    for (const command of ["cargo", "rustup"]) await symlink("/usr/bin/true", path.join(shims, command));
    await cp(new URL("scripts/lib/rust-environment.mjs", repo), path.join(root, "scripts/lib/rust-environment.mjs"));
    await writeFile(path.join(root, "scripts/check-mcp-rust-licenses.mjs"), "");
    await cp(new URL("./build-mcp.mjs", import.meta.url), path.join(desktop, "scripts/build-mcp.mjs"));

    for (const [arch, target, linkerFlag] of [
      ["arm64", "aarch64-apple-darwin", "-adhoc_codesign"],
      ["x86_64", "x86_64-apple-darwin", "-no_adhoc_codesign"],
    ]) {
      const release = path.join(root, "crates/pwrgit-mcp/target", target, "release");
      await mkdir(release, { recursive: true });
      execFileSync("/usr/bin/clang", ["-arch", arch, `-Wl,${linkerFlag}`, "-x", "c", "-", "-o", path.join(release, "pwrgit-mcp")], {
        input: "int main(void) { return 0; }",
      });
    }

    execFileSync(process.execPath, [path.join(desktop, "scripts/build-mcp.mjs"), "--universal"], {
      env: { ...process.env, PATH: [shims, "/usr/bin", "/bin"].join(path.delimiter) },
    });
    const relay = path.join(desktop, "build/mcp/pwrgit-mcp");
    expect(execFileSync("/usr/bin/lipo", ["-archs", relay], { encoding: "utf8" }).trim().split(/\s+/).sort())
      .toEqual(["arm64", "x86_64"]);
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--all-architectures", relay]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
