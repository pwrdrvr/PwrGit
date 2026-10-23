import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ArtifactsWrangler, wranglerClient, wranglerInvocation, type WranglerRunner } from "./wrangler";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/wrangler.json", import.meta.url), "utf8"));
const hostname = fixture.whoami.accounts[0].id + ".artifacts.cloudflare.net";
const remote = fixture.repositories[0].remote;
const now = () => 1_800_000_000_000;
function runner(): ReturnType<typeof vi.fn<WranglerRunner>> {
  return vi.fn<WranglerRunner>(async (args) => {
    if (args[0] === "--version") return "4.100.0";
    if (args[0] === "whoami") return JSON.stringify(fixture.whoami);
    if (args[1] === "namespaces") return JSON.stringify(fixture.namespaces);
    if (args[2] === "list") return JSON.stringify(fixture.repositories);
    if (args[2] === "get") return JSON.stringify(fixture.repositories[0]);
    if (args[2] === "create") return JSON.stringify({ ...fixture.repositories[0], token: fixture.token.plaintext });
    if (args[2] === "issue-token") return JSON.stringify({ ...fixture.token, scope: args[args.indexOf("--scope") + 1] });
    throw new Error("Unexpected command");
  });
}
describe("verified Wrangler Artifacts output", () => {
  it("returns only account metadata, coalesces probes and refreshes explicitly", async () => {
    const run = runner(); const client = new ArtifactsWrangler(run, now);
    const [a, b] = await Promise.all([client.accounts(), client.accounts()]);
    expect(a).toEqual(b);
    expect(a).toEqual({ installed: true, loggedIn: true, accounts: [{ hostname, name: "Fixture account" }] });
    expect(JSON.stringify(a)).not.toContain("fixture-oauth-secret");
    expect(run).toHaveBeenCalledTimes(2);
    expect(await client.hasAccount(hostname)).toBe(true);
    expect(await client.hasAccount("f".repeat(32) + ".artifacts.cloudflare.net")).toBe(false);
    await client.accounts(true); expect(run).toHaveBeenCalledTimes(4);
  });
  it("distinguishes missing CLI from failed login and never interprets text-mode exit zero as authentication", async () => {
    const missing = new ArtifactsWrangler(async () => { throw new Error("not installed"); });
    expect(await missing.accounts()).toEqual({ installed: false, loggedIn: false, accounts: [] });
    for (const payload of [{ loggedIn: false }, { loggedIn: true, accounts: null }, { loggedIn: true, accounts: [{ id: "bad", name: "bad" }] }]) {
      const run = vi.fn<WranglerRunner>(async (args) => args[0] === "--version" ? "4" : JSON.stringify(payload));
      expect(await new ArtifactsWrangler(run).accounts()).toEqual({ installed: true, loggedIn: false, accounts: [] });
      expect(run).toHaveBeenCalledWith(["whoami", "--json"]);
    }
  });
  it("pins the selected account and uses API-provided remotes, with unknown push permission unless read_only is true", async () => {
    const run = runner(); const client = new ArtifactsWrangler(run, now);
    expect(await client.namespaces(hostname)).toEqual(["default"]);
    const repos = await client.repositories(hostname, "default");
    expect(repos[0]).toMatchObject({ host: "artifacts", hostname, nameWithOwner: "default/starter-repo", httpsUrl: remote, sshUrl: "", visibility: "unknown" });
    expect(repos[0]).not.toHaveProperty("viewerCanPush");
    expect(await client.repositoryAt(remote)).toEqual(repos[0]);
    expect(await client.createRepository(hostname, "default", "starter-repo")).toEqual(repos[0]);
    expect(JSON.stringify(repos)).not.toContain("art_v1_");
    for (const call of run.mock.calls) expect(call[1]?.env).toEqual({ CLOUDFLARE_ACCOUNT_ID: fixture.whoami.accounts[0].id, CF_ACCOUNT_ID: fixture.whoami.accounts[0].id });
    run.mockResolvedValueOnce(JSON.stringify([{ ...fixture.repositories[0], read_only: true }]));
    expect((await client.repositories(hostname, "default"))[0]?.viewerCanPush).toBe(false);
  });
  it("requests a fresh token for the exact scope with a bounded TTL and validates expiry", async () => {
    const run = runner(); const client = new ArtifactsWrangler(run, now);
    for (const scope of ["read", "write"] as const) {
      expect(await client.token(remote, scope)).toBe(fixture.token.plaintext);
      expect(run).toHaveBeenLastCalledWith(["artifacts", "repos", "issue-token", "starter-repo", "--namespace", "default", "--scope", scope, "--ttl", "3600", "--json"], expect.anything());
    }
    expect(run).toHaveBeenCalledTimes(2);
    for (const bad of [{ ...fixture.token, scope: "write" }, { ...fixture.token, plaintext: "art_v1_" + "a".repeat(40) + "?expires=1" }, { plaintext: "secret" }]) {
      run.mockResolvedValueOnce(JSON.stringify(bad));
      await expect(client.token(remote, "read")).rejects.toThrow("invalid or expired");
    }
  });
  it("rejects malformed responses and cross-account remotes instead of returning empty repositories", async () => {
    const run = runner(); const client = new ArtifactsWrangler(run, now);
    for (const payload of [null, {}, [{ ...fixture.repositories[0], remote: remote.replace("0123456789abcdef0123456789abcdef", "f".repeat(32)) }]]) {
      run.mockResolvedValueOnce(JSON.stringify(payload));
      await expect(client.repositories(hostname, "default")).rejects.toThrow();
    }
    const count = run.mock.calls.length;
    await expect(client.repositories("evil.example", "default")).rejects.toThrow();
    await expect(client.repositories(hostname, "../oops")).rejects.toThrow();
    await expect(client.createRepository(hostname, "default", "--help")).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(count);
  });
  it("redacts repository and older whoami credential output in diagnostics", () => {
    const output = `Authorization: Bearer arbitrary-secret\n{"apiToken":"fixture-oauth-secret","plaintext":"${fixture.token.plaintext}"}`;
    const safe = wranglerClient.sanitize(output, {});
    for (const secret of ["arbitrary-secret", "fixture-oauth-secret", fixture.token.plaintext]) expect(safe).not.toContain(secret);
  });
  it("runs npm's Windows script directly with separate arguments", () => {
    expect(wranglerInvocation({ PATH: "C:\\Tools;C:\\Users\\Fixture\\AppData\\Roaming\\npm" }, "win32", (path) => path.startsWith("C:\\Users"))).toEqual({ binary: "node", prefix: ["C:\\Users\\Fixture\\AppData\\Roaming\\npm\\node_modules\\wrangler\\bin\\wrangler.js"] });
    expect(() => wranglerInvocation({ PATH: "relative" }, "win32", () => true)).toThrow("Install Wrangler");
  });
});
