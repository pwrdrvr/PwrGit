import { mkdtemp, readFile, rm, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SshHostTrustService } from "./ssh-host-trust";
import { parseSshPublicKey, type ForgeSshHostKeyProvider } from "../forge/ssh-host-keys";

const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString("base64");
const key = `ssh-ed25519 ${blob}`;
let home: string;
let now = 1000;
let config: string;
let found = false;
let allowed = true;
let lookup: ReturnType<typeof vi.fn<ForgeSshHostKeyProvider["lookup"]>>;
let run: ReturnType<typeof vi.fn<(binary: string, args: string[]) => Promise<{ stdout: string; code: number }>>>;
let service: SshHostTrustService;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pwrgit-ssh-trust-"));
  now = 1000; found = false; allowed = true;
  config = `hostname git.cafe\nport 22\nstricthostkeychecking ask\nuserknownhostsfile "${join(home, ".ssh", "known_hosts")}"\nglobalknownhostsfile "${join(home, "global_hosts")}"\n`;
  lookup = vi.fn(async () => null);
  run = vi.fn(async (binary: string) => {
    if (binary === "git") return { stdout: "", code: 1 };
    if (binary === "ssh") return { stdout: config, code: 0 };
    if (binary === "ssh-keyscan") return { stdout: `git.cafe ${key}\n`, code: 0 };
    if (binary === "ssh-keygen") return { stdout: found ? `git.cafe ${key}` : "", code: found ? 0 : 1 };
    throw new Error("Unexpected command");
  });
  const provider = { lookup };
  service = new SshHostTrustService({ home, run, now: () => now, env: {}, allowed: () => allowed, providers: { github: provider, gitlab: provider, gitcafe: provider } });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
it("does not save during inspection and saves only the key approved by this window", async () => {
  const proposal = await service.inspect("gitcafe", "git.cafe", 7);
  expect(proposal.verification).toBe("unpublished");
  await expect(readFile(join(home, ".ssh", "known_hosts"))).rejects.toThrow();
  await expect(service.trust(proposal.id, 8)).rejects.toThrow("unavailable");
  await service.trust(proposal.id, 7);
  expect(await readFile(join(home, ".ssh", "known_hosts"), "utf8")).toBe(`git.cafe ${key}\n`);
  expect(run.mock.calls.filter(([binary]) => binary === "ssh-keyscan")).toHaveLength(1);
  await expect(service.trust(proposal.id, 7)).rejects.toThrow("unavailable");
});
it("compares the scanned key to a published HTTPS key", async () => {
  lookup.mockResolvedValue({ sourceUrl: "https://example.com/keys", keys: [parseSshPublicKey(key)!] });
  const proposal = await service.inspect("gitcafe", "git.cafe", 7);
  expect(proposal).toMatchObject({ verification: "published-match", canTrust: true });
});
it("blocks a published-key mismatch", async () => {
  lookup.mockResolvedValue({ sourceUrl: "https://example.com/keys", keys: [] });
  const proposal = await service.inspect("gitcafe", "git.cafe", 7);
  expect(proposal).toMatchObject({ verification: "mismatch", canTrust: false });
  await expect(service.trust(proposal.id, 7)).rejects.toThrow();
});
it("reports lookup failure without claiming verification", async () => {
  lookup.mockRejectedValue(new Error("offline"));
  expect(await service.inspect("gitcafe", "git.cafe", 7)).toMatchObject({ verification: "lookup-failed", sourceUrl: null });
});
it("never overwrites matching, hashed, revoked or changed existing trust", async () => {
  await writeFile(join(home, "global_hosts"), "@revoked |1|hashed key\n");
  found = true;
  const proposal = await service.inspect("gitcafe", "git.cafe", 7);
  expect(proposal).toMatchObject({ verification: "existing-key", canTrust: false });
  await expect(service.trust(proposal.id, 7)).rejects.toThrow();
});
it("rejects stale approvals and disabled hosts", async () => {
  let proposal = await service.inspect("gitcafe", "git.cafe", 7);
  now += 300001;
  await expect(service.trust(proposal.id, 7)).rejects.toThrow("expired");
  proposal = await service.inspect("gitcafe", "git.cafe", 7);
  allowed = false;
  await expect(service.trust(proposal.id, 7)).rejects.toThrow("no longer enabled");
});
it("rejects changed SSH configuration or changed known_hosts before writing", async () => {
  let proposal = await service.inspect("gitcafe", "git.cafe", 7);
  config += "compression no\n";
  await expect(service.trust(proposal.id, 7)).rejects.toThrow("configuration changed");
  proposal = await service.inspect("gitcafe", "git.cafe", 7);
  await mkdir(join(home, ".ssh"));
  await writeFile(join(home, ".ssh", "known_hosts"), "other.example old-key\n");
  await expect(service.trust(proposal.id, 7)).rejects.toThrow("trust changed");
  expect(await readFile(join(home, ".ssh", "known_hosts"), "utf8")).toBe("other.example old-key\n");
});
it("honors the resolved port and refuses proxy routing and disabled host checking", async () => {
  config = config.replace("port 22", "port 2222");
  const proposal = await service.inspect("gitcafe", "git.cafe", 7);
  expect(proposal.port).toBe(2222);
  await service.trust(proposal.id, 7);
  expect(await readFile(join(home, ".ssh", "known_hosts"), "utf8")).toContain("[git.cafe]:2222");
  config += "proxyjump bastion\n";
  await expect(service.inspect("gitcafe", "git.cafe", 7)).rejects.toThrow("custom SSH");
  config = config.replace("proxyjump bastion\n", "").replace("stricthostkeychecking ask", "stricthostkeychecking false");
  await expect(service.inspect("gitcafe", "git.cafe", 7)).rejects.toThrow("disabled");
});
it("bounds concurrent inspections and invalidates a prior proposal from the same window", async () => {
  const first = service.inspect("gitcafe", "git.cafe", 7);
  await expect(service.inspect("gitcafe", "git.cafe", 8)).rejects.toThrow("in progress");
  const proposal = await first;
  await service.inspect("gitcafe", "git.cafe", 7);
  await expect(service.trust(proposal.id, 7)).rejects.toThrow("unavailable");
});

it("never rewrites an SSH HostName through forge www canonicalization", async () => {
  config = config.replace("hostname git.cafe", "hostname www.git.cafe");
  await expect(service.inspect("gitcafe", "git.cafe", 7)).rejects.toThrow("terminal verification");
  expect(run.mock.calls.some(([binary]) => binary === "ssh-keyscan")).toBe(false);
});

// `allowed()` was asked about the host the renderer named. A HostName stanza
// makes `ssh -G` answer with a different endpoint, and the keyscan and the
// known_hosts line would then act on a host nothing checked.
it("refuses a host redirected elsewhere by SSH configuration", async () => {
  config = config.replace("hostname git.cafe", "hostname other.example");
  await expect(service.inspect("gitcafe", "git.cafe", 7)).rejects.toThrow("redirected");
  expect(run.mock.calls.some(([binary]) => binary === "ssh-keyscan")).toBe(false);
});

// Both states refuse the write; this is about which one the user is shown.
// A key that contradicts the published list while another is already trusted
// is an interception signature, not a housekeeping note.
it("keeps a published mismatch when trust for the endpoint already exists", async () => {
  lookup.mockResolvedValue({ sourceUrl: "https://example.com/keys", keys: [] });
  // `existing` is only consulted for a known_hosts file that has content.
  await writeFile(join(home, "global_hosts"), "@revoked |1|hashed key\n");
  found = true;
  const proposal = await service.inspect("gitcafe", "git.cafe", 7);
  expect(proposal).toMatchObject({ verification: "mismatch", canTrust: false });
  expect(proposal.message).toContain("Do not connect");
  expect(proposal.message).toContain("already trusted");
});

it("recovers from a lock file a killed approval left behind", async () => {
  await mkdir(join(home, ".ssh"), { recursive: true });
  const lockPath = join(home, ".ssh", ".pwrgit-host-trust.lock");
  await writeFile(lockPath, "");
  const proposal = await service.inspect("gitcafe", "git.cafe", 7);
  // Still inside the window a live approval could hold it: refuse.
  await expect(service.trust(proposal.id, 7)).rejects.toThrow("in progress");
  const stale = await service.inspect("gitcafe", "git.cafe", 7);
  // Backdate the lock itself: staleness is real wall-clock against the file's
  // mtime, not the injected proposal clock.
  const old = new Date(Date.now() - 120000);
  await utimes(lockPath, old, old);
  await service.trust(stale.id, 7);
  expect(await readFile(join(home, ".ssh", "known_hosts"), "utf8")).toBe(`git.cafe ${key}\n`);
});
