import type { LaneBranchInfo, PrSummary, StackPosition } from "@pwrgit/shared";
import wideFont from "@fontsource/geist-sans/files/geist-sans-latin-600-normal.woff2?url";
import { useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BranchChipMenu, type BranchChipTarget } from "../../../src/renderer/src/features/graph/BranchChipMenu";
import { GraphRow, type GraphRowVM } from "../../../src/renderer/src/features/graph/GraphRow";
import { useHoverIntent } from "../../../src/renderer/src/lib/hoverIntent";
import "../../../src/renderer/src/styles/app.css";

const now = Date.parse("2026-11-18T15:00:00Z");
const noop = () => undefined;

const samplePr: PrSummary = {
  number: 7,
  url: "https://forge.example.test/pull/7",
  title: "Prepare widget preview",
  state: "open",
  isDraft: false
};
const firstRef = (i: number) => `feature/WWWW-widget-preview-${i}`;

function makeScene(count: number, deep = false) {
  const laneCount = deep ? 24 : 3;
  const branches: Record<string, LaneBranchInfo> = {};
  const stackPositions = new Map<string, StackPosition>();
  const lanes = Array.from({ length: deep ? laneCount : 1 }, (_, lane) => ({ from: lane, to: lane }));
  const rows = Array.from({ length: count }, (_, i): GraphRowVM => {
    const hash = i.toString(16).padStart(7, "0");
    const kind = i % 10;
    const name = firstRef(i);
    if (deep && kind === 6) {
      const layer = {
        branch: name, parent: "main",
        health: { inSync: true, needsRestack: false, parentMerged: false, needsPush: false, drift: false, remoteAhead: false }
      };
      stackPositions.set(name, {
        layer, index: 1,
        stack: { id: `widget-stack-${i}`, catalogRepository: "widgets", source: "tracked", trunk: { branch: "main" }, layers: [layer] }
      });
    }
    if (kind <= 2 || stackPositions.has(name)) {
      branches[name] = {
        ...(kind === 1 || kind === 6 ? { pr: samplePr } : {}),
        ...(kind === 2 || kind === 6 ? { worktreeId: "widget-checkout" } : {})
      };
    }
    const hasLocal = kind <= 2 || (deep && kind >= 5 && kind <= 8);
    const extraRefs = kind === 0 ? 8 : kind === 5 ? 10 : kind === 6 ? 9 : 0;
    return {
      commit: {
        hash, shortHash: hash, parents: [], subject: `Widget history entry ${i}`,
        authorName: "Avery Chen", authorEmail: "avery@example.test",
        committedAt: "2026-11-18T14:00:00Z", isMerge: kind === 2
      },
      row: { lane: deep ? i % laneCount : kind % 3, top: lanes, bottom: lanes },
      refs: hasLocal
        ? [name, `widget-${i}`, ...Array.from({ length: extraRefs }, (_, j) => `archive/${i}-${j}`)]
        : [],
      remoteRefs: kind === 3 ? [`origin/widget-${i}`, "upstream"] : [],
      ...(kind === 0 || kind === 4 ? { tag: { name: `preview/WWWW-widgets-${i}`, kind: "annotated" } } : {}),
      ...(kind === 5 ? { pullRequest: samplePr } : {}),
      isHead: false, isHeadOnly: false, isMine: false, defaultBranch: "main"
    };
  });
  return { rows, branches, laneCount, stackPositions, deep };
}

function Graph({ scene, width, lateFont }: {
  scene: ReturnType<typeof makeScene>;
  width: number;
  lateFont: boolean;
}) {
  const hoverIntent = useHoverIntent();
  const [branch, setBranch] = useState<BranchChipTarget | null>(null);
  return (
    <div className="graph-harness" style={{ width }}>
      <div
        className="graph-scroll"
        style={{
          ...(lateFont ? { "--font-mono": '"Graph Fit Late", "Geist Mono", monospace' } as CSSProperties : {}),
          ...(scene.deep ? { maxHeight: "calc(100vh - 16px)" } : {})
        }}
      >
        <div className="graph-card">
          {scene.rows.map((vm) => (
            <GraphRow
              key={vm.commit.hash}
              vm={vm}
              branchInfo={scene.branches}
              laneCount={scene.laneCount}
              stackPositions={scene.stackPositions}
              onOpenStack={stack => { lastAction = `stack:${stack.id}`; }}
              now={now}
              selected={false}
              focused={false}
              flashing={false}
              contextOpen={false}
              hoverIntent={hoverIntent}
              onOpen={noop}
              onShowContext={noop}
              onHideContext={noop}
              onFocusContext={() => false}
              onOpenContextMenu={noop}
              {...(!scene.deep && {
                onOpenBranchMenu: setBranch,
                onRevealWorktree: (id: string) => { lastAction = `worktree:${id}`; }
              })}
              onShowPerson={noop}
              onTakeTag={moved => { lastAction = `tag:${moved.name}`; }}
            />
          ))}
        </div>
        {branch !== null && (
          <BranchChipMenu
            target={branch}
            branchInfo={scene.branches}
            viewingBranch="main"
            repoId="widgets"
            worktreeId="main-checkout"
            onClose={() => setBranch(null)}
            onRevealWorktree={(id) => { lastAction = `worktree:${id}`; }}
            onSwitchBranch={target => { lastAction = `switch:${target.branch}`; }}
          />
        )}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
let scene = makeScene(0);
let width = 540;
let key = 0;
let lateFont = false;
let lastAction = "";

function render() {
  flushSync(() => root.render(<Graph key={key} scene={scene} width={width} lateFont={lateFont} />));
}

function readRows() {
  const visible = (element: Element) => element.getClientRects().length > 0;
  const contains = (outer: DOMRect, inner: DOMRect) =>
    inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 &&
    inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
  return [...document.querySelectorAll(".graph-row")].map((row) => {
    const line = row.querySelector(".commit-meta")!;
    const rect = line.getBoundingClientRect();
    const slots = [...line.querySelectorAll(
      ":scope > :not([popover]), :scope > .ref-chips > *, :scope > .ref-chips > .ref-group > *"
    )].filter(visible);
    const names = [...line.querySelectorAll(".ref-chips .ref-chip__name, :scope > .commit-tag--tag .commit-tag__name")]
      .filter(visible);
    return {
      chips: names.map((name) => ({
        text: name.textContent,
        truncated: name.scrollWidth > name.clientWidth || name.scrollHeight > name.clientHeight
      })),
      summary: line.querySelector(".ref-browser")?.textContent ?? null,
      clipped: slots.flatMap((slot) => {
        const box = slot.getBoundingClientRect();
        const parent = slot.parentElement!;
        return contains(rect, box) && contains(parent.getBoundingClientRect(), box) &&
          // A whole pill still needs room for its glyph and name ellipsis.
          [...slot.querySelectorAll(":scope > svg, :scope > .ref-chip__name, :scope > .commit-tag__name")]
            .filter(visible).every((part) => contains(box, part.getBoundingClientRect()))
          ? [] : [slot.className];
      })
    };
  });
}

export const harness = {
  production: import.meta.env.PROD,
  readRows,
  lastAction: () => lastAction,
  ready: Promise.all([
    document.fonts.load('600 9.5px "Geist Mono"'),
    document.fonts.load('600 12.5px "Geist Sans"'),
    document.fonts.load('500 10.5px "Geist Sans"'),
    document.fonts.load('700 7px "Geist Sans"')
  ]),
  mount(count: number, nextWidth: number, withLateFont = false) {
    scene = makeScene(count);
    width = nextWidth;
    lateFont = withLateFont;
    key++;
    render();
  },
  prepareDeepScene(nextWidth: number, count = 24) {
    scene = makeScene(count, true);
    width = nextWidth;
    lateFont = false;
  },
  remount() {
    key++;
    render();
  },
  resize(nextWidth: number) {
    width = nextWidth;
    document.querySelector<HTMLElement>(".graph-harness")!.style.width = `${width}px`;
  },
  refresh() {
    scene = structuredClone(scene);
    render();
  },
  changeBranch(pr: boolean, worktree: boolean) {
    scene = {
      ...scene,
      rows: scene.rows.map((row) => ({ ...row })),
      branches: {
        ...scene.branches,
        [firstRef(0)]: {
          ...(pr ? { pr: { ...samplePr, state: "merged" } } : {}),
          ...(worktree ? { worktreeId: "widget-checkout" } : {})
        }
      }
    };
    render();
  },
  changeRow(change: Partial<GraphRowVM>) {
    scene = {
      ...scene,
      rows: scene.rows.map((row, i) => i === 0 ? { ...row, ...change } : { ...row })
    };
    render();
  },
  async loadWideFont() {
    const style = document.createElement("style");
    // Widen the late face enough to cross a fit step at the same row width.
    style.textContent = `@font-face {
      font-family: "Graph Fit Late";
      src: url("${wideFont}");
      font-weight: 600;
      size-adjust: 130%;
    }`;
    document.head.append(style);
    await document.fonts.load('600 9.5px "Graph Fit Late"');
  }
};

Object.assign(window, { graphRefHarness: harness });
