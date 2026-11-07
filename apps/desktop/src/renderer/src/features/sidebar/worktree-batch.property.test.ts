// @vitest-environment jsdom
//
// Model test: "at most one thing looks selected" in the sidebar.
//
// The rule has broken five times: fc5c65f ("3 highlighted → 2 selected"),
// 8de070d (one worktree under two repositories), 5a83d04 (a ⌘F/⌘K pick or an
// expand left the old row's batch tint behind), #494's first push (the repo
// index tinted its scroll marker beside the selection), and the change
// request row (a picked PR left the worktree it replaced tinted).
//
// fast-check generates sessions of the commands below. Each runs on the real
// batch hook (`useWorktreeBatch`, mounted through React so its effects run as
// they do in the sidebar) and the real pure rules around it: the row look,
// the "N selected" count, `primaryUnlessHeld`, `neighbourOf`, the lens filter,
// `resolveWorktreeSelection` at boot, `mergeChangedRepos` and
// `claimWorktreeOwnership` on every refresh, and the repo index's classes.
// What App does with a pick (set the selection, drop the change request) is
// restated here in a line each.
//
// Invariants, after every command ("viewed" is the worktree on screen: App's
// selection, or nothing while a change request is on screen):
//
//   I1  Lit rows (is-selected or is-multiselected) = {viewed} ∪ batch.
//   I2  The batch lies within one repository's worktrees.
//   I3  The batch is empty or contains the viewed row, unless the last
//       gesture was a ⌘- or Shift-click.
//   I4  Per repository, "N selected" shows exactly when two or more of its
//       rows are lit, and N is that number.
//   I5  One worktree has one owner.
//   I6  Only the repository holding what is on screen tints in the index
//       (tinting classes read from app.css).
//   I7  A refresh, lens switch or scroll that moves nothing on screen leaves
//       the batch alone, apart from rows that left.
//
// Against the code before each fix, extracted with `git show`:
//
//   - fc5c65f..5a83d04^ (no re-seed): I3 failed on 10 of 10 seeds within
//     9–75 runs, shrunk to `toggleExpand(a), plainClick(a), toggleExpand(b)`.
//   - #494's first push (a jump only scrolled; `is-current` had the tint): I6
//     failed on 10 of 10 seeds within 1–9 runs, shrunk to `indexJump(b)`.
//   - main before this test: I3 within 14–98 runs (a change request left the
//     clicked row tinted), I4 within 6–69 (`indexJump, metaClick`: two rows
//     lit, no count), I6 within 68–88 (a change request in another repository
//     tinted the selection's), I7 within 9–23 (a refresh re-seeded a
//     ⌘-click batch), I2 in 2 of 8 seeds (a Shift range took a pinned branch
//     row), and I5 in 2 of 30 (`refresh(fossil, fossil)`: one worktree twice
//     under one repository).
//
// The shrunk sequences are kept below as example tests.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimWorktreeOwnership,
  type ChangeRequestEntry,
  type Lens,
  type Repo,
  type Worktree
} from "@pwrgit/shared";
import { changeRequestPickKey } from "../change-request/change-request-selection";
import { mergeChangedRepos } from "../../state/useRepoTree";
import { pinnedBranchRowId } from "./PinnedBranchRow";
import { repoIndexItemClass } from "./repo-index";
import { filterReposByLens } from "./repo-view";
import {
  resolveWorktreeSelection,
  type WorktreeSelection
} from "./worktree-selection";
import {
  neighbourOf,
  primaryUnlessHeld,
  selectionBarCount,
  selectionHolder,
  useWorktreeBatch,
  worktreeRowLook
} from "./worktree-batch";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-11-01T12:00:00Z");
const LENSES: Lens[] = ["All", "Pinned", "Focused"];

// ---- The repo index's tint, from the stylesheet ----

/** Classes that tint `.repo-index__item` — a background, or the accent as
 *  its text colour — which is what reads as "selected". Pseudo-classes and
 *  pseudo-elements (hover, focus, the rail) are not states the model drives. */
function indexTintClasses(): Set<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(resolve(here, "../../styles/app.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const found = new Set<string>();
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const tints =
      /(^|[;\s])background(-color)?\s*:\s*(?!transparent)/.test(body!) ||
      /(^|[;\s])color\s*:\s*var\(--accent\b/.test(body!);
    if (!tints) continue;
    for (const selector of selectors!.split(",")) {
      const m = /^\.repo-index__item((?:\.[\w-]+)+)$/.exec(selector.trim());
      if (m === null) continue;
      for (const cls of m[1]!.split(".").filter(Boolean)) found.add(cls);
    }
  }
  return found;
}
const TINTS = indexTintClasses();

// ---- Fixtures ----

function worktree(repoId: string, id: string, isPrimary: boolean): Worktree {
  return {
    id,
    repoId,
    branch: isPrimary ? "main" : id,
    path: isPrimary ? `/repos/${repoId}` : `/repos/${repoId}-${id}`,
    dirty: 0,
    ahead: 0,
    behind: 0,
    behindDefault: 0,
    defaultBranch: "main",
    mergedIntoDefault: false,
    divergedFromDefault: false,
    isDefaultBranch: isPrimary,
    pinned: false,
    isPrimary
  };
}

type RepoShape = { linked: number; pinned: boolean; pinnedBranches: number };

function buildRepo(id: string, shape: RepoShape, nextId: () => string): Repo {
  const worktrees = [worktree(id, `${id}-main`, true)];
  for (let i = 0; i < shape.linked; i++) worktrees.push(worktree(id, nextId(), false));
  return {
    id,
    name: id,
    path: `/repos/${id}`,
    profileId: "p",
    pinned: shape.pinned,
    worktrees,
    ...(shape.pinnedBranches === 0
      ? {}
      : { pinnedBranches: ["spike", "wip", "old"].slice(0, shape.pinnedBranches) })
  };
}

/** The ids a repository's rows hand to a click, in drawn order: primary,
 *  pinned branches (rows that are not worktrees), then linked worktrees. */
function displayIds(repo: Repo): string[] {
  const primary = repo.worktrees.filter((w) => w.isPrimary).map((w) => w.id);
  const others = repo.worktrees.filter((w) => !w.isPrimary).map((w) => w.id);
  return [...primary, ...(repo.pinnedBranches ?? []).map(pinnedBranchRowId), ...others];
}

const pick = <T>(list: readonly T[], n: number): T | undefined =>
  list.length === 0 ? undefined : list[n % list.length];

// ---- The system under test: the hook, plus App's half of the state ----

type Hook = ReturnType<typeof useWorktreeBatch>;
type HarnessProps = {
  repos: Repo[];
  selectedWorktreeId: string | null;
  changeRequestKey: string | null;
  out: { hook: Hook | null };
};
function Harness({ out, ...props }: HarnessProps): null {
  out.hook = useWorktreeBatch(props);
  return null;
}

class Real {
  repos: Repo[];
  selection: WorktreeSelection | null;
  changeRequest: { repoId: string; key: string } | null = null;
  lens: Lens = "All";
  expanded = new Set<string>();
  spy: { current: string | null; inView: Set<string> } = { current: null, inView: new Set() };
  private seq = 0;
  private readonly out: { hook: Hook | null } = { hook: null };
  private readonly root: Root;
  private readonly container = document.createElement("div");

  constructor(shapes: RepoShape[], stored: { repo: number; wt: number; stale: boolean } | null) {
    this.repos = shapes.map((shape, i) => buildRepo(`r${i}`, shape, () => this.newId()));
    // Boot: App restores the stored selection through resolveWorktreeSelection.
    const repo = stored === null ? undefined : pick(this.repos, stored.repo);
    const wt = repo === undefined || stored === null ? undefined : pick(repo.worktrees, stored.wt);
    this.selection = resolveWorktreeSelection(
      this.repos,
      repo === undefined || wt === undefined
        ? null
        : { repoId: repo.id, worktreeId: stored?.stale === true ? "gone" : wt.id }
    );
    document.body.append(this.container);
    this.root = createRoot(this.container);
    this.render();
  }

  newId(): string {
    this.seq += 1;
    return `w${this.seq}`;
  }

  get hook(): Hook {
    if (this.out.hook === null) throw new Error("not rendered");
    return this.out.hook;
  }

  get selectedId(): string | null {
    return this.selection?.worktreeId ?? null;
  }

  /** The worktree on screen; a change request takes its place. */
  get viewed(): string | null {
    return this.changeRequest === null ? this.selectedId : null;
  }

  get drawn(): Repo[] {
    return filterReposByLens(this.repos, this.lens, NOW, {
      selectedWorktreeId: this.selectedId,
      visits: {}
    });
  }

  /** Repositories whose rows are on screen: drawn and expanded. */
  get open(): Repo[] {
    return this.drawn.filter((repo) => this.expanded.has(repo.id));
  }

  /** Every state change goes through here, as one React batch. */
  act(change: () => void): void {
    act(() => {
      change();
      this.renderNow();
    });
  }

  render(): void {
    act(() => this.renderNow());
  }

  private renderNow(): void {
    this.root.render(
      createElement(Harness, {
        repos: this.repos,
        selectedWorktreeId: this.selectedId,
        changeRequestKey: this.changeRequest?.key ?? null,
        out: this.out
      })
    );
  }

  /** App's `selectWorktree`: every worktree pick leaves a change request. */
  selectWorktree(repo: Repo, worktree: Worktree): void {
    this.changeRequest = null;
    this.selection = { repoId: repo.id, worktreeId: worktree.id };
  }

  /** App drops a change request whose repository left the tree. */
  setRepos(next: Repo[]): void {
    this.repos = next;
    if (this.changeRequest !== null && !next.some((r) => r.id === this.changeRequest?.repoId)) {
      this.changeRequest = null;
    }
  }

  unmount(): void {
    act(() => this.root.unmount());
    this.container.remove();
  }
}

type Model = { lastGesture: "modifier" | "other" };
type Cmd = fc.Command<Model, Real>;

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));
const show = (set: ReadonlySet<string>): string => `{${[...set].sort().join(", ")}}`;

function checkInvariants(model: Model, real: Real): void {
  const { repos, hook } = real;
  const batch = hook.batch;
  const viewed = real.viewed;

  // I5: one worktree, one owner.
  const owners = new Map<string, string>();
  for (const repo of repos) {
    for (const w of repo.worktrees) {
      expect(owners.get(w.id), `I5: ${w.id} under ${owners.get(w.id)} and ${repo.id}`)
        .toBeUndefined();
      owners.set(w.id, repo.id);
    }
  }

  // I2: the batch lies within one repository's worktrees.
  const batchRepo = repos.find((r) => r.id === batch.repoId);
  const batchRows = new Set(batchRepo?.worktrees.map((w) => w.id) ?? []);
  for (const id of batch.ids) {
    expect(batchRows.has(id), `I2: batch ${show(batch.ids)} has ${id}, not a row of ${batch.repoId}`)
      .toBe(true);
  }

  // I1: lit rows = {viewed} ∪ batch.
  const lit = new Set<string>();
  const litByRepo = new Map<string, number>();
  for (const repo of repos) {
    const batchIds = hook.idsFor(repo.id);
    let n = 0;
    for (const w of repo.worktrees) {
      const look = worktreeRowLook({
        worktreeId: w.id,
        selectedWorktreeId: real.selectedId,
        changeRequestKey: real.changeRequest?.key ?? null,
        batchIds
      });
      if (look.selected || look.multiSelected) {
        lit.add(w.id);
        n += 1;
      }
    }
    litByRepo.set(repo.id, n);
  }
  const expected = new Set(
    [...batch.ids, ...(viewed === null ? [] : [viewed])].filter((id) => owners.has(id))
  );
  expect(sameSet(lit, expected), `I1: lit ${show(lit)}, viewed ${viewed}, batch ${show(batch.ids)}`)
    .toBe(true);

  // I3: the batch holds the viewed row, unless ⌘/Shift built it.
  if (model.lastGesture !== "modifier") {
    expect(
      batch.ids.size === 0 || (viewed !== null && batch.ids.has(viewed)),
      `I3: batch ${show(batch.ids)} without the viewed row ${viewed}`
    ).toBe(true);
  }

  // I4: "N selected" counts exactly the lit rows.
  for (const repo of repos) {
    const n = litByRepo.get(repo.id) ?? 0;
    expect(
      selectionBarCount(hook.idsFor(repo.id)),
      `I4: ${repo.id} lights ${n} rows (batch ${show(hook.idsFor(repo.id))}, viewed ${viewed})`
    ).toBe(n >= 2 ? n : null);
  }

  // I6: only the repository holding what is on screen tints in the index.
  const holder =
    real.changeRequest?.repoId ??
    (viewed === null ? null : (owners.get(viewed) ?? null));
  const tinted = new Set(
    real.drawn
      .filter((repo) =>
        repoIndexItemClass({
          current: real.spy.current === repo.id,
          inView: real.spy.inView.has(repo.id),
          containsSelection:
            repo.id === selectionHolder(repos, real.selectedId, real.changeRequest?.key ?? null),
          dragging: false
        })
          .split(" ")
          .some((cls) => TINTS.has(cls))
      )
      .map((repo) => repo.id)
  );
  const shouldTint = new Set(real.drawn.filter((r) => r.id === holder).map((r) => r.id));
  expect(sameSet(tinted, shouldTint), `I6: index tints ${show(tinted)}, holder ${holder}`)
    .toBe(true);
}

/** I7: a command that moved nothing on screen kept the batch, less rows that
 *  left. */
function checkBatchKept(real: Real, before: { ids: ReadonlySet<string>; viewed: string | null }): void {
  if (real.viewed !== before.viewed) return;
  const rows = new Set(
    real.repos.find((r) => r.id === real.hook.batch.repoId)?.worktrees.map((w) => w.id) ?? []
  );
  const kept = new Set([...before.ids].filter((id) => rows.has(id)));
  expect(
    sameSet(real.hook.batch.ids, kept),
    `I7: batch went from ${show(before.ids)} to ${show(real.hook.batch.ids)}`
  ).toBe(true);
}

abstract class Base implements Cmd {
  check(): boolean {
    return true;
  }
  abstract apply(model: Model, real: Real): void;
  run(model: Model, real: Real): void {
    this.apply(model, real);
    checkInvariants(model, real);
  }
  abstract toString(): string;
}

/** Runs `change` and records "other" when it moved what is on screen. */
function moving(model: Model, real: Real, change: () => void): void {
  const before = `${real.selectedId}|${real.changeRequest?.key}`;
  real.act(change);
  if (`${real.selectedId}|${real.changeRequest?.key}` !== before) model.lastGesture = "other";
}

class ClickRow extends Base {
  constructor(
    readonly kind: "plain" | "meta" | "shift",
    readonly r: number,
    readonly w: number
  ) {
    super();
  }
  apply(model: Model, real: Real): void {
    const repo = pick(real.open, this.r);
    const wt = repo === undefined ? undefined : pick(repo.worktrees, this.w);
    if (repo === undefined || wt === undefined) return;
    const modifiers = {
      shiftKey: this.kind === "shift",
      metaKey: this.kind === "meta",
      ctrlKey: false
    };
    real.act(() => {
      if (real.hook.click(repo, wt.id, modifiers, displayIds(repo))) real.selectWorktree(repo, wt);
    });
    model.lastGesture = this.kind === "plain" ? "other" : "modifier";
  }
  toString(): string {
    return `${this.kind}Click(${this.r},${this.w})`;
  }
}

class ContextRow extends Base {
  constructor(readonly r: number, readonly w: number) {
    super();
  }
  apply(model: Model, real: Real): void {
    const repo = pick(real.open, this.r);
    const wt = repo === undefined ? undefined : pick(repo.worktrees, this.w);
    if (repo === undefined || wt === undefined) return;
    const before = real.hook.batch;
    real.act(() => void real.hook.context(repo, wt.id, displayIds(repo)));
    if (real.hook.batch !== before) model.lastGesture = "other";
  }
  toString(): string {
    return `contextClick(${this.r},${this.w})`;
  }
}

class ClearSelection extends Base {
  apply(model: Model, real: Real): void {
    real.act(() => real.hook.clear());
    model.lastGesture = "other";
  }
  toString(): string {
    return "clearSelection";
  }
}

/** ⌘F, ⌘K or the palette: any worktree in the profile. */
class ExternalPick extends Base {
  constructor(readonly r: number, readonly w: number) {
    super();
  }
  apply(model: Model, real: Real): void {
    const repo = pick(real.repos, this.r);
    const wt = repo === undefined ? undefined : pick(repo.worktrees, this.w);
    if (repo === undefined || wt === undefined) return;
    moving(model, real, () => real.selectWorktree(repo, wt));
  }
  toString(): string {
    return `externalPick(${this.r},${this.w})`;
  }
}

/** A repo row's disclosure: `toggleExpand`. */
class ToggleExpand extends Base {
  constructor(readonly r: number) {
    super();
  }
  apply(model: Model, real: Real): void {
    const repo = pick(real.drawn, this.r);
    if (repo === undefined) return;
    moving(model, real, () => {
      if (real.expanded.has(repo.id)) real.expanded.delete(repo.id);
      else real.expanded.add(repo.id);
      const primary = primaryUnlessHeld(repo, real.selectedId);
      if (primary !== null) real.selectWorktree(repo, primary);
    });
  }
  toString(): string {
    return `toggleExpand(${this.r})`;
  }
}

/** A name in the repo index: `jumpToRepo`. */
class IndexJump extends Base {
  constructor(readonly r: number) {
    super();
  }
  apply(model: Model, real: Real): void {
    const repo = pick(real.drawn, this.r);
    if (repo === undefined) return;
    moving(model, real, () => {
      const primary = primaryUnlessHeld(repo, real.selectedId);
      if (primary !== null) real.selectWorktree(repo, primary);
      real.expanded.add(repo.id);
      // The jump puts the block at the top: the spy names it.
      real.spy = { current: repo.id, inView: new Set([repo.id]) };
    });
  }
  toString(): string {
    return `indexJump(${this.r})`;
  }
}

class Scroll extends Base {
  constructor(readonly r: number, readonly mask: number) {
    super();
  }
  apply(_model: Model, real: Real): void {
    const before = { ids: real.hook.batch.ids, viewed: real.viewed };
    const drawn = real.drawn;
    const current = pick(drawn, this.r);
    real.act(() => {
      real.spy = {
        current: current?.id ?? null,
        inView: new Set(drawn.filter((_, i) => (this.mask >> i) & 1).map((r) => r.id))
      };
    });
    checkBatchKept(real, before);
  }
  toString(): string {
    return `scroll(${this.r},${this.mask})`;
  }
}

class SwitchLens extends Base {
  constructor(readonly lens: Lens) {
    super();
  }
  apply(_model: Model, real: Real): void {
    const before = { ids: real.hook.batch.ids, viewed: real.viewed };
    real.act(() => {
      real.lens = this.lens;
    });
    checkBatchKept(real, before);
  }
  toString(): string {
    return `lens(${this.lens})`;
  }
}

type RefreshOp = {
  op: "addWorktree" | "removeWorktree" | "togglePin" | "pinBranch" | "addRepo" | "dropRepo" | "fossil";
  a: number;
  b: number;
};

/** A repository list arriving from main: a full `repo:list` (ownership
 *  claimed in main) or a `repo:changed` for the touched repositories, merged
 *  by `mergeChangedRepos`. */
class Refresh extends Base {
  constructor(readonly ops: RefreshOp[], readonly partial: boolean) {
    super();
  }
  apply(_model: Model, real: Real): void {
    const before = { ids: real.hook.batch.ids, viewed: real.viewed };
    let next = real.repos.map((repo) => ({ ...repo, worktrees: [...repo.worktrees] }));
    const touched = new Set<string>();
    for (const { op, a, b } of this.ops) {
      const repo = pick(next, a);
      if (op === "addRepo") {
        const id = `r${real.newId()}`;
        next.push(buildRepo(id, { linked: b % 3, pinned: false, pinnedBranches: 0 }, () => real.newId()));
        continue;
      }
      if (repo === undefined) continue;
      touched.add(repo.id);
      if (op === "addWorktree") repo.worktrees.push(worktree(repo.id, real.newId(), false));
      else if (op === "removeWorktree") {
        const linked = repo.worktrees.filter((w) => !w.isPrimary);
        const gone = pick(linked, b);
        repo.worktrees = repo.worktrees.filter((w) => w !== gone);
      } else if (op === "togglePin") repo.pinned = !repo.pinned;
      else if (op === "pinBranch") {
        const branches = repo.pinnedBranches ?? [];
        repo.pinnedBranches = branches.length > 0 ? [] : ["spike"];
      } else if (op === "dropRepo") next = next.filter((r) => r !== repo);
      else {
        // An old database's fossil: another repository's linked worktree
        // stranded under this one too (8de070d).
        const donor = pick(next.filter((r) => r !== repo), b);
        const stranded = donor?.worktrees.find((w) => !w.isPrimary);
        if (stranded !== undefined) repo.worktrees.push({ ...stranded, repoId: repo.id });
      }
    }
    const added = next.filter((r) => !real.repos.some((old) => old.id === r.id));
    const merged =
      this.partial && added.length === 0
        ? mergeChangedRepos(
            real.repos,
            [...touched],
            next.filter((r) => touched.has(r.id))
          )
        : claimWorktreeOwnership(next);
    real.act(() => real.setRepos(merged));
    checkBatchKept(real, before);
  }
  toString(): string {
    return `refresh(${this.partial ? "partial " : ""}${this.ops
      .map((o) => `${o.op}:${o.a},${o.b}`)
      .join(" ")})`;
  }
}

/** Hide (or Remove) on a repo row: `selectNeighbourOf`, then the list without
 *  it. */
class HideRepo extends Base {
  constructor(readonly r: number) {
    super();
  }
  apply(model: Model, real: Real): void {
    const repo = pick(real.drawn, this.r);
    if (repo === undefined) return;
    moving(model, real, () => {
      const next = neighbourOf(repo, real.drawn, real.repos, real.selectedId);
      if (next !== null) real.selectWorktree(next.repo, next.worktree);
    });
    moving(model, real, () => real.setRepos(real.repos.filter((r) => r.id !== repo.id)));
  }
  toString(): string {
    return `hideRepo(${this.r})`;
  }
}

/** A row in an open repository's PR section. */
class PickChangeRequest extends Base {
  constructor(readonly r: number, readonly n: number) {
    super();
  }
  apply(model: Model, real: Real): void {
    const repo = pick(real.open, this.r);
    if (repo === undefined) return;
    const entry = { forgeRepo: "o/r", pr: { number: 1 + (this.n % 3) } } as ChangeRequestEntry;
    moving(model, real, () => {
      real.changeRequest = { repoId: repo.id, key: changeRequestPickKey(repo.id, entry) };
    });
  }
  toString(): string {
    return `pickChangeRequest(${this.r},${this.n})`;
  }
}

/** Esc on a change request: back to the worktree that was selected. */
class LeaveChangeRequest extends Base {
  apply(model: Model, real: Real): void {
    moving(model, real, () => {
      real.changeRequest = null;
    });
  }
  toString(): string {
    return "leaveChangeRequest";
  }
}

const idx = fc.nat({ max: 7 });
const commands = fc.commands<Model, Real>(
  [

    fc.tuple(fc.constantFrom("plain", "meta", "shift") as fc.Arbitrary<"plain" | "meta" | "shift">, idx, idx)
      .map(([kind, r, w]) => new ClickRow(kind, r, w)),
    fc.tuple(idx, idx).map(([r, w]) => new ContextRow(r, w)),
    fc.constant(new ClearSelection()),
    fc.tuple(idx, idx).map(([r, w]) => new ExternalPick(r, w)),
    idx.map((r) => new ToggleExpand(r)),
    idx.map((r) => new IndexJump(r)),
    fc.tuple(idx, fc.nat({ max: 63 })).map(([r, mask]) => new Scroll(r, mask)),
    fc.constantFrom(...LENSES).map((lens) => new SwitchLens(lens)),
    fc.tuple(
      fc.array(
        fc.record({
          op: fc.constantFrom<RefreshOp["op"]>(
            "addWorktree",
            "removeWorktree",
            "togglePin",
            "pinBranch",
            "addRepo",
            "dropRepo",
            "fossil"
          ),
          a: idx,
          b: idx
        }),
        { minLength: 0, maxLength: 3 }
      ),
      fc.boolean()
    ).map(([ops, partial]) => new Refresh(ops, partial)),
    idx.map((r) => new HideRepo(r)),
    fc.tuple(idx, idx).map(([r, n]) => new PickChangeRequest(r, n)),
    fc.constant(new LeaveChangeRequest())
  ],
  { maxCommands: 25 }
);

const shapes = fc.array(
  fc.record({
    linked: fc.nat({ max: 3 }),
    pinned: fc.boolean(),
    pinnedBranches: fc.nat({ max: 2 })
  }),
  { minLength: 1, maxLength: 4 }
);
const stored = fc.option(
  fc.record({ repo: idx, wt: idx, stale: fc.boolean() }),
  { nil: null }
);

const one = (linked: number, pinnedBranches = 0): RepoShape => ({
  linked,
  pinned: false,
  pinnedBranches
});

describe("sidebar selection model", () => {
  let mounted: Real | null = null;
  afterEach(() => {
    mounted?.unmount();
    mounted = null;
  });

  /** Replays a session with every invariant checked after each step. */
  function session(repoShapes: RepoShape[], cmds: Cmd[]): Real {
    mounted?.unmount();
    const real = new Real(repoShapes, null);
    mounted = real;
    const model: Model = { lastGesture: "other" };
    checkInvariants(model, real);
    fc.modelRun(() => ({ model, real }), cmds);
    return real;
  }
  const ids = (real: Real): string[] => [...real.hook.batch.ids].sort();

  // The shrunk counterexamples, kept by name. Each failed on the code before
  // its fix.
  it("5a83d04: an expand elsewhere does not leave the clicked row tinted", () => {
    const real = session([one(0), one(0)], [
      new ToggleExpand(0),
      new ClickRow("plain", 0, 0),
      new ToggleExpand(1)
    ]);
    expect(ids(real)).toEqual(["r1-main"]);
  });

  it("#494: a jump in the repo index tints only the repository it selects", () => {
    session([one(0), one(0)], [new IndexJump(1)]);
  });

  it("a picked change request leaves no worktree row tinted", () => {
    const real = session([one(0)], [
      new IndexJump(0),
      new ClickRow("plain", 0, 0),
      new PickChangeRequest(0, 0)
    ]);
    expect(ids(real)).toEqual([]);
  });

  it("a change request tints its own repository in the index", () => {
    const real = session([one(0), one(0)], [
      new IndexJump(1),
      new ExternalPick(0, 0),
      new PickChangeRequest(0, 0)
    ]);
    expect(real.changeRequest?.repoId).toBe("r1");
  });

  it("⌘-click after a pick that was not a click counts both rows", () => {
    const real = session([one(1)], [new IndexJump(0), new ClickRow("meta", 0, 1)]);
    expect(selectionBarCount(real.hook.idsFor("r0"))).toBe(2);
  });

  it("a refresh keeps a ⌘-click batch", () => {
    const real = session([one(1)], [
      new IndexJump(0),
      new ClickRow("meta", 0, 1),
      new Refresh([], false)
    ]);
    expect(ids(real)).toEqual(["r0-main", "w1"]);
  });

  it("a Shift range over a pinned branch row holds only worktrees", () => {
    // Rows as drawn: r0-main, branch:spike, w1.
    const real = session([one(1, 1)], [
      new IndexJump(0),
      new ClickRow("plain", 0, 0),
      new ClickRow("shift", 0, 1)
    ]);
    expect(ids(real)).toEqual(["r0-main", "w1"]);
  });

  it("the stylesheet tints only is-selected (and a drag) in the repo index", () => {
    expect([...TINTS].sort()).toEqual(["is-dragging", "is-selected"]);
  });

  it("at most one thing looks selected, whatever the session", () => {
    fc.assert(
      fc.property(shapes, stored, commands, (repoShapes, restored, cmds) => {
        mounted?.unmount();
        const real = new Real(repoShapes, restored);
        mounted = real;
        const model: Model = { lastGesture: "other" };
        checkInvariants(model, real);
        fc.modelRun(() => ({ model, real }), cmds);
      })
    );
  });
});
