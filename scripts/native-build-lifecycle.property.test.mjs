import { readFileSync } from "node:fs";
import fc from "fast-check";
import { expect, it } from "vitest";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const packages = {
  root: JSON.parse(read("package.json")).scripts,
  desktop: JSON.parse(read("apps/desktop/package.json")).scripts,
  server: JSON.parse(read("packages/mcp-server/package.json")).scripts
};

// Model pnpm's pre/post lifecycle and explicit workspace-script calls. The
// oracle is the user's boundary: ordinary commands must never reach Rust.
function reachable(scope, name, seen = new Set(), installationHook = false) {
  if (scope === "root" && name === "install" && !installationHook) {
    if (seen.has("install-lifecycle")) return [];
    seen.add("install-lifecycle");
    return Object.entries(packages).flatMap(([workspace, scripts]) =>
      ["preinstall", "install", "postinstall", "prepare"].filter((hook) => scripts[hook]).flatMap((hook) => reachable(workspace, hook, seen, true)));
  }
  const key = `${scope}:${name}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const script = packages[scope][name];
  if (!script) return [];
  const commands = [script];
  for (const hook of [`pre${name}`, `post${name}`]) commands.push(...reachable(scope, hook, seen));
  for (const call of script.matchAll(/\bpnpm\s+(?:--filter\s+(@pwrgit\/(?:desktop|mcp-server))\s+)?(?:run\s+)?([\w:-]+)/g)) {
    const target = call[1] === "@pwrgit/desktop" ? "desktop" : call[1] === "@pwrgit/mcp-server" ? "server" : scope;
    commands.push(...reachable(target, call[2], seen));
  }
  return commands;
}

it("ordinary install, Dev, JS build and tests never invoke Rust implicitly", () => {
  const ordinary = fc.constantFrom(["root", "install"], ["root", "dev"], ["root", "build"], ["root", "test"], ["root", "test:e2e"], ["desktop", "build"], ["desktop", "test:e2e"]);
  fc.assert(fc.property(fc.array(ordinary, { minLength: 1, maxLength: 20 }), (commands) => {
    for (const [scope, name] of commands) {
      for (const command of reachable(scope, name)) expect(command, `${scope}:${name}`).not.toMatch(/\bcargo\b|\brustup\b|build-mcp\.mjs|\bbuild:(?:mcp|native)\b/);
    }
  }));
});

it("explicit native build reaches the host builder and packaging requests universal explicitly", () => {
  expect(reachable("root", "build:native").join("\n")).toMatch(/build-mcp\.mjs/);
  expect(read("apps/desktop/scripts/release.mjs")).toContain('"build:native", "--universal"');
});

it("CI compiles the helper explicitly before suites that use it", () => {
  const ci = read(".github/workflows/ci.yml");
  for (const name of ["linux-test", "windows-test", "desktop-e2e", "macos-e2e", "windows-e2e"]) {
    const job = ci.split(`\n  ${name}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
    expect(job, name).toBeDefined();
    const native = job.indexOf("run: pnpm build:native");
    expect(native, name).toBeGreaterThan(-1);
    expect(native, name).toBeLessThan(job.indexOf("id: " + (name.endsWith("test") ? "unit-tests" : "e2e-tests")));
  }
  for (const file of ["release.yml", "docs-screenshots.yml"]) expect(read(`.github/workflows/${file}`)).toContain("run: pnpm build:native");
});
