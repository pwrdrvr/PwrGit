import fc from "fast-check";
import {
  searchNameKey,
  type Commit,
  type FileSearchHit,
  type RepoSearchHit
} from "@pwrgit/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../../../main/persistence/db";
import { ProfileService } from "../../../../main/profiles/profile-service";
import { RepoIndexer } from "../../../../main/git/repo-indexer";
import {
  SEARCH_EXACT_TIER_SQL,
  SEARCH_REPO_BEGUN_SQL,
  searchExactTierParams,
  searchMatchTier
} from "../../../../main/git/search-rank";
import { createSystemGit } from "../../../../main/git/test-support/system-git";
import { buildPaletteItems } from "./RepoSwitcherOverlay";

// ⌘K's promise for a repository's name: type it, in any case, with stray
// spaces around it, and the repository is the first row. Three layers have to
// keep it — the search SQL (which ranks before its 60-row cap), main's
// re-rank, and the palette's grouping — so this runs all three, over the real
// FTS5 index, the way a keystroke does. Nothing here needs git: the search
// rows are written by triggers on insert.

let db: ReturnType<typeof openDatabase>;
let indexer: RepoIndexer;
let mine: string;
let theirs: string;

beforeAll(() => {
  db = openDatabase(":memory:");
  indexer = new RepoIndexer(db, createSystemGit());
  const profiles = new ProfileService(db);
  mine = profiles.create({ name: "ours", email: "ours@example.com", roots: [] }).id;
  theirs = profiles.create({ name: "theirs", email: "theirs@example.com", roots: [] }).id;
});

afterAll(() => db.close());

/** Letters from several scripts, with and without precomposed accents, and
 *  the separators real repository names use. */
const NAME_CHARS = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ..."-_.",
  ..."ÀÁÂÄÅÇÈÉÊËÍÎÏÑÒÓÔÖØÙÚÛÜÝàáâäåçèéêëíîïñòóôöøùúûüýÿ",
  ..."ŁłŒœŠšŽžĞğŞşĆćČčŘřŮů",
  // Case maps that change length: `ß` upper-cases to `SS`, `ẞ` lower-cases to
  // `ß`, `İ` lower-cases to `i` and a combining dot. FTS5's unicode61 folds
  // none of these the way `searchNameKey` does.
  ..."ßẞİ",
  ..."ΑΒΓΔΕΣΩαβγδεσςωάέ",
  ..."ДЖЗИЯдежзия",
  ..."日本語中文"
];

const nameChar = fc.constantFrom(...NAME_CHARS);

/** A repository name: something FTS5 can search for. A name with no letter or
 *  digit sends the palette to its browse list instead (`buildFtsQuery`
 *  returns null), which is a different promise. */
const repoName = fc
  .array(nameChar, { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(""))
  .filter((name) => /[\p{L}\p{N}]/u.test(name));

/**
 * The same name as a person might type it: each letter as it is, upper or
 * lower, and whitespace around the whole.
 *
 * `keepLength` leaves out case maps that change a letter's length (`ß` →
 * `SS`). Only a whole name is looked up outside the index; a prefix still goes
 * through FTS5, whose unicode61 tokenizer does not fold them, so `STRAS`
 * never begins `straße` there.
 */
const typedAs = (
  name: string,
  { keepLength = false }: { keepLength?: boolean } = {}
): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.tuple(
        ...Array.from(name, (char) =>
          fc.constantFrom(
            ...[char, char.toUpperCase(), char.toLowerCase()].filter(
              (variant) => !keepLength || Array.from(variant).length === 1
            )
          )
        )
      ),
      fc.constantFrom("", " ", "  ", "\t", " "),
      fc.constantFrom("", " ", "\t", "　")
    )
    .map(([chars, before, after]) => `${before}${chars.join("")}${after}`);

type Fixture = {
  /** This profile's repositories; the first is the one typed. */
  repos: string[];
  /** Another profile's repository with the same name as the one typed. */
  twinInOtherProfile: boolean;
  /** Checkouts whose branch is the typed name (as the #337 report had: a
   *  repository and 80 worktrees on a branch of the same name). */
  sameNamedCheckouts: { repoIndex: number; spelling: string }[];
  /** Local branches of the typed name, checked out nowhere. */
  sameNamedBranches: { repoIndex: number; spelling: string }[];
  /** The repository the window is in (`repos` index), if any. Its exact-name
   *  branches lead the palette (#358), but never ahead of the named
   *  repository, even when the window is in that very repository. */
  focus: number | null;
  query: string;
  allProfiles: boolean;
};

const fixture: fc.Arbitrary<Fixture> = fc
  .uniqueArray(repoName, {
    minLength: 1,
    maxLength: 6,
    selector: searchNameKey
  })
  .chain((repos) => {
    const typed = repos[0]!;
    const sameNamed = fc.record({
      repoIndex: fc.nat({ max: repos.length - 1 }),
      spelling: typedAs(typed).map((spelled) => spelled.trim())
    });
    return fc.record({
      repos: fc.constant(repos),
      twinInOtherProfile: fc.boolean(),
      // Up to 80, often past the 60-row cap the SQL ranks before.
      sameNamedCheckouts: fc.array(sameNamed, { maxLength: 80, size: "max" }),
      // A repository holds one branch of each exact spelling.
      sameNamedBranches: fc.uniqueArray(sameNamed, {
        maxLength: 20,
        selector: ({ repoIndex, spelling }) => `${repoIndex}:${spelling}`
      }),
      focus: fc.option(fc.nat({ max: repos.length - 1 })),
      query: typedAs(typed),
      allProfiles: fc.boolean()
    });
  });

const repoId = (index: number): string => `repo-${index}`;

function seed(f: Omit<Fixture, "focus" | "query" | "allProfiles">): string {
  db.prepare("DELETE FROM repos").run();
  const insertRepo = db.prepare(
    "INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)"
  );
  const insertWorktree = db.prepare(
    "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES (?, ?, ?, ?, 0)"
  );
  const insertBranch = db.prepare(
    "INSERT INTO local_branches (id, repo_id, name, full_name) VALUES (?, ?, ?, ?)"
  );
  f.repos.forEach((name, index) => {
    insertRepo.run(repoId(index), mine, name, `/ours/${index}/${name}`);
  });
  if (f.twinInOtherProfile) {
    insertRepo.run("repo-theirs", theirs, f.repos[0], `/theirs/${f.repos[0]}`);
  }
  // Checkouts live beside their repository and carry its name in their path,
  // as agent worktrees do (`PwrAgnt-wt/...`): bm25 scores them on the
  // repository's name as well as their own.
  f.sameNamedCheckouts.forEach(({ repoIndex, spelling }, index) => {
    insertWorktree.run(
      `wt-${index}`,
      repoId(repoIndex),
      spelling,
      `/ours/${repoIndex}/${f.repos[repoIndex]}-wt/${index}/${spelling}`
    );
  });
  f.sameNamedBranches.forEach(({ repoIndex, spelling }, index) => {
    insertBranch.run(`lb-${index}`, repoId(repoIndex), spelling, `refs/heads/${spelling}`);
  });
  return repoId(0);
}

/** A commit and a file that also answered the query. The palette draws both
 *  above ordinary results, so only its own name tests keep the repository
 *  ahead of them. */
const commit: Commit = {
  hash: "c".repeat(40),
  shortHash: "c".repeat(7),
  parents: [],
  subject: "docs: mention the project by name",
  authorName: "Ada",
  authorEmail: "ada@example.com",
  committedAt: "2026-11-01T12:00:00.000Z",
  isMerge: false
};
const file: FileSearchHit = { path: "docs/overview.md", name: "overview.md", dir: "docs" };

/** The palette for `query`, as a keystroke builds it: main's search, then the
 *  renderer's grouping, both told which repository the window is in. */
function palette(
  query: string,
  { focus = null, allProfiles = false }: { focus?: number | null; allProfiles?: boolean } = {}
) {
  const focusedRepoId = focus === null ? null : repoId(focus);
  const hits = indexer.searchAll(query, { profileId: mine, allProfiles, focusedRepoId });
  return buildPaletteItems([commit], hits, query, [file], focusedRepoId);
}

const firstRow = (query: string, scope?: { focus?: number | null; allProfiles?: boolean }) =>
  palette(query, scope)[0];

describe("⌘K exact repository name", () => {
  it("puts the named repository first, whatever its script, case, spacing or the repository you are in", () => {
    fc.assert(
      fc.property(fixture, (f) => {
        const wanted = seed(f);
        const first = firstRow(f.query, f);
        expect(first?.kind).toBe("repo");
        expect(first?.kind === "repo" ? first.hit.kind : null).toBe("repo");
        expect(first?.kind === "repo" ? first.hit.repoId : null).toBe(wanted);
      })
    );
  });

  it("leads the branches of its own name in the repository you are in", () => {
    // The operator's report, shrunk: inside a repository, typing its name put
    // its checkouts on a branch of that name first (#358's group) and the
    // repository row below them.
    const wanted = seed({
      repos: ["PwrAgent"],
      twinInOtherProfile: false,
      sameNamedCheckouts: [{ repoIndex: 0, spelling: "pwragent" }],
      sameNamedBranches: []
    });
    expect(firstRow("PwrAgent", { focus: 0 })).toMatchObject({
      kind: "repo",
      hit: { kind: "repo", repoId: wanted }
    });
  });

  it("finds straße typed as STRASSE, which the index cannot", () => {
    // unicode61 indexes `straße` as one token and never matches `strasse*`,
    // so the repository was missing from the answer altogether.
    const wanted = seed({
      repos: ["straße"],
      twinInOtherProfile: false,
      sameNamedCheckouts: [],
      sameNamedBranches: []
    });
    expect(firstRow("STRASSE")).toMatchObject({
      kind: "repo",
      hit: { kind: "repo", repoId: wanted }
    });
  });

  it("finds İa typed as i̇a", () => {
    // Found by the property above. Lower-case İ is `i` and a combining dot,
    // which FTS5 splits into two tokens; only the lookup outside the index
    // reads it as the name.
    const wanted = seed({
      repos: ["İa", "a"],
      twinInOtherProfile: false,
      sameNamedCheckouts: [],
      sameNamedBranches: []
    });
    expect(firstRow("İa".toLowerCase())).toMatchObject({
      kind: "repo",
      hit: { kind: "repo", repoId: wanted }
    });
  });

  it("puts the same-named repository you are in first, then by folder", () => {
    // The operator has two repositories named PwrGit.
    seed({ repos: ["PwrGit"], twinInOtherProfile: false, sameNamedCheckouts: [], sameNamedBranches: [] });
    db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES ('repo-1', ?, 'PwrGit', '/a/PwrGit')").run(mine);
    const order = (focus: number | null) =>
      palette("pwrgit", { focus }).slice(0, 2).map((item) => (item.kind === "repo" ? item.hit.repoId : item.kind));
    expect(order(null)).toEqual(["repo-1", "repo-0"]);
    expect(order(0)).toEqual(["repo-0", "repo-1"]);
    expect(order(1)).toEqual(["repo-1", "repo-0"]);
  });

  it("finds ẞ typed as ß", () => {
    // Found by the property above. `searchNameKey` folded `ẞ` to `ß` and `ß`
    // to `ss`: one pass of upper-then-lower case did not reach a fixed point.
    expect(searchNameKey("ẞ")).toBe(searchNameKey("ß"));
    const wanted = seed({
      repos: ["ẞ"],
      twinInOtherProfile: false,
      sameNamedCheckouts: [],
      sameNamedBranches: []
    });
    expect(firstRow("ß")).toMatchObject({
      kind: "repo",
      hit: { kind: "repo", repoId: wanted }
    });
  });

  it("finds Übersicht typed in lower case past 80 same-named checkouts", () => {
    // The shrunk counterexample from the property above, kept by name.
    // SQL's `COLLATE NOCASE` folds ASCII only, so `übersicht` was not an exact
    // match for `Übersicht` before the cap, and 60 checkouts on branch
    // `übersicht` took every slot.
    const wanted = seed({
      repos: ["Übersicht"],
      twinInOtherProfile: false,
      sameNamedCheckouts: Array.from({ length: 80 }, () => ({
        repoIndex: 0,
        spelling: "übersicht"
      })),
      sameNamedBranches: []
    });
    const hits = indexer.searchAll("übersicht", { profileId: mine, allProfiles: false });
    expect(hits.some((hit) => hit.kind === "repo")).toBe(true);
    expect(firstRow("übersicht")).toMatchObject({
      kind: "repo",
      hit: { kind: "repo", repoId: wanted }
    });
  });

  it("finds ςa typed as Σa", () => {
    // Found by the property above. Whole-string lowercasing turns a
    // word-final Σ into ς and a medial one into σ, so the renderer and main
    // could fold the same letters two ways; SQL's NOCASE folded neither.
    const wanted = seed({
      repos: ["ςa", "a"],
      twinInOtherProfile: false,
      sameNamedCheckouts: [{ repoIndex: 0, spelling: "ςa" }],
      sameNamedBranches: []
    });
    expect(firstRow("Σa")).toMatchObject({ kind: "repo", hit: { kind: "repo", repoId: wanted } });
  });
});

type PrefixFixture = {
  /** This profile's repositories; the first is the one whose name is begun. */
  repos: string[];
  /** The first letters of `repos[0]`, as stored. */
  prefix: string;
  /** Checkouts and branches. `named` ones begin with `prefix` too; the rest
   *  match only through their repository's name, which every row carries. */
  refs: { kind: "worktree" | "local_branch"; repoIndex: number; name: string }[];
  focus: number | null;
  query: string;
};

const prefixFixture: fc.Arbitrary<PrefixFixture> = fc
  .uniqueArray(repoName, { minLength: 1, maxLength: 4, selector: searchNameKey })
  .chain((repos) => {
    const typed = repos[0]!;
    return fc
      .nat({ max: Array.from(typed).length - 1 })
      .map((cut) => Array.from(typed).slice(0, cut + 1).join(""))
      // A prefix with no letter or digit browses instead of searching.
      .filter((prefix) => /[\p{L}\p{N}]/u.test(prefix))
      .chain((prefix) =>
        fc.record({
          repos: fc.constant(repos),
          prefix: fc.constant(prefix),
          refs: fc.uniqueArray(
            fc.record({
              kind: fc.constantFrom("worktree" as const, "local_branch" as const),
              repoIndex: fc.nat({ max: repos.length - 1 }),
              name: fc.oneof(
                repoName.map((rest) => `${prefix}${rest}`),
                repoName
              )
            }),
            // Up to 80: the operator's own repository has 65 checkouts and
            // 300 branches, past the 60-row cap. One branch per name.
            {
              maxLength: 80,
              size: "max",
              selector: ({ kind, repoIndex, name }) => `${kind}:${repoIndex}:${name}`
            }
          ),
          focus: fc.option(fc.nat({ max: repos.length - 1 })),
          query: typedAs(prefix, { keepLength: true })
        })
      );
  });

function seedPrefix(f: PrefixFixture): string {
  seed({ repos: f.repos, twinInOtherProfile: false, sameNamedCheckouts: [], sameNamedBranches: [] });
  const insertWorktree = db.prepare(
    "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES (?, ?, ?, ?, 0)"
  );
  const insertBranch = db.prepare(
    "INSERT INTO local_branches (id, repo_id, name, full_name) VALUES (?, ?, ?, ?)"
  );
  f.refs.forEach(({ kind, repoIndex, name }, index) => {
    if (kind === "worktree") {
      insertWorktree.run(
        `wt-${index}`,
        repoId(repoIndex),
        name,
        `/ours/${repoIndex}/${f.repos[repoIndex]}-wt/${index}`
      );
    } else {
      insertBranch.run(`lb-${index}`, repoId(repoIndex), name, `refs/heads/${name}`);
    }
  });
  return repoId(0);
}

describe("⌘K repository name begun", () => {
  it("ranks the repository above its own checkouts and branches that match no better, and above files and commits", () => {
    fc.assert(
      fc.property(prefixFixture, (f) => {
        const wanted = seedPrefix(f);
        const items = palette(f.query, { focus: f.focus });
        const at = items.findIndex(
          (item) => item.kind === "repo" && item.hit.kind === "repo" && item.hit.repoId === wanted
        );
        // Present at all: inside the repository, its own rows once filled
        // the 60-row cap ahead of it.
        expect(at).toBeGreaterThanOrEqual(0);
        const repoTier = searchMatchTier((items[at] as { hit: RepoSearchHit }).hit, f.query);
        items.forEach((item, index) => {
          if (index >= at) return;
          if (item.kind === "file" || item.kind === "commit") {
            expect({ above: item.kind, index }).toBeUndefined();
          }
          if (item.kind !== "repo" || item.hit.repoId !== wanted) return;
          // One of its own rows above it must match the query better.
          expect({
            name: item.hit.name,
            tier: searchMatchTier(item.hit, f.query)
          }).toEqual({ name: item.hit.name, tier: expect.toSatisfy((tier: number) => tier < repoTier) });
        });
      })
    );
  });

  it("keeps the repository you are in when its own rows fill the result cap", () => {
    // The operator's data: inside PwrAgnt (65 checkouts, 300 branches),
    // `pwrag` returned 60 of PwrAgnt's rows and not PwrAgnt. SQL put the
    // focused repository's rows first by their `repo_name`, which a
    // repository's own index row leaves empty.
    const wanted = seedPrefix({
      repos: ["PwrAgnt"],
      prefix: "PwrAg",
      refs: Array.from({ length: 70 }, (_, index) => ({
        kind: "worktree" as const,
        repoIndex: 0,
        name: `detached@${index}`
      })),
      focus: 0,
      query: "pwrag"
    });
    expect(
      indexer.searchAll("pwrag", { profileId: mine, allProfiles: false, focusedRepoId: wanted })[0]
    ).toMatchObject({ kind: "repo", repoId: wanted });
    expect(firstRow("pwrag", { focus: 0 })).toMatchObject({
      kind: "repo",
      hit: { kind: "repo", repoId: wanted }
    });
  });

  it("keeps a long repository name past 80 checkouts that repeat its first letters", () => {
    // bm25 favours a short row that says the word often: `herd/herd-herd` in
    // `/herd/…` outscored `herder-tools-for-the-whole-team`, and 60 of them
    // took the cap. SQL now keeps a repository the query begins ahead of
    // them, as main ranks it.
    const wanted = seedPrefix({
      repos: ["herder-tools-for-the-whole-team", "other"],
      prefix: "her",
      refs: [],
      focus: null,
      query: "her"
    });
    const insertWorktree = db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES (?, 'repo-1', 'herd/herd-herd', ?, 0)"
    );
    for (let index = 0; index < 80; index += 1) {
      insertWorktree.run(`wt-${index}`, `/herd/herd-${index}/herd`);
    }
    expect(firstRow("her")).toMatchObject({ kind: "repo", hit: { kind: "repo", repoId: wanted } });
  });

  it("keeps the repository you are in when a word inside its name is typed", () => {
    // `agnt` begins no name of `pwr-agnt`, so only the focused-repository key
    // keeps the repository row inside the cap, and that key matched rows by
    // `repo_name`, which a repository's own row leaves empty.
    const wanted = seedPrefix({
      repos: ["pwr-agnt"],
      prefix: "pwr",
      refs: Array.from({ length: 70 }, (_, index) => ({
        kind: "worktree" as const,
        repoIndex: 0,
        name: `detached@${index}`
      })),
      focus: 0,
      query: "agnt"
    });
    expect(
      indexer
        .searchAll("agnt", { profileId: mine, allProfiles: false, focusedRepoId: wanted })
        .some((hit) => hit.kind === "repo" && hit.repoId === wanted)
    ).toBe(true);
  });

  it("leads its own checkouts that sit in a folder of its name", () => {
    // The operator's PwrSuiteLab: `pwrsuitel` listed ten checkouts in
    // `PwrSuiteLab-…` folders first. Both begin a name, and bm25 scores the
    // checkouts on two columns.
    const wanted = seedPrefix({
      repos: ["PwrSuiteLab"],
      prefix: "PwrSuiteL",
      refs: [],
      focus: null,
      query: "pwrsuitel"
    });
    db.prepare(
      "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES ('wt-x', ?, 'main', '/wt/PwrSuiteLab-main', 0)"
    ).run(wanted);
    expect(
      indexer.searchAll("pwrsuitel", { profileId: mine, allProfiles: false })[0]
    ).toMatchObject({ kind: "repo", repoId: wanted });
    expect(firstRow("pwrsuitel")).toMatchObject({
      kind: "repo",
      hit: { kind: "repo", repoId: wanted }
    });
  });
});

/** One row of every kind the capped search query ranks, named freely. */
type Names = {
  repo: string;
  repoFolder: string;
  worktree: string;
  worktreeFolder: string;
  local: string;
  remote: string;
  /** The open PR on the worktree's branch, if any: a bare number names it
   *  (SQL's `pr LIKE '<n> %'`, main's `pr.number`). */
  prNumber: number | null;
};

const names: fc.Arbitrary<Names> = fc.record({
  repo: repoName,
  repoFolder: repoName,
  worktree: repoName,
  worktreeFolder: repoName,
  local: repoName,
  remote: repoName,
  prNumber: fc.option(fc.integer({ min: 1, max: 999 }))
});

/** A query aimed at one of the names (typed in full, or its first letters),
 *  or at nothing in particular. */
const queryFor = (n: Names): fc.Arbitrary<string> => {
  const all = [n.repo, n.repoFolder, n.worktree, n.worktreeFolder, n.local, n.remote];
  // `#106` and `106` name PR 106; `1060` must not.
  const prQueries =
    n.prNumber === null
      ? []
      : [fc.constantFrom(`${n.prNumber}`, `#${n.prNumber}`, ` ${n.prNumber}0`)];
  return fc.oneof(
    ...prQueries,
    fc.constantFrom(...all).chain(typedAs),
    fc
      .constantFrom(...all)
      .chain((name) => fc.nat({ max: name.length - 1 }).map((cut) => name.slice(0, cut + 1)))
      .chain(typedAs),
    repoName
  );
};

function seedNames(n: Names): void {
  db.prepare("DELETE FROM repos").run();
  db.prepare("DELETE FROM branch_pr").run();
  // Before the worktree: its search row copies the PR when it is written.
  if (n.prNumber !== null) {
    db.prepare(
      `INSERT INTO branch_pr (repo_id, branch, number, url, title, state)
       VALUES ('r', ?, ?, ?, 'a change', 'open')`
    ).run(n.worktree, n.prNumber, `https://github.com/o/r/pull/${n.prNumber}`);
  }
  db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES ('r', ?, ?, ?)").run(
    mine,
    n.repo,
    `/ours/${n.repoFolder}`
  );
  db.prepare(
    "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES ('w', 'r', ?, ?, 0)"
  ).run(n.worktree, `/worktrees/${n.worktreeFolder}`);
  db.prepare(
    "INSERT INTO local_branches (id, repo_id, name, full_name) VALUES ('l', 'r', ?, ?)"
  ).run(n.local, `refs/heads/${n.local}`);
  db.prepare(
    "INSERT INTO remote_branches (id, repo_id, remote_name, name, full_name) VALUES ('o', 'r', 'origin', ?, ?)"
  ).run(n.remote, `refs/remotes/origin/${n.remote}`);
}

/** The search SQL's tier for each kind's row, from the rows the triggers wrote. */
function sqlTiers(query: string): Map<string, number> {
  return new Map(sqlKeys(query).map((row) => [row.kind, row.tier]));
}

/** Both of the search SQL's keys before the cap, per kind. */
function sqlKeys(query: string): { kind: string; tier: number; begun: number }[] {
  const params = searchExactTierParams(query);
  return db
    .prepare(
      `SELECT kind, ${SEARCH_EXACT_TIER_SQL} AS tier, ${SEARCH_REPO_BEGUN_SQL} AS begun
         FROM search_fts WHERE kind <> 'change_request'`
    )
    .all(...params, params[0]) as { kind: string; tier: number; begun: number }[];
}

describe("⌘K's three tests of an exact name agree", () => {
  it("SQL's tier, main's tier and the palette's leading group say the same", () => {
    fc.assert(
      fc.property(
        names.chain((n) => fc.tuple(fc.constant(n), queryFor(n))),
        ([n, query]) => {
          seedNames(n);
          const sql = sqlTiers(query);
          // Every row the index matched, hydrated as main hands it on. One row
          // of each kind, so a hit's kind names its SQL row.
          const hits = indexer.searchAll(query, { profileId: mine, allProfiles: false });
          for (const hit of hits) {
            const main = searchMatchTier(hit, query);
            // SQL ranks only the exact tiers; main's 1 and 2 are both its 1.
            expect({ kind: hit.kind, tier: sql.get(hit.kind) }).toEqual({
              kind: hit.kind,
              tier: Math.min(main, 1)
            });
            if (hit.kind !== "repo") continue;
            // SQL keeps ahead of the cap the repositories main ranks first in
            // their tier.
            expect({
              begun: sqlKeys(query).find((row) => row.kind === "repo")?.begun,
              main
            }).toEqual({ begun: main <= 1 ? 0 : 1, main });
            // Named: the repository leads even a checkout of the same name in
            // the repository you are in (#358's group).
            const sameNamedHere: RepoSearchHit = {
              ...hit,
              kind: "worktree",
              repoId: "focused",
              name: query.trim()
            };
            const named = buildPaletteItems([], [sameNamedHere, hit], query, [], "focused");
            // Begun: the repository leads the file and commit groups.
            const begun = buildPaletteItems([commit], [hit], query, [file], null);
            expect({
              leadsNamed: named[0]?.kind === "repo" && named[0].hit === hit,
              leadsBegun: begun[0]?.kind === "repo",
              main
            }).toEqual({ leadsNamed: main === -1, leadsBegun: main <= 1, main });
          }
        }
      )
    );
  });

  it("reads `_` in a folder name as itself", () => {
    // The tier compared folder names with LIKE once, where `_` matches any
    // one character: `wip1` named the checkout in `wip_1`.
    seedNames({
      repo: "tools",
      repoFolder: "tools",
      worktree: "feature",
      worktreeFolder: "wip_1",
      local: "x",
      remote: "y",
      prNumber: null
    });
    expect(sqlTiers("wip1").get("worktree")).toBe(1);
    expect(sqlTiers("WIP_1").get("worktree")).toBe(0);
  });
});
