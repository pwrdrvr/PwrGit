import { createHash } from "node:crypto";
import fc from "fast-check";
import { expect, it } from "vitest";
import {
  authorizeUrl, callbackCode, createAuthAttempt, ChatGptAuth, CHATGPT_SCOPE,
  type ChatGptRegistration, type ChatGptStorage,
} from "./chatgpt-auth";

const id = fc.stringMatching(/^[a-zA-Z0-9_-]{1,24}$/);
it("binds every callback to its state, exact path and issued client, with S256 independent of URL encoding", () => {
  fc.assert(fc.property(id, fc.integer({ min: 1024, max: 65535 }), fc.boolean(), (suffix, port, returning) => {
    const clientId = `oaiapp_${suffix}`;
    const attempt = createAuthAttempt(`http://127.0.0.1:${port}/auth/callback`, returning
      ? { clientId, subject: suffix, label: suffix, welcomed: true } : undefined);
    const authorization = new URL(authorizeUrl("https://fixture.invalid/authorize", "urn:uuid:fixture", attempt));
    expect(authorization.searchParams.get("code_challenge")).toBe(createHash("sha256").update(attempt.verifier).digest("base64url"));
    expect(attempt.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.get("client_id")).toBe(returning ? clientId : "dynamic_agent_client");
    expect(authorization.searchParams.has("agent_name_hint")).toBe(!returning);
    expect(authorization.searchParams.has("id_token_hint")).toBe(false);
    const callback = new URL(attempt.redirectUri);
    callback.search = new URLSearchParams({ state: attempt.state, client_id: clientId, code: suffix }).toString();
    expect(callbackCode(callback, attempt)).toEqual({ code: suffix, clientId });
    for (const field of ["state", "client_id", "path"] as const) {
      const invalid = new URL(callback);
      if (field === "state") invalid.searchParams.set(field, `${attempt.state}x`);
      if (field === "client_id") invalid.searchParams.set(field, returning ? `${clientId}x` : "dynamic_agent_client");
      if (field === "path") invalid.pathname += "/";
      expect(() => callbackCode(invalid, attempt)).toThrow();
    }
  }));
});

const profiles = ["work", "personal"] as const;
type Profile = typeof profiles[number];
type Account = { connected: boolean; allowed: boolean; rotation: number; expiresAt: number };
type Model = { clock: number; accounts: Record<Profile, Account> };
function fixture() {
  let clock = 1_800_000_000_000;
  const records = new Map<string, ChatGptRegistration>();
  const grants = { work: true, personal: true };
  const errors = { work: "", personal: "" };
  const rotations = { work: 0, personal: 0 };
  const forms: URLSearchParams[] = [];
  for (const profile of profiles) records.set(profile, {
    clientId: `oaiapp_${profile}`, subject: profile, label: profile, welcomed: true,
    credential: { clientId: `oaiapp_${profile}`, subject: profile, label: profile,
      accessToken: `${profile}-access-0`, refreshToken: `${profile}-refresh-0`, idToken: `${profile}-id`,
      scopes: [CHATGPT_SCOPE], expiresAt: clock - 1 },
  });
  const storage: ChatGptStorage = {
    hostId: () => "urn:uuid:fixture",
    read: (profile) => structuredClone(records.get(profile)),
    write: (profile, value) => { records.set(profile, structuredClone(value)); },
  };
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/discovery")) return Response.json({
      issuer: "https://fixture.invalid", token_endpoint: "https://fixture.invalid/token",
      revocation_endpoint: "https://fixture.invalid/revoke",
    });
    const form = new URLSearchParams(String(init?.body));
    forms.push(form);
    const profile = form.get("client_id")?.slice("oaiapp_".length) as Profile;
    if (!profiles.includes(profile)) throw new Error("Unknown fixture client");
    if (String(url).endsWith("/revoke")) return new Response(null, { status: 200 });
    // Endpoint oracle rejects token transfer and reuse, independently of local storage.
    expect(form.get("refresh_token")).toBe(`${profile}-refresh-${rotations[profile]}`);
    if (errors[profile]) return Response.json({ error: errors[profile] }, { status: 400 });
    rotations[profile]++;
    return Response.json({ access_token: `${profile}-access-${rotations[profile]}`,
      refresh_token: `${profile}-refresh-${rotations[profile]}`, token_type: "Bearer", expires_in: 3600,
      scope: grants[profile] ? CHATGPT_SCOPE : "openid" });
  };
  return {
    auth: new ChatGptAuth(storage, async () => { throw new Error("No sign-in in model"); }, fetcher, () => clock, "https://fixture.invalid/discovery"),
    storage, records, grants, errors, forms,
    advance: () => { clock += 3_600_001; },
  };
}
type Real = ReturnType<typeof fixture>;
class Action implements fc.AsyncCommand<Model, Real> {
  constructor(readonly profile: Profile, readonly operation: "read" | "expire" | "transient" | "invalid" | "scope" | "disconnect", readonly callers: number) {}
  check() { return true; }
  toString() { return `${this.operation}(${this.profile}, ${this.callers})`; }
  async run(model: Model, real: Real) {
    const account = model.accounts[this.profile];
    if (this.operation === "expire") {
      model.clock += 3_600_001;
      real.advance();
    } else if (this.operation === "disconnect") {
      const refresh = real.storage.read(this.profile)?.credential?.refreshToken;
      const before = real.forms.length;
      expect(await real.auth.signOut(this.profile)).toEqual({ remoteRevocationConfirmed: true });
      expect(real.forms.slice(before).map((form) => Object.fromEntries(form))).toEqual(refresh ? [{
        token: refresh, token_type_hint: "refresh_token", client_id: `oaiapp_${this.profile}`,
      }] : []);
      account.connected = false;
    } else {
      const renewable = account.connected && account.allowed && account.expiresAt <= model.clock + 60_000;
      real.errors[this.profile] = this.operation === "transient" ? "temporarily_unavailable" : this.operation === "invalid" ? "invalid_grant" : "";
      real.grants[this.profile] = this.operation !== "scope";
      const before = real.forms.length;
      const results = await Promise.allSettled(Array.from({ length: this.callers }, () => real.auth.credential(this.profile)));
      expect(real.forms.length - before).toBe(renewable ? 1 : 0);
      if (renewable && this.operation === "invalid") account.connected = false;
      if (renewable && this.operation !== "invalid" && this.operation !== "transient") {
        account.rotation++;
        account.allowed = this.operation !== "scope";
        account.expiresAt = model.clock + 3_600_000;
      }
      const success = account.connected && account.allowed && !(renewable && this.operation === "transient");
      for (const result of results) {
        expect(result.status).toBe(success ? "fulfilled" : "rejected");
        if (result.status === "fulfilled") expect(result.value.accessToken).toBe(`${this.profile}-access-${account.rotation}`);
      }
    }
    for (const profile of profiles) {
      const expected = model.accounts[profile];
      const saved = real.storage.read(profile)!;
      expect(saved.clientId).toBe(`oaiapp_${profile}`);
      expect(saved.subject).toBe(profile);
      expect(saved.credential?.refreshToken).toBe(expected.connected ? `${profile}-refresh-${expected.rotation}` : undefined);
      expect(real.auth.status(profile)).toMatchObject({ connected: expected.connected, planUsage: expected.connected && expected.allowed });
    }
  }
}
it("matches a two-profile credential model after generated expiry, concurrent reads, scope loss, errors and disconnects", async () => {
  await fc.assert(fc.asyncProperty(fc.commands([fc.tuple(fc.constantFrom(...profiles),
    fc.constantFrom("read", "expire", "transient", "invalid", "scope", "disconnect"), fc.integer({ min: 1, max: 6 }))
    .map(([profile, operation, callers]) => new Action(profile, operation, callers))], { maxCommands: 30 }), async (commands) => {
    const real = fixture();
    const account = (): Account => ({ connected: true, allowed: true, rotation: 0, expiresAt: 1_800_000_000_000 - 1 });
    await fc.asyncModelRun(() => ({ model: { clock: 1_800_000_000_000, accounts: { work: account(), personal: account() } }, real }), commands);
  }));
});

it("revokes the latest rotation after an in-flight refresh under generated response orderings", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.integer({ min: 1, max: 8 }), async (scheduler, callers) => {
    const real = fixture();
    // Schedule the discovery/token responses without sleeps. signOut must wait
    // for the work refresh, while personal can finish on either side of it.
    // The public storage and endpoint oracle are reused with a scheduled fetch.
    const fetcher: typeof fetch = scheduler.scheduleFunction(async (url, init) => {
      if (String(url).endsWith("/discovery")) return Response.json({
        issuer: "https://fixture.invalid", token_endpoint: "https://fixture.invalid/token",
        revocation_endpoint: "https://fixture.invalid/revoke",
      });
      const form = new URLSearchParams(String(init?.body));
      real.forms.push(form);
      const profile = form.get("client_id")?.slice("oaiapp_".length);
      if (String(url).endsWith("/revoke")) return new Response(null, { status: 200 });
      expect(form.get("refresh_token")).toBe(`${profile}-refresh-0`);
      return Response.json({ access_token: `${profile}-access-1`, refresh_token: `${profile}-refresh-1`,
        token_type: "Bearer", expires_in: 3600, scope: CHATGPT_SCOPE });
    });
    const auth = new ChatGptAuth(real.storage, async () => {}, fetcher, () => 1_800_000_000_000, "https://fixture.invalid/discovery");
    const work = Array.from({ length: callers }, () => auth.credential("work"));
    const personal = auth.credential("personal");
    const signOut = auth.signOut("work");
    const results = await scheduler.waitFor(Promise.all([...work, personal, signOut]));
    expect(results.at(-1)).toEqual({ remoteRevocationConfirmed: true });
    expect(real.forms.filter((form) => form.get("grant_type") === "refresh_token")).toHaveLength(2);
    const revoke = real.forms.find((form) => form.has("token_type_hint"));
    expect(Object.fromEntries(revoke!)).toEqual({ token: "work-refresh-1", token_type_hint: "refresh_token", client_id: "oaiapp_work" });
    expect(auth.status("work").connected).toBe(false);
    expect((await auth.credential("personal")).accessToken).toBe("personal-access-1");
    auth.dispose();
  }));
});
