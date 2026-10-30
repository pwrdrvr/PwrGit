import {
  err,
  ok,
  parseForgeRemote,
  type ForgeHostMap,
  type RepoIdentity,
  type Result,
  type RetrackCheckout,
  type RetrackMove,
  type RetrackReview,
  type TrackingChoices,
  type TrackingOption
} from "@pwrgit/shared";
import { requireExit0, type GitExec } from "./dugite";
import {
  listRemoteEndpoints,
  listWorktrees,
  readCheckoutDirtyCount
} from "./git-service";

/**
 * Which remote a local branch tracks, and changing it: the switcher's
 * tracking chip and its review step.
 *
 * A branch name can exist on several remotes at once — `origin/main`,
 * `upstream/main`, a renamed project's `pwrdisk/main` — and only one of them
 * is the branch's upstream. Everything here reads refs locally; Fetch is what
 * refreshes them.
 */

const REMOTES = "refs/remotes/";

/** Every remote's `<remote>/<name>` ref, plus the tracked one when it has
 *  another name. Remote names come from `git remote`, so a name with a slash
 *  is matched whole. */
async function candidateRefs(
  git: GitExec,
  cwd: string,
  branch: string,
  upstreamRef: string | null
): Promise<
  Result<{ remote: string; remoteBranch: string; refname: string; head: string }[]>
> {
  const endpoints = await listRemoteEndpoints(git, cwd);
  if (!endpoints.ok) return endpoints;
  const remotes = endpoints.value.map((remote) => remote.name);
  const wanted = new Map<string, { remote: string; remoteBranch: string }>();
  for (const remote of remotes) {
    wanted.set(`${REMOTES}${remote}/${branch}`, { remote, remoteBranch: branch });
  }
  if (upstreamRef !== null && upstreamRef.startsWith(REMOTES)) {
    const owner = splitRemoteRefname(upstreamRef, remotes);
    if (owner !== null) wanted.set(upstreamRef, owner);
  }
  if (wanted.size === 0) return ok([]);
  const args = [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    ...wanted.keys()
  ];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  const out: { remote: string; remoteBranch: string; refname: string; head: string }[] = [];
  for (const line of checked.value.stdout.split("\n")) {
    const [refname = "", head = ""] = line.trim().split("\t");
    // for-each-ref patterns match by prefix; keep exact names only.
    const owner = wanted.get(refname);
    if (owner === undefined || head === "") continue;
    out.push({ ...owner, refname, head });
  }
  return ok(out);
}

/** `refs/remotes/team/fork/main` → `team/fork` + `main` when `team/fork` is a
 *  configured remote. Longest remote name first: `team` is a prefix of
 *  `team/fork`. */
export function splitRemoteRefname(
  refname: string,
  remotes: readonly string[]
): { remote: string; remoteBranch: string } | null {
  if (!refname.startsWith(REMOTES)) return null;
  const rest = refname.slice(REMOTES.length);
  const remote = [...remotes]
    .sort((a, b) => b.length - a.length)
    .find((name) => rest.startsWith(`${name}/`));
  if (remote === undefined) return null;
  const remoteBranch = rest.slice(remote.length + 1);
  return remoteBranch === "" || remoteBranch === "HEAD"
    ? null
    : { remote, remoteBranch };
}

async function revParse(git: GitExec, cwd: string, ref: string): Promise<Result<string | null>> {
  const raw = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  if (!raw.ok) return raw;
  return ok(raw.value.exitCode === 0 ? raw.value.stdout.trim() : null);
}

async function upstreamOf(git: GitExec, cwd: string, branch: string): Promise<Result<string | null>> {
  const args = ["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  // Git refuses `main` and `main/x` side by side, so the pattern can only
  // match the branch itself.
  const line = checked.value.stdout.split("\n")[0]?.trim() ?? "";
  return ok(line === "" ? null : line);
}

async function leftRight(
  git: GitExec,
  cwd: string,
  left: string,
  right: string
): Promise<Result<{ ahead: number; behind: number }>> {
  const args = ["rev-list", "--left-right", "--count", `${left}...${right}`];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) return checked;
  const [a = "", b = ""] = checked.value.stdout.trim().split(/\s+/);
  return ok({ ahead: Number.parseInt(a, 10) || 0, behind: Number.parseInt(b, 10) || 0 });
}

function missingBranch(branch: string) {
  return err({
    kind: "repo" as const,
    code: "branch_missing",
    message: `${branch} is not a local branch here. Nothing was changed.`
  });
}

/** Every ref `branch` could track, compared with it. */
export async function listTrackingOptions(
  git: GitExec,
  cwd: string,
  branch: string,
  identity?: RepoIdentity,
  hosts: ForgeHostMap = {}
): Promise<Result<TrackingChoices>> {
  const head = await revParse(git, cwd, `refs/heads/${branch}`);
  if (!head.ok) return head;
  if (head.value === null) return missingBranch(branch);
  const upstream = await upstreamOf(git, cwd, branch);
  if (!upstream.ok) return upstream;
  const [refs, endpoints] = await Promise.all([
    candidateRefs(git, cwd, branch, upstream.value),
    listRemoteEndpoints(git, cwd)
  ]);
  if (!refs.ok) return refs;
  if (!endpoints.ok) return endpoints;
  const options: TrackingOption[] = [];
  for (const ref of refs.value) {
    const counts = await leftRight(git, cwd, `refs/heads/${branch}`, ref.refname);
    if (!counts.ok) return counts;
    const fetchUrl = endpoints.value.find((remote) => remote.name === ref.remote)?.fetchUrl ?? "";
    const forge = parseForgeRemote(fetchUrl, hosts);
    const option: TrackingOption = {
      remote: ref.remote,
      remoteBranch: ref.remoteBranch,
      ref: `${ref.remote}/${ref.remoteBranch}`,
      head: ref.head,
      ahead: counts.value.ahead,
      behind: counts.value.behind,
      tracked: ref.refname === upstream.value
    };
    if (forge !== null) option.nameWithOwner = forge.nameWithOwner;
    // The forge identity is origin's; it says nothing about another remote.
    if (
      ref.remote === "origin" &&
      identity?.viewerCanPush !== undefined &&
      forge !== null &&
      forge.nameWithOwner.toLowerCase() === identity.nameWithOwner.toLowerCase()
    ) {
      option.canPush = identity.viewerCanPush;
    }
    options.push(option);
  }
  options.sort((a, b) =>
    a.tracked !== b.tracked ? (a.tracked ? -1 : 1) : a.remote.localeCompare(b.remote)
  );
  const choices: TrackingChoices = { branch, head: head.value, options };
  const tracked = options.find((option) => option.tracked);
  if (tracked !== undefined) choices.upstream = tracked.ref;
  return ok(choices);
}

async function checkoutOf(
  git: GitExec,
  cwd: string,
  branch: string
): Promise<Result<RetrackCheckout>> {
  const current = await git(["symbolic-ref", "--quiet", "HEAD"], cwd);
  if (!current.ok) return current;
  if (current.value.exitCode === 0 && current.value.stdout.trim() === `refs/heads/${branch}`) {
    const dirty = await readCheckoutDirtyCount(git, cwd);
    if (!dirty.ok) return dirty;
    return ok({ kind: "here", dirty: dirty.value });
  }
  const worktrees = await listWorktrees(git, cwd);
  if (!worktrees.ok) return worktrees;
  const holder = worktrees.value.find(
    (worktree) => !worktree.detached && !worktree.prunable && worktree.branch === branch
  );
  return ok(holder === undefined ? { kind: "free" } : { kind: "elsewhere", path: holder.path });
}

async function configValue(git: GitExec, cwd: string, key: string): Promise<Result<string | null>> {
  const raw = await git(["config", "--get", key], cwd);
  if (!raw.ok) return raw;
  if (raw.value.exitCode === 1) return ok(null);
  const checked = requireExit0(raw.value, ["config", "--get", key]);
  if (!checked.ok) return checked;
  return ok(checked.value.stdout.trim());
}

async function branchExists(git: GitExec, cwd: string, name: string): Promise<Result<boolean>> {
  const raw = await git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], cwd);
  if (!raw.ok) return raw;
  return ok(raw.value.exitCode === 0);
}

/** `main-before-pwrdisk`, or `-2`, `-3`… when that is taken. */
async function freeCopyName(
  git: GitExec,
  cwd: string,
  branch: string,
  remote: string
): Promise<Result<string>> {
  const base = `${branch}-before-${remote.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const taken = await branchExists(git, cwd, name);
    if (!taken.ok) return taken;
    if (!taken.value) return ok(name);
  }
  return ok(`${base}-${Date.now()}`);
}

/** What changing `branch` to track `remote/remoteBranch` would do. */
export async function inspectRetrack(
  git: GitExec,
  cwd: string,
  req: { branch: string; remote: string; remoteBranch: string },
  identity?: RepoIdentity,
  hosts: ForgeHostMap = {}
): Promise<Result<RetrackReview>> {
  const choices = await listTrackingOptions(git, cwd, req.branch, identity, hosts);
  if (!choices.ok) return choices;
  const target = choices.value.options.find(
    (option) => option.remote === req.remote && option.remoteBranch === req.remoteBranch
  );
  if (target === undefined) {
    return err({
      kind: "remote",
      code: "retrack_target_missing",
      message: `${req.remote}/${req.remoteBranch} is not fetched here. Fetch ${req.remote} and try again.`
    });
  }
  const branchRef = `refs/heads/${req.branch}`;
  const targetRef = `${REMOTES}${target.remote}/${target.remoteBranch}`;
  const upstreamRef = await upstreamOf(git, cwd, req.branch);
  if (!upstreamRef.ok) return upstreamRef;
  const from = choices.value.options.find((option) => option.tracked) ?? null;

  // Leaving commits (on the branch, not on the target) that no remote has.
  const unpushedArgs = ["rev-list", "--count", branchRef, "--not", "--remotes"];
  const unpushedRaw = await git(unpushedArgs, cwd);
  if (!unpushedRaw.ok) return unpushedRaw;
  const unpushedChecked = requireExit0(unpushedRaw.value, unpushedArgs);
  if (!unpushedChecked.ok) return unpushedChecked;
  const unpushed = Number.parseInt(unpushedChecked.value.stdout.trim(), 10) || 0;

  let leavingOn: string | null = null;
  if (target.ahead > 0 && from !== null) {
    const contained = await git(
      ["merge-base", "--is-ancestor", branchRef, `${REMOTES}${from.remote}/${from.remoteBranch}`],
      cwd
    );
    if (!contained.ok) return contained;
    if (contained.value.exitCode === 0) leavingOn = from.ref;
  }

  const logArgs = ["log", "-n", "3", "--format=%H%x09%s", `${branchRef}..${targetRef}`];
  const logRaw = await git(logArgs, cwd);
  if (!logRaw.ok) return logRaw;
  const logChecked = requireExit0(logRaw.value, logArgs);
  if (!logChecked.ok) return logChecked;
  const arriving = logChecked.value.stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
    });

  const checkout = await checkoutOf(git, cwd, req.branch);
  if (!checkout.ok) return checkout;

  let pushOverride: RetrackReview["pushOverride"] = null;
  for (const key of [`branch.${req.branch}.pushRemote`, "remote.pushDefault"]) {
    const value = await configValue(git, cwd, key);
    if (!value.ok) return value;
    if (value.value === null) continue;
    if (value.value !== target.remote) pushOverride = { key, remote: value.value };
    // The branch's own setting wins over the default; stop at the first set.
    break;
  }

  const copyName = await freeCopyName(git, cwd, req.branch, target.remote);
  if (!copyName.ok) return copyName;

  return ok({
    branch: req.branch,
    head: choices.value.head,
    upstreamRef: upstreamRef.value,
    from,
    target,
    unpushed,
    leavingOn,
    arriving,
    checkout: checkout.value,
    pushOverride,
    copyName: copyName.value
  });
}

const stale = (branch: string, ref: string) =>
  err({
    kind: "remote" as const,
    code: "retrack_stale",
    message: `${branch} or ${ref} changed since the review. Nothing was changed. Review it again.`
  });

/**
 * Apply a reviewed tracking change. Runs under the worktree and repository
 * locks (the caller takes them). Order matters for "nothing was changed":
 * every check first, then the copy, then the tip, and the upstream last, so a
 * refused tip move leaves the configuration as it was.
 */
export async function retrackBranch(
  git: GitExec,
  cwd: string,
  req: {
    branch: string;
    remote: string;
    remoteBranch: string;
    head: string;
    targetHead: string;
    upstreamRef: string | null;
    move: RetrackMove;
    copy?: string;
  }
): Promise<Result<{ moved: boolean; copied: string | null }>> {
  const label = `${req.remote}/${req.remoteBranch}`;
  const branchRef = `refs/heads/${req.branch}`;
  const targetRef = `${REMOTES}${req.remote}/${req.remoteBranch}`;
  const [head, target, upstream] = await Promise.all([
    revParse(git, cwd, branchRef),
    revParse(git, cwd, targetRef),
    upstreamOf(git, cwd, req.branch)
  ]);
  if (!head.ok) return head;
  if (!target.ok) return target;
  if (!upstream.ok) return upstream;
  if (head.value === null) return missingBranch(req.branch);
  if (
    head.value !== req.head ||
    target.value !== req.targetHead ||
    upstream.value !== req.upstreamRef
  ) {
    return stale(req.branch, label);
  }
  // The target must be a configured remote's ref, not any ref that happens
  // to be spelled like one.
  const endpoints = await listRemoteEndpoints(git, cwd);
  if (!endpoints.ok) return endpoints;
  const owner = splitRemoteRefname(targetRef, endpoints.value.map((remote) => remote.name));
  if (owner === null || owner.remote !== req.remote) {
    return err({
      kind: "remote",
      code: "retrack_target_missing",
      message: `${label} does not belong to a configured remote. Nothing was changed.`
    });
  }

  const moves = req.move !== "none" && req.head !== req.targetHead;
  if (req.move === "forward" && moves) {
    const ancestor = await git(["merge-base", "--is-ancestor", req.head, req.targetHead], cwd);
    if (!ancestor.ok) return ancestor;
    if (ancestor.value.exitCode !== 0) {
      return err({
        kind: "remote",
        code: "retrack_not_fast_forward",
        message: `${req.branch} has commits ${label} doesn't, so it can't fast-forward. Nothing was changed.`
      });
    }
  }
  if (req.move === "reset" && moves && req.copy === undefined) {
    // Moving the tip may only drop commits some remote still has.
    const args = ["rev-list", "--count", branchRef, "--not", "--remotes"];
    const raw = await git(args, cwd);
    if (!raw.ok) return raw;
    const checked = requireExit0(raw.value, args);
    if (!checked.ok) return checked;
    const lost = Number.parseInt(checked.value.stdout.trim(), 10) || 0;
    if (lost > 0) {
      return err({
        kind: "remote",
        code: "retrack_would_drop",
        message: `${req.branch} has ${lost === 1 ? "a commit" : `${lost} commits`} on no remote. Keep a copy, or track ${label} without moving ${req.branch}. Nothing was changed.`
      });
    }
  }

  const checkout = moves ? await checkoutOf(git, cwd, req.branch) : ok({ kind: "free" } as RetrackCheckout);
  if (!checkout.ok) return checkout;
  if (moves && checkout.value.kind === "elsewhere") {
    return err({
      kind: "remote",
      code: "checked_out_elsewhere",
      message: `${req.branch} is checked out at ${checkout.value.path}, so its tip can only move there. Nothing was changed.`
    });
  }

  let copied: string | null = null;
  if (moves && req.copy !== undefined) {
    const format = await git(["check-ref-format", "--branch", req.copy], cwd);
    if (!format.ok) return format;
    const exists = await branchExists(git, cwd, req.copy);
    if (!exists.ok) return exists;
    if (format.value.exitCode !== 0 || exists.value) {
      return err({
        kind: "remote",
        code: "retrack_copy_taken",
        message: `${req.copy} can't be used for the copy. Review again for another name. Nothing was changed.`
      });
    }
    const args = ["branch", "--no-track", "--", req.copy, req.head];
    const made = await git(args, cwd);
    if (!made.ok) return made;
    const checked = requireExit0(made.value, args);
    if (!checked.ok) return checked;
    copied = req.copy;
  }

  if (moves) {
    const args =
      checkout.value.kind === "here"
        ? req.move === "forward"
          ? ["merge", "--ff-only", req.targetHead]
          : ["reset", "--keep", req.targetHead]
        : ["update-ref", "-m", `pwrgit: track ${label}`, branchRef, req.targetHead, req.head];
    const raw = await git(args, cwd);
    if (!raw.ok) return raw;
    if (raw.value.exitCode !== 0) {
      // The copy was only ever for this move; take it back so a refusal really
      // changes nothing.
      if (copied !== null) {
        await git(["update-ref", "-d", `refs/heads/${copied}`, req.head], cwd);
      }
      const detail = raw.value.stderr.trim() || raw.value.stdout.trim();
      return err({
        kind: "remote",
        code: checkout.value.kind === "here" ? "retrack_would_overwrite" : "retrack_stale",
        message:
          checkout.value.kind === "here"
            ? `Uncommitted changes touch files that change on ${label}. Commit or stash them, then try again. Nothing was changed.`
            : `${req.branch} moved while it was being updated. Nothing was changed.`,
        detail
      });
    }
  }
  const args = ["branch", `--set-upstream-to=${targetRef}`, "--", req.branch];
  const set = await git(args, cwd);
  if (!set.ok) return set;
  const checked = requireExit0(set.value, args);
  if (!checked.ok) {
    return err({
      ...checked.error,
      message: moves
        ? `${req.branch} moved to ${label}, but tracking could not be changed: ${checked.error.message}`
        : checked.error.message
    });
  }
  return ok({ moved: moves, copied });
}
