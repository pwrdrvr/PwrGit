import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ok } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { DiffViewer } from "../../../src/renderer/src/features/diff/DiffViewer";

/**
 * The real `DiffViewer` and stylesheet inside each scroll container that
 * hosts it in the app: the change request view's body, the diff pane's body,
 * and the file-history pane's body around a commit's diff. Every one of them
 * pads its top, and Chromium pins a `top`-sticky element to the scroll
 * container's PADDING edge, not its scrollport edge — so a head that says
 * `top: 0` stuck that many pixels down, with rows scrolling past above it.
 * `sticky-heads.spec.ts` drives it through `window.__harness`.
 */

const bridge = {
  profileId: "profile-harness",
  platform: "darwin",
  appearance: { theme: "light", resolvedTheme: "light" },
  dispatch: async (): Promise<unknown> => ok(null),
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

/** An added file of `lines` lines: a single tall hunk to scroll through. */
function addedFile(path: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+  step_${i + 1}: run the widget task ${i + 1}`);
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines} @@`,
    ...body
  ].join("\n");
}

/** A modified file with two hunks, so one hunk sits mid-file below its head. */
function modifiedFile(path: string, lines: number): string {
  const hunk = (start: number): string[] => [
    `@@ -${start},${lines} +${start},${lines} @@`,
    ...Array.from({ length: lines }, (_, i) =>
      i === 3 ? `+  tuned_${start + i}: true` : `   setting_${start + i}: true`
    )
  ];
  return [
    `diff --git a/${path} b/${path}`,
    "index 2222222..3333333 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunk(10),
    ...hunk(200)
  ].join("\n");
}

const PATCH = [
  addedFile(".ci/workflows/widget-share.yml", 60),
  // Short hunks: `block: "nearest"` aligns a hunk TALLER than the pane by
  // its bottom edge, so only one that fits shows the top-edge case.
  modifiedFile("tools/widget-share/Cargo.toml", 8),
  addedFile("tools/widget-share/README.md", 60)
].join("\n") + "\n";

/** Each host exactly as the app nests it, by class name. */
const HOSTS: { id: string; label: string; wrap: (diff: ReactNode) => ReactNode }[] = [
  {
    id: "cr-view",
    label: ".cr-view__body",
    wrap: (diff) => <div className="cr-view__body harness-host">{diff}</div>
  },
  {
    id: "diff-pane",
    label: ".diff-pane__body",
    wrap: (diff) => <div className="diff-pane__body harness-host">{diff}</div>
  },
  {
    id: "file-insight",
    label: ".file-insight-pane__body › .file-insight-diff",
    wrap: (diff) => (
      <div className="file-insight-pane__body harness-host">
        <div className="file-insight-diff">
          <div className="file-insight-diff__head">
            <span className="file-insight-diff__subject">Add the widget share workflow</span>
          </div>
          <div className="file-insight-diff__body">{diff}</div>
        </div>
      </div>
    )
  }
];

function App() {
  return (
    <div className="harness-grid">
      {HOSTS.map((host) => (
        <div key={host.id} className="harness-scene" data-host={host.id}>
          <div className="harness-caption">{host.label}</div>
          {host.wrap(<DiffViewer patch={PATCH} />)}
        </div>
      ))}
    </div>
  );
}

export type StickyReport = {
  host: string;
  /** Sticky elements found inside the host. */
  stickies: number;
  /**
   * For each sticky element, scrolled well into its own block: how far its
   * top edge sits below the host's scrollport top (inside the border). Rows
   * of the host show through any gap, so it must be 0.
   */
  stuckGaps: { what: string; gap: number }[];
  /** At rest (scrollTop 0), how far each head sits from the top of its own
   *  file block's content box. A head that isn't stuck must not move: 0. */
  restShifts: { what: string; shift: number }[];
  /** The host's own top padding, which is what opens the gap. */
  paddingTop: number;
  /**
   * A mid-file hunk scrolled into view from below with `block: "nearest"`, as
   * the diff pane's j/k do: its top minus the bottom of its file's stuck head.
   * Negative means rows hid under the head.
   */
  hunkClearance: number;
};

const frame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function scrollHost(host: HTMLElement): HTMLElement {
  const scroller = host.querySelector<HTMLElement>(".harness-host");
  if (scroller === null) throw new Error("no scroller");
  return scroller;
}

/** Scrolls each host and measures every sticky element in it. */
async function report(): Promise<StickyReport[]> {
  const out: StickyReport[] = [];
  for (const scene of document.querySelectorAll<HTMLElement>(".harness-scene")) {
    const scroller = scrollHost(scene);
    const stickies = [...scroller.querySelectorAll<HTMLElement>("*")].filter(
      (el) => getComputedStyle(el).position === "sticky"
    );
    const portTop = (): number => scroller.getBoundingClientRect().top + scroller.clientTop;

    scroller.scrollTop = 0;
    await frame();
    const restShifts = stickies.map((sticky) => {
      const block = sticky.parentElement!;
      const contentTop = block.getBoundingClientRect().top + block.clientTop;
      return {
        what: `${sticky.className} @ ${block.getAttribute("data-path") ?? "?"}`,
        shift: Math.round((sticky.getBoundingClientRect().top - contentTop) * 100) / 100
      };
    });

    const stuckGaps: StickyReport["stuckGaps"] = [];
    for (const sticky of stickies) {
      const block = sticky.parentElement!;
      // Halfway into the sticky's own block, so it is stuck and not yet
      // pushed out by the next one.
      scroller.scrollTop = 0;
      await frame();
      const blockTop = block.getBoundingClientRect().top - portTop();
      scroller.scrollTop = blockTop + block.offsetHeight / 2;
      await frame();
      stuckGaps.push({
        what: `${sticky.className} @ ${block.getAttribute("data-path") ?? "?"}`,
        gap: Math.round((sticky.getBoundingClientRect().top - portTop()) * 100) / 100
      });
    }
    // The second hunk of the two-hunk file, reached from further down.
    const hunk = scroller.querySelectorAll<HTMLElement>(".diff-file")[1]?.querySelectorAll<HTMLElement>(
      ".diff-hunk"
    )[1];
    let hunkClearance = NaN;
    if (hunk !== undefined) {
      scroller.scrollTop = scroller.scrollHeight;
      await frame();
      hunk.scrollIntoView({ block: "nearest" });
      await frame();
      const head = hunk.closest(".diff-file")!.querySelector<HTMLElement>(".diff-file__head")!;
      hunkClearance =
        Math.round((hunk.getBoundingClientRect().top - head.getBoundingClientRect().bottom) * 100) / 100;
    }
    out.push({
      host: scene.dataset["host"] ?? "?",
      stickies: stickies.length,
      stuckGaps,
      restShifts,
      paddingTop: parseFloat(getComputedStyle(scroller).paddingTop),
      hunkClearance
    });
  }
  return out;
}

/** Leaves every host scrolled into its second file, for the screenshot. */
async function park(): Promise<void> {
  for (const scene of document.querySelectorAll<HTMLElement>(".harness-scene")) {
    const scroller = scrollHost(scene);
    const second = scroller.querySelectorAll<HTMLElement>(".diff-file")[1];
    if (second === undefined) continue;
    scroller.scrollTop = 0;
    await frame();
    scroller.scrollTop =
      second.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 90;
  }
  await frame();
}

const harness = {
  ready: (async () => {
    await Promise.all(
      ['400 12px "Geist Mono"', '600 12px "Geist Mono"', '600 9px "Geist Sans"', '600 12px "Geist Sans"'].map(
        (font) => document.fonts.load(font)
      )
    );
    await document.fonts.ready;
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
    await frame();
  })(),
  report,
  park
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
