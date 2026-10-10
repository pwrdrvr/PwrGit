import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandBus } from "../../command-bus";
import { ArtifactsCredentials, type CredentialEncryption } from "./credentials";
import { registerArtifactsCredentialHandlers } from "./handlers";

const host = "0123456789abcdef0123456789abcdef.artifacts.cloudflare.net";
const remote = `https://${host}/git/default/demo.git`;
const token = `art_v1_${"a".repeat(40)}?expires=1900000000`;
// Test-only authenticated cipher; production uses Electron safeStorage/OS keys.
function encryption(): CredentialEncryption {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const cipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString();
    }
  };
}
let directory: string;
let path: string;
let store: ArtifactsCredentials;
let now: number;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pwrgit-artifacts-credentials-"));
  path = join(directory, "credentials.enc"); now = 1_800_000_000_000;
  store = new ArtifactsCredentials(path, encryption(), () => now);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("Artifacts encrypted credential storage", () => {
  it("writes ciphertext and returns only remote/expiry metadata", () => {
    const saved = store.save(remote, token);
    expect(saved).toEqual({ ok: true, value: { secureStorageAvailable: true, credentials: [{ remote, expiresAt: 1_900_000_000_000, expired: false }] } });
    expect(readFileSync(path).includes(Buffer.from(token))).toBe(false);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(store.status())).not.toContain(token);
    expect(store.token(remote)).toEqual({ ok: true, value: token });
    expect(store.token(remote.replace("demo.git", "other.git"))).toEqual({ ok: true, value: null });
    expect(store.hasToken(host)).toBe(true);
    expect(store.hasToken("other.example")).toBe(false);
  });
  it("keeps expired metadata but blocks its use and permits replacement/removal", () => {
    store.save(remote, token); now = 1_900_000_000_000;
    expect(store.token(remote)).toMatchObject({ ok: false, error: { code: "artifacts_token_expired" } });
    expect(store.status()).toMatchObject({ value: { credentials: [{ expired: true }] } });
    expect(store.hasToken()).toBe(false);
    expect(store.save(remote, token)).toMatchObject({ ok: false, error: { code: "artifacts_token_expired" } });
    expect(store.save(remote, token.replace("1900000000", "2000000000")).ok).toBe(true);
    expect(store.remove(remote)).toMatchObject({ ok: true, value: { credentials: [] } });
  });
  it.each([false, "basic_text"])("refuses insecure storage (%s) without writing", (backend) => {
    const insecure = new ArtifactsCredentials(path, { ...encryption(), isEncryptionAvailable: () => backend !== false, getSelectedStorageBackend: () => String(backend) });
    expect(insecure.status()).toEqual({ ok: true, value: { secureStorageAvailable: false, credentials: [] } });
    expect(insecure.save(remote, token)).toMatchObject({ ok: false, error: { code: "artifacts_storage_unavailable" } });
    expect(existsSync(path)).toBe(false);
  });
  it("rejects credential URLs, API tokens and corrupt ciphertext without echoing inputs", () => {
    expect(store.save(remote.replace("https://", `https://x:${token}@`), token)).toMatchObject({ ok: false, error: { code: "invalid_artifacts_remote" } });
    const failure = store.save(remote, "private-api-token");
    expect(failure).toMatchObject({ ok: false, error: { code: "invalid_artifacts_token" } });
    expect(JSON.stringify(failure)).not.toContain("private-api-token");
    writeFileSync(path, token);
    expect(store.status()).toMatchObject({ ok: false, error: { code: "artifacts_storage_unavailable" } });
    expect(JSON.stringify(store.status())).not.toContain(token);
  });
});

it("requires the local main-frame UI for mutations and registers a host only after a successful save", async () => {
  const bus = new CommandBus(); const register = vi.fn(); const changed = vi.fn(async () => undefined);
  registerArtifactsCredentialHandlers(bus, store, register, changed);
  for (const context of [{}, { webContentsId: 1, isMainFrame: false }]) {
    expect(await bus.dispatch("artifacts:saveCredential", { remote, token }, context)).toMatchObject({ ok: false, error: { code: "local_window_required" } });
  }
  expect(register).not.toHaveBeenCalled(); expect(existsSync(path)).toBe(false);
  const context = { webContentsId: 1, isMainFrame: true };
  expect((await bus.dispatch("artifacts:saveCredential", { remote, token: "bad" }, context)).ok).toBe(false);
  expect(register).not.toHaveBeenCalled();
  expect((await bus.dispatch("artifacts:saveCredential", { remote, token }, context)).ok).toBe(true);
  expect(register).toHaveBeenCalledWith(host); expect(changed).toHaveBeenCalledOnce();
  expect(JSON.stringify(await bus.dispatch("artifacts:credentials", undefined))).not.toContain(token);
  expect((await bus.dispatch("artifacts:removeCredential", { remote }, context)).ok).toBe(true);
});
