import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { canonicalForgeHostname } from "@pwrgit/shared";
import {
  createCliClient,
  type CliSpec,
  type CliRunOptions
} from "../cli-runner";
import { ForgeResponseError } from "../repo-provider";

export function cafePaths(
  env: NodeJS.ProcessEnv,
  platform = process.platform
): string[] {
  // Use the requested platform's rules, even when it differs from the host
  // running this helper (as in the cross-platform discovery tests).
  const path = platform === "win32" ? win32 : posix;
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
  return [
    env.BUN_INSTALL_BIN,
    path.join(env.BUN_INSTALL || path.join(home, ".bun"), "bin")
  ].filter((value): value is string => Boolean(value));
}

export function cafeWindowsScript(env: NodeJS.ProcessEnv): string {
  const home = env.USERPROFILE || homedir();
  const globalDir =
    env.BUN_INSTALL_GLOBAL_DIR ||
    win32.join(
      env.BUN_INSTALL || win32.join(home, ".bun"),
      "install",
      "global"
    );
  return win32.join(globalDir, "node_modules", "@gitcafe", "cli", "cafe.js");
}

export function cafeInvocation(
  env: NodeJS.ProcessEnv,
  platform = process.platform,
  fileExists: (path: string) => boolean = existsSync
): { binary: string; prefix: string[] } {
  if (platform !== "win32") return { binary: "cafe", prefix: [] };
  const script = cafeWindowsScript(env);
  if (!fileExists(script))
    throw new Error("Install the GitCafe CLI with `bun i -g @gitcafe/cli`.");
  return { binary: "bun", prefix: [script] };
}

export const CAFE_CLI_SPEC: CliSpec = {
  binary: "cafe",
  label: "GitCafe CLI",
  errorName: "CafeCliError",
  authenticationRequiredMessage:
    "Sign in with `cafe auth login` to use GitCafe.",
  extraSearchPaths: cafePaths,
  invocation: cafeInvocation,
  nonInteractiveEnv: {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    CAFE_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1"
  },
  sensitiveEnvNames: ["CAFE_TOKEN"],
  tokenPrefixes: ["gct_"],
  redactionPatterns: [
    { pattern: /\bgct_[A-Za-z0-9_-]+/g, replacement: "[REDACTED]" },
    {
      pattern: /(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"']+/gi,
      replacement: "$1[REDACTED]"
    },
    { pattern: /("token"\s*:\s*")[^"]*/gi, replacement: "$1[REDACTED]" }
  ],
  authenticationHints: [
    /AUTHENTICATION_REQUIRED|TOKEN_EXPIRED|CAFE_TOKEN.*rejected|cafe auth login/i
  ]
};
export const cafeClient = createCliClient(CAFE_CLI_SPEC);
export type CafeRunner = (
  args: string[],
  options?: CliRunOptions
) => Promise<string>;

/** Every command is noninteractive. Explicit targets always override CAFE_HOST. */
export const runCafe: CafeRunner = (args, options = {}) => {
  const env = { ...options.env };
  const targetIndex = args.indexOf("--host");
  const target = targetIndex < 0 ? undefined : args[targetIndex + 1];
  const defaultHost =
    env.CAFE_HOST ?? process.env.CAFE_HOST ?? "https://git.cafe/api";
  // An environment credential belongs to the CLI's configured default host.
  // An explicitly added host must use its own stored login, never that token.
  if (
    target !== undefined &&
    cafeApiOrigin(target) !== cafeApiOrigin(defaultHost)
  ) {
    env.CAFE_TOKEN = undefined;
  }
  return cafeClient.run(
    [...args, "--no-input", "--no-browser", "--no-update-check"],
    { ...options, env }
  );
};
function cafeApiOrigin(value: string): string | null {
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).origin;
  } catch {
    return null;
  }
}
export function cafeHostArgs(host?: string, port?: number): string[] {
  if (host === undefined) return [];
  const canonical = canonicalForgeHostname(host);
  if (canonical === null) throw new Error("Invalid GitCafe hostname.");
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  )
    throw new Error("Invalid GitCafe port.");
  return [
    "--host",
    `https://${canonical}${port === undefined ? "" : `:${port}`}/api`
  ];
}
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ForgeResponseError(
      "GitCafe returned an invalid response. Update cafe to 0.5.0 or newer."
    );
  }
  return value as Record<string, unknown>;
}
export function cafeData(stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ForgeResponseError("GitCafe returned invalid JSON.");
  }
  const envelope = object(parsed);
  if (envelope.error !== undefined) {
    const error = object(envelope.error);
    throw new Error(
      cafeClient.sanitize(
        `GitCafe ${String(error.code)}: ${String(error.message)} (HTTP ${String(error.status)})`
      )
    );
  }
  if (envelope.schemaVersion !== 1)
    throw new ForgeResponseError("Unsupported GitCafe CLI response version.");
  return object(envelope.data);
}
export function cafeResource(stdout: string): Record<string, unknown> {
  return object(cafeData(stdout).resource);
}
export function parseCafeAuthStatus(
  stdout: string
): { host: string; account: string } | null {
  const data = cafeData(stdout);
  const host =
    typeof data.host === "string" ? canonicalForgeHostname(data.host) : null;
  return host !== null &&
    typeof data.username === "string" &&
    data.username.trim() !== ""
    ? { host, account: data.username }
    : null;
}
export async function cafeLoggedIn(
  host?: string,
  run: CafeRunner = runCafe
): Promise<boolean> {
  const status = parseCafeAuthStatus(
    await run(["auth", "status", "--json", ...cafeHostArgs(host)])
  );
  return (
    status !== null &&
    (host === undefined || status.host === canonicalForgeHostname(host))
  );
}
export async function cafeInstalled(
  run: CafeRunner = runCafe
): Promise<boolean> {
  const version = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(await run(["--version"]));
  return (
    version !== null && (Number(version[1]) > 0 || Number(version[2]) >= 5)
  );
}

export function cafePage(stdout: string): {
  items: unknown[];
  nextCursor: string | null;
} {
  const data = cafeData(stdout);
  if (!Array.isArray(data.items))
    throw new ForgeResponseError("GitCafe returned no item list.");
  const page = object(data.page);
  if (page.nextCursor !== null && typeof page.nextCursor !== "string") {
    throw new ForgeResponseError("GitCafe returned invalid pagination.");
  }
  if (page.truncated === true && !page.nextCursor)
    throw new ForgeResponseError(
      "GitCafe truncated the response without a cursor."
    );
  return { items: data.items, nextCursor: page.nextCursor as string | null };
}
