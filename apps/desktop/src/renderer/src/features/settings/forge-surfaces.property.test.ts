import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalForgeHostname,
  FORGE_KINDS,
  FORGE_PRODUCTS,
  forgeBlockAt,
  forgeLoggedInAt,
  type ForgeHostConfig,
  type ForgeKind,
  type ForgeStatus
} from "@pwrgit/shared";
import { classifyProvider } from "@pwrgit/mcp-server/remote";
import { discoverForgeHosts } from "../../../../main/forge/cli-hosts";
import { ForgeHosts, ForgeHostsView } from "../../../../main/forge/hosts";
import { resolveForgeRepo } from "../../../../main/forge/resolve";
import { ForgeStatusService, type ForgeProbe } from "../../../../main/forge/status";
import { exactRepository } from "../sidebar/clone-dialog";
import { forkSeedFromOrigin } from "../sidebar/fork-dialog";
import { forgeProductState } from "./ForgeProductSection";

/**
 * Every surface that says which forge runs at a host, and whether PwrGit can
 * read it, must say the same thing.
 *
 * Twice this was found by hand rather than by a test. #226: a self-managed
 * `gitlab.internal.example` resolved for change-request status while
 * `ForgeHosts` called it unknown, because a shared classifier still read the
 * `gitlab.*` prefix. #229: Settings → Forges said "GitLab: Signed out" under a
 * signed-in host row; its own first push then stopped probing the SaaS host.
 * #226's author picked `code.acme-corp.example` precisely because a `gitlab.*`
 * name "would have resolved under the deleted rule too" — so the hostnames here
 * are generated, and product-looking names are among them on purpose.
 *
 * The world is one machine: three CLIs (each installed or not, each with an
 * enumeration that works, fails or is too old to answer, and the hosts it is
 * signed in to), the settings file, the env allowlists, and a remote on every
 * host. Each surface is driven through the code the app runs:
 *
 * - Settings → Forges host rows: `ForgeHostsView.rows()`;
 * - the Forges card: `ForgeStatusService` probing `statusTargets()`, read
 *   through `forgeProductState` and `forgeLoggedInAt`;
 * - change-request status: `resolveForgeRepo` with main's map;
 * - the clone and fork dialogs: `exactRepository` / `forkSeedFromOrigin` with
 *   the map `forge:hosts` ships, and `forgeBlockAt` against the probe;
 * - the MCP server's `classifyProvider`, which reads only the environment, so
 *   it is held to what the app answers from the environment alone.
 *
 * The reference is `ForgeHosts.kindFor` / `isEnabled` plus the world's own
 * sign-ins: "logged in at h" means h resolves to product k, the switch allows
 * it, k's CLI is installed, and that CLI holds a credential for h.
 */

type CliWorld = {
  installed: boolean;
  /** `ok` reports every sign-in; `fails` exits non-zero with nothing usable;
   *  `old` is a CLI that predates the JSON flag and prints usage text. */
  enumeration: "ok" | "fails" | "old";
  /** Canonical host → account. */
  signedIn: ReadonlyMap<string, string>;
  /** `gh auth token --hostname h` failing outright, rather than answering
   *  "no token", on a host it holds nothing for. */
  probeThrows: boolean;
};

type Spelling = { upper: boolean; www: number };

type World = {
  pool: string[];
  clis: Record<ForgeKind, CliWorld>;
  settings: Record<string, ForgeHostConfig>;
  env: Record<string, string>;
  remotes: Array<{ host: string; spelling: Spelling; form: number }>;
};

const SAAS_HOSTS = FORGE_KINDS.map((kind) => FORGE_PRODUCTS[kind].saasHost);

const LOWER = [..."abcdefghijklmnopqrstuvwxyz"];
const ALNUM = [...LOWER, ..."0123456789"];
/** `[a-z][a-z0-9-]{0,6}[a-z0-9]`, built from characters: `fc.stringMatching`
 *  cost most of this file's time budget. */
const freeLabelArb = fc
  .tuple(
    fc.constantFrom(...LOWER),
    fc.string({ unit: fc.constantFrom(...ALNUM, "-"), maxLength: 6 }),
    fc.constantFrom(...ALNUM)
  )
  .map(([first, middle, last]) => first + middle + last);
/** A hostname, sometimes dressed as a product it may not run. */
const labelArb = fc.oneof(
  fc.constantFrom("github", "gitlab", "git", "code", "scm", "cafe", "src", "ghe"),
  freeLabelArb
);
const hostArb = fc.oneof(
  { weight: 1, arbitrary: fc.constantFrom(...SAAS_HOSTS) },
  {
    weight: 3,
    arbitrary: fc
      .tuple(
        labelArb,
        fc.array(labelArb, { maxLength: 1 }),
        fc.constantFrom("example", "acme.example", "corp", "io", "com")
      )
      .map(([first, middle, tld]) => [first, ...middle, tld].join("."))
  }
);

const spellingArb: fc.Arbitrary<Spelling> = fc.record({
  upper: fc.boolean(),
  www: fc.nat({ max: 2 })
});

function spell(host: string, spelling: Spelling): string {
  const named = "www.".repeat(spelling.www) + host;
  return spelling.upper ? named.toUpperCase() : named;
}

/** The remote shapes `git remote -v` hands back. */
function remoteUrl(hostSpelled: string, form: number): string {
  switch (form % 4) {
    case 0:
      return `https://${hostSpelled}/team/app.git`;
    case 1:
      return `git@${hostSpelled}:team/app.git`;
    case 2:
      return `ssh://git@${hostSpelled}/team/app`;
    default:
      return `https://${hostSpelled}/team/app`;
  }
}

function cliArb(pool: string[], maxSignedIn: number): fc.Arbitrary<CliWorld> {
  return fc.record({
    installed: fc.boolean(),
    enumeration: fc.constantFrom("ok", "ok", "fails", "old"),
    signedIn: fc
      .subarray(pool, { maxLength: maxSignedIn })
      .chain((hosts) =>
        fc
          .array(fc.string({ unit: fc.constantFrom(...LOWER), minLength: 1, maxLength: 6 }), {
            minLength: hosts.length,
            maxLength: hosts.length
          })
          .map((accounts) => new Map(hosts.map((host, i) => [host, accounts[i]!])))
      ),
    probeThrows: fc.boolean()
  });
}

const worldArb: fc.Arbitrary<World> = fc
  .uniqueArray(hostArb, { minLength: 1, maxLength: 6 })
  .chain((pool) =>
    fc.record({
      pool: fc.constant(pool),
      clis: fc.record({
        github: cliArb(pool, pool.length),
        gitlab: cliArb(pool, pool.length),
        // `cafe auth status` reports one host, its default.
        gitcafe: cliArb(pool, 1)
      }),
      settings: fc
        .array(
          fc.record({
            host: fc.constantFrom(...pool),
            // A hand-edited settings.json is read unvalidated, so its keys can
            // be spelled any way the user typed them.
            spelling: fc.oneof(
              { weight: 4, arbitrary: fc.constant({ upper: false, www: 0 }) },
              { weight: 1, arbitrary: spellingArb }
            ),
            config: fc.record(
              {
                kind: fc.constantFrom<ForgeKind | "bogus">(...FORGE_KINDS, "bogus"),
                enabled: fc.boolean()
              },
              { requiredKeys: [] }
            )
          }),
          { maxLength: 4 }
        )
        .map((entries) =>
          Object.fromEntries(
            entries.map(({ host, spelling, config }) => [
              spell(host, spelling),
              config as ForgeHostConfig
            ])
          )
        ),
      env: fc.record(
        Object.fromEntries(
          FORGE_KINDS.map((kind) => [
            FORGE_PRODUCTS[kind].hostAllowlistEnv,
            fc
              .subarray(pool)
              .chain((hosts) =>
                fc
                  .array(spellingArb, { minLength: hosts.length, maxLength: hosts.length })
                  .map((spellings) =>
                    hosts.map((host, i) => spell(host, spellings[i]!)).join(",")
                  )
              )
          ])
        ),
        { requiredKeys: [] }
      ) as fc.Arbitrary<Record<string, string>>,
      remotes: fc.tuple(
        ...pool.map((host) =>
          fc.record({ host: fc.constant(host), spelling: spellingArb, form: fc.nat(3) })
        )
      )
    })
  );

/** `gh auth status --json hosts`, as gh prints it. */
function ghStatus(cli: CliWorld): string {
  if (cli.enumeration === "old") return "Usage: gh auth status [flags]";
  return JSON.stringify({
    hosts: Object.fromEntries(
      [...cli.signedIn].map(([host, login]) => [
        host,
        [{ state: "success", active: true, host, login, scopes: "repo" }]
      ])
    )
  });
}

/** `glab auth status --all`, as glab writes it to stderr. */
function glabStatus(cli: CliWorld): string {
  if (cli.enumeration === "old") return "Usage: glab auth status [flags]";
  return [...cli.signedIn]
    .map(([host, login]) => `${host}\n  ✓ Logged in to ${host} as ${login} (keyring)\n`)
    .join("");
}

function cafeStatus(cli: CliWorld): string {
  const first = [...cli.signedIn][0];
  if (cli.enumeration === "old" || first === undefined) {
    return JSON.stringify({ schemaVersion: 1, error: null, data: {} });
  }
  return JSON.stringify({
    schemaVersion: 1,
    error: null,
    data: { host: first[0], username: first[1] }
  });
}

function enumerator<T>(cli: CliWorld, answer: () => T): () => Promise<T> {
  return async () => {
    if (!cli.installed) throw new Error("ENOENT");
    if (cli.enumeration === "fails") throw new Error("exit status 1");
    return answer();
  };
}

/** The credential each CLI would find. An undefined host is the CLI's own
 *  default, which in this world is the product's SaaS host. */
function probesFor(world: World): ForgeProbe[] {
  return FORGE_KINDS.map((kind) => {
    const cli = world.clis[kind];
    return {
      kind,
      cli: FORGE_PRODUCTS[kind].cli,
      installed: async () => {
        if (!cli.installed) throw new Error("ENOENT");
        return true;
      },
      loggedIn: async (host) => {
        const key = canonicalForgeHostname(host ?? FORGE_PRODUCTS[kind].saasHost);
        if (key !== null && cli.signedIn.has(key)) return true;
        if (cli.probeThrows) throw new Error("exit status 1");
        return false;
      }
    };
  });
}

type Built = {
  world: World;
  hosts: ForgeHosts;
  envOnly: ForgeHosts;
  view: ForgeHostsView;
  statuses: ForgeStatus[];
};

async function build(world: World): Promise<Built> {
  const discovered = await discoverForgeHosts({
    gh: enumerator(world.clis.github, () => ghStatus(world.clis.github)),
    glabAuthStatus: enumerator(world.clis.gitlab, () => glabStatus(world.clis.gitlab)),
    cafe: enumerator(world.clis.gitcafe, () => cafeStatus(world.clis.gitcafe))
  });
  const hosts = new ForgeHosts({
    readSettings: () => ({ hosts: world.settings }),
    discovered: () => discovered,
    env: world.env
  });
  const envOnly = new ForgeHosts({
    readSettings: () => ({ hosts: {} }),
    discovered: () => [],
    env: world.env
  });
  const status = new ForgeStatusService({
    probes: probesFor(world),
    hosts: () => hosts.statusTargets()
  });
  return {
    world,
    hosts,
    envOnly,
    view: new ForgeHostsView(hosts, async () => {}),
    statuses: await status.list()
  };
}

function statusOf(built: Built, kind: ForgeKind): ForgeStatus {
  const status = built.statuses.find((entry) => entry.kind === kind);
  if (status === undefined) throw new Error(`no status for ${kind}`);
  return status;
}

/** The reference: what is actually true at this host on this machine. */
function truth(built: Built, host: string) {
  const key = canonicalForgeHostname(host) ?? "";
  const kind = built.hosts.kindFor(host).kind;
  const enabled = built.hosts.isEnabled(host).enabled;
  const cli = kind === null ? undefined : built.world.clis[kind];
  return {
    key,
    kind,
    enabled,
    installed: cli?.installed === true,
    loggedIn:
      kind !== null && enabled && cli?.installed === true && cli.signedIn.has(key)
  };
}

function hostsOf(world: World): Array<{ host: string; url: string }> {
  return world.remotes.map(({ host, spelling, form }) => ({
    host: spell(host, spelling),
    url: remoteUrl(spell(host, spelling), form)
  }));
}

/** Every disagreement, so a failure names all of them at once. */
function disagreements(built: Built): string[] {
  const problems: string[] = [];
  const map = built.view.overrides();
  const rows = built.view.rows();
  const targets = built.hosts.statusTargets();

  for (const { host, url } of hostsOf(built.world)) {
    const want = truth(built, host);
    const say = (surface: string, got: unknown, expected: unknown): void => {
      problems.push(
        `${surface} at ${host}: ${JSON.stringify(got)}, reference ${JSON.stringify(expected)}`
      );
    };

    // Which product.
    const resolved = resolveForgeRepo(url, map)?.kind ?? null;
    if (resolved !== want.kind) say("resolveForgeRepo kind", resolved, want.kind);
    const cloned = exactRepository(url, "github", map)?.host ?? null;
    const clonedKind = cloned === "other" ? null : cloned;
    if (clonedKind !== want.kind) say("clone dialog kind", clonedKind, want.kind);
    const forked =
      forkSeedFromOrigin([{ name: "origin", fetchUrl: url, pushUrl: url }], map)?.host ??
      null;
    if (forked !== want.kind) say("fork dialog kind", forked, want.kind);
    const row = rows.find((entry) => entry.host === want.key);
    if (row !== undefined && row.kind !== want.kind) {
      say("Settings row kind", row.kind, want.kind);
    }
    const mcp = classifyProvider(host, built.world.env);
    const envKind = built.envOnly.kindFor(host).kind ?? "other";
    if (mcp !== envKind) say("mcp-server kind", mcp, envKind);
    if (want.kind !== null && want.enabled) {
      const probed = targets.some(
        (target) => target.kind === want.kind && target.host === want.key
      );
      if (!probed) say("probe target", "absent", `${want.kind} ${want.key}`);
    }

    // Whether it can be read.
    if (want.kind === null) continue;
    const status = statusOf(built, want.kind);
    const block = forgeBlockAt(status, host);
    const expectedBlock = !want.installed
      ? "cli_missing"
      : !want.enabled
        ? "host_off"
        : want.loggedIn
          ? null
          : "signed_out";
    if (block !== expectedBlock) say("clone/fork forgeBlockAt", block, expectedBlock);
    if (want.installed && want.enabled) {
      const card = forgeLoggedInAt(status, host);
      if (card !== want.loggedIn) say("Forges card loggedIn", card, want.loggedIn);
    }
  }

  // A row that says a CLI holds an account here is a row the card must read
  // as signed in — the #229 contradiction, from the row's side.
  for (const row of rows) {
    const want = truth(built, row.host);
    const status = statusOf(built, row.kind);
    if (!want.installed || !row.enabled) continue;
    const cardSays = forgeLoggedInAt(status, row.host);
    if (row.origin === "cli" && !cardSays) {
      problems.push(`Settings row ${row.host} says ${row.cli} is signed in; card says signed out`);
    }
    if (row.origin === "cli" && forgeProductState(status) !== "connected") {
      problems.push(
        `Settings row ${row.host} says ${row.cli} is signed in; ${row.kind} card is ${forgeProductState(status)}`
      );
    }
    if (
      row.origin === "config" &&
      cardSays &&
      built.world.clis[row.kind].enumeration === "ok"
    ) {
      problems.push(`Settings row ${row.host} says no account; card says signed in`);
    }
  }

  // The card's chip, against the sign-ins that resolve to that product.
  for (const kind of FORGE_KINDS) {
    const cli = built.world.clis[kind];
    const readable = [...cli.signedIn.keys(), FORGE_PRODUCTS[kind].saasHost].some(
      (host) => {
        const want = truth(built, host);
        return want.kind === kind && want.loggedIn;
      }
    );
    const state = forgeProductState(statusOf(built, kind));
    const expected = !cli.installed ? "missing" : readable ? "connected" : undefined;
    if (expected !== undefined && state !== expected) {
      problems.push(`${kind} card is ${state}, reference ${expected}`);
    }
    if (expected === undefined && state === "connected") {
      problems.push(`${kind} card is connected with no readable host`);
    }
  }
  return problems;
}

describe("forge surfaces agree on which product runs at a host, and whether it can be read", () => {
  it("for any hosts, sign-ins, settings and env allowlists", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, async (world) => {
        expect(disagreements(await build(world))).toEqual([]);
      })
    );
  });
});
