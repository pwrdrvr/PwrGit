import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSystemGit, systemGitLauncher } from "../../git/test-support/system-git";
import { artifactsGitEnvironment } from "./git-auth";

/** Real Git against a local smart-HTTP fixture. This checks Git's header
 * transport; it is NOT a live Artifacts compatibility or permission test. */
it("clones, fetches, pulls and pushes with ephemeral Bearer headers and a bare remote", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pwrgit-artifacts-http-"));
  const git = createSystemGit({ env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" } });
  const bare = join(directory, "git", "default", "demo.git");
  const seed = join(directory, "seed"); const clone = join(directory, "clone");
  mkdirSync(seed); mkdirSync(join(directory, "git", "default"), { recursive: true });
  const run = async (args: string[], cwd: string, env?: Record<string, string | undefined>) => {
    const result = await git(args, cwd, env === undefined ? {} : { env });
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.code);
    expect(result.value.exitCode, result.value.stderr).toBe(0); return result.value;
  };
  const readToken = `art_v1_${"a".repeat(40)}?expires=1900000000`;
  const writeToken = `art_v1_${"b".repeat(40)}?expires=1900000000`;
  const seen: { path: string; write: boolean; protocol: string | undefined }[] = [];
  const children = new Set<ReturnType<typeof spawn>>();
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const write = url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack");
    if (req.headers.authorization !== `Bearer ${write ? writeToken : readToken}` && req.headers.authorization !== `Bearer ${writeToken}`) {
      res.writeHead(403); res.end("Use an appropriate repo token"); return;
    }
    seen.push({ path: url.pathname, write, protocol: req.headers["git-protocol"] as string | undefined });
    const launch = systemGitLauncher(process.env)({});
    const backend = spawn(launch.binary, ["http-backend"], {
      cwd: directory, env: { ...launch.env, GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
        CONTENT_TYPE: req.headers["content-type"] ?? "", REMOTE_USER: "fixture", REMOTE_ADDR: "127.0.0.1",
        ...(req.headers["git-protocol"] ? { HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}) }
    });
    children.add(backend); const output: Buffer[] = [];
    backend.stdin.on("error", () => undefined); req.pipe(backend.stdin);
    backend.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    backend.stderr.resume();
    backend.on("error", () => { res.writeHead(500); res.end("Fixture backend failed"); });
    backend.on("close", () => {
      children.delete(backend); if (res.writableEnded) return;
      const data = Buffer.concat(output); const boundary = data.indexOf("\r\n\r\n");
      if (boundary < 0) { res.writeHead(500); res.end("Fixture response invalid"); return; }
      for (const header of data.subarray(0, boundary).toString().split("\r\n")) {
        const colon = header.indexOf(":"); const name = header.slice(0, colon); const value = header.slice(colon + 1).trim();
        if (name.toLowerCase() === "status") res.statusCode = Number(value.split(" ")[0]);
        else if (colon > 0) res.setHeader(name, value);
      }
      res.end(data.subarray(boundary + 4));
    });
  });
  try {
    await run(["init", "--bare", bare], directory); await run(["config", "http.receivepack", "true"], bare);
    await run(["init", "-b", "main"], seed); await run(["config", "user.email", "fixture@example.test"], seed); await run(["config", "user.name", "Fixture"], seed);
    writeFileSync(join(seed, "README.md"), "first\n"); await run(["add", "."], seed); await run(["commit", "-m", "first"], seed);
    await run(["push", bare, "HEAD:main"], seed); await run(["symbolic-ref", "HEAD", "refs/heads/main"], bare);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Fixture did not listen");
    // Only the HTTP transport helper accepts this test-only localhost URL.
    // Product remote validation separately requires the documented HTTPS host.
    const remote = `http://127.0.0.1:${address.port}/git/default/demo.git`;
    const readEnv = artifactsGitEnvironment({}, [{ remote, token: readToken }], false);
    await run(["clone", remote, clone], directory, readEnv);
    expect((await run(["remote", "get-url", "origin"], clone)).stdout.trim()).toBe(remote);
    expect(readFileSync(join(clone, ".git", "config"), "utf8")).not.toContain(readToken);
    await run(["fetch", "origin"], clone, readEnv);
    writeFileSync(join(seed, "README.md"), "second\n"); await run(["commit", "-am", "second"], seed); await run(["push", bare, "main"], seed);
    await run(["pull", "--ff-only"], clone, readEnv); expect(readFileSync(join(clone, "README.md"), "utf8")).toBe("second\n");
    await run(["config", "user.email", "fixture@example.test"], clone); await run(["config", "user.name", "Fixture"], clone);
    writeFileSync(join(clone, "README.md"), "third\n"); await run(["commit", "-am", "third"], clone);
    const denied = await git(["push", "origin", "main"], clone, { env: artifactsGitEnvironment({}, [{ remote, token: readToken }], true) });
    expect(denied).toMatchObject({ ok: true, value: { exitCode: 128 } });
    await run(["push", "origin", "main"], clone, artifactsGitEnvironment({}, [{ remote, token: writeToken }], true));
    expect((await run(["log", "-1", "--format=%s", "main"], bare)).stdout.trim()).toBe("third");
    expect(seen.some((request) => request.path.endsWith("git-upload-pack"))).toBe(true);
    expect(seen.some((request) => request.path.endsWith("git-receive-pack"))).toBe(true);
    expect(seen.filter((request) => request.write).every((request) => request.protocol !== "version=2")).toBe(true);
    expect(readFileSync(join(clone, ".git", "config"), "utf8")).not.toContain(writeToken);
  } finally {
    for (const child of children) child.kill(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
