import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { createServer } from "node:http";

export const CHATGPT_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const DYNAMIC_CLIENT = "dynamic_agent_client";
const RESOURCE = "https://api.openai.com/v1";
const INVALID_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export type ChatGptCredential = {
  clientId: string;
  subject: string;
  label: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  scopes: string[];
  expiresAt: number;
};
export type ChatGptConnection = {
  connected: boolean;
  planUsage: boolean;
  label: string;
  welcome: boolean;
};
export type ChatGptRegistration = {
  clientId: string;
  subject: string;
  label: string;
  welcomed: boolean;
  credential?: ChatGptCredential;
};
export interface ChatGptStorage {
  hostId(): string;
  clearTokens?(profileId: string): void;
  read(profileId: string): ChatGptRegistration | undefined;
  write(profileId: string, value: ChatGptRegistration): void;
}
type Discovery = {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
};
type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  expires_in: number;
  token_type: string;
};
export type AuthAttempt = {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  subject?: string;
};
const random = () => randomBytes(32).toString("base64url");
export function createAuthAttempt(
  redirectUri: string,
  registration?: ChatGptRegistration,
): AuthAttempt {
  return {
    state: random(),
    nonce: random(),
    verifier: random(),
    redirectUri,
    clientId: registration?.clientId ?? DYNAMIC_CLIENT,
    ...(registration ? { subject: registration.subject } : {}),
  };
}
export function authorizeUrl(
  endpoint: string,
  hostId: string,
  attempt: AuthAttempt,
): string {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    client_id: attempt.clientId,
    ext_agent_host_id: hostId,
    response_type: "code",
    redirect_uri: attempt.redirectUri,
    scope:
      "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: RESOURCE,
    state: attempt.state,
    nonce: attempt.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256")
      .update(attempt.verifier)
      .digest("base64url"),
    ...(attempt.clientId === DYNAMIC_CLIENT
      ? { agent_name_hint: "PwrGit" }
      : {}),
  }).toString();
  return url.toString();
}
export function callbackCode(
  url: URL,
  attempt: AuthAttempt,
): { code: string; clientId: string } {
  if (
    url.pathname !== "/auth/callback" ||
    url.searchParams.get("state") !== attempt.state
  )
    throw new Error("ChatGPT sign-in callback was not valid.");
  if (url.searchParams.has("error"))
    throw new Error(
      "ChatGPT sign-in was declined. You can try again when ready.",
    );
  const clientId = url.searchParams.get("client_id") ?? attempt.clientId;
  if (
    !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId) ||
    (attempt.clientId !== DYNAMIC_CLIENT && clientId !== attempt.clientId)
  )
    throw new Error(
      "ChatGPT registration did not return the expected issued client ID.",
    );
  const code = url.searchParams.get("code");
  if (!code) throw new Error("ChatGPT sign-in did not return a code.");
  return { code, clientId };
}
export function verifyIdentity(
  token: string,
  keys: JsonWebKey[],
  issuer: string,
  clientId: string,
  nonce: string | undefined,
  now: number,
): { subject: string; label: string } {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error();
    const header = JSON.parse(
      Buffer.from(parts[0]!, "base64url").toString(),
    ) as { alg: string; kid: string };
    const claims = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString(),
    ) as {
      iss: string;
      aud: string | string[];
      exp: number;
      nonce: string;
      sub: string;
      email?: string;
      name?: string;
    };
    const key = keys.find(
      (item) => (item as JsonWebKey & { kid?: string }).kid === header.kid,
    );
    if (
      header.alg !== "RS256" ||
      !key ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(parts[2]!, "base64url"),
      )
    )
      throw new Error();
    if (
      claims.iss !== issuer ||
      !(Array.isArray(claims.aud)
        ? claims.aud.includes(clientId)
        : claims.aud === clientId) ||
      !Number.isFinite(claims.exp) ||
      claims.exp * 1000 <= now ||
      (nonce !== undefined && claims.nonce !== nonce) ||
      typeof claims.sub !== "string" ||
      !claims.sub
    )
      throw new Error();
    return {
      subject: claims.sub,
      label: (claims.email ?? claims.name ?? "ChatGPT account").slice(0, 200),
    };
  } catch {
    throw new Error("ChatGPT identity verification failed.");
  }
}

/** Main-process OAuth owner. No token or authorization URL is returned over IPC. */
export class ChatGptAuth {
  private readonly pendingClients = new Map<string, string>();
  private readonly refreshing = new Map<string, Promise<ChatGptCredential>>();
  private readonly signingOut = new Set<string>();
  private readonly signingIn = new Set<string>();
  private readonly cancellations = new Set<() => void>();
  constructor(
    private readonly storage: ChatGptStorage,
    private readonly openExternal: (url: string) => Promise<void>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now = Date.now,
    private readonly discoveryUrl = "https://auth.openai.com/.well-known/openid-configuration",
  ) {}
  status(profileId: string): ChatGptConnection {
    const saved = this.storage.read(profileId);
    return {
      connected: saved?.credential !== undefined,
      planUsage: saved?.credential?.scopes.includes(CHATGPT_SCOPE) ?? false,
      label: saved?.label ?? "",
      welcome: false,
    };
  }
  private async discovery(): Promise<Discovery> {
    const response = await this.fetcher(this.discoveryUrl, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(
        "ChatGPT sign-in service is unavailable. Try again later.",
      );
    const document = (await response.json()) as Discovery;
    if (
      this.discoveryUrl.startsWith("https://auth.openai.com/") &&
      (document.issuer !== "https://auth.openai.com" ||
        [
          document.jwks_uri,
          document.authorization_endpoint,
          document.token_endpoint,
          document.revocation_endpoint,
        ].some(
          (endpoint) => new URL(endpoint).origin !== "https://auth.openai.com",
        ))
    )
      throw new Error("ChatGPT discovery document was not valid.");
    // Dynamic OSS registration uses the published accounts endpoints. Generic
    // OIDC authorization endpoints need not support dynamic_agent_client.
    if (this.discoveryUrl.startsWith("https://auth.openai.com/")) {
      document.authorization_endpoint =
        "https://auth.openai.com/api/accounts/authorize";
      document.token_endpoint =
        "https://auth.openai.com/api/accounts/oauth/token";
    }
    return document;
  }
  private async token(
    endpoint: string,
    form: Record<string, string>,
  ): Promise<TokenResponse> {
    const response = await this.fetcher(endpoint, {
      method: "POST",
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      let code = "";
      try {
        code = ((await response.json()) as { error?: string }).error ?? "";
      } catch {
        /* Never include endpoint bodies in errors. */
      }
      if (INVALID_REFRESH.has(code)) throw new RefreshExpired();
      throw new Error(
        "ChatGPT credentials could not be renewed. Try again later.",
      );
    }
    const tokens = (await response.json()) as TokenResponse;
    if (
      typeof tokens.access_token !== "string" ||
      !tokens.access_token ||
      tokens.token_type?.toLowerCase() !== "bearer" ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0
    )
      throw new Error("ChatGPT returned an invalid token response.");
    return tokens;
  }
  async signIn(profileId: string): Promise<ChatGptConnection> {
    if (this.signingIn.has(profileId) || this.signingOut.has(profileId))
      throw new Error(
        "ChatGPT connection is already changing for this profile.",
      );
    this.signingIn.add(profileId);
    try {
      await this.refreshing.get(profileId)?.catch(() => undefined);
      const discovery = await this.discovery();
      const registration = this.storage.read(profileId);
      const hostId = this.storage.hostId();
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        throw new Error("ChatGPT callback listener could not start.");
      }
      const attempt = createAuthAttempt(
        `http://127.0.0.1:${address.port}/auth/callback`,
        registration,
      );
      attempt.clientId =
        registration?.clientId ??
        this.pendingClients.get(profileId) ??
        attempt.clientId;
      const callback = new Promise<{ code: string; clientId: string }>(
        (resolve, reject) => {
          server.on("request", (request, response) => {
            const url = new URL(request.url ?? "/", attempt.redirectUri);
            if (url.pathname !== "/auth/callback" || request.method !== "GET") {
              response.writeHead(404).end();
              return;
            }
            try {
              const result = callbackCode(url, attempt);
              response
                .writeHead(200, {
                  "Content-Type": "text/plain",
                  "Cache-Control": "no-store",
                })
                .end("Return to PwrGit to finish signing in.");
              resolve(result);
            } catch {
              response.writeHead(400).end("Sign-in callback rejected.");
              reject(new Error("ChatGPT sign-in callback was rejected."));
            }
          });
          server.once("close", () =>
            reject(new Error("ChatGPT sign-in was cancelled or timed out.")),
          );
        },
      );
      // Attach a rejection handler before the browser promise, which can fail independently.
      void callback.catch(() => undefined);
      const cancel = () => {
        server.close();
        server.closeAllConnections();
      };
      this.cancellations.add(cancel);
      const timer = setTimeout(cancel, 180_000);
      try {
        await this.openExternal(
          authorizeUrl(discovery.authorization_endpoint, hostId, attempt),
        );
        const { code, clientId } = await callback;
        this.pendingClients.set(profileId, clientId);
        const tokens = await this.token(discovery.token_endpoint, {
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: attempt.verifier,
          redirect_uri: attempt.redirectUri,
          resource: RESOURCE,
        });
        const keys = await this.keys(discovery);
        if (!tokens.id_token || !tokens.refresh_token)
          throw new Error(
            "ChatGPT sign-in did not return credentials for this app.",
          );
        const identity = verifyIdentity(
          tokens.id_token,
          keys,
          discovery.issuer,
          clientId,
          attempt.nonce,
          this.now(),
        );
        if (registration && identity.subject !== registration.subject)
          throw new Error(
            "ChatGPT signed in a different account. Use another PwrGit profile for another ChatGPT account.",
          );
        const credential: ChatGptCredential = {
          clientId,
          ...identity,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          idToken: tokens.id_token,
          scopes: (tokens.scope ?? "").split(/\s+/).filter(Boolean),
          expiresAt: this.now() + tokens.expires_in * 1000,
        };
        const welcome =
          credential.scopes.includes(CHATGPT_SCOPE) && !registration?.welcomed;
        this.storage.write(profileId, {
          clientId,
          ...identity,
          welcomed: registration?.welcomed === true || welcome,
          credential,
        });
        this.pendingClients.delete(profileId);
        return { ...this.status(profileId), welcome };
      } finally {
        clearTimeout(timer);
        this.cancellations.delete(cancel);
        cancel();
      }
    } finally {
      this.signingIn.delete(profileId);
    }
  }
  private async keys(discovery: Discovery): Promise<JsonWebKey[]> {
    const response = await this.fetcher(discovery.jwks_uri, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("ChatGPT identity keys are unavailable.");
    return ((await response.json()) as { keys: JsonWebKey[] }).keys;
  }
  async credential(profileId: string): Promise<ChatGptCredential> {
    if (this.signingIn.has(profileId) || this.signingOut.has(profileId))
      throw new Error(
        "ChatGPT connection is changing. Try again after it finishes.",
      );
    const saved = this.storage.read(profileId);
    if (!saved?.credential)
      throw new Error("Sign in with ChatGPT for this profile first.");
    if (!saved.credential.scopes.includes(CHATGPT_SCOPE))
      throw new Error(
        "ChatGPT plan use is not enabled. Continue with ChatGPT to grant plan usage.",
      );
    if (saved.credential.expiresAt > this.now() + 60_000)
      return saved.credential;
    const pending = this.refreshing.get(profileId);
    if (pending) return pending;
    const refresh = this.refresh(profileId, saved);
    this.refreshing.set(profileId, refresh);
    try {
      return await refresh;
    } finally {
      this.refreshing.delete(profileId);
    }
  }
  private async refresh(
    profileId: string,
    saved: ChatGptRegistration,
  ): Promise<ChatGptCredential> {
    const old = saved.credential!;
    try {
      const discovery = await this.discovery();
      const tokens = await this.token(discovery.token_endpoint, {
        grant_type: "refresh_token",
        client_id: saved.clientId,
        refresh_token: old.refreshToken,
        resource: RESOURCE,
      });
      if (!tokens.refresh_token)
        throw new Error("ChatGPT did not return a rotated refresh token.");
      if (tokens.id_token) {
        const identity = verifyIdentity(
          tokens.id_token,
          await this.keys(discovery),
          discovery.issuer,
          saved.clientId,
          undefined,
          this.now(),
        );
        if (identity.subject !== saved.subject)
          throw new Error("ChatGPT refreshed a different account.");
      }
      const credential = {
        ...old,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        idToken: tokens.id_token ?? old.idToken,
        scopes:
          tokens.scope === undefined
            ? old.scopes
            : tokens.scope.split(/\s+/).filter(Boolean),
        expiresAt: this.now() + tokens.expires_in * 1000,
      };
      this.storage.write(profileId, { ...saved, credential });
      if (!credential.scopes.includes(CHATGPT_SCOPE))
        throw new Error(
          "ChatGPT plan usage permission was removed. Sign in again.",
        );
      return credential;
    } catch (cause) {
      if (cause instanceof RefreshExpired) {
        const { credential: _credential, ...registration } = saved;
        this.storage.write(profileId, registration);
        throw new Error(
          "ChatGPT sign-in expired. Continue with ChatGPT again.",
        );
      }
      throw cause;
    }
  }
  async signOut(
    profileId: string,
  ): Promise<{ remoteRevocationConfirmed: boolean }> {
    if (this.signingIn.has(profileId) || this.signingOut.has(profileId))
      throw new Error(
        "Finish the current connection change before disconnecting.",
      );
    this.signingOut.add(profileId);
    let saved: ChatGptRegistration | undefined;
    let confirmed = false;
    try {
      await this.refreshing.get(profileId)?.catch(() => undefined);
      saved = this.storage.read(profileId);
      confirmed = saved?.credential === undefined;
      if (saved?.credential) {
        const discovery = await this.discovery();
        confirmed =
          (
            await this.fetcher(discovery.revocation_endpoint, {
              method: "POST",
              body: new URLSearchParams({
                token: saved.credential.refreshToken,
                token_type_hint: "refresh_token",
                client_id: saved.clientId,
              }),
              signal: AbortSignal.timeout(15_000),
            })
          ).status === 200;
      }
    } catch {
      confirmed = false;
    } finally {
      try {
        if (this.storage.clearTokens) this.storage.clearTokens(profileId);
        else if (saved) {
          const { credential: _credential, ...registration } = saved;
          this.storage.write(profileId, registration);
        }
      } finally {
        this.signingOut.delete(profileId);
      }
    }
    return { remoteRevocationConfirmed: confirmed };
  }
  dispose(): void {
    for (const cancel of this.cancellations) cancel();
  }
}
class RefreshExpired extends Error {}
export const newChatGptHostId = (): string => `urn:uuid:${randomUUID()}`;
