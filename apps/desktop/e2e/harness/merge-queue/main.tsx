import { createRoot, type Root } from "react-dom/client";
import { ok, type PrSummary } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { PrChip } from "../../../src/renderer/src/features/sidebar/PrChip";
import { PrStatusCard } from "../../../src/renderer/src/features/sidebar/PrStatusCard";

// All contrived: an invented repository, branches, numbers and times.
const NOW = Date.parse("2026-11-11T12:00:00Z");
const base = (number: number, title: string, extra: Partial<PrSummary>): PrSummary => ({
  number,
  url: `https://github.com/acme/lumen/pull/${number}`,
  title,
  state: "open",
  isDraft: false,
  checkState: "passing",
  checksStillRunning: false,
  mergeState: "mergeable",
  forge: "github",
  host: "github.com",
  repoPath: "acme/lumen",
  headRefName: `feat/${number}`,
  baseRefName: "main",
  headOid: "0123456789abcdef0123456789abcdef01234567",
  createdAt: NOW - 3 * 3600_000,
  ...extra
});

/** One row per queue state, each on a base branch that requires the queue. */
const rows: { label: string; pr: PrSummary }[] = [
  { label: "Ready to queue", pr: base(412, "Batch the tile cache writes", {
    mergeQueue: { required: true, blocked: false, method: "squash" } }) },
  { label: "Queued, #3", pr: base(408, "Add a retry budget to the uploader", {
    mergeQueue: { required: true, entry: { state: "queued", position: 3, etaSeconds: 1080 } } }) },
  { label: "Merge group checks running", pr: base(405, "Stream the export log", {
    mergeQueue: { required: true, entry: { state: "awaiting_checks", position: 1, etaSeconds: 420 } } }) },
  { label: "Removed from queue", pr: base(401, "Rename the region setting", {
    mergeQueue: { required: true, lastEvent: { kind: "removed", reason: "failed_checks", at: NOW - 600_000 } } }) },
  { label: "Merged by queue", pr: base(398, "Drop the legacy thumbnailer", {
    state: "merged", mergedAt: NOW - 1800_000,
    mergeQueue: { required: true, lastEvent: { kind: "removed", reason: "merged", at: NOW - 1800_000 } } }) }
];

const bridge = {
  profileId: "demo",
  platform: "darwin",
  dispatch: async () => ok(null),
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["platform"] = "darwin";

function Grid() {
  return (
    <div className="mq-harness" style={{ display: "grid", gridTemplateColumns: "repeat(5, 272px)", gap: 16, padding: 16, background: "var(--bg-app)", alignItems: "start" }}>
      {rows.map(({ label, pr }) => (
        <section key={pr.number} data-row={label} style={{ display: "grid", gap: 8 }}>
          <div style={{ color: "var(--text-muted)", font: '600 10px/1 "Geist Sans"', letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</div>
          <div><PrChip pr={pr} repoId="lumen" /></div>
          <div className="pr-status-card" style={{ position: "static" }}>
            <PrStatusCard pr={pr} repoId="lumen" now={NOW} />
          </div>
        </section>
      ))}
    </div>
  );
}

let root: Root | null = null;
const harness = {
  ready: (async () => {
    await Promise.all([
      '500 10.5px "Geist Sans"', '600 12px "Geist Sans"', '600 10px "Geist Sans"',
      '500 10.5px "Geist Mono"', '600 10px "Geist Mono"'
    ].map((font) => document.fonts.load(font)));
    await document.fonts.ready;
  })(),
  mount(theme: "dark" | "light"): void {
    document.documentElement.dataset["theme"] = theme;
    root?.unmount();
    root = createRoot(document.getElementById("root")!);
    root.render(<Grid />);
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
