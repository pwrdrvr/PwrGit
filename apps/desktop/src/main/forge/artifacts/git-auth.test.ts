import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { createSystemGit } from "../../git/test-support/system-git";
import { ArtifactsCredentials } from "./credentials";
import { artifactsGitEnvironment, createArtifactsGitAuthentication } from "./git-auth";

const hostname = "0123456789abcdef0123456789abcdef.artifacts.cloudflare.net";
const remote = `https://${hostname}/git/default/demo.git`;
const token = `art_v1_${"a".repeat(40)}?expires=1900000000`;
const otherRemote = remote.replace("demo.git", "other.git");
const otherToken = token.replace("a".repeat(40), "b".repeat(40));
let directory: string;
let store: ArtifactsCredentials;
const git = createSystemGit();
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "pwrgit-artifacts-auth-"));
  // Storage behavior is independently covered using an authenticated cipher.
  store = new ArtifactsCredentials(join(directory, "tokens"), {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString()
  }, () => 1_800_000_000_000);
  store.save(remote, token); store.save(otherRemote, otherToken);
  expect((await git(["init", "-b", "main"], directory)).ok).toBe(true);
  await git(["remote", "add", "origin", remote], directory);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function config(env: Record<string, string | undefined>, key: string): string[] {
  return Array.from({ length: Number(env.GIT_CONFIG_COUNT ?? 0) }, (_, index) =>
    env[`GIT_CONFIG_KEY_${index}`] === key ? env[`GIT_CONFIG_VALUE_${index}`] : undefined
  ).filter((value): value is string => value !== undefined);
}

describe("Artifacts authentication on every Git network operation", () => {
  it.each([
    ["clone", "--depth", "1", "--", remote, "destination"],
    ["fetch", "--prune", "origin"], ["pull", "--ff-only"],
    ["push", "origin", "HEAD:main"], ["ls-remote", remote]
  ])("authenticates %s without changing argv or writing the header to Git config", async (...args) => {
    const original = [...args];
    const authenticate = createArtifactsGitAuthentication(store, git, () => ({ [hostname]: "artifacts" }));
    const result = await authenticate(args, directory, { GIT_TRACE_CURL: "1", GIT_TRACE2_EVENT: join(directory, "trace") });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(args).toEqual(original);
    expect(config(result.value, `http.${remote}/.extraHeader`)).toEqual(["", `Authorization: Bearer ${token}`]);
    expect(config(result.value, `http.${remote}/.followRedirects`)).toEqual(["false"]);
    expect(config(result.value, "protocol.version")).toEqual(args[0] === "push" ? ["1"] : []);
    expect(result.value.GIT_TRACE_CURL).toBe("0"); expect(result.value.GIT_TRACE2_EVENT).toBe("0");
    const bare = await git(["remote", "get-url", "origin"], directory);
    expect(bare).toMatchObject({ ok: true, value: { stdout: `${remote}\n` } });
    const saved = await git(["config", "--local", "--list"], directory);
    expect(JSON.stringify(saved)).not.toContain(token);
  });
  it("uses Git's push URL, branch remote and all-remote resolution", async () => {
    await git(["remote", "add", "secondary", otherRemote], directory);
    await git(["remote", "set-url", "--push", "origin", otherRemote], directory);
    await git(["config", "branch.main.remote", "secondary"], directory);
    const authenticate = createArtifactsGitAuthentication(store, git, () => ({ [hostname]: "artifacts" }));
    for (const args of [["push", "origin"], ["pull"]]) {
      const result = await authenticate(args, directory, {});
      expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.code);
      expect(config(result.value, `http.${otherRemote}/.extraHeader`)).toContain(`Authorization: Bearer ${otherToken}`);
      expect(config(result.value, `http.${remote}/.extraHeader`)).toEqual([]);
    }
    const all = await authenticate(["fetch", "--all"], directory, {});
    expect(all.ok).toBe(true); if (!all.ok) throw new Error(all.error.code);
    expect(config(all.value, `http.${remote}/.extraHeader`)).toContain(`Authorization: Bearer ${token}`);
    expect(config(all.value, `http.${otherRemote}/.extraHeader`)).toContain(`Authorization: Bearer ${otherToken}`);
    await git(["config", "branch.main.remote", "."], directory);
    expect(await authenticate(["pull"], directory, {})).toEqual(ok({}));
  });
  it("does no work for local commands, existing forges or an unregistered account", async () => {
    const spy = vi.fn(git);
    const authenticate = createArtifactsGitAuthentication(store, spy, () => ({}));
    expect(await authenticate(["fetch", "origin"], directory, {})).toEqual(ok({}));
    expect(await authenticate(["clone", remote, "destination"], directory, {})).toEqual(ok({}));
    expect(spy).not.toHaveBeenCalled();
    const registered = createArtifactsGitAuthentication(store, spy, () => ({ [hostname]: "artifacts" }));
    expect(await registered(["status"], directory, {})).toEqual(ok({}));
    expect(await registered(["clone", "https://github.com/team/repo.git"], directory, {})).toEqual(ok({}));
    expect(spy).not.toHaveBeenCalled();
  });
  it("fails before network activity for missing tokens, invalid protocols and partial clone", async () => {
    const authenticate = createArtifactsGitAuthentication(store, git, () => ({ [hostname]: "artifacts" }));
    expect(await authenticate(["clone", remote.replace("demo.git", "missing.git")], directory, {})).toMatchObject({ ok: false, error: { code: "artifacts_token_required" } });
    expect(await authenticate(["clone", `git@${hostname}:default/demo.git`], directory, {})).toMatchObject({ ok: false, error: { code: "invalid_artifacts_remote" } });
    expect(await authenticate(["clone", remote.replace("https:", "http:")], directory, {})).toMatchObject({ ok: false, error: { code: "invalid_artifacts_remote" } });
    expect(await authenticate(["clone", "--filter=blob:none", remote], directory, {})).toMatchObject({ ok: false, error: { code: "artifacts_partial_clone_unsupported" } });
  });
});

it("real Git scopes the full header to only this repository's HTTP endpoints", async () => {
  const env = artifactsGitEnvironment({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: inherited" }, [{ remote, token }], true);
  for (const url of [`${remote}/info/refs`, `${remote}/git-upload-pack`, `${remote}/git-receive-pack`]) {
    const result = await git(["config", "--get-urlmatch", "http.extraHeader", url], directory, { env });
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0, stdout: `Authorization: Bearer ${token}\n` } });
  }
  for (const url of [`${otherRemote}/info/refs`, `https://other.example/git/default/demo.git/info/refs`]) {
    const result = await git(["config", "--get-urlmatch", "http.extraHeader", url], directory, { env });
    expect(JSON.stringify(result)).not.toContain(token);
  }
  expect(await git(["config", "--get", "protocol.version"], directory, { env })).toMatchObject({ ok: true, value: { stdout: "1\n" } });
});
