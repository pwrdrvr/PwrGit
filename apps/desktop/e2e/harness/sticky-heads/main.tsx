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

const PATCH = [
  addedFile(".ci/workflows/widget-share.yml", 60),
  addedFile("tools/widget-share/Cargo.toml", 60),
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
  /** At rest (scrollTop 0), the first head's distance below the scrollport
   *  top: the fix must not move anything that isn't stuck. */
  restOffset: number;
  /** The host's own top padding, for the rest check. */
  paddingTop: number;
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
    const first = stickies[0];
    const restOffset = first === undefined ? NaN : first.getBoundingClientRect().top - portTop();

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
    out.push({
      host: scene.dataset["host"] ?? "?",
      stickies: stickies.length,
      stuckGaps,
      restOffset: Math.round(restOffset * 100) / 100,
      paddingTop: parseFloat(getComputedStyle(scroller).paddingTop)
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
