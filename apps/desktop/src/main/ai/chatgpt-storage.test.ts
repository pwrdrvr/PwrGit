import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { ChatGptSecretStore } from "./chatgpt-storage";
import type { ChatGptRegistration } from "./chatgpt-auth";
const databases: DB[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const key = randomBytes(32);
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString(text: string) {
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([iv, cipher.update(text), cipher.final()]);
  },
  decryptString(value: Buffer) {
    const cipher = createDecipheriv("aes-256-cbc", key, value.subarray(0, 16));
    return Buffer.concat([
      cipher.update(value.subarray(16)),
      cipher.final(),
    ]).toString();
  },
};
function saved(clientId: string): ChatGptRegistration {
  return {
    clientId,
    subject: "fixture-user",
    label: "Fixture",
    welcomed: true,
    credential: {
      clientId,
      subject: "fixture-user",
      label: "Fixture",
      accessToken: "access-fixture",
      refreshToken: `${clientId}-refresh-fixture`,
      idToken: "id-fixture",
      expiresAt: 123,
      scopes: ["chatgpt.tokens.use.direct"],
    },
  };
}
it("shares one opaque installation host ID and keeps encrypted issued-client/sub credentials inside separate deletion-safe profiles", () => {
  const db = openDatabase(":memory:");
  databases.push(db);
  const profiles = new ProfileService(db);
  const work = profiles.create({ name: "Work", email: "work@example.invalid" });
  const personal = profiles.create({
    name: "Personal",
    email: "personal@example.invalid",
  });
  const store = new ChatGptSecretStore(db, encryption);
  store.write(work.id, saved("oaiapp_work"));
  store.write(personal.id, saved("oaiapp_personal"));
  expect(store.read(work.id)?.credential?.refreshToken).toBe(
    "oaiapp_work-refresh-fixture",
  );
  expect(store.read(personal.id)?.credential?.refreshToken).toBe(
    "oaiapp_personal-refresh-fixture",
  );
  expect(store.hostId()).toMatch(/^urn:uuid:/);
  expect(new ChatGptSecretStore(db, encryption).hostId()).toBe(store.hostId());
  expect(
    JSON.stringify(db.prepare("SELECT * FROM app_meta").all()),
  ).not.toContain("refresh-fixture");
  expect(() => store.write(work.id, saved("dynamic_agent_client"))).toThrow();
  expect(
    profiles.delete({ profileId: work.id, expectedName: work.name }).ok,
  ).toBe(true);
  expect(store.read(work.id)).toBeUndefined();
  expect(store.read(personal.id)?.credential).toBeDefined();
  expect(() => store.write(work.id, saved("oaiapp_work"))).toThrow(
    "existing profile",
  );
});
it("refuses unavailable OS encryption and Linux basic_text", () => {
  const db = openDatabase(":memory:");
  databases.push(db);
  const profile = new ProfileService(db).create({
    name: "Work",
    email: "work@example.invalid",
  });
  expect(() =>
    new ChatGptSecretStore(db, {
      ...encryption,
      isEncryptionAvailable: () => false,
    }).write(profile.id, saved("oaiapp_work")),
  ).toThrow("encryption");
  expect(() =>
    new ChatGptSecretStore(db, {
      ...encryption,
      getSelectedStorageBackend: () => "basic_text",
    }).write(profile.id, saved("oaiapp_work")),
  ).toThrow("encryption");
});

it("can remove encrypted tokens without unlocking the key while retaining the issued registration", () => {
  const db = openDatabase(":memory:");
  databases.push(db);
  const profile = new ProfileService(db).create({
    name: "Work",
    email: "work@example.invalid",
  });
  const store = new ChatGptSecretStore(db, encryption);
  store.write(profile.id, saved("oaiapp_work"));
  const locked = new ChatGptSecretStore(db, {
    ...encryption,
    isEncryptionAvailable: () => false,
    decryptString: () => {
      throw new Error("Key locked");
    },
  });
  expect(() => locked.read(profile.id)).toThrow("could not be read");
  locked.clearTokens(profile.id);
  expect(locked.read(profile.id)).toEqual({
    clientId: "oaiapp_work",
    subject: "fixture-user",
    label: "Fixture",
    welcomed: true,
  });
});
