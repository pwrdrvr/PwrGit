import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitSandbox, type GitSandbox } from "./git-sandbox";

/**
 * The repository world that appears in documentation screenshots.
 *
 * Separate from the per-spec sandboxes because it answers a different
 * question. A test fixture only has to reproduce one behavior; this one is
 * *read by people*, so every name in it ends up published on docs.pwrgit.com
 * and pwrgit.com. Three rules follow that the ordinary fixtures don't carry:
 *
 * 1. **Plausible names.** `repo-a` / `feat/x` prove a code path just as well
 *    and look like a toy in a screenshot. These read like one afternoon's real
 *    work, which is the only reason showing the app is worth anything.
 * 2. **Only domains we own.** Every identity is `@pwrgit.com`. A published
 *    screenshot is a permanent, public advertisement of whatever address is in
 *    it, and a domain we don't own can be registered by someone else.
 * 3. **No third-party product names**, per the PwrDrvr trademark rule.
 *
 * It is still real git throughout — real commits, real linked worktrees, real
 * ahead/behind counts computed against a real remote. Nothing is mocked, which
 * is exactly what makes the images worth publishing.
 *
 * Authorship is handled here rather than by extending `git-sandbox.ts`: that
 * fixture hardcodes `PwrGit Test` / `Someone Else`, which is right for tests
 * and wrong in a screenshot, but threading an identity through its ~79 internal
 * git calls would put twenty specs at risk to change a caption. `commitBy`
 * below carries the same isolation env and takes the author explicitly.
 */

/** The person the docs reader is looking over the shoulder of. */
export const DOCS_AUTHOR = { name: "Dana Reyes", email: "dana@pwrgit.com" };

/** A colleague, so "not mine" paths render with a second name. */
export const DOCS_COLLEAGUE = { name: "Sam Okafor", email: "sam@pwrgit.com" };

type Identity = { name: string; email: string };

/** Same isolation git-sandbox uses — never the developer's config or identity
 *  — with the author stated outright instead of fixed at module scope. */
function envFor(who: Identity): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: who.name,
    GIT_AUTHOR_EMAIL: who.email,
    GIT_COMMITTER_NAME: who.name,
    GIT_COMMITTER_EMAIL: who.email
  };
}

function runGit(
  who: Identity,
  cwd: string,
  args: string[],
  daysAgo?: number
): string {
  const env = envFor(who);
  if (daysAgo !== undefined) {
    // Both dates, not just the author date: the sidebar's "last activity" and
    // the Stale rule read the COMMITTER date (`git log -1 --format=%cI`), so
    // setting only GIT_AUTHOR_DATE would age the caption while leaving every
    // worktree looking touched seconds ago.
    const when = new Date(BASE_TIME - daysAgo * 86_400_000).toISOString();
    env.GIT_AUTHOR_DATE = when;
    env.GIT_COMMITTER_DATE = when;
  }
  return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

/**
 * The instant the world is anchored to. Fixed per run rather than per commit
 * so the relative ages in one screenshot set are consistent with each other.
 *
 * Absolute determinism is not achievable here: the app renders "3 days ago"
 * relative to now, so a capture taken tomorrow differs from one taken today
 * no matter what is committed. Anchoring to run-time at least keeps the set
 * internally coherent, and the docs repo's noise filter absorbs the churn.
 */
const BASE_TIME = Date.now();

/** Write a file (creating its directory) and commit it as `who`. */
function commitBy(
  who: Identity,
  cwd: string,
  file: string,
  message: string,
  daysAgo: number,
  body = `${file}\n`
): void {
  const target = join(cwd, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  runGit(who, cwd, ["add", "-A"]);
  runGit(who, cwd, ["commit", "-m", message], daysAgo);
}

/** Leave a file modified but uncommitted, so the Changes rail has content. */
function leaveDirty(cwd: string, file: string, body: string): void {
  const target = join(cwd, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}

export type DocsWorld = {
  box: GitSandbox;
  /** The repo the screenshots centre on. */
  primary: string;
  cleanup: () => void;
};

/**
 * Build the world. Deliberately takes no parameters: a screenshot set is only
 * comparable between runs if every run produces the same repositories, the
 * same branches, and the same counts.
 */
export function createDocsWorld(): DocsWorld {
  const box = createGitSandbox();
  // Bare origins live outside the scanned roots so the app never indexes them.
  const remotes = mkdtempSync(join(tmpdir(), "pwrgit-docs-remotes-"));
  const discard = (): void => {
    box.cleanup();
    rmSync(remotes, { recursive: true, force: true });
  };

  // Everything below shells out to git. A failure part-way leaves two temp
  // trees behind unless they are cleaned here: the caller only records the
  // world once this returns, so its afterEach has nothing to clean up yet —
  // and Playwright's retry would double the mess.
  try {
    // The focus repo. Several strands of work in flight is what makes the
    // sidebar and the lineage graph worth a picture at all.
    const web = box.makeRepo("acme-web");

    // git-sandbox authored the root commit as "PwrGit Test" and stamped it now.
    // Re-attribute and back-date it before anything is pushed, so the graph
    // never shows a test identity or a repository born seconds ago.
    runGit(
      DOCS_AUTHOR,
      web.path,
      ["commit", "--amend", "--no-edit", "--reset-author"],
      90
    );

    // A real origin sharing this history, so ahead/behind are genuinely computed
    // rather than staged. makeBareRemote() can't be used: it seeds its own
    // unrelated repo, leaving origin with no common ancestor.
    const origin = join(remotes, "acme-web.git");
    runGit(DOCS_AUTHOR, remotes, ["init", "--bare", "acme-web.git"]);
    runGit(DOCS_AUTHOR, origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    runGit(DOCS_AUTHOR, web.path, ["remote", "add", "origin", origin]);
    runGit(DOCS_AUTHOR, web.path, ["push", "-u", "origin", "main"]);
    runGit(DOCS_AUTHOR, web.path, ["remote", "set-head", "origin", "--auto"]);

    // Work in flight, pushed and then advanced — so the branch has a real
    // upstream and is genuinely one commit ahead of it. Without the push the
    // header reads "no upstream", which is the least interesting sync state
    // there is and not what the Sync page describes.
    const checkout = web.addWorktree("feat/checkout-redesign");
    commitBy(DOCS_AUTHOR, checkout, "src/checkout/summary.tsx", "Add the order summary panel", 3);
    runGit(DOCS_AUTHOR, checkout, ["push", "-u", "origin", "feat/checkout-redesign"]);
    commitBy(DOCS_AUTHOR, checkout, "src/checkout/totals.ts", "Split totals out of the cart", 2);

    // Uncommitted work: fills the Changes rail and puts a dirty badge in the
    // sidebar. One staged file and one unstaged, so both sections are non-empty.
    const session = web.addWorktree("fix/session-timeout");
    commitBy(DOCS_AUTHOR, session, "src/auth/session.ts", "Refresh the token before it expires", 1);
    runGit(DOCS_AUTHOR, session, ["push", "-u", "origin", "fix/session-timeout"]);
    leaveDirty(session, "src/auth/session.ts", "// refresh 60s before expiry, not 5\n");
    leaveDirty(session, "src/auth/retry.ts", "export const MAX_RETRIES = 3;\n");
    runGit(DOCS_AUTHOR, session, ["add", "src/auth/retry.ts"]);

    // Authored by someone else, so the graph shows a second name.
    const deps = web.addWorktree("chore/bump-deps");
    commitBy(DOCS_COLLEAGUE, deps, "package.json", "Bump the pinned toolchain", 6);

    // Merged into main and left alone for well over the 14-day staleness
    // window, so the Stale lens has something real to find. Clean + merged +
    // old is exactly the rule the Worktrees page documents.
    const banner = web.addWorktree("chore/retire-banner");
    commitBy(DOCS_AUTHOR, banner, "src/home/banner.tsx", "Remove the launch banner", 45);
    runGit(
      DOCS_AUTHOR,
      web.path,
      ["merge", "--no-ff", "chore/retire-banner", "-m", "Merge chore/retire-banner"],
      44
    );
    // Push the merge. "Merged into the default branch" is evaluated against
    // `origin/HEAD` — `resolveDefaultBranch` returns `origin/main`, not the local
    // ref — so a merge that never left the machine leaves the branch looking
    // unmerged and the Stale lens empty. Landing it upstream is also what
    // actually makes the worktree safe to prune.
    runGit(DOCS_AUTHOR, web.path, ["push", "origin", "main"], 44);

    // Neighbouring repositories: they exist so the sidebar reads as a real
    // working set rather than one row, and so the search overlay has more than
    // one thing to find.
    //
    // Each gets its root commit re-authored and back-dated, exactly as the
    // focus repo does. git-sandbox stamps them "PwrGit Test" a second ago, and
    // although these are not the repo the captures centre on, the app is free
    // to select one — clicking a repo row to expand it does — at which point
    // the test identity is what lands in the published image. Ages also stop
    // every neighbour reading "today", which is the tell that a screenshot was
    // staged minutes before it was taken.
    const neighbour = (
      name: string,
      daysAgo: number,
      worktrees: string[] = []
    ): void => {
      const repo = box.makeRepo(name, { worktrees });
      runGit(
        DOCS_AUTHOR,
        repo.path,
        ["commit", "--amend", "--no-edit", "--reset-author"],
        daysAgo
      );
    };

    neighbour("acme-api", 12, ["feat/rate-limits"]);
    neighbour("billing-service", 20, ["fix/invoice-rounding"]);
    neighbour("infra-terraform", 34);
    neighbour("design-tokens", 61);

    // An open-source checkout alongside the work ones, because that is what a
    // real machine looks like. Named after a real project, but with history of
    // our own making, and deliberately never the selected repo.
    //
    // Its actual history is not imported, and must not be: the lineage graph
    // renders commit authors, and openclaw has ~3,000 contributors whose names
    // would then be advertising PwrGit without ever having agreed to. (It is
    // also 84k commits and 3.8 GB, which the capture job could not clone
    // anyway — the screenshots have to be reproducible from a bare CI runner,
    // not from one laptop.) A repository row shows a name, a branch and a
    // count; none of that requires anyone else's identity.
    neighbour("openclaw", 8, ["fix/gateway-timeout"]);

    return { box, primary: web.name, cleanup: discard };
  } catch (err) {
    discard();
    throw err;
  }
}

/**
 * Where captured PNGs land. Overridable so CI can collect them elsewhere.
 *
 * Anchored to this file rather than `process.cwd()`: only `.gitignore`'s
 * `apps/desktop/docs-screenshots/` is ignored, so a run whose cwd is the repo
 * root (a bare `npx playwright test`, or an IDE runner) would drop six
 * untracked PNGs at the top of the tree. Specs here use `import.meta.url`
 * rather than `__dirname` — they run as ESM. See e2e/AGENTS.md.
 */
export const shotsDir = (): string =>
  process.env.PWRGIT_DOCS_SHOTS_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs-screenshots");
