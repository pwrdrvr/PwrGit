import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  artifactsTokenExpiry, err, ok, parseArtifactsRemote,
  type ArtifactsCredentialStatus, type Err, type PwrGitError, type Result
} from "@pwrgit/shared";

export type CredentialEncryption = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

/** App-wide, like existing forge logins. Only ciphertext is written to disk. */
export class ArtifactsCredentials {
  constructor(
    private readonly path: string,
    private readonly encryption: CredentialEncryption,
    private readonly now: () => number = Date.now
  ) {}

  available(): boolean {
    return this.encryption.isEncryptionAvailable() && this.encryption.getSelectedStorageBackend?.() !== "basic_text";
  }

  private read(): Record<string, string> {
    if (!this.available()) throw new Error("storage unavailable");
    if (!existsSync(this.path)) return {};
    if (statSync(this.path).size > 1_000_000) throw new Error("invalid credential file");
    const ciphertext = readFileSync(this.path);
    if (ciphertext.length > 1_000_000) throw new Error("invalid credential file");
    const data: unknown = JSON.parse(this.encryption.decryptString(ciphertext));
    if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid credential file");
    const entries: Record<string, string> = {};
    for (const [remote, token] of Object.entries(data)) {
      if (parseArtifactsRemote(remote)?.remote !== remote || typeof token !== "string" || artifactsTokenExpiry(token) === null) {
        throw new Error("invalid credential file");
      }
      entries[remote] = token;
    }
    return entries;
  }

  private write(entries: Record<string, string>): void {
    const ciphertext = this.encryption.encryptString(JSON.stringify(entries));
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, ciphertext, { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.path);
  }

  status(): Result<ArtifactsCredentialStatus> {
    if (!this.available()) return ok({ secureStorageAvailable: false, credentials: [] });
    try {
      return ok({ secureStorageAvailable: true, credentials: Object.entries(this.read()).map(([remote, token]) => {
        const expiresAt = artifactsTokenExpiry(token)!;
        return { remote, expiresAt, expired: expiresAt <= this.now() };
      }).sort((a, b) => a.remote.localeCompare(b.remote)) });
    } catch { return this.storageError(); }
  }

  save(remoteValue: unknown, tokenValue: unknown): Result<ArtifactsCredentialStatus> {
    const remote = typeof remoteValue === "string" ? parseArtifactsRemote(remoteValue) : null;
    if (remote === null) return err({ kind: "validation", code: "invalid_artifacts_remote", message: "Paste the credential-free HTTPS remote returned by Artifacts: https://<account-id>.artifacts.cloudflare.net/git/<namespace>/<repo>.git." });
    const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
    const expiresAt = artifactsTokenExpiry(token);
    if (expiresAt === null) return err({ kind: "validation", code: "invalid_artifacts_token", message: "Use the full repo token (art_v1_…?expires=…), including its expiry. A Cloudflare API token cannot authenticate Git." });
    if (expiresAt <= this.now()) return this.expiredError();
    if (!this.available()) return this.storageError();
    try {
      const entries = this.read();
      entries[remote.remote] = token;
      this.write(entries);
      return this.status();
    } catch { return this.storageError(); }
  }

  remove(remoteValue: unknown): Result<ArtifactsCredentialStatus> {
    const remote = typeof remoteValue === "string" ? parseArtifactsRemote(remoteValue) : null;
    if (remote === null) return err({ kind: "validation", code: "invalid_artifacts_remote", message: "Choose a saved Artifacts remote." });
    try {
      const entries = this.read();
      delete entries[remote.remote];
      this.write(entries);
      return this.status();
    } catch { return this.storageError(); }
  }

  token(remoteValue: string): Result<string | null> {
    const remote = parseArtifactsRemote(remoteValue);
    if (remote === null) return ok(null);
    if (!this.available()) return this.storageError();
    try {
      const token = this.read()[remote.remote];
      if (token === undefined) return ok(null);
      if (artifactsTokenExpiry(token)! <= this.now()) return this.expiredError();
      return ok(token);
    } catch { return this.storageError(); }
  }

  hasToken(host?: string): boolean {
    const status = this.status();
    return status.ok && status.value.credentials.some((entry) => !entry.expired && (host === undefined || parseArtifactsRemote(entry.remote)?.hostname === host));
  }

  private storageError(): Err<PwrGitError> {
    return err({ kind: "remote", code: "artifacts_storage_unavailable", message: "Artifacts credentials could not be opened securely. Unlock the OS credential store and retry in Settings → Forges → Cloudflare Artifacts. Linux requires a secure keyring; plaintext storage is refused." });
  }
  private expiredError(): Err<PwrGitError> {
    return err({ kind: "remote", code: "artifacts_token_expired", message: "The Artifacts repo token has expired. Issue a new read or write token in Cloudflare, then replace it in Settings → Forges → Cloudflare Artifacts." });
  }
}
