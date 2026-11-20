import { createHash } from "node:crypto";
import type { DB } from "../persistence/db";
import {
  newChatGptHostId,
  type ChatGptCredential,
  type ChatGptRegistration,
  type ChatGptStorage,
} from "./chatgpt-auth";

type LocalEncryption = {
  encryptString(text: string): Buffer;
  decryptString(value: Buffer): string;
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
};
/** Tokens use the desktop app's OS-user encryption key. Nonsecret registration
 * metadata survives disconnect; token records are separate per client/sub and
 * profile. Profile deletion clears both through its reserved namespace. */
export class ChatGptSecretStore implements ChatGptStorage {
  constructor(
    private readonly db: DB,
    private readonly encryption: LocalEncryption,
  ) {}
  private get(key: string): string | undefined {
    return (
      this.db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }
  private put(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }
  private credentialKey(
    profileId: string,
    registration: ChatGptRegistration,
  ): string {
    const identity = createHash("sha256")
      .update(JSON.stringify([registration.clientId, registration.subject]))
      .digest("hex");
    return `profile:${profileId}:chatgpt-credential:${identity}`;
  }
  hostId(): string {
    const saved = this.get("chatgpt:host-id");
    if (saved) return saved;
    const host = newChatGptHostId();
    this.put("chatgpt:host-id", host);
    return host;
  }
  read(profileId: string): ChatGptRegistration | undefined {
    const value = this.get(`profile:${profileId}:chatgpt-registration`);
    if (!value) return undefined;
    try {
      const saved = JSON.parse(value) as ChatGptRegistration;
      if (
        !/^oaiapp_[A-Za-z0-9_-]+$/.test(saved.clientId) ||
        !saved.subject ||
        saved.credential !== undefined
      )
        throw new Error();
      const encrypted = this.get(this.credentialKey(profileId, saved));
      if (encrypted) {
        const credential = JSON.parse(
          this.encryption.decryptString(Buffer.from(encrypted, "base64")),
        ) as ChatGptCredential;
        if (
          credential.clientId !== saved.clientId ||
          credential.subject !== saved.subject
        )
          throw new Error();
        saved.credential = credential;
      }
      return saved;
    } catch {
      throw new Error("Stored ChatGPT registration could not be read.");
    }
  }
  clearTokens(profileId: string): void {
    const prefix = `profile:${profileId}:chatgpt-credential:`;
    this.db
      .prepare("DELETE FROM app_meta WHERE substr(key, 1, ?) = ?")
      .run(prefix.length, prefix);
  }
  write(profileId: string, value: ChatGptRegistration): void {
    if (!this.db.prepare("SELECT id FROM profiles WHERE id = ?").get(profileId))
      throw new Error("ChatGPT credentials require an existing profile.");
    if (!/^oaiapp_[A-Za-z0-9_-]+$/.test(value.clientId) || !value.subject)
      throw new Error(
        "An issued ChatGPT client ID and verified subject are required.",
      );
    const { credential, ...registration } = value;
    let encrypted: string | undefined;
    if (credential) {
      if (
        credential.clientId !== value.clientId ||
        credential.subject !== value.subject
      )
        throw new Error("ChatGPT credentials do not match the registration.");
      if (
        !this.encryption.isEncryptionAvailable() ||
        this.encryption.getSelectedStorageBackend?.() === "basic_text"
      )
        throw new Error(
          "OS credential encryption is unavailable. ChatGPT tokens were not saved.",
        );
      encrypted = this.encryption
        .encryptString(JSON.stringify(credential))
        .toString("base64");
    }
    this.db.transaction(() => {
      this.clearTokens(profileId);
      this.put(
        `profile:${profileId}:chatgpt-registration`,
        JSON.stringify(registration),
      );
      if (encrypted !== undefined)
        this.put(this.credentialKey(profileId, registration), encrypted);
    })();
  }
}
