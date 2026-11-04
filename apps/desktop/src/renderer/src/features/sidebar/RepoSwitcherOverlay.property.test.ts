import fc from "fast-check";
import type {
  Commit,
  FileSearchHit,
  HiddenRepo,
  RepoSearchHit
} from "@pwrgit/shared";
import { describe, expect, it } from "vitest";
import {
  buildPaletteItems,
  paletteItemKey,
  resolvePaletteHits,
  selectedPaletteItemIndex,
  selectionAfterResolve,
  type PaletteItem
} from "./RepoSwitcherOverlay";

const hex = (length: number) =>
  fc
    .array(fc.constantFrom(..."0123456789abcdef"), { minLength: length, maxLength: length })
    .map((chars) => chars.join(""));

/** A ref name segment git accepts: no `:`, `~`, `^`, `?`, `*`, `[`, `\`,
 *  space or `..`, and some letters beyond ASCII. */
const refSegment = fc
  .array(fc.constantFrom(..."abcxyzABC019-_.äöüßøé日"), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(""))
  .filter((segment) => !segment.startsWith(".") && !segment.endsWith(".") && !segment.includes(".."));

const refName = fc
  .array(refSegment, { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join("/"));

const base = (repoId: string): Omit<RepoSearchHit, "kind" | "name"> => ({
  repoId,
  path: `/repos/${repoId}`,
  profileId: "profile",
  profileName: "Personal",
  worktreeCount: 0,
  pinned: false
});

/**
 * One search hit, as main hydrates it, keyed by the entity it stands for —
 * which is what main dedupes on and what makes two hits distinct.
 */
const hitOf = (repoIds: string[]): fc.Arbitrary<{ identity: string; hit: RepoSearchHit }> => {
  const repoId = fc.constantFrom(...repoIds);
  return fc.oneof(
    repoId.map((id) => ({
      identity: `repo ${id}`,
      hit: { ...base(id), kind: "repo" as const, name: id, worktreeCount: 2 }
    })),
    fc.tuple(repoId, hex(12), refName).map(([id, worktreeId, branch]) => ({
      // A worktree's id is a hash of its path: unique across repositories.
      identity: `worktree ${worktreeId}`,
      hit: { ...base(id), kind: "worktree" as const, name: branch, worktreeId, path: `/w/${worktreeId}` }
    })),
    fc.tuple(repoId, refName).map(([id, branch]) => ({
      identity: `local ${id} ${branch}`,
      hit: { ...base(id), kind: "local_branch" as const, name: branch }
    })),
    fc.tuple(repoId, fc.constantFrom("origin", "upstream", "fork"), refName).map(([id, remote, branch]) => ({
      identity: `remote ${id} ${remote}/${branch}`,
      hit: {
        ...base(id),
        kind: "remote_branch" as const,
        name: branch,
        remoteName: remote,
        remoteRef: `refs/remotes/${remote}/${branch}`
      }
    })),
    fc
      .tuple(repoId, fc.constantFrom("o/r", "fork/r", "o/r2"), fc.integer({ min: 1, max: 40 }), fc.string())
      .map(([id, repoPath, number, title]) => ({
        // A fork checkout lists the fork's and the original's: both can
        // have a #14, and two titles can be the same words.
        identity: `change ${id} ${repoPath}#${number}`,
        hit: {
          ...base(id),
          kind: "change_request" as const,
          name: title,
          pr: {
            number,
            url: `https://github.com/${repoPath}/pull/${number}`,
            title,
            state: "open" as const,
            isDraft: false,
            repoPath,
            host: "github.com"
          }
        }
      }))
  );
};

const commitOf = (hash: string): Commit => ({
  hash,
  shortHash: hash.slice(0, 7),
  parents: [],
  subject: "subject",
  authorName: "Ada",
  authorEmail: "ada@example.com",
  committedAt: "2026-11-01T12:00:00.000Z",
  isMerge: false
});

const fileOf = (path: string): FileSearchHit => ({ path, name: path, dir: "" });

const hiddenOf = (path: string): HiddenRepo => ({
  path,
  name: path,
  profileId: "profile",
  profileName: "Personal",
  hiddenAt: "2026-11-01T12:00:00.000Z",
  repoId: null,
  worktreeCount: 0,
  missing: false
});

describe("palette item keys", () => {
  // `hitKey` has been patched five times for collisions: two local branches
  // in one repo, a fork's and the original's #14, and so on. A collision is a
  // duplicate React key (ghost rows) and two rows the highlight cannot tell
  // apart.
  it("gives every distinct row its own key", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(hex(16), { minLength: 1, maxLength: 4 }).chain((repoIds) =>
          fc.record({
            hits: fc.uniqueArray(hitOf(repoIds), { maxLength: 30, selector: (h) => h.identity }),
            commits: fc.uniqueArray(hex(40), { maxLength: 4 }),
            files: fc.uniqueArray(fc.string({ minLength: 1 }), { maxLength: 4 }),
            hidden: fc.uniqueArray(fc.string({ minLength: 1 }), { maxLength: 3 }),
            showHidden: fc.boolean()
          })
        ),
        (f) => {
          const items: PaletteItem[] = [
            ...f.hits.map(({ hit }) => ({ kind: "repo" as const, hit })),
            ...f.commits.map((hash) => ({ kind: "commit" as const, commit: commitOf(hash) })),
            ...f.files.map((path) => ({ kind: "file" as const, hit: fileOf(path) })),
            ...f.hidden.map((path) => ({ kind: "hidden" as const, entry: hiddenOf(path) })),
            ...(f.showHidden
              ? [{ kind: "show-hidden" as const, count: 1, profileName: "Personal" }]
              : [])
          ];
          expect(new Set(items.map(paletteItemKey)).size).toBe(items.length);
        }
      )
    );
  });
});

type Branch = { name: string; worktreeId: string | null };

type Step =
  | { kind: "select"; row: number }
  | { kind: "resolve"; branch: number }
  | { kind: "requery" };

const REPO = "repo";
const localHit = (b: Branch): RepoSearchHit => ({ ...base(REPO), kind: "local_branch", name: b.name });
const worktreeHit = (b: Branch): RepoSearchHit => ({
  ...base(REPO),
  kind: "worktree",
  name: b.name,
  worktreeId: b.worktreeId!,
  path: `/w/${b.worktreeId}`
});

const selectionScenario = fc
  .uniqueArray(refName, { minLength: 1, maxLength: 8 })
  .chain((names) =>
    fc.tuple(
      fc.tuple(...names.map((name, i) => fc.boolean().map((held): Branch => ({
        name,
        worktreeId: held ? `wt${i}` : null
      })))),
      fc.constantFrom("", REPO, ...names),
      fc.constantFrom(null, REPO)
    )
  )
  .chain(([branches, query, focusedRepoId]) =>
    fc.record({
      branches: fc.constant(branches),
      query: fc.constant(query),
      focusedRepoId: fc.constant(focusedRepoId),
      // What the index answered: the repository, every branch as a bare
      // local branch (the index can lag a checkout made in a terminal —
      // that lag is why rows resolve at all), and some checkouts it already
      // knew about. In any order.
      initial: fc
        .subarray(branches.filter((b) => b.worktreeId !== null))
        .chain((known) =>
          fc.shuffledSubarray(
            [
              { ...base(REPO), kind: "repo" as const, name: REPO },
              ...branches.map(localHit),
              ...known.map(worktreeHit)
            ],
            { minLength: 1 }
          )
        ),
      steps: fc.array(
        fc.oneof(
          fc.nat({ max: 20 }).map((row): Step => ({ kind: "select", row })),
          fc.nat({ max: branches.length - 1 }).map((branch): Step => ({ kind: "resolve", branch })),
          fc.constant<Step>({ kind: "requery" })
        ),
        { maxLength: 25 }
      )
    })
  );

describe("palette selection while branch rows resolve", () => {
  // A local-branch row is checked against main once it is on screen (or
  // picked), and turns into the worktree that holds it. The highlight must
  // stay on that row as it changes shape: the reader pointed at it, and
  // Enter opens whatever is highlighted.
  it("keeps the highlight on the row the reader chose", () => {
    fc.assert(
      fc.property(selectionScenario, (s) => {
        const resolved = new Map<string, RepoSearchHit | null>();
        let results = resolvePaletteHits(s.initial, resolved);
        let selectedKey: string | null = null;
        const itemsNow = () => buildPaletteItems([], results, s.query, [], s.focusedRepoId);
        // The model: the row the reader chose, by the key it had then, and
        // what that row has become since. Nothing chosen yet means the first.
        let chosen = paletteItemKey(itemsNow()[0]!);
        const becomes = (key: string): string => {
          const into = resolved.get(key);
          return into === undefined || into === null ? key : paletteItemKey({ kind: "repo", hit: into });
        };

        for (const step of s.steps) {
          if (step.kind === "select") {
            const items = itemsNow();
            selectedKey = paletteItemKey(items[step.row % items.length]!);
            chosen = selectedKey;
          } else if (step.kind === "resolve") {
            const branch = s.branches[step.branch]!;
            const hit = localHit(branch);
            const into = branch.worktreeId === null ? null : worktreeHit(branch);
            // The component's two updates, in its order.
            resolved.set(paletteItemKey({ kind: "repo", hit }), into);
            results = resolvePaletteHits(results, resolved);
            selectedKey = selectionAfterResolve(selectedKey, hit, into);
          } else {
            // A new answer to the same query (the scope toggle, a re-render).
            results = resolvePaletteHits(s.initial, resolved);
          }
          const items = itemsNow();
          const highlighted = items[selectedPaletteItemIndex(items, selectedKey)];
          expect(highlighted && paletteItemKey(highlighted)).toBe(becomes(chosen));
        }
      })
    );
  });

  it("follows a highlighted second branch into its worktree", () => {
    // The shrunk counterexample, kept by name: the highlight sat on the
    // second row, that row resolved, and the old comparison (against a
    // `repo:` prefix no key carries) dropped it back to the first row.
    const first: Branch = { name: "fix/first", worktreeId: null };
    const second: Branch = { name: "fix/second", worktreeId: "wt1" };
    const resolved = new Map<string, RepoSearchHit | null>();
    const before = buildPaletteItems([], [localHit(first), localHit(second)], "", []);
    const selected = paletteItemKey(before[1]!);
    resolved.set(selected, worktreeHit(second));
    const after = buildPaletteItems(
      [],
      resolvePaletteHits([localHit(first), localHit(second)], resolved),
      "",
      []
    );
    const next = selectionAfterResolve(selected, localHit(second), worktreeHit(second));
    expect(after[selectedPaletteItemIndex(after, next)]).toEqual({
      kind: "repo",
      hit: worktreeHit(second)
    });
  });
});
