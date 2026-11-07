import { createRoot } from "react-dom/client";
import { ok, type AgentJobStatus, type AgentMessageDraft, type RebaseCommitRef } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { RebaseTab } from "../../../src/renderer/src/features/rail/RebaseTab";

const commits: RebaseCommitRef[] = [
  { hash: "c".repeat(40), subject: "fix(export): handle empty rows" },
  { hash: "b".repeat(40), subject: "test(export): cover quoting" },
  { hash: "a".repeat(40), subject: "feat(export): add CSV exporter" }
];
const job = (jobId: AgentJobStatus["jobId"]): AgentJobStatus => ({
  jobId, state: "ready", message: "", providerName: "Codex", model: null, modelLabel: null, effort: null
});
const draft = (requestId: string): AgentMessageDraft => ({
  requestId, providerId: "codex", providerName: "Codex", model: "gpt-5.5",
  saw: {
    source: "commits", commitCount: 3,
    files: [{ path: "src/export.ts", added: 12, removed: 3, treatment: "sent", sentLines: 30, totalLines: 30 }],
    budget: { used: 30, limit: 2000 }, styleSubjects: 20
  },
  style: { convention: "conventional", matched: 18, sampled: 20 },
  generatedAt: "2026-09-19T12:00:00.000Z",
  subject: "feat(export): ship CSV export with quoting",
  body: "Adds the exporter, quotes embedded commas and handles empty rows."
});

/** Each scene's draft request, answered only when the spec says so. */
const answers = new Map<string, () => void>();
let drafts = 0;
let cancels = 0;
const bridge = {
  profileId: "demo", platform: "darwin",
  dispatch: async (name: string, req: { commits?: RebaseCommitRef[]; op?: string; requestId?: string; worktreeId?: string }) => {
    switch (name) {
      case "agent:availability":
        return ok({ profileId: "demo", jobs: { commitMessage: job("commitMessage"), historyEditing: job("historyEditing") } });
      case "graph:log": return ok({ commits });
      case "rebase:draft": return ok({ op: req.op, valid: true,
        steps: [...(req.commits ?? [])].reverse().map((c) => ({ action: "pick", shortHash: c.hash.slice(0, 7), subject: c.subject })),
        summary: `→ 1 commit` });
      case "agent:draftMessage":
        drafts += 1;
        // Main had already produced this draft when Cancel arrived, so it
        // answers with the draft, not `cancelled`.
        return new Promise((resolve) => answers.set(req.worktreeId ?? "", () => resolve(ok(draft(req.requestId ?? "")))));
      case "agent:cancel":
        cancels += 1;
        return ok({ cancelled: true });
      default: return ok(null);
    }
  },
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["theme"] = "light";
document.documentElement.dataset["platform"] = "darwin";

function Scenes() {
  const hashes = commits.map((c) => c.hash);
  return <div className="harness-grid">
    <section className="harness-scene" data-scene="cancelled">
      <div className="harness-label"><h2>Cancel while Codex is drafting</h2><p>Squash asked Codex for a message, and Cancel was clicked.<br />Main has not answered yet.</p></div>
      <RebaseTab worktreeId="demo-cancelled" sourceHead="demo-head" op="squash" selectedHashes={hashes} branch="feat/csv-export" onClear={() => undefined} />
    </section>
    <section className="harness-scene" data-scene="late">
      <div className="harness-label"><h2>A draft that lands after Cancel</h2><p>Cancel was clicked, then the draft main had already<br />finished arrived.</p></div>
      <RebaseTab worktreeId="demo-late" sourceHead="demo-head" op="squash" selectedHashes={hashes} branch="feat/csv-export" onClear={() => undefined} />
    </section>
  </div>;
}

const ready = (async () => {
  await Promise.all([
    '400 13px "Geist Sans"', '500 12px "Geist Sans"', '600 13px "Geist Sans"', '700 15px "Geist Sans"',
    '400 11px "Geist Mono"', '500 11px "Geist Mono"', '600 11px "Geist Mono"'
  ].map((font) => document.fonts.load(font)));
  await document.fonts.ready;
  createRoot(document.getElementById("root")!).render(<Scenes />);
})();
(window as unknown as { __harness: unknown }).__harness = {
  ready,
  answer: (scene: string) => answers.get(scene)?.(),
  drafts: () => drafts,
  cancels: () => cancels
};
