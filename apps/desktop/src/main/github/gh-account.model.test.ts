import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CliRunOptions } from "../forge/cli-runner";
import { GhAccountUnavailableError, GitHubCredentials } from "./gh-account";

/**
 * Model test: which account a GitHub host reads as, and whose token every
 * read and every `gh` spawn carries.
 *
 * The machine is a fake `gh` holding accounts per host (one active), the
 * user's environment, and the pins Settings writes. Random sequences of
 * sign-ins, sign-outs, `gh auth switch`, pin changes and environment changes
 * run against `GitHubCredentials`, and after each read or spawn the token is
 * checked against the rule:
 *
 * - an environment token that applies to the host wins
 *   (`GH_TOKEN`/`GITHUB_TOKEN` on github.com, `GH_ENTERPRISE_TOKEN` on the
 *   host `GH_HOST` names);
 * - else a pinned account's own token, and NOTHING when that account is gone
 *   — never the active account's;
 * - else the active account's token.
 *
 * Tokens name their owner (`tok:host:login:version`), so a leak between two
 * accounts on one host is visible in the value itself. Every change to gh's
 * own store moves the clock past the cache TTL, so a cached token is never
 * legitimately stale; a pin change does NOT, which is what makes a cache
 * keyed by host alone fail here.
 *
 * The fake gh is pessimistic where real gh's behaviour is not pinned down:
 * `gh auth token --user` still answers with an environment token when one is
 * set, and it applies `GH_ENTERPRISE_TOKEN` to every Enterprise host as gh
 * does.
 */

const DOTCOM = "github.com";
const HOSTS = [DOTCOM, "ghe.contoso-labs.test", "ghe.build.test"] as const;
/** Two logins, so a pin usually names an account that is signed in somewhere
 *  and the interesting interleavings are common rather than rare. */
const LOGINS = ["a.hopper", "release-bot"] as const;
const TTL = 1_000;

type Host = (typeof HOSTS)[number];

type Op =
  | { t: "signIn"; host: Host; login: string }
  | { t: "signOut"; host: Host; login: string }
  | { t: "switch"; host: Host; login: string }
  | { t: "pin"; host: Host; login: string | null }
  | { t: "env"; name: string; value: string | undefined }
  | { t: "read"; host: Host }
  | { t: "spawn"; host: Host; form: "api" | "repo" | "mcp" };

const hostArb = fc.constantFrom(...HOSTS);
const loginArb = fc.constantFrom(...LOGINS);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    arbitrary: fc.record({
      t: fc.constant("signIn" as const),
      host: hostArb,
      login: loginArb,
    }),
    weight: 2,
  },
  fc.record({
    t: fc.constant("signOut" as const),
    host: hostArb,
    login: loginArb,
  }),
  fc.record({
    t: fc.constant("switch" as const),
    host: hostArb,
    login: loginArb,
  }),
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("pin" as const),
      host: hostArb,
      // `b.liskov` never signs in anywhere: a pin that was stale from the start.
      login: fc.oneof(
        { arbitrary: fc.constantFrom<string | null>(...LOGINS), weight: 4 },
        {
          arbitrary: fc.constantFrom<string | null>("b.liskov", null),
          weight: 1,
        },
      ),
    }),
  },
  fc.record({
    t: fc.constant("env" as const),
    name: fc.constantFrom("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"),
    value: fc.option(fc.constantFrom("env-a", "env-b"), { nil: undefined }),
  }),
  fc.record({
    t: fc.constant("env" as const),
    name: fc.constant("GH_HOST"),
    value: fc.option(hostArb, { nil: undefined }),
  }),
  {
    arbitrary: fc.record({ t: fc.constant("read" as const), host: hostArb }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      t: fc.constant("spawn" as const),
      host: hostArb,
      form: fc.constantFrom("api" as const, "repo" as const, "mcp" as const),
    }),
    weight: 3,
  },
);

class Machine {
  /** host → login → token version. Insertion order is gh's listing order. */
  readonly accounts = new Map<string, Map<string, number>>();
  readonly active = new Map<string, string>();
  readonly pins = new Map<string, string>();
  env: Record<string, string | undefined> = {};
  now = 0;
  private version = 0;

  token(host: string, login: string): string | null {
    const version = this.accounts.get(host)?.get(login);
    return version === undefined ? null : `tok:${host}:${login}:${version}`;
  }

  apply(op: Op): void {
    if (op.t === "signIn") {
      const hostAccounts =
        this.accounts.get(op.host) ?? new Map<string, number>();
      // Signing in again mints a new token, as `gh auth login` does.
      hostAccounts.set(op.login, ++this.version);
      this.accounts.set(op.host, hostAccounts);
      this.active.set(op.host, op.login);
      this.now += TTL;
    } else if (op.t === "signOut") {
      const hostAccounts = this.accounts.get(op.host);
      if (hostAccounts?.delete(op.login) !== true) return;
      if (this.active.get(op.host) === op.login) {
        const next = [...hostAccounts.keys()][0];
        if (next === undefined) this.active.delete(op.host);
        else this.active.set(op.host, next);
      }
      this.now += TTL;
    } else if (op.t === "switch") {
      if (this.accounts.get(op.host)?.has(op.login) !== true) return;
      this.active.set(op.host, op.login);
      this.now += TTL;
    } else if (op.t === "pin") {
      if (op.login === null) this.pins.delete(op.host);
      else this.pins.set(op.host, op.login);
    } else if (op.t === "env") {
      this.env = { ...this.env, [op.name]: op.value };
      this.now += TTL;
    }
  }

  /** gh's own environment-token precedence for a host. */
  private ghEnvToken(
    host: string,
    env: Record<string, string | undefined>,
  ): string | undefined {
    return host === DOTCOM
      ? (env["GH_TOKEN"] ?? env["GITHUB_TOKEN"])
      : (env["GH_ENTERPRISE_TOKEN"] ?? env["GITHUB_ENTERPRISE_TOKEN"]);
  }

  /** A fake `gh`: `auth token` and any host-targeted command. */
  readonly gh = async (
    args: string[],
    options?: CliRunOptions,
  ): Promise<string> => {
    const env = { ...this.env, ...options?.env };
    const flag = (name: string): string | undefined => {
      const index = args.indexOf(name);
      return index === -1 ? undefined : args[index + 1];
    };
    if (args[0] === "auth" && args[1] === "token") {
      const host = flag("--hostname") ?? env["GH_HOST"] ?? DOTCOM;
      const fromEnv = this.ghEnvToken(host, env);
      if (fromEnv !== undefined) return fromEnv;
      const login = flag("--user") ?? this.active.get(host);
      const token = login === undefined ? null : this.token(host, login);
      if (token === null) throw new Error("no oauth token found");
      return token;
    }
    const repo = flag("--repo");
    const repoHost =
      repo !== undefined && repo.split("/").length >= 3
        ? repo.split("/")[0]
        : undefined;
    const host = flag("--hostname") ?? repoHost ?? env["GH_HOST"] ?? DOTCOM;
    const fromEnv = this.ghEnvToken(host, env);
    if (fromEnv !== undefined) return `${host}|${fromEnv}`;
    const login = this.active.get(host);
    const token = login === undefined ? null : this.token(host, login);
    if (token === null) throw new Error("authentication required");
    return `${host}|${token}`;
  };

  /** The environment token PwrGit lets outrank a pin at this host. */
  private envRule(host: string): string | undefined {
    const env = this.env;
    const value =
      host === DOTCOM
        ? env["GH_TOKEN"] || env["GITHUB_TOKEN"]
        : env["GH_HOST"] === host
          ? env["GH_ENTERPRISE_TOKEN"]
          : undefined;
    return value || undefined;
  }

  /** The rule. Null means "signed out". */
  expected(host: string): string | null {
    const fromEnv = this.envRule(host);
    if (fromEnv !== undefined) return fromEnv;
    const pinned = this.pins.get(host);
    if (pinned !== undefined) return this.token(host, pinned);
    // Unpinned is unchanged: whatever `gh auth token --hostname` says, which
    // includes gh applying an Enterprise token to every Enterprise host.
    const native = this.ghEnvToken(host, this.env);
    if (native !== undefined) return native;
    const active = this.active.get(host);
    return active === undefined ? null : this.token(host, active);
  }

  /** Whether an environment token outranks the pin at this host. */
  envOverrides(host: string): boolean {
    return this.envRule(host) !== undefined;
  }
}

function spawnCall(
  host: Host,
  form: "api" | "repo" | "mcp",
): { args: string[]; options?: CliRunOptions } {
  if (form === "api") return { args: ["api", "--hostname", host, "user"] };
  if (form === "mcp") {
    return {
      args: [
        "pr",
        "list",
        "--repo",
        host === DOTCOM ? "team/app" : `${host}/team/app`,
      ],
    };
  }
  // `targetHost`'s shape: github.com untouched, an Enterprise host by GH_HOST.
  return host === DOTCOM
    ? { args: ["repo", "list"] }
    : { args: ["repo", "list"], options: { env: { GH_HOST: host } } };
}

async function run(ops: Op[]): Promise<string[]> {
  const machine = new Machine();
  const credentials = new GitHubCredentials({
    run: machine.gh,
    env: () => machine.env as NodeJS.ProcessEnv,
    now: () => machine.now,
    ttlMs: TTL,
  });
  credentials.setAccountChooser((host) => machine.pins.get(host));
  const problems: string[] = [];
  for (const [step, op] of ops.entries()) {
    machine.apply(op);
    if (op.t === "read") {
      const got = await credentials.token(op.host);
      const want = machine.expected(op.host);
      if (got !== want)
        problems.push(`#${step} read ${op.host}: ${got}, want ${want}`);
    } else if (op.t === "spawn") {
      // A spawn without a pin is gh's own business: only a pinned host, or an
      // environment token, has an answer PwrGit is responsible for. The
      // github.com forms that name no host follow GH_HOST, so skip those.
      const call = spawnCall(op.host, op.form);
      const named =
        op.form === "api" ||
        op.host !== DOTCOM ||
        machine.env["GH_HOST"] === undefined;
      if (
        !named ||
        (!machine.pins.has(op.host) && !machine.envOverrides(op.host))
      )
        continue;
      const want = machine.expected(op.host);
      let got: string | null;
      try {
        got =
          (await credentials.run(call.args, call.options)).split("|")[1] ??
          null;
      } catch (cause) {
        if (
          !(cause instanceof GhAccountUnavailableError) &&
          machine.pins.has(op.host) &&
          !machine.envOverrides(op.host)
        ) {
          problems.push(
            `#${step} spawn ${op.form} ${op.host}: threw ${String(cause)}`,
          );
          continue;
        }
        got = null;
      }
      if (got !== want) {
        problems.push(
          `#${step} spawn ${op.form} ${op.host}: ${got}, want ${want}`,
        );
      }
    }
  }
  return problems;
}

describe("GitHub account selection and token resolution", () => {
  it("reads as the pinned account, else the active one; never falls back; env wins", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { minLength: 1, maxLength: 40 }),
        async (ops) => {
          expect(await run(ops)).toEqual([]);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("keeps two accounts on one host in separate cache slots", async () => {
    // The minimal case of the cache-isolation property, spelled out.
    const host = "ghe.contoso-labs.test";
    const problems = await run([
      { t: "signIn", host, login: "a.hopper" },
      { t: "signIn", host, login: "release-bot" },
      { t: "pin", host, login: "a.hopper" },
      { t: "read", host },
      { t: "pin", host, login: "release-bot" },
      { t: "read", host },
      { t: "pin", host, login: null },
      { t: "read", host },
    ]);
    expect(problems).toEqual([]);
  });

  it("answers a stale pin with signed out, not the active account", async () => {
    const host = "ghe.build.test";
    const machine = new Machine();
    machine.apply({ t: "signIn", host, login: "a.hopper" });
    const credentials = new GitHubCredentials({
      run: machine.gh,
      env: () => ({}),
      now: () => machine.now,
      ttlMs: TTL,
    });
    credentials.setAccountChooser(() => "b.liskov");
    expect(await credentials.token(host)).toBeNull();
    await expect(
      credentials.run(["api", "--hostname", host, "user"]),
    ).rejects.toBeInstanceOf(GhAccountUnavailableError);
  });
});
