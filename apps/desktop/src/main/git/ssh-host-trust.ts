import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalForgeHostname, type ForgeKind, type SshHostTrustProposal } from "@pwrgit/shared";
import { createForgeSshHostKeyProviders, parseSshPublicKey, type ForgeSshHostKeyProvider } from "../forge/ssh-host-keys";

type Run = (binary: string, args: string[]) => Promise<{ stdout: string; code: number }>;
const runTool: Run = (binary, args) => new Promise((resolveRun, reject) => {
  execFile(binary, args, { timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true, cwd: homedir() }, (error, stdout) => {
    if (error && (typeof error.code !== "number" || error.killed)) {
      reject(new Error("OpenSSH could not inspect this host. Use the terminal command instead."));
    } else resolveRun({ stdout, code: error ? Number(error.code) : 0 });
  });
});

type Context = { host: string; port: number; files: string[]; config: string; destination: string };
type Pending = { owner: number; at: number; kind: ForgeKind; originalHost: string; context: Context; snapshots: string[]; key: string; proposal: SshHostTrustProposal };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function contents(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw new Error("Unsupported known_hosts file. Use the terminal command.");
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** Only an explicit, main-owned proposal can write a key. Existing host entries
 * (including hashed/revoked/CA entries) are never replaced or bypassed. */
export class SshHostTrustService {
  private readonly pending = new Map<string, Pending>();
  private busy = false;
  constructor(private readonly deps: {
    allowed: (kind: ForgeKind, hostname: string) => boolean;
    providers?: Record<ForgeKind, ForgeSshHostKeyProvider>;
    run?: Run;
    home?: string;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
  }) {}
  private get run(): Run { return this.deps.run ?? runTool; }
  private get home(): string { return this.deps.home ?? homedir(); }
  private get now(): number { return (this.deps.now ?? Date.now)(); }

  private async context(hostname: string): Promise<Context> {
    const env = this.deps.env ?? process.env;
    if (env.GIT_SSH || env.GIT_SSH_COMMAND || env.GIT_SSH_VARIANT) throw new Error("Custom SSH commands require terminal verification.");
    const gitConfig = await this.run("git", ["config", "--get", "core.sshCommand"]);
    if (gitConfig.code !== 1) throw new Error("Custom Git SSH configuration requires terminal verification.");
    const config = await this.run("ssh", ["-G", "-o", "PermitLocalCommand=no", "--", `git@${hostname}`]);
    if (config.code !== 0) throw new Error("SSH configuration could not be resolved.");
    const value = (key: string) => config.stdout.split(/\r?\n/).find((line) => line.startsWith(`${key} `))?.slice(key.length + 1).trim();
    if (["proxycommand", "proxyjump", "hostkeyalias", "knownhostscommand"].some((key) => value(key) && value(key) !== "none")) {
      throw new Error("This host uses custom SSH routing or trust configuration. Use the terminal command.");
    }
    if (!["true", "yes", "ask", "accept-new"].includes(value("stricthostkeychecking") ?? "")) {
      throw new Error("SSH host checking is disabled in your configuration. Use the terminal to correct it before trusting a host.");
    }
    const rawHost = (value("hostname") ?? "").toLowerCase();
    const host = canonicalForgeHostname(rawHost);
    // Forge canonicalization strips www.; SSH routing must never do that.
    if (host !== rawHost) throw new Error("This SSH hostname requires terminal verification.");
    const port = Number(value("port"));
    if (host === null || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Unsupported SSH endpoint.");
    const paths = (text: string) => (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((path) => {
      const unquoted = path.replace(/^["']|["']$/g, "");
      return unquoted.startsWith("~/") ? join(this.home, unquoted.slice(2)) : resolve(unquoted);
    });
    const userFiles = paths(value("userknownhostsfile") ?? "");
    const destination = join(this.home, ".ssh", "known_hosts");
    if (userFiles.length === 0 || userFiles[0] !== destination || userFiles.some((path) => path !== destination && path !== `${destination}2`)) {
      throw new Error("Custom known_hosts locations require terminal verification.");
    }
    const globalFiles = paths(value("globalknownhostsfile") ?? "");
    return { host, port, files: [...new Set([...userFiles, ...globalFiles])], destination, config: config.stdout };
  }

  async inspect(kind: ForgeKind, hostname: string, owner: number): Promise<SshHostTrustProposal> {
    if (this.busy) throw new Error("Another SSH host verification is in progress.");
    const canonical = canonicalForgeHostname(hostname);
    if (canonical === null || !this.deps.allowed(kind, canonical)) throw new Error("This forge host is not enabled.");
    this.busy = true;
    try {
      for (const [id, item] of this.pending) if (item.owner === owner || this.now - item.at > 300000) this.pending.delete(id);
      if (this.pending.size >= 16) throw new Error("Too many pending host verifications.");
      const context = await this.context(canonical);
      const scan = await this.run("ssh-keyscan", ["-T", "5", "-p", String(context.port), "-t", "ed25519,ecdsa,rsa", context.host]);
      const keys = scan.stdout.split(/\r?\n/).flatMap((line) => {
        if (line.startsWith("#")) return [];
        const parts = line.trim().split(/\s+/);
        const key = parseSshPublicKey(parts.slice(1).join(" "));
        return key === null ? [] : [key];
      });
      if (keys.length === 0) throw new Error("No SSH server key was received. Use the terminal command.");
      const key = keys.find((item) => item.algorithm === "ssh-ed25519") ?? keys[0]!;
      const snapshots = await Promise.all(context.files.map(contents));
      const target = context.port === 22 ? context.host : `[${context.host}]:${context.port}`;
      let existing = false;
      for (let i = 0; i < context.files.length; i++) {
        if (!snapshots[i]) continue;
        const found = await this.run("ssh-keygen", ["-F", target, "-f", context.files[i]!]);
        if (found.code !== 0 && found.code !== 1) throw new Error("Existing SSH trust could not be checked.");
        if (found.code === 0) existing = true;
      }
      const proposal: SshHostTrustProposal = {
        id: randomUUID(), hostname: context.host, port: context.port,
        algorithm: key.algorithm, fingerprint: key.fingerprint,
        verification: "unpublished", sourceUrl: null, canTrust: true,
        message: "No published key source is available for this endpoint. Verify this fingerprint with the host administrator before trusting it."
      };
      try {
        const provider = (this.deps.providers ?? createForgeSshHostKeyProviders())[kind];
        const published = await provider.lookup(context.host, context.port);
        if (published !== null) {
          proposal.sourceUrl = published.sourceUrl;
          const matches = published.keys.some((item) => item.algorithm === key.algorithm && item.key === key.key);
          proposal.verification = matches ? "published-match" : "mismatch";
          proposal.canTrust = matches;
          proposal.message = matches ? "Matches the host key published by the forge over HTTPS." : "Does not match the forge’s published host keys. Do not connect; verify this with the host administrator.";
        }
      } catch {
        proposal.verification = "lookup-failed";
        proposal.message = "The published key lookup failed. This key has NOT been verified. Verify it independently before trusting, or cancel and try again.";
      }
      if (existing) {
        proposal.verification = "existing-key";
        proposal.canTrust = false;
        proposal.message = "An SSH trust entry already exists for this endpoint. PwrGit will not replace it. A changed, revoked, or conflicting key requires investigation in your terminal.";
      }
      this.pending.set(proposal.id, { owner, at: this.now, kind, originalHost: canonical, context, snapshots: snapshots.map(digest), key: `${key.algorithm} ${key.key}`, proposal });
      return proposal;
    } finally { this.busy = false; }
  }

  async trust(id: string, owner: number): Promise<void> {
    if (this.busy) throw new Error("Another SSH host verification is in progress.");
    const item = this.pending.get(id);
    if (!item || item.owner !== owner || !item.proposal.canTrust || this.now < item.at || this.now - item.at > 300000) throw new Error("This SSH approval is unavailable or expired. Inspect the host again.");
    if (!this.deps.allowed(item.kind, item.originalHost)) throw new Error("This forge host is no longer enabled.");
    this.busy = true;
    this.pending.delete(id);
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    const directory = join(this.home, ".ssh");
    const lockPath = join(directory, ".pwrgit-host-trust.lock");
    try {
      const context = await this.context(item.originalHost);
      if (context.config !== item.context.config) throw new Error("SSH configuration changed. Inspect the host again.");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await lstat(directory)).isSymbolicLink()) throw new Error("A linked SSH directory requires terminal verification.");
      lock = await open(lockPath, "wx", 0o600);
      const snapshots = await Promise.all(context.files.map(contents));
      if (snapshots.some((text, i) => digest(text) !== item.snapshots[i])) throw new Error("SSH trust changed while approval was open. Inspect the host again.");
      const target = context.port === 22 ? context.host : `[${context.host}]:${context.port}`;
      // Append only the exact key shown in this proposal. No scan at approval
      // time, no replacement, and no StrictHostKeyChecking bypass on retry.
      const file = await open(context.destination, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const before = snapshots[context.files.indexOf(context.destination)] ?? "";
        const current = await file.readFile("utf8");
        const handleStat = await file.stat();
        const pathStat = await lstat(context.destination);
        if (current !== before || pathStat.isSymbolicLink() || pathStat.ino !== handleStat.ino || !handleStat.isFile()) {
          throw new Error("SSH trust changed while approval was open. Inspect the host again.");
        }
        await file.writeFile(`${before !== "" && !before.endsWith("\n") ? "\n" : ""}${target} ${item.key}\n`, "utf8");
        await file.sync();
      } finally { await file.close(); }
    } finally {
      try {
        if (lock) { await lock.close(); await unlink(lockPath); }
      } finally { this.busy = false; }
    }
  }
}
