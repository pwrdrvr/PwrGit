import { userSystemConfig } from "@pwrgit/mcp-server";
import fc from "fast-check";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  configureBundledGit,
  configureBundledGitConfig,
  gitLaunch,
  installedGitEnvironment,
  shippedBundleDirectory,
  useInstalledGit,
  useManagedGit
} from "./dugite";

vi.mock("node:path", async (importOriginal) => {
  const path = await importOriginal<typeof import("node:path")>();
  return { ...path, relative: vi.fn(path.relative) };
});

const shipped = shippedBundleDirectory();
const windows = process.platform === "win32";
const root = resolve(tmpdir(), "installed-git-environment-fixture");
const bundle = join(root, "shipped");
const managed = join(root, "managed");
const command = join(root, "installed", "bin", "git");

afterEach(() => {
  configureBundledGit(shipped);
  configureBundledGitConfig(null);
  useInstalledGit(null);
  useManagedGit(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(relative).mockClear();
});

/** Pre-cache environment algorithm, with runtime and CLI inputs supplied explicitly. */
function uncachedEnvironment(
  source: NodeJS.ProcessEnv, git: string, active: string, shipped: string, configDir: string
): NodeJS.ProcessEnv {
  const env = { ...source };
  const inBundle = (value: string): boolean => [active, shipped].some((directory) => {
    const path = relative(resolve(directory), value);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
  });
  let inherited = "";
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (upper === "PATH") {
      inherited = value ?? "";
      delete env[key];
    } else if (
      ["LOCAL_GIT_DIRECTORY", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR"].includes(upper) ||
      (["PREFIX", "GIT_SSL_CAINFO"].includes(upper) && value !== undefined && inBundle(value))
    ) {
      delete env[key];
    } else if (upper === "GIT_CONFIG_SYSTEM") {
      const user = userSystemConfig(resolve(active), configDir, value);
      if (user === undefined) delete env[key];
      else env[key] = user;
    }
  }
  const cli = windows ? [] : [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const entries = [inherited, ...cli].join(delimiter).split(delimiter);
  env.PATH = [...new Set([dirname(git), ...entries.filter((entry) => entry !== "" && !inBundle(entry))])].join(delimiter);
  return { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" };
}

it("matches the uncached launch environment across changes to the runtime, PATH and overlays", () => {
  const configDir = mkdtempSync(join(tmpdir(), "pwrgit-launch-config-"));
  const generated = join(configDir, "generated");
  const userConfig = join(configDir, "..", "fixture-user-config");
  configureBundledGitConfig(configDir);
  const entry = fc.constantFrom(
    "", bundle, join(bundle, "bin"), bundle.toUpperCase(), `${bundle}-tools`,
    join(bundle, "..helpers"), join(managed, "libexec"), join(root, "bin"), dirname(command),
    join(".", "bin"), join("..", "bin"),
    ...(windows ? ["Z:relative", "\\drive-rooted", "\\\\server\\share\\bin", "C:/mixed/slashes"] : [])
  );
  const path = fc.array(entry, { maxLength: 12 }).map((entries) => entries.join(delimiter));
  const settings = fc.record({
    shipped: fc.constantFrom(bundle, managed, "relative-bundle"),
    managed: fc.constantFrom(null, bundle, managed),
    command: fc.constantFrom(command, join(root, "other", "git"), "relative-git"),
    cli: path,
    overlay: fc.dictionary(fc.constantFrom("PATH", "Path", "path"), fc.option(path, { nil: undefined })),
    prefix: entry,
    ca: entry,
    config: fc.constantFrom(generated, join(bundle, "etc", "gitconfig"), userConfig, undefined)
  });
  const originalEnv = process.env;
  try {
    process.env = { LANG: "C", HOME: root };
    fc.assert(fc.property(fc.array(settings, { minLength: 1, maxLength: 5 }), (steps) => {
      for (const step of steps) {
        configureBundledGit(step.shipped);
        useManagedGit(step.managed);
        useInstalledGit(step.command);
        process.env.PATH = step.cli;
        const active = step.managed ?? step.shipped;
        for (const token of ["first-fixture-token", "second-fixture-token"]) {
          // Rewrite the same generated file between launches with identical PATH inputs.
          const include = `${userConfig}-${token}`.replaceAll("\\", "\\\\");
          writeFileSync(generated, `# Written by PwrGit: fixture\n[include]\n\tpath = "${include}"\n`);
          process.env.GIT_ASKPASS = token;
          const overlay = {
            ...step.overlay, Local_git_directory: active, GIT_EXEC_PATH: join(active, "libexec"),
            GIT_TEMPLATE_DIR: join(active, "templates"), Prefix: step.prefix, GIT_SSL_CAINFO: step.ca,
            GIT_CONFIG_SYSTEM: step.config, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper",
            GIT_CONFIG_VALUE_0: token, GIT_TERMINAL_PROMPT: "1", GCM_INTERACTIVE: "Auto"
          };
          const launch = gitLaunch(overlay);
          expect(launch.binary).toBe(step.command);
          expect(launch.env).toEqual(uncachedEnvironment({ ...process.env, ...overlay }, step.command, active, step.shipped, configDir));
        }
      }
    }));
  } finally {
    process.env = originalEnv;
    rmSync(configDir, { recursive: true, force: true });
  }
});

it("resolves relative PATH entries again when the working directory changes", () => {
  configureBundledGit(bundle);
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(bundle);
  const source = { PATH: "relative-tools" };
  vi.stubEnv("PATH", "");
  expect(installedGitEnvironment(source, command).PATH?.split(delimiter)).not.toContain(source.PATH);
  cwd.mockReturnValue(root);
  expect(installedGitEnvironment(source, command).PATH?.split(delimiter)).toContain(source.PATH);
  cwd.mockRestore();
});

it.skipIf(!windows)("resolves drive-rooted PATH entries again when the current drive changes", () => {
  configureBundledGit("C:\\shipped");
  const git = "C:\\installed\\bin\\git.exe";
  const source = { PATH: "\\shipped\\bin" };
  const cwd = vi.spyOn(process, "cwd").mockReturnValue("C:\\workspace");
  try {
    expect(installedGitEnvironment(source, git).PATH).toBe(dirname(git));
    cwd.mockReturnValue("D:\\workspace");
    expect(installedGitEnvironment(source, git).PATH).toBe([dirname(git), source.PATH].join(delimiter));
  } finally {
    cwd.mockRestore();
  }
});

it.skipIf(!windows)("resolves drive-relative PATH entries again when that drive's directory changes", () => {
  const root = "Z:\\";
  const bundle = join(root, "shipped");
  configureBundledGit(bundle);
  const source = { PATH: "Z:relative-tools" };
  const originalEnv = process.env;
  try {
    process.env = { "=Z:": bundle };
    expect(installedGitEnvironment(source, command).PATH?.split(delimiter)).not.toContain(source.PATH);
    process.env["=Z:"] = root;
    expect(installedGitEnvironment(source, command).PATH?.split(delimiter)).toContain(source.PATH);
  } finally {
    process.env = originalEnv;
  }
});

it("reuses PATH containment checks across commands with unchanged absolute inputs", () => {
  configureBundledGit(bundle);
  useManagedGit(managed);
  const entry = join(root, "cost-oracle", "bin");
  const source = { PATH: entry };
  vi.stubEnv("PATH", join(root, "cli", "bin"));
  const checks = () => vi.mocked(relative).mock.calls.filter(([, value]) => value === entry).length;
  const first = installedGitEnvironment(source, command);
  expect(first.PATH?.split(delimiter)).toContain(entry);
  const firstChecks = checks();
  expect(firstChecks).toBeGreaterThan(0);
  for (let index = 0; index < 8; index += 1) {
    expect(installedGitEnvironment({ ...source, GIT_ASKPASS: String(index) }, command).PATH).toBe(first.PATH);
  }
  expect(checks()).toBe(firstChecks);
});

it("rebuilds PATH as each absolute input changes", () => {
  const otherGit = join(root, "other", "git");
  const shippedBin = join(bundle, "bin");
  const managedBin = join(managed, "bin");
  const cli = join(root, "cli", "bin");
  const extra = join(root, "extra", "bin");
  configureBundledGit(bundle);
  useManagedGit(managed);
  vi.stubEnv("PATH", cli);
  const read = (git: string, ...entries: string[]) => installedGitEnvironment({ PATH: entries.join(delimiter) }, git)
    .PATH?.split(delimiter).filter((entry) => entry.startsWith(root));

  expect(read(command, shippedBin, managedBin)).toEqual([dirname(command), ...(windows ? [] : [cli])]);
  vi.stubEnv("PATH", extra);
  const cliEntries = windows ? [] : [extra];
  expect(read(command, shippedBin, managedBin)).toEqual([dirname(command), ...cliEntries]);
  expect(read(command, cli, shippedBin, managedBin)).toEqual([dirname(command), cli, ...cliEntries]);
  expect(read(otherGit, cli, shippedBin, managedBin)).toEqual([dirname(otherGit), cli, ...cliEntries]);
  configureBundledGit(join(root, "new-shipped"));
  expect(read(otherGit, cli, shippedBin, managedBin)).toEqual([dirname(otherGit), cli, shippedBin, ...cliEntries]);
  useManagedGit(null);
  expect(read(otherGit, cli, shippedBin, managedBin)).toEqual([dirname(otherGit), cli, shippedBin, managedBin, ...cliEntries]);
});
