import {
  createHash,
  generateKeyPairSync,
  sign,
  type JsonWebKey,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeUrl,
  callbackCode,
  ChatGptAuth,
  CHATGPT_SCOPE,
  createAuthAttempt,
  verifyIdentity,
  type ChatGptRegistration,
  type ChatGptStorage,
} from "./chatgpt-auth";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "fixture",
} as JsonWebKey;
const now = 1_800_000_000_000;
function jwt(nonce: string, overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "fixture" }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      aud: "oaiapp_fixture",
      exp: now / 1000 + 3600,
      nonce,
      sub: "user-fixture",
      email: "fixture@example.invalid",
      ...overrides,
    }),
  ).toString("base64url");
  return `${header}.${body}.${sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url")}`;
}
function memory() {
  const registrations = new Map<string, ChatGptRegistration>();
  const storage: ChatGptStorage = {
    hostId: () => "urn:uuid:fixture-host",
    read: (id) => registrations.get(id),
    write: (id, value) => {
      registrations.set(id, structuredClone(value));
    },
  };
  return { storage, registrations };
}
function registration(): ChatGptRegistration {
  return {
    clientId: "oaiapp_fixture",
    subject: "user-fixture",
    label: "Fixture",
    welcomed: true,
    credential: {
      clientId: "oaiapp_fixture",
      subject: "user-fixture",
      label: "Fixture",
      accessToken: "access-old",
      refreshToken: "refresh-old",
      idToken: "id-token-fixture",
      scopes: [CHATGPT_SCOPE],
      expiresAt: now - 1,
    },
  };
}
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function endpoint() {
  const forms: URLSearchParams[] = [];
  const control = { refreshError: "", revokeStatus: 200, scope: CHATGPT_SCOPE };
  let base = "";
  const server = createServer(async (req, res) => {
    if (req.url === "/discovery") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          issuer: "https://auth.openai.com",
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          jwks_uri: `${base}/jwks`,
          revocation_endpoint: `${base}/revoke`,
        }),
      );
      return;
    }
    if (req.url === "/jwks") {
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const form = new URLSearchParams(body);
    forms.push(form);
    if (req.url === "/revoke") {
      res.writeHead(control.revokeStatus).end();
      return;
    }
    if (control.refreshError) {
      res.writeHead(400).end(
        JSON.stringify({
          error: control.refreshError,
          secret: "never-disclose",
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        access_token: "access-new",
        refresh_token: "refresh-rotated",
        token_type: "Bearer",
        expires_in: 3600,
        scope: control.scope,
        ...(form.get("grant_type") === "authorization_code"
          ? { id_token: jwt(form.get("code")!) }
          : {}),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, forms, control };
}

describe("SIWC public-client protocol (local fixtures only)", () => {
  it("builds dynamic registration, S256, stable loopback path and returning registration", () => {
    const attempt = createAuthAttempt("http://127.0.0.1:4567/auth/callback");
    const url = new URL(
      authorizeUrl(
        "https://auth.openai.com/api/accounts/authorize",
        "urn:uuid:host",
        attempt,
      ),
    );
    expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(url.searchParams.get("agent_name_hint")).toBe("PwrGit");
    expect(url.searchParams.get("ext_agent_host_id")).toBe("urn:uuid:host");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(attempt.verifier).digest("base64url"),
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")!.split(" ")).toContain(CHATGPT_SCOPE);
    expect(url.searchParams.get("redirect_uri")).toBe(attempt.redirectUri);
    const returning = new URL(
      authorizeUrl(
        url.origin,
        "urn:uuid:host",
        createAuthAttempt(attempt.redirectUri, registration()),
      ),
    );
    expect(returning.searchParams.get("client_id")).toBe("oaiapp_fixture");
    expect(returning.searchParams.has("agent_name_hint")).toBe(false);
    expect(returning.searchParams.has("id_token_hint")).toBe(false);
  });
  it("rejects state, path, missing/dynamic issued id, denial and registration replacement", () => {
    const attempt = createAuthAttempt("http://127.0.0.1:4567/auth/callback");
    const callback = new URL(attempt.redirectUri);
    callback.search = new URLSearchParams({
      state: attempt.state,
      code: "code",
      client_id: "oaiapp_fixture",
    }).toString();
    expect(callbackCode(callback, attempt)).toEqual({
      code: "code",
      clientId: "oaiapp_fixture",
    });
    for (const [key, value] of [
      ["state", "wrong"],
      ["client_id", "dynamic_agent_client"],
      ["error", "access_denied"],
    ]) {
      const changed = new URL(callback);
      changed.searchParams.set(key!, value!);
      expect(() => callbackCode(changed, attempt)).toThrow();
    }
    callback.pathname = "/callback";
    expect(() => callbackCode(callback, attempt)).toThrow();
    callback.pathname = "/auth/callback";
    callback.searchParams.delete("client_id");
    expect(() => callbackCode(callback, attempt)).toThrow();
    const returning = createAuthAttempt(attempt.redirectUri, registration());
    callback.searchParams.set("state", returning.state);
    expect(callbackCode(callback, returning).clientId).toBe("oaiapp_fixture");
    callback.searchParams.set("client_id", "oaiapp_other");
    expect(() => callbackCode(callback, returning)).toThrow();
  });
  it("verifies signature, issuer, audience, expiration and nonce before trusting sub", () => {
    expect(
      verifyIdentity(
        jwt("nonce"),
        [jwk],
        "https://auth.openai.com",
        "oaiapp_fixture",
        "nonce",
        now,
      ).subject,
    ).toBe("user-fixture");
    for (const claims of [
      { iss: "wrong" },
      { aud: "wrong" },
      { exp: 0 },
      { nonce: "wrong" },
      { sub: "" },
    ])
      expect(() =>
        verifyIdentity(
          jwt("nonce", claims),
          [jwk],
          "https://auth.openai.com",
          "oaiapp_fixture",
          "nonce",
          now,
        ),
      ).toThrow();
    expect(() =>
      verifyIdentity(
        jwt("nonce").slice(0, -8) + "garbage",
        [jwk],
        "https://auth.openai.com",
        "oaiapp_fixture",
        "nonce",
        now,
      ),
    ).toThrow();
  });
  it("completes loopback OAuth without a browser and persists only the verified issued registration", async () => {
    const { base, forms } = await endpoint();
    const { storage, registrations } = memory();
    const auth = new ChatGptAuth(
      storage,
      async (raw) => {
        const url = new URL(raw);
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        expect(callback.hostname).toBe("127.0.0.1");
        expect(callback.pathname).toBe("/auth/callback");
        expect((await fetch(`${callback.origin}/callback`)).status).toBe(404);
        callback.search = new URLSearchParams({
          state: url.searchParams.get("state")!,
          code: url.searchParams.get("nonce")!,
          client_id: "oaiapp_fixture",
        }).toString();
        expect((await fetch(callback)).status).toBe(200);
      },
      fetch,
      () => now,
      `${base}/discovery`,
    );
    const result = await auth.signIn("work");
    expect(result).toEqual({
      connected: true,
      planUsage: true,
      label: "fixture@example.invalid",
      welcome: true,
    });
    expect(forms[0]!.get("client_id")).toBe("oaiapp_fixture");
    expect(forms[0]!.has("client_secret")).toBe(false);
    expect(registrations.get("work")!.subject).toBe("user-fixture");
    expect(registrations.has("personal")).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(
      /access-new|refresh-rotated|id_token/,
    );
    expect((await auth.signIn("work")).welcome).toBe(false);
    auth.dispose();
  });
  it("serializes refresh rotation per profile and preserves other profile credentials", async () => {
    const { base, forms } = await endpoint();
    const { storage, registrations } = memory();
    registrations.set("work", registration());
    registrations.set("personal", {
      ...registration(),
      clientId: "oaiapp_personal",
      credential: {
        ...registration().credential!,
        clientId: "oaiapp_personal",
        refreshToken: "personal-refresh",
        expiresAt: now + 3_600_000,
      },
    });
    const auth = new ChatGptAuth(
      storage,
      async () => {},
      fetch,
      () => now,
      `${base}/discovery`,
    );
    const results = await Promise.all([
      auth.credential("work"),
      auth.credential("work"),
      auth.credential("work"),
    ]);
    expect(forms).toHaveLength(1);
    expect(forms[0]!.get("refresh_token")).toBe("refresh-old");
    expect(results.map((value) => value.refreshToken)).toEqual([
      "refresh-rotated",
      "refresh-rotated",
      "refresh-rotated",
    ]);
    expect((await auth.credential("personal")).refreshToken).toBe(
      "personal-refresh",
    );
    expect(JSON.stringify(auth.status("work"))).not.toContain("access-new");
  });
  it("gates scope, clears invalid refreshes and retains registration; transient failures preserve tokens", async () => {
    const { base, control } = await endpoint();
    const { storage, registrations } = memory();
    registrations.set("work", registration());
    const auth = new ChatGptAuth(
      storage,
      async () => {},
      fetch,
      () => now,
      `${base}/discovery`,
    );
    control.refreshError = "temporarily_unavailable";
    await expect(auth.credential("work")).rejects.toThrow();
    expect(registrations.get("work")!.credential?.refreshToken).toBe(
      "refresh-old",
    );
    control.refreshError = "refresh_token_reused";
    await expect(auth.credential("work")).rejects.toThrow("expired");
    expect(registrations.get("work")!.credential).toBeUndefined();
    expect(registrations.get("work")!.clientId).toBe("oaiapp_fixture");
    const denied = registration();
    denied.credential!.scopes = ["openid"];
    registrations.set("work", denied);
    await expect(auth.credential("work")).rejects.toThrow(
      "plan use is not enabled",
    );
  });
  it("revokes refresh tokens with issued client id and clears locally even without confirmation", async () => {
    const { base, forms, control } = await endpoint();
    const { storage, registrations } = memory();
    registrations.set("work", registration());
    registrations.set("personal", registration());
    const auth = new ChatGptAuth(
      storage,
      async () => {},
      fetch,
      () => now,
      `${base}/discovery`,
    );
    expect(await auth.signOut("work")).toEqual({
      remoteRevocationConfirmed: true,
    });
    expect(Object.fromEntries(forms[0]!)).toEqual({
      token: "refresh-old",
      token_type_hint: "refresh_token",
      client_id: "oaiapp_fixture",
    });
    expect(registrations.get("personal")!.credential).toBeDefined();
    expect(registrations.get("work")!.credential).toBeUndefined();
    control.revokeStatus = 503;
    expect(await auth.signOut("personal")).toEqual({
      remoteRevocationConfirmed: false,
    });
    expect(registrations.get("personal")!.credential).toBeUndefined();
  });
});

it("uses the published dynamic OSS endpoints rather than generic discovery authorization routes", async () => {
  const { storage } = memory();
  const requested: string[] = [];
  let nonce = "";
  const fetcher: typeof fetch = async (input) => {
    const url = input.toString();
    requested.push(url);
    if (url.endsWith("openid-configuration"))
      return Response.json({
        issuer: "https://auth.openai.com",
        authorization_endpoint: "https://auth.openai.com/oauth/authorize",
        token_endpoint: "https://auth.openai.com/oauth/token",
        jwks_uri: "https://auth.openai.com/jwks",
        revocation_endpoint: "https://auth.openai.com/revoke",
      });
    if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
    if (url === "https://auth.openai.com/api/accounts/oauth/token")
      return Response.json({
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        id_token: jwt(nonce),
        token_type: "Bearer",
        scope: CHATGPT_SCOPE,
        expires_in: 3600,
      });
    throw new Error("Unexpected fixture request");
  };
  const auth = new ChatGptAuth(
    storage,
    async (raw) => {
      const url = new URL(raw);
      expect(url.pathname).toBe("/api/accounts/authorize");
      nonce = url.searchParams.get("nonce")!;
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({
        code: "fixture-code",
        client_id: "oaiapp_fixture",
        state: url.searchParams.get("state")!,
      }).toString();
      await fetch(callback);
    },
    fetcher,
    () => now,
  );
  expect((await auth.signIn("work")).planUsage).toBe(true);
  expect(requested).toContain(
    "https://auth.openai.com/api/accounts/oauth/token",
  );
  expect(requested).not.toContain("https://auth.openai.com/oauth/token");
});

it("retains the issued pending client after invalid_grant without persisting an unverified account", async () => {
  const { base, control } = await endpoint();
  const { storage, registrations } = memory();
  const clients: string[] = [];
  const auth = new ChatGptAuth(
    storage,
    async (raw) => {
      const url = new URL(raw);
      clients.push(url.searchParams.get("client_id")!);
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.search = new URLSearchParams({
        state: url.searchParams.get("state")!,
        code: url.searchParams.get("nonce")!,
        client_id: "oaiapp_fixture",
      }).toString();
      await fetch(callback);
    },
    fetch,
    () => now,
    `${base}/discovery`,
  );
  control.refreshError = "invalid_grant";
  await expect(auth.signIn("work")).rejects.toThrow();
  expect(registrations.size).toBe(0);
  control.refreshError = "";
  expect((await auth.signIn("work")).planUsage).toBe(true);
  expect(clients).toEqual(["dynamic_agent_client", "oaiapp_fixture"]);
});
