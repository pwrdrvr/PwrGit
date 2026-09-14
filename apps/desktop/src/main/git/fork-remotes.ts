import {
  err,
  forgeCloneUrls,
  forgeRemoteUrlLike,
  ok,
  parseForgeRemote,
  type ForgeHostMap,
  type Result
} from "@pwrgit/shared";
import { requireExit0, type GitExec } from "./dugite";
import { parseRemoteRows } from "./remote-list";

/**
 * Re-pointing an existing checkout at a fork.
 *
 * Kept apart from `ForkService`, which creates forks and clones them fresh:
 * everything here acts on a checkout that already exists, and the order the
 * two remotes are written in is the whole subtlety. See `planForkRemotes`.
 */

/** The remote name a fork's original is kept under when nothing claims it. */
export const UPSTREAM_REMOTE = "upstream";

/** One remote's fetch URL. `git remote -v` also lists a push row per remote;
 *  this is the fetch side, which is what `git remote get-url` answers. */
export type CheckoutRemote = { name: string; url: string };

/** Every remote's fetch URL, in the order Git lists them (alphabetical). */
export async function readCheckoutRemotes(
  git: GitExec,
  cwd: string
): Promise<Result<CheckoutRemote[]>> {
  const raw = await git(["remote", "-v"], cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, ["remote", "-v"]);
  if (!checked.ok) return checked;
  return ok(
    parseRemoteRows(checked.value.stdout)
      .filter((row) => row.direction === "fetch")
      .map((row) => ({ name: row.name, url: row.url }))
  );
}

/**
 * Which protocol a remote URL speaks, so the fork's URL can be written in the
 * same one.
 *
 * Read rather than asked. A checkout whose `origin` authenticates over SSH
 * must not silently start asking for a password because a dialog defaulted to
 * HTTPS — and the reverse strands a machine that has no key loaded. There is
 * no third answer: `cli` is a way to *run* a clone, not a URL a remote can
 * hold, which is why `ForkCheckoutPreflight.protocol` has two members where
 * `CloneProtocol` has three.
 */
export function remoteProtocol(url: string): "ssh" | "https" {
  const trimmed = url.trim();
  if (/^ssh:\/\//i.test(trimmed)) return "ssh";
  if (/^https?:\/\//i.test(trimmed)) return "https";
  // scp-style (`git@github.com:owner/name.git`) is the other SSH spelling and
  // the one both forges hand out. Anything else — `git://`, a local path — is
  // not something this flow reaches, and HTTPS is the answer that at least
  // prompts for credentials rather than failing on a missing key.
  return /^[^/]+@[^/]+:/.test(trimmed) ? "ssh" : "https";
}

/**
 * Where the original is kept once `origin` points at the fork.
 *
 * Three outcomes, in the order they are checked:
 *
 * - A remote already points at the original (someone added `upstream` by
 *   hand, or this checkout is already half-wired). Its name is reported with
 *   `existing: true` and the rewire adds nothing — re-adding would fail, and
 *   renaming someone's remote out from under them is not ours to do.
 * - `upstream` is free: take it.
 * - `upstream` is taken by some OTHER URL. A suffix is appended rather than
 *   clobbering it. A remote is a thing the user may have configured
 *   deliberately (a mirror, a second fork), and silently re-pointing it would
 *   lose that with no way back.
 *
 * `origin` is excluded from the match: it is the remote being re-pointed, so
 * "already points at the original" is true of it by definition right now.
 */
export function planUpstreamRemote(
  remotes: readonly CheckoutRemote[],
  original: { hostname: string; nameWithOwner: string },
  hosts: ForgeHostMap = {}
): { name: string; existing: boolean } {
  const slug = original.nameWithOwner.toLowerCase();
  const existing = remotes.find((remote) => {
    if (remote.name === "origin") return false;
    const parsed = parseForgeRemote(remote.url, hosts);
    return (
      parsed !== null &&
      parsed.hostname === original.hostname &&
      parsed.nameWithOwner.toLowerCase() === slug
    );
  });
  if (existing !== undefined) return { name: existing.name, existing: true };
  const taken = new Set(remotes.map((remote) => remote.name));
  if (!taken.has(UPSTREAM_REMOTE)) {
    return { name: UPSTREAM_REMOTE, existing: false };
  }
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${UPSTREAM_REMOTE}-${suffix}`;
    if (!taken.has(candidate)) return { name: candidate, existing: false };
  }
  // A checkout with `upstream` through `upstream-99` is not a real shape.
  // `existing: false` even though the name may well be taken, deliberately:
  // `existing` means "a remote already points at the original", and claiming
  // it here would tell `applyForkRemotes` to add nothing and tell the dialog
  // a remote already points there — leaving the checkout with no remote for
  // the original and no word about it. Reported as a plain add, so the `git
  // remote add` that cannot succeed says so.
  return { name: `${UPSTREAM_REMOTE}-100`, existing: false };
}

/**
 * The fetch URL for a repository on a forge, written the way this checkout
 * already writes them.
 *
 * `like` is the remote being re-pointed. Composing from protocol + hostname
 * alone is what `parseForgeRemote` leaves you with, and it silently drops a
 * non-default SSH port and a non-`git` SSH user — fine for a URL being
 * invented, and not fine for one replacing a remote that works today. A
 * template that is not a shape we recognise falls back to the canonical pair.
 */
export function forkRemoteUrl(
  protocol: "ssh" | "https",
  hostname: string,
  nameWithOwner: string,
  like?: string
): string {
  if (like !== undefined) {
    const shaped = forgeRemoteUrlLike(like, nameWithOwner);
    if (shaped !== null) return shaped;
  }
  const urls = forgeCloneUrls(hostname, nameWithOwner);
  return protocol === "ssh" ? urls.sshUrl : urls.httpsUrl;
}

export type ForkRemotePlan = {
  /** Where `origin` will point: the fork. */
  originUrl: string;
  /** The original, and the remote it is kept under. Null when the user asked
   *  for no remote for it. */
  upstream: { name: string; url: string; existing: boolean } | null;
};

/**
 * Rewire one checkout's remotes onto a fork.
 *
 * **The order matters and is not interchangeable with the obvious one.**
 * Renaming `origin` to `upstream` and adding a new `origin` reads more
 * naturally and is wrong: `git remote rename` rewrites every
 * `branch.<name>.remote` that named it, so every local branch would come out
 * tracking the ORIGINAL — and the next push would go straight back to the
 * repository the user just established they cannot push to.
 *
 * Adding the upstream remote first and then re-pointing `origin` in place
 * leaves branch tracking untouched and therefore correct: those branches
 * already track `origin`, and `origin` is now the fork.
 *
 * A distinct push URL is re-pointed too when one is configured. `origin`'s
 * fetch URL alone decides nothing about where a push lands, and leaving a
 * stale `pushurl` behind is exactly the silent failure this whole flow exists
 * to remove. (`SshRemoteRecovery` deliberately preserves one — it is changing
 * how you reach the same repository, where this is changing which repository
 * you push to.)
 */
export async function applyForkRemotes(
  git: GitExec,
  cwd: string,
  plan: ForkRemotePlan,
  signal?: AbortSignal
): Promise<Result<void>> {
  const options = signal === undefined ? undefined : { signal };
  const run = async (args: string[]): Promise<Result<string>> => {
    const raw = await git(args, cwd, options);
    if (!raw.ok) return raw;
    const checked = requireExit0(raw.value, args);
    return checked.ok ? ok(checked.value.stdout) : err(checked.error);
  };

  if (plan.upstream !== null && !plan.upstream.existing) {
    const added = await run([
      "remote",
      "add",
      plan.upstream.name,
      plan.upstream.url
    ]);
    if (!added.ok) {
      return err({
        kind: "remote",
        code: "remote_config_failed",
        message: `Could not add the ${plan.upstream.name} remote: ${added.error.message}`
      });
    }
  }

  const pointed = await run(["remote", "set-url", "origin", plan.originUrl]);
  if (!pointed.ok) {
    return err({
      kind: "remote",
      code: "remote_update_failed",
      message: `Could not point origin at the fork: ${pointed.error.message}`
    });
  }

  // Exit 1 is "no such key", which is the ordinary case: most remotes have no
  // explicit push URL and inherit the fetch one, which was just re-pointed.
  const pushUrls = await git(
    ["config", "--get-all", "remote.origin.pushurl"],
    cwd,
    options
  );
  if (!pushUrls.ok) return pushUrls;
  if (pushUrls.value.exitCode === 0 && pushUrls.value.stdout.trim() !== "") {
    const repointed = await run([
      "remote",
      "set-url",
      "--push",
      "origin",
      plan.originUrl
    ]);
    if (!repointed.ok) {
      return err({
        kind: "remote",
        code: "remote_update_failed",
        message: `origin now fetches from the fork, but its separate push URL could not be changed: ${repointed.error.message}`
      });
    }
  }
  return ok(undefined);
}
