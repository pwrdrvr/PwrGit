import type { LaneBranchInfo, PrSummary } from "@pwrgit/shared";
import wideFont from "@fontsource/geist-sans/files/geist-sans-latin-600-normal.woff2?url";
import type { CSSProperties } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
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

function makeScene(count: number) {
  const branches: Record<string, LaneBranchInfo> = {};
  const rows = Array.from({ length: count }, (_, i): GraphRowVM => {
    const hash = i.toString(16).padStart(7, "0");
    const kind = i % 10;
    const name = firstRef(i);
    if (kind <= 2) {
      branches[name] = {
        ...(kind === 1 ? { pr: samplePr } : {}),
        ...(kind === 2 ? { worktreeId: "widget-checkout" } : {})
      };
    }
    return {
      commit: {
        hash, shortHash: hash, parents: [], subject: `Widget history entry ${i}`,
        authorName: "Avery Chen", authorEmail: "avery@example.test",
        committedAt: "2026-11-18T14:00:00Z", isMerge: kind === 2
      },
      row: { lane: kind % 3, top: [{ from: 0, to: 0 }], bottom: [{ from: 0, to: 0 }] },
      refs: kind <= 2
        ? [name, `widget-${i}`, ...Array.from({ length: kind === 0 ? 8 : 0 }, (_, j) => `archive/${i}-${j}`)]
        : [],
      remoteRefs: kind === 3 ? [`origin/widget-${i}`, "upstream"] : [],
      ...(kind === 0 || kind === 4 ? { tag: { name: `preview/WWWW-widgets-${i}`, kind: "annotated" } } : {}),
      ...(kind === 5 ? { pullRequest: samplePr } : {}),
      isHead: false, isHeadOnly: false, isMine: false, defaultBranch: "main"
    };
  });
  return { rows, branches };
}

function Graph({
  scene, width, lateFont
}: {
  scene: ReturnType<typeof makeScene>;
  width: number;
  lateFont: boolean;
}) {
  const hoverIntent = useHoverIntent();
  return (
    <div className="graph-harness" style={{ width }}>
      <div
        className="graph-scroll"
        style={lateFont ? { "--font-mono": '"Graph Fit Late", "Geist Mono", monospace' } as CSSProperties : undefined}
      >
        <div className="graph-card">
          {scene.rows.map((vm) => (
            <GraphRow
              key={vm.commit.hash}
              vm={vm}
              branchInfo={scene.branches}
              laneCount={3}
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
              onShowPerson={noop}
              onTakeTag={noop}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
let scene = makeScene(0);
let width = 540;
let key = 0;
let lateFont = false;

function render() {
  flushSync(() => root.render(<Graph key={key} scene={scene} width={width} lateFont={lateFont} />));
}

export const harness = {
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
