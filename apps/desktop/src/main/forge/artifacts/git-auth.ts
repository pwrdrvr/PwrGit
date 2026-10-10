import {
  classifyForgeHost, err, forgeProductFor, ok, parseArtifactsRemote,
  type ForgeHostMap, type Result
} from "@pwrgit/shared";
import type { GitExec, GitExecOptions } from "../../git/dugite";
import type { ArtifactsCredentials } from "./credentials";

type GitEnvironment = NonNullable<GitExecOptions["env"]>;
export type GitAuthentication = (args: string[], cwd: string, env: GitEnvironment) => Promise<Result<GitEnvironment>>;
const NETWORK = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);

function commandArgs(args: string[]): string[] {
  let index = 0;
  while (index < args.length && args[index]?.startsWith("-")) {
    const arg = args[index++]!;
    if (["-c", "-C", "--config-env", "--git-dir", "--work-tree"].includes(arg)) index++;
  }
  return args.slice(index);
}

function firstOperand(args: string[]): string | undefined {
  const withValue = new Set(["--depth", "--deepen", "--filter", "--shallow-since", "--shallow-exclude", "--upload-pack", "--receive-pack", "--refmap", "-o", "--push-option", "--server-option", "--branch", "-b", "--origin", "--config", "-c", "--template", "--reference", "--reference-if-able", "--separate-git-dir", "--jobs", "-j", "--bundle-uri", "--negotiation-tip"]);
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") return args[index + 1];
    if (withValue.has(arg)) { index++; continue; }
    if (arg.startsWith("--repo=")) return arg.slice(7);
    if (arg === "--repo") return args[index + 1];
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

/** URL-specific environment config keeps secrets out of argv, disk and remotes.
 * The HTTP scope and disabled redirects prevent a token reaching another repo/host. */
export function artifactsGitEnvironment(
  env: GitEnvironment, credentials: readonly { remote: string; token: string }[], push: boolean
): GitEnvironment {
  if (credentials.length === 0) return env;
  // An inherited diagnostic setting can dump environment config or HTTP
  // headers to stderr/files. Authenticated operations must never trace secrets.
  const next = { ...env, GIT_TRACE: "0", GIT_TRACE_CURL: "0", GIT_CURL_VERBOSE: "0",
    GIT_TRACE2: "0", GIT_TRACE2_EVENT: "0", GIT_TRACE2_PERF: "0", GIT_TRACE_REDACT: "1" } as GitEnvironment;
  const inherited = next["GIT_CONFIG_COUNT"] ?? process.env["GIT_CONFIG_COUNT"] ?? "0";
  let count = /^\d+$/.test(inherited) ? Number(inherited) : NaN;
  if (!Number.isSafeInteger(count) || count > 1000) throw new Error("Invalid Git environment configuration.");
  const add = (key: string, value: string) => {
    next[`GIT_CONFIG_KEY_${count}`] = key;
    next[`GIT_CONFIG_VALUE_${count++}`] = value;
  };
  for (const { remote, token } of credentials) {
    // Empty header resets inherited extraHeaders for exactly this repository.
    add(`http.${remote}/.extraHeader`, "");
    add(`http.${remote}/.extraHeader`, `Authorization: Bearer ${token}`);
    add(`http.${remote}/.followRedirects`, "false");
  }
  if (push) add("protocol.version", "1");
  next["GIT_CONFIG_COUNT"] = String(count);
  return next;
}

export function createArtifactsGitAuthentication(
  store: ArtifactsCredentials, git: GitExec, hosts: () => ForgeHostMap
): GitAuthentication {
  return async (args, cwd, env) => {
    const command = commandArgs(args);
    const verb = command[0];
    if (verb === undefined || !NETWORK.has(verb)) return ok(env);
    // URL expansion is a local query, including when this hook calls back
    // through execGit. It must neither acquire credentials nor recurse.
    if (verb === "ls-remote" && command.includes("--get-url")) return ok(env);
    const target = firstOperand(command);
    const overrides = hosts();
    if (!Object.values(overrides).some((kind) => forgeProductFor(kind)?.authentication === "repo-token")) return ok(env);
    const prefix = args.slice(0, args.length - command.length);
    const readGit = (query: string[]) => git([...prefix, ...query], cwd, { env });
    const resolveUrl = async (url: string): Promise<string[]> => {
      // This expands insteadOf without contacting the remote, and works
      // outside a repository (clone's cwd).
      const result = await readGit(["ls-remote", "--get-url", "--", url]);
      return result.ok && result.value.exitCode === 0
        ? result.value.stdout.trim().split(/\r?\n/).filter(Boolean)
        : [url];
    };
    let urls: string[] = [];
    if (target !== undefined && (verb === "clone" || /^(?:[a-z][a-z0-9+.-]*:\/\/|[^/]+@[^/]+:)/i.test(target))) {
      urls = await resolveUrl(target);
    } else if (verb !== "clone") {
      // Git itself resolves pushurl and url.*.insteadOf; do not reimplement it.
      const namesResult = await readGit(["remote"]);
      if (!namesResult.ok || namesResult.value.exitCode !== 0) return ok(env);
      const names = namesResult.value.stdout.trim().split(/\r?\n/).filter(Boolean);
      let selected = target === undefined ? [] : names.filter((name) => name === target);
      const allOverride = command.filter((arg) => arg === "--all" || arg === "--no-all").at(-1);
      let fetchAll = verb === "fetch" && allOverride === "--all";
      if (verb === "fetch" && allOverride === undefined && target === undefined && !command.includes("--multiple")) {
        const result = await readGit(["config", "--bool", "--get", "fetch.all"]);
        fetchAll = result.ok && result.value.exitCode === 0 && result.value.stdout.trim() === "true";
      }
      if (fetchAll) {
        selected = [];
        for (const name of names) {
          // Git treats the deprecated skipDefaultUpdate as the same setting:
          // whichever spelling occurs last wins. --bool handles yes/on/1.
          const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const result = await readGit(["config", "--bool", "--get-regexp", `^remote\\.${escapedName}\\.(skipFetchAll|skipDefaultUpdate)$`]);
          if (!(result.ok && result.value.exitCode === 0 && result.value.stdout.trim().endsWith(" true"))) selected.push(name);
        }
      }
      else if (verb === "fetch" && command.includes("--multiple")) selected = names.filter((name) => command.slice(1).includes(name));
      else if (target === undefined) {
        const branchResult = await readGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
        const branch = branchResult.ok && branchResult.value.exitCode === 0 ? branchResult.value.stdout.trim() : "";
        const keys = verb === "push" ? [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`] : [`branch.${branch}.remote`];
        for (const key of keys) {
          if (branch === "" && key.startsWith("branch.")) continue;
          const result = await readGit(["config", "--get", key]);
          if (result.ok && result.value.stdout.trim() === ".") return ok(env);
          if (result.ok && result.value.exitCode === 0 && names.includes(result.value.stdout.trim())) { selected = [result.value.stdout.trim()]; break; }
        }
        if (selected.length === 0) selected = names.includes("origin") ? ["origin"] : names.length === 1 ? names : [];
      }
      for (const name of selected) {
        const result = await readGit(["remote", "get-url", ...(verb === "push" ? ["--push", "--all"] : []), "--", name]);
        if (result.ok && result.value.exitCode === 0) urls.push(...result.value.stdout.trim().split(/\r?\n/));
      }
      if (target !== undefined && selected.length === 0 && !fetchAll && !command.includes("--multiple")) urls = await resolveUrl(target);
    }
    const credentials: { remote: string; token: string }[] = [];
    for (const url of new Set(urls)) {
      let hostname: string | undefined;
      try { hostname = new URL(url).hostname; }
      catch { hostname = /^(?:[^@\s]+@)?([^\s:/]+):/.exec(url)?.[1]; }
      if (hostname === undefined || forgeProductFor(classifyForgeHost(hostname, overrides))?.authentication !== "repo-token") continue;
      const remote = parseArtifactsRemote(url);
      if (remote === null) return err({ kind: "remote", code: "invalid_artifacts_remote", message: "Artifacts requires its exact credential-free HTTPS remote. Copy it from Cloudflare, then update the remote in PwrGit." });
      if (command.some((arg) => arg === "--filter" || arg.startsWith("--filter="))) return err({ kind: "remote", code: "artifacts_partial_clone_unsupported", message: "Artifacts does not document partial clone support. Remove the Git --filter option and use a full or shallow clone." });
      const token = store.token(remote.remote);
      if (!token.ok) return token;
      if (token.value === null) return err({ kind: "remote", code: "artifacts_token_required", message: "Add this repository's Artifacts read or write token in Settings → Forges → Cloudflare Artifacts. Git cannot use a Cloudflare API token." });
      credentials.push({ remote: remote.remote, token: token.value });
    }
    return ok(artifactsGitEnvironment(env, credentials, verb === "push"));
  };
}
