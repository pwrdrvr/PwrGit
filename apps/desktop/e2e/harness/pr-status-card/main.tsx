import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import {
  ok,
  type PrSummary,
  type StackPosition
} from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { PrChip } from "../../../src/renderer/src/features/sidebar/PrChip";
import { PrStatusCard } from "../../../src/renderer/src/features/sidebar/PrStatusCard";

// All contrived: invented repositories, branches, titles, numbers, and times.
export const HARNESS_NOW = Date.parse("2026-11-26T18:00:00Z");

export type CardScene = {
  id: string;
  label: string;
  pr: PrSummary;
  repoId?: string | undefined;
  stackPosition?: StackPosition | undefined;
  /** Optional narrow commit-meta preview showing the dot-only PR chip below. */
  dotPreviewWidth?: number | undefined;
  /** Optional explicit card max-width (simulating a narrow viewport). */
  cardWidth?: number | undefined;
};

export type CardMeasurement = {
  id: string;
  cardWidth: number;
  cardScrollWidth: number;
  cardClientWidth: number;
  hasNumberChip: boolean;
  numberChipText: string | null;
  numberChipTruncated: boolean;
  numberChipVisible: boolean;
  eyebrowLines: number;
  headerOverlap: boolean;
  headerClipped: boolean;
  repoClipped: boolean;
  titleClipped: boolean;
  branchClipped: boolean;
  headTruncated: boolean;
  baseTruncated: boolean;
  headWidth: number | null;
  baseWidth: number | null;
  arrowVisible: boolean;
  statusDotAligned: boolean;
  chipContrast: number;
  descendantOverflow: string[];
  overlappingPairs: string[];
};

const CLEAN_HEALTH = {
  inSync: true,
  needsRestack: false,
  parentMerged: false,
  needsPush: false,
  drift: false,
  remoteAhead: false
};

const STACK_SAMPLE: StackPosition = {
  index: 2,
  layer: {
    branch: "feat/popover-clamp-regression",
    parent: "feat/tooltip-geometry-foundation",
    pr: {
      number: 4524,
      url: "https://github.com/northstar/Beacon/pull/4524",
      title: "fix(desktop): re-clamp popover placement on same-height wraps",
      state: "merged",
      isDraft: false,
      forge: "github",
      repoPath: "northstar/Beacon"
    },
    health: CLEAN_HEALTH
  },
  stack: {
    id: "stack-1",
    source: "tracked",
    catalogRepository: "github.com/northstar/Beacon",
    trunk: { branch: "main", head: "1".repeat(40) },
    layers: [
      {
        branch: "feat/tooltip-geometry-foundation",
        parent: "main",
        pr: {
          number: 4520,
          url: "https://github.com/northstar/Beacon/pull/4520",
          title: "feat(desktop): isolate tooltip viewport measurements",
          state: "merged",
          isDraft: false
        },
        health: CLEAN_HEALTH
      },
      {
        branch: "feat/popover-clamp-regression",
        parent: "feat/tooltip-geometry-foundation",
        pr: {
          number: 4524,
          url: "https://github.com/northstar/Beacon/pull/4524",
          title: "fix(desktop): re-clamp popover placement on same-height wraps",
          state: "merged",
          isDraft: false
        },
        health: CLEAN_HEALTH
      },
      {
        branch: "feat/popover-number-chip",
        parent: "feat/popover-clamp-regression",
        pr: {
          number: 4529,
          url: "https://github.com/northstar/Beacon/pull/4529",
          title: "feat(desktop): show PR number chip in status popover",
          state: "open",
          isDraft: false,
          checkState: "passing"
        },
        health: { ...CLEAN_HEALTH, inSync: false, parentMerged: true }
      }
    ]
  }
};

export const SHOWCASE_SCENES: CardScene[] = [
  {
    id: "lineage-dot-merged",
    label: "Dot-only commit row · Merged PR",
    dotPreviewWidth: 260,
    pr: {
      number: 4524,
      url: "https://github.com/northstar/Beacon/pull/4524",
      title: "fix(desktop): re-clamp popover placement on same-height wraps",
      state: "merged",
      isDraft: false,
      forge: "github",
      repoPath: "northstar/Beacon",
      headRefName: "fix/popover-clamp-regression-checks",
      baseRefName: "main",
      additions: 300,
      deletions: 21,
      changedFiles: 3,
      commitCount: 2,
      createdAt: HARNESS_NOW - 34 * 60_000,
      mergedAt: HARNESS_NOW - 12 * 60_000
    }
  },
  {
    id: "gitlab-nested-path",
    label: "GitLab nested group · Passing MR",
    pr: {
      number: 874,
      url: "https://gitlab.example.test/northstar/platform/services/billing-gateway/-/merge_requests/874",
      title: "feat(billing): stream ledger reconciliation checkpoints",
      state: "open",
      isDraft: false,
      checkState: "passing",
      forge: "gitlab",
      repoPath: "northstar/platform/services/billing-gateway",
      headRefName: "feat/ledger-reconciliation-stream",
      baseRefName: "main",
      additions: 842,
      deletions: 119,
      changedFiles: 14,
      commitCount: 5,
      createdAt: HARNESS_NOW - 4 * 3600_000
    }
  },
  {
    id: "stress-long-fields",
    label: "7-digit PR · Long repo, title & base",
    pr: {
      number: 1234567,
      url: "https://github.com/northstar/monorepo-platform-core-services-engine/pull/1234567",
      title: "fix(storage): prevent_unbroken_token_https://example.test/very/long/path/overflow_in_card_layout",
      state: "open",
      isDraft: true,
      checkState: "failing",
      checksStillRunning: true,
      mergeState: "conflicting",
      forge: "github",
      repoPath: "northstar/monorepo-platform-core-services-engine",
      headRefName: "feat/add-incremental-index-compaction-pass-v2",
      baseRefName: "feat/refactor-storage-engine-v2-checkpointing",
      additions: 14820,
      deletions: 9312,
      changedFiles: 184,
      commitCount: 27,
      createdAt: HARNESS_NOW - 3 * 86_400_000
    }
  },
  {
    id: "minimal-and-stack",
    label: "Stacked PR · No repo path",
    stackPosition: STACK_SAMPLE,
    pr: {
      number: 4524,
      url: "https://github.com/northstar/Beacon/pull/4524",
      title: "fix(desktop): re-clamp popover placement on same-height wraps",
      state: "open",
      isDraft: false,
      checkState: "passing",
      mergeState: "mergeable",
      forge: "github",
      headRefName: "feat/popover-clamp-regression",
      baseRefName: "feat/tooltip-geometry-foundation",
      mergeQueue: { required: true, blocked: false, method: "squash" }
    },
    repoId: "beacon"
  }
];

const bridge = {
  profileId: "demo",
  platform: "darwin",
  dispatch: async () => ok(null),
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["platform"] = "darwin";

function SceneCard({ scene }: { scene: CardScene }) {
  return (
    <section
      data-scene={scene.id}
      style={{ display: "grid", gap: 8, alignContent: "start" }}
    >
      <div
        style={{
          color: "var(--text-muted)",
          font: '600 10px/1.2 "Geist Sans"',
          letterSpacing: "0.06em",
          textTransform: "uppercase"
        }}
      >
        {scene.label}
      </div>
      <div
        className="pr-status-card"
        style={{
          position: "static",
          ...(scene.cardWidth !== undefined
            ? { width: `${scene.cardWidth}px`, maxWidth: `${scene.cardWidth}px` }
            : {})
        }}
      >
        <PrStatusCard
          pr={scene.pr}
          repoId={scene.repoId}
          stackPosition={scene.stackPosition}
          now={HARNESS_NOW}
        />
      </div>
      {scene.dotPreviewWidth !== undefined ? (
        <div
          style={{
            width: `${scene.dotPreviewWidth}px`,
            padding: "6px 8px",
            border: "1px solid var(--border-subtle)",
            borderRadius: "var(--radius-md)",
            background: "var(--bg-panel)"
          }}
        >
          <div className="commit-meta" style={{ containerType: "inline-size", containerName: "lineage-meta" }}>
            <PrChip pr={scene.pr} stackTag={false} />
            <span className="commit-tag">fix/popover-clamp...</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Grid({ scenes }: { scenes: CardScene[] }) {
  return (
    <div
      className="pr-card-harness"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${Math.min(scenes.length, 4)}, max-content)`,
        gap: 18,
        padding: 18,
        background: "var(--bg-app)",
        alignItems: "start"
      }}
    >
      {scenes.map((scene) => (
        <SceneCard key={scene.id} scene={scene} />
      ))}
    </div>
  );
}

function rectsOverlap(a: DOMRect, b: DOMRect, epsilon = 0.5): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return (
    a.left < b.right - epsilon &&
    a.right > b.left + epsilon &&
    a.top < b.bottom - epsilon &&
    a.bottom > b.top + epsilon
  );
}

function measureCardElement(id: string, card: HTMLElement): CardMeasurement {
  const cardRect = card.getBoundingClientRect();
  const cardStyle = getComputedStyle(card);
  const padLeft = parseFloat(cardStyle.paddingLeft) || 0;
  const padRight = parseFloat(cardStyle.paddingRight) || 0;
  const borderLeft = parseFloat(cardStyle.borderLeftWidth) || 0;
  const borderRight = parseFloat(cardStyle.borderRightWidth) || 0;
  const contentLeft = cardRect.left + borderLeft + padLeft;
  const contentRight = cardRect.right - borderRight - padRight;

  const eyebrow = card.querySelector<HTMLElement>(".pr-status-card__eyebrow");
  const chip = card.querySelector<HTMLElement>(".pr-status-card__number-chip");
  const chipText = card.querySelector<HTMLElement>(".pr-status-card__number-text");
  const repo = card.querySelector<HTMLElement>(".pr-status-card__repo");
  const title = card.querySelector<HTMLElement>(".pr-status-card__title");
  const branch = card.querySelector<HTMLElement>(".pr-status-card__branch");
  const head = card.querySelector<HTMLElement>(".pr-status-card__branch-name");
  const arrow = card.querySelector<HTMLElement>(".pr-status-card__branch-arrow");
  const base = card.querySelector<HTMLElement>(".pr-status-card__branch-base");
  const statusRow = card.querySelector<HTMLElement>(".pr-status-card__status");
  const statusDot = statusRow?.querySelector<HTMLElement>(".pr-status-card__dot") ?? null;
  const statusLabel = statusRow?.querySelector<HTMLElement>(".pr-status-card__status-label") ?? null;

  const eyebrowRect = eyebrow?.getBoundingClientRect();
  const chipRect = chip?.getBoundingClientRect();
  const eyebrowLineHeight = eyebrow ? parseFloat(getComputedStyle(eyebrow).lineHeight) || 10 : 10;
  const eyebrowLines = eyebrowRect ? Math.max(1, Math.round(eyebrowRect.height / eyebrowLineHeight)) : 0;

  const headerOverlap =
    eyebrowRect !== undefined && chipRect !== undefined && rectsOverlap(eyebrowRect, chipRect);

  const header = card.querySelector<HTMLElement>(".pr-status-card__header");
  const headerClipped = header ? header.scrollWidth > header.clientWidth + 0.5 : false;
  const repoClipped = repo ? repo.getBoundingClientRect().right > contentRight + 1 : false;
  const titleClipped = title
    ? title.scrollWidth > title.clientWidth + 0.5 || title.getBoundingClientRect().right > contentRight + 1
    : false;
  const branchClipped = branch
    ? branch.scrollWidth > branch.clientWidth + 0.5 || branch.getBoundingClientRect().right > contentRight + 1
    : false;

  const descendantOverflow: string[] = [];
  for (const el of card.querySelectorAll<HTMLElement>("*")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > contentRight + 1.5 || r.left < contentLeft - 1.5) {
      descendantOverflow.push(
        `${el.className || el.tagName} (${Math.round(r.left)}..${Math.round(r.right)} vs ${Math.round(contentLeft)}..${Math.round(contentRight)})`
      );
    }
    const style = getComputedStyle(el);
    if (
      style.overflowX === "visible" &&
      el.scrollWidth > el.clientWidth + 1.5 &&
      el.clientWidth > 0
    ) {
      descendantOverflow.push(
        `overflow-x:${el.className || el.tagName} (scroll=${el.scrollWidth} > client=${el.clientWidth})`
      );
    }
  }

  const overlappingPairs: string[] = [];
  const siblingChecks: [string, HTMLElement | null, string, HTMLElement | null][] = [
    ["eyebrow", eyebrow, "chip", chip],
    ["header", header, "repo", repo],
    ["header", header, "title", title],
    ["repo", repo, "title", title],
    ["head", head, "arrow", arrow],
    ["arrow", arrow, "base", base],
    ["head", head, "base", base],
    ["statusDot", statusDot, "statusLabel", statusLabel]
  ];
  for (const [aName, aEl, bName, bEl] of siblingChecks) {
    if (aEl && bEl && rectsOverlap(aEl.getBoundingClientRect(), bEl.getBoundingClientRect())) {
      overlappingPairs.push(`${aName}↔${bName}`);
    }
  }
  const rowContainers = card.querySelectorAll<HTMLElement>(
    ".pr-status-card__header, .pr-status-card__diff, .pr-status-card__row, .pr-status-card__queue, .stack-card-section__title, .stack-card-section__list li"
  );
  for (const row of rowContainers) {
    const kids = [...row.children].filter((el): el is HTMLElement => el instanceof HTMLElement);
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i]!;
        const b = kids[j]!;
        if (rectsOverlap(a.getBoundingClientRect(), b.getBoundingClientRect())) {
          overlappingPairs.push(
            `${a.className || a.tagName}↔${b.className || b.tagName}`
          );
        }
      }
    }
  }

  const statusDotAligned = (() => {
    if (!statusDot || !statusLabel) return true;
    const dotR = statusDot.getBoundingClientRect();
    const labelR = statusLabel.getBoundingClientRect();
    const firstLineH = parseFloat(getComputedStyle(statusLabel).lineHeight) || 14;
    const dotCenter = dotR.top + dotR.height / 2;
    const firstLineCenter = labelR.top + firstLineH / 2;
    return Math.abs(dotCenter - firstLineCenter) <= 2.5;
  })();

  const parseRgb = (css: string): [number, number, number] | null => {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(css);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const relLum = ([r, g, b]: [number, number, number]): number => {
    const toLin = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
  };
  const chipContrast = (() => {
    if (!chip) return 0;
    const style = getComputedStyle(chip);
    const fg = parseRgb(style.color);
    const bg = parseRgb(style.backgroundColor);
    if (!fg || !bg) return 0;
    const l1 = relLum(fg);
    const l2 = relLum(bg);
    return Math.round(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)) * 100) / 100;
  })();

  const numberChipVisible =
    chipRect !== undefined &&
    chipRect.width > 0 &&
    chipRect.height > 0 &&
    chipRect.left >= contentLeft - 1 &&
    chipRect.right <= contentRight + 1;

  const numberChipTruncated = chipText
    ? chipText.scrollWidth > chipText.clientWidth + 0.5
    : chip
      ? chip.scrollWidth > chip.clientWidth + 0.5
      : false;

  return {
    id,
    cardWidth: Math.round(cardRect.width * 10) / 10,
    cardScrollWidth: card.scrollWidth,
    cardClientWidth: card.clientWidth,
    hasNumberChip: chip !== null,
    numberChipText: chipText?.textContent ?? chip?.textContent ?? null,
    numberChipTruncated,
    numberChipVisible,
    eyebrowLines,
    headerOverlap,
    headerClipped,
    repoClipped,
    titleClipped,
    branchClipped,
    headTruncated: head ? head.scrollWidth > head.clientWidth + 0.5 : false,
    baseTruncated: base ? base.scrollWidth > base.clientWidth + 0.5 : false,
    headWidth: head ? Math.round(head.getBoundingClientRect().width * 10) / 10 : null,
    baseWidth: base ? Math.round(base.getBoundingClientRect().width * 10) / 10 : null,
    arrowVisible: arrow ? arrow.getBoundingClientRect().width > 0 : true,
    statusDotAligned,
    chipContrast,
    descendantOverflow,
    overlappingPairs
  };
}

let root: Root | null = null;
function remount(node: ReturnType<typeof Grid>, theme: "dark" | "light"): void {
  if (theme === "light") document.documentElement.dataset["theme"] = "light";
  else delete document.documentElement.dataset["theme"];
  if (root !== null) {
    flushSync(() => root!.unmount());
  }
  root = createRoot(document.getElementById("root")!);
  flushSync(() => root!.render(node));
}

const harness = {
  ready: (async () => {
    await Promise.all(
      [
        '500 10.5px "Geist Sans"',
        '600 12px "Geist Sans"',
        '600 10px "Geist Sans"',
        '500 10.5px "Geist Mono"',
        '600 10.5px "Geist Mono"'
      ].map((font) => document.fonts.load(font))
    );
    await document.fonts.ready;
  })(),
  mountShowcase(theme: "dark" | "light"): void {
    remount(<Grid scenes={SHOWCASE_SCENES} />, theme);
  },
  mountCases(theme: "dark" | "light", scenes: CardScene[]): CardMeasurement[] {
    remount(<Grid scenes={scenes} />, theme);
    return scenes.map((scene) => {
      const card = document.querySelector<HTMLElement>(
        `[data-scene="${CSS.escape(scene.id)}"] .pr-status-card`
      );
      if (!card) throw new Error(`missing card for scene ${scene.id}`);
      return measureCardElement(scene.id, card);
    });
  },
  measureShowcase(): CardMeasurement[] {
    return SHOWCASE_SCENES.map((scene) => {
      const card = document.querySelector<HTMLElement>(
        `[data-scene="${CSS.escape(scene.id)}"] .pr-status-card`
      );
      if (!card) throw new Error(`missing card for scene ${scene.id}`);
      return measureCardElement(scene.id, card);
    });
  }
};

(window as unknown as { __harness: typeof harness }).__harness = harness;
