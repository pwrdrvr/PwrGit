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
 * Case maps that change a letter's length (`ß` → `SS`) are left out: the
 * index's unicode61 tokenizer does not fold them, so FTS5 never returns the
 * repository at all. That is the tokenizer's limit, not the ranking this
 * property is about. `NAME_CHARS` holds no such letter today; the guard keeps
 * a future addition honest.
 */
const typedAs = (name: string): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.tuple(
        ...Array.from(name, (char) =>
          fc.constantFrom(
            ...[char, char.toUpperCase(), char.toLowerCase()].filter(
              (variant) => Array.from(variant).length === 1
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
    return fc.record({
      repos: fc.constant(repos),
      twinInOtherProfile: fc.boolean(),
      sameNamedCheckouts: fc.array(
        fc.record({
          repoIndex: fc.nat({ max: repos.length - 1 }),
          spelling: typedAs(typed).map((spelled) => spelled.trim())
        }),
        // Up to 80, often past the 60-row cap the SQL ranks before.
        { maxLength: 80, size: "max" }
      ),
      query: typedAs(typed),
      allProfiles: fc.boolean()
    });
  });

function seed(f: Fixture): string {
  db.prepare("DELETE FROM repos").run();
  const insertRepo = db.prepare(
    "INSERT INTO repos (id, profile_id, name, path) VALUES (?, ?, ?, ?)"
  );
  const insertWorktree = db.prepare(
    "INSERT INTO worktrees (id, repo_id, branch, path, is_primary) VALUES (?, ?, ?, ?, 0)"
  );
  f.repos.forEach((name, index) => {
    insertRepo.run(`repo-${index}`, mine, name, `/ours/${index}/${name}`);
  });
  if (f.twinInOtherProfile) {
    insertRepo.run("repo-theirs", theirs, f.repos[0], `/theirs/${f.repos[0]}`);
  }
  f.sameNamedCheckouts.forEach(({ repoIndex, spelling }, index) => {
    insertWorktree.run(
      `wt-${index}`,
      `repo-${repoIndex}`,
      spelling,
      `/worktrees/${index}/${spelling}`
    );
  });
  return "repo-0";
}

/** A commit and a file that also answered the query. The palette draws both
 *  above ordinary results, so only its own exact-name test keeps the
 *  repository ahead of them. */
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

const firstRow = (hits: RepoSearchHit[], query: string) =>
  // focusedRepoId = null: with a repository focused, #358 deliberately puts
  // that repository's exact-name branches and checkouts ahead of everything,
  // its own repository row included. Whether that should yield to an
  // exact-named repository is an open product question, so this property
  // speaks only for the palette with nothing focused.
  buildPaletteItems([commit], hits, query, [file], null)[0];

describe("⌘K exact repository name", () => {
  it("puts the named repository first, whatever its script, case or spacing", () => {
    fc.assert(
      fc.property(fixture, (f) => {
        const wanted = seed(f);
        const hits = indexer.searchAll(f.query, {
          profileId: mine,
          allProfiles: f.allProfiles
        });
        const first = firstRow(hits, f.query);
        expect(first?.kind).toBe("repo");
        expect(first?.kind === "repo" ? first.hit.kind : null).toBe("repo");
        expect(first?.kind === "repo" ? first.hit.repoId : null).toBe(wanted);
      })
    );
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
      query: "übersicht",
      allProfiles: false
    });
    const hits = indexer.searchAll("übersicht", { profileId: mine, allProfiles: false });
    expect(hits.some((hit) => hit.kind === "repo")).toBe(true);
    expect(firstRow(hits, "übersicht")).toMatchObject({
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
      query: "Σa",
      allProfiles: false
    });
    expect(
      firstRow(indexer.searchAll("Σa", { profileId: mine, allProfiles: false }), "Σa")
    ).toMatchObject({ kind: "repo", hit: { kind: "repo", repoId: wanted } });
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
  const rows = db
    .prepare(
      `SELECT kind, ${SEARCH_EXACT_TIER_SQL} AS tier FROM search_fts
        WHERE kind <> 'change_request'`
    )
    .all(...searchExactTierParams(query)) as { kind: string; tier: number }[];
  return new Map(rows.map((row) => [row.kind, row.tier]));
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
            const palette = buildPaletteItems([commit], [hit], query, [file], null);
            expect({ leads: palette[0]?.kind === "repo", main }).toEqual({
              leads: main === -1,
              main
            });
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
