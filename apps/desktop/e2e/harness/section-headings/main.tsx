import { StrictMode, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { ok } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { ChangeRequestSelectionContext } from "../../../src/renderer/src/features/change-request/change-request-selection";
import { RepoRow } from "../../../src/renderer/src/features/sidebar/RepoRow";
import { HARNESS_NOW, HARNESS_REPOS, type HarnessRepo } from "./fixtures";
import { headingRowProblems, repoRowProblems } from "./measure";

/**
 * The real `RepoRow` (and the Worktrees, PR, Branches, Tags and Remotes
 * headings it draws) against a fake preload bridge, at the section-row
 * widths a sidebar gives them: 270 (the 320px default), 222 (a 400px
 * sidebar with the repository index), 194 (320px with the index) and 170.
 * `section-headings.spec.ts` drives it; the page answers through
 * `window.__harness`.
 */

const ROWS = [270, 222, 194, 170] as const;
/** A section row is the tree's width less the tree's own insets. */
const TREE_INSET = 50;

type RepoKey = keyof typeof HARNESS_REPOS;

const byId = new Map(
  Object.values(HARNESS_REPOS).map((entry) => [entry.repo.id, entry])
);

const bridge = {
  profileId: "profile-harness",
  platform: "darwin",
  appearance: { theme: "light", resolvedTheme: "light" },
  dispatch: async (name: string, req: unknown): Promise<unknown> => {
    const repoId = (req as { repoId?: string } | null)?.repoId;
    const entry = repoId === undefined ? undefined : byId.get(repoId);
    if (name === "repo:refs" && entry !== undefined) return ok(entry.refs);
    if (name === "pr:openList" && entry !== undefined) return ok(entry.changeRequests);
    if (name === "forge:hosts") return ok({ hosts: [], overrides: {} });
    return ok({ rows: [], total: 0 });
  },
  on: () => () => undefined,
  getAppMenuModel: async () => [],
  popupAppMenu: () => undefined,
  runWindowControl: async () => undefined,
  readWindowFrameState: async () => null,
  onWindowFrameState: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.setAttribute("data-theme", "light");
document.documentElement.dataset["platform"] = "darwin";
for (const entry of Object.values(HARNESS_REPOS)) {
  // Worktrees closed, so a scene is its headings.
  window.localStorage.setItem(`pwrgit.unpinnedWorktreesOpen.${entry.repo.id}`, "0");
}

const noop = (): void => undefined;

/** Scenes drawn collapsed, set from outside through `__harness.setExpanded`. */
let setCollapsed: Dispatch<SetStateAction<ReadonlySet<string>>> | null = null;
const sceneKey = (repo: string, row: number): string => `${repo}@${row}`;

function Tree({
  entry,
  row,
  tree,
  expanded
}: {
  entry: HarnessRepo;
  row: number;
  tree: number;
  expanded: boolean;
}) {
  return (
    <div className="harness-scene" data-repo={entry.repo.id} data-row={row}>
      <div className="harness-caption">
        {entry.repo.name} · section row {row}px
      </div>
      <aside className="pane pane--sidebar" style={{ width: tree }}>
        <div className="sidebar__body">
          <div className="sidebar__tree-pane">
            <div className="sidebar__list">
              <div className="sidebar__tree" role="tree" aria-label="Repositories">
                <RepoRow
                  repo={entry.repo}
                  expanded={expanded}
                  containsSelection={entry.selectedWorktreeId !== null}
                  selectedWorktreeId={entry.selectedWorktreeId}
                  selectedIds={new Set()}
                  sort="recent"
                  customOrder={undefined}
                  now={HARNESS_NOW}
                  focused={false}
                  focusContext={{ selectedWorktreeId: entry.selectedWorktreeId, visits: {} }}
                  onToggleExpand={noop}
                  onToggleRepoPin={noop}
                  refreshing={false}
                  onRefreshWorktrees={noop}
                  onSelectWorktree={noop}
                  onContextWorktree={noop}
                  onToggleWorktreePin={noop}
                  onToggleBranchPin={noop}
                  onRemoveWorktree={noop}
                  onRefreshPullRequest={noop}
                  onRemoveSelected={noop}
                  onClearSelected={noop}
                  onCycleSort={noop}
                  onReorder={noop}
                  onNewWorktree={noop}
                  onRevealWorktree={noop}
                  onCreateWorktreeFromRef={noop}
                  onForkRepo={noop}
                  onHideRepo={noop}
                  onRemoveRepo={noop}
                  arrangeable={false}
                  dragProps={{ draggable: false }}
                  dragging={false}
                  dropPosition={null}
                  focusable
                  onRowKeyDown={noop}
                  onRowFocus={noop}
                  isPostDragClick={() => false}
                  posinset={1}
                  setsize={1}
                  platform="darwin"
                />
              </div>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Harness({ inset }: { inset: number }) {
  const [collapsed, setCollapsedState] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    setCollapsed = setCollapsedState;
  }, []);
  const repos = (new URLSearchParams(location.search).get("repos") ?? "atlas,beacon,cinder")
    .split(",")
    .filter((key): key is RepoKey => key in HARNESS_REPOS);
  return (
    <ChangeRequestSelectionContext.Provider
      value={{ selectedKey: null, select: noop, clear: noop }}
    >
      <div className="harness-grid" style={{ gridTemplateColumns: `repeat(${ROWS.length}, max-content)` }}>
        {repos.flatMap((key) =>
          ROWS.map((row) => (
            <Tree
              key={`${key}-${row}`}
              entry={HARNESS_REPOS[key]}
              row={row}
              tree={row + inset}
              expanded={!collapsed.has(sceneKey(HARNESS_REPOS[key].repo.id, row))}
            />
          ))
        )}
      </div>
    </ChangeRequestSelectionContext.Provider>
  );
}

export type SceneReport = {
  repo: string;
  row: number;
  /** The measured width of the block's section rows. */
  measured: number;
  sectionSteps: string[];
  rowSteps: string[];
  problems: string[];
  /** Each heading's button name, and the +N chip's, as a screen reader gets it. */
  names: string[];
};

function report(): SceneReport[] {
  // A collapsed scene has no headings to report.
  return [...document.querySelectorAll<HTMLElement>(".harness-scene")]
    .filter((scene) => scene.querySelector(".repo-sections") !== null)
    .map((scene) => {
    const sections = scene.querySelector<HTMLElement>(".repo-sections")!;
    const row = scene.querySelector<HTMLElement>(".repo-row")!;
    const problems = [
      ...repoRowProblems(row),
      ...[
        ...sections.querySelectorAll<HTMLElement>(
          ".ref-section__head-wrap, .wt-section__head"
        )
      ].flatMap(headingRowProblems)
    ];
    return {
      repo: scene.dataset["repo"] ?? "",
      row: Number(scene.dataset["row"]),
      measured: sections.querySelector(".wt-section__head")!.getBoundingClientRect().width,
      sectionSteps: [...sections.classList].filter((c) => c.startsWith("fit-")),
      rowSteps: [...row.classList].filter((c) => c.startsWith("rr-")),
      problems,
      names: [
        ...sections.querySelectorAll<HTMLElement>(
          ".ref-section__head, .wt-section__toggle, .ref-section__chip.is-more"
        )
      ]
        .filter((el) => el.getClientRects().length > 0)
        .map((el) => el.getAttribute("aria-label") ?? (el.textContent ?? "").trim())
    };
  });
}

/** Wait until every scene's lists have landed and nothing is "…". */
async function settled(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const loading = [...document.querySelectorAll(".ref-section__count")].some(
      (el) => el.textContent === "…"
    );
    if (!loading && document.querySelectorAll(".harness-scene").length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the harness never settled");
}

function App() {
  const [inset, setInset] = useState(TREE_INSET);
  useEffect(() => {
    // The tree's insets are the stylesheet's, so measure them rather than
    // trust the constant: one pass, then correct every scene.
    const head = document.querySelector(".harness-scene .wt-section__head");
    const aside = document.querySelector<HTMLElement>(".harness-scene .pane--sidebar");
    if (head === null || aside === null) return;
    const actual = aside.getBoundingClientRect().width - head.getBoundingClientRect().width;
    if (Math.abs(actual - inset) > 0.25) setInset(actual);
  }, [inset]);
  return <Harness inset={inset} />;
}

const harness = {
  ready: (async () => {
    // Load every face the headings draw before the first fit, so no step is
    // measured in a fallback font.
    await Promise.all(
      [
        '600 10px "Geist Sans"',
        '600 13px "Geist Sans"',
        '600 10px "Geist Mono"',
        '500 11px "Geist Mono"'
      ].map((font) => document.fonts.load(font))
    );
    await document.fonts.ready;
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
    await settled();
    // Two frames for the inset correction's re-render and its fits.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await settled();
  })(),
  report,
  /** Collapse or expand one scene's repository. */
  setExpanded(repo: string, row: number, expanded: boolean): void {
    setCollapsed?.((current) => {
      const next = new Set(current);
      if (expanded) next.delete(sceneKey(repo, row));
      else next.add(sceneKey(repo, row));
      return next;
    });
  },
  /** Resize one scene's tree in place, to exercise the ResizeObserver. */
  resize(repo: string, row: number, tree: number): void {
    const aside = document.querySelector<HTMLElement>(
      `.harness-scene[data-repo="${repo}"][data-row="${row}"] .pane--sidebar`
    );
    if (aside !== null) aside.style.width = `${tree}px`;
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
