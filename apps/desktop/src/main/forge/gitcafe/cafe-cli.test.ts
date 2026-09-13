import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => mocks);
import {
  cafeClient,
  cafeData,
  cafeHostArgs,
  cafeInstalled,
  cafeInvocation,
  cafeLoggedIn,
  cafePage,
  cafePaths,
  cafeWindowsScript,
  parseCafeAuthStatus,
  runCafe
} from "./cafe-cli";
import { discoverForgeHosts } from "../cli-hosts";
import { ForgeStatusService } from "../status";

const auth = (data: unknown) => JSON.stringify({ schemaVersion: 1, data });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GitCafe CLI", () => {
  it("extracts only host/account from authentication status", () => {
    expect(
      parseCafeAuthStatus(
        auth({
          host: "git.cafe",
          username: "sample",
          token: "gct_private",
          backend: "bun-secrets"
        })
      )
    ).toEqual({ host: "git.cafe", account: "sample" });
    expect(
      parseCafeAuthStatus(auth({ host: "git.cafe", username: null }))
    ).toBeNull();
    expect(
      parseCafeAuthStatus(
        auth({ host: "https://evil.example/api", username: "sample" })
      )
    ).toBeNull();
  });
  it("rejects errors and incompatible schemas instead of caching negative answers", () => {
    expect(() =>
      cafeData(
        '{"schemaVersion":1,"error":{"code":"AUTHENTICATION_REQUIRED","message":"gct_private","status":401}}'
      )
    ).toThrow("[REDACTED]");
    expect(() => cafeData('{"schemaVersion":2,"data":{}}')).toThrow("version");
    expect(() => cafeData("<html>login</html>")).toThrow("JSON");
    expect(() =>
      cafePage(auth({ items: [], page: { truncated: true, nextCursor: null } }))
    ).toThrow("truncated");
    expect(() => cafePage(auth({ items: [] }))).toThrow();
  });
  it("honors the selected host and detects a mismatched auth response", async () => {
    expect(cafeHostArgs("Cafe.Example")).toEqual([
      "--host",
      "https://cafe.example/api"
    ]);
    expect(() => cafeHostArgs("--token=secret")).toThrow();
    expect(cafeHostArgs("cafe.example", 8443)).toEqual([
      "--host",
      "https://cafe.example:8443/api"
    ]);
    expect(() => cafeHostArgs("cafe.example", -1)).toThrow();
    const run = vi.fn(async () =>
      auth({ host: "git.cafe", username: "sample" })
    );
    expect(await cafeLoggedIn("cafe.example", run)).toBe(false);
    expect(run).toHaveBeenCalledWith([
      "auth",
      "status",
      "--json",
      "--host",
      "https://cafe.example/api"
    ]);
  });
  it.each([
    ["cafe 0.4.2", false],
    ["cafe 0.5.0", true],
    ["cafe 1.0.0", true],
    ["unknown", false]
  ])("requires the current CLI contract: %s", async (version, supported) => {
    expect(await cafeInstalled(async () => version)).toBe(supported);
  });
  it("discovers Bun bins on GUI PATHs and respects overrides", () => {
    expect(cafePaths({ HOME: "/Users/sample" }, "darwin")).toEqual([
      "/Users/sample/.bun/bin"
    ]);
    expect(
      cafePaths(
        {
          HOME: "/home/sample",
          BUN_INSTALL: "/tools/bun",
          BUN_INSTALL_BIN: "/tools/bin"
        },
        "linux"
      )
    ).toEqual(["/tools/bin", "/tools/bun/bin"]);
    expect(cafePaths({ USERPROFILE: "C:\\Users\\sample" }, "win32")).toEqual([
      "C:\\Users\\sample\\.bun\\bin"
    ]);
    expect(cafeWindowsScript({ USERPROFILE: "C:\\Users\\sample" })).toBe(
      "C:\\Users\\sample\\.bun\\install\\global\\node_modules\\@gitcafe\\cli\\cafe.js"
    );
    expect(cafeWindowsScript({ BUN_INSTALL_GLOBAL_DIR: "D:\\global" })).toBe(
      "D:\\global\\node_modules\\@gitcafe\\cli\\cafe.js"
    );
  });
  it("spawns without prompts and redacts streamed and failed credentials", async () => {
    vi.stubEnv("CAFE_TOKEN", "contrived-secret");
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn()
    });
    mocks.spawn.mockReturnValue(child);
    // Force POSIX to test its shebang invocation on every test platform.
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const chunks: string[] = [];
    const pending = runCafe(["repo", "clone", "sample/demo"], {
      onStderr: (chunk) => chunks.push(chunk),
      env: { GIT_TERMINAL_PROMPT: "1" }
    });
    child.stderr.emit("data", "token gct_");
    child.stderr.emit("data", "contrived contrived-secret\n");
    child.emit("close", 1, null);
    await expect(pending).rejects.toThrow("[REDACTED]");
    expect(chunks.join("")).not.toContain("contrived");
    expect(mocks.spawn).toHaveBeenCalledWith(
      "cafe",
      [
        "repo",
        "clone",
        "sample/demo",
        "--no-input",
        "--no-browser",
        "--no-update-check"
      ],
      expect.objectContaining({
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: expect.objectContaining({
          GIT_TERMINAL_PROMPT: "0",
          CAFE_NO_UPDATE_CHECK: "1",
          PATH: expect.stringContaining(".bun")
        })
      })
    );
    expect(
      cafeClient.sanitize('"token":"anything" Authorization: Bearer other')
    ).not.toContain("anything");
  });
  it("enumerates GitCafe without exposing the token", async () => {
    const hosts = await discoverForgeHosts({
      gh: async () => "{}",
      glabAuthStatus: async () => "",
      cafe: async () =>
        auth({ host: "git.cafe", username: "sample", token: "gct_hidden" })
    });
    expect(hosts).toEqual([
      { kind: "gitcafe", host: "git.cafe", account: "sample" }
    ]);
  });
  it("does not authenticate a disabled GitCafe host", async () => {
    const loggedIn = vi.fn(async () => true);
    const service = new ForgeStatusService({
      probes: [
        { kind: "gitcafe", cli: "cafe", installed: async () => true, loggedIn }
      ],
      hosts: () => [{ kind: "gitcafe", host: "git.cafe", enabled: false }]
    });
    expect(await service.list()).toMatchObject([
      { kind: "gitcafe", loggedIn: false, hosts: [{ enabled: false }] }
    ]);
    expect(loggedIn).not.toHaveBeenCalled();
  });
});

it("does not send the default host's environment token to another host", async () => {
  vi.stubEnv("CAFE_TOKEN", "contrived-secret");
  vi.stubEnv("CAFE_HOST", "https://git.cafe/api");
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn()
  });
  mocks.spawn.mockReturnValue(child);
  const result = runCafe(
    ["repo", "view", "sample/demo", ...cafeHostArgs("cafe.example")],
    { env: { PATH: "/bundled/git" } }
  );
  child.emit("close", 0, null);
  await result;
  const env = mocks.spawn.mock.calls.at(-1)?.[2].env;
  expect(env.CAFE_TOKEN).toBeUndefined();
  expect(env.PATH).toContain("/bundled/git");
  expect(env.PATH).toContain(".bun/bin");
});

it("runs the Bun package entry point on Windows without a Node or shell shim", () => {
  const env = { USERPROFILE: "C:\\Users\\Example User" };
  expect(cafeInvocation(env, "win32", () => true)).toEqual({
    binary: "bun",
    prefix: [cafeWindowsScript(env)]
  });
  expect(() => cafeInvocation(env, "win32", () => false)).toThrow(
    "bun i -g @gitcafe/cli"
  );
  expect(cafeInvocation({}, "darwin")).toEqual({ binary: "cafe", prefix: [] });
});
