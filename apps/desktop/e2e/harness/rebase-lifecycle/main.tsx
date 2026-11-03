import { useState } from "react";
import { createRoot } from "react-dom/client";
import { err, ok, type AgentJobStatus, type RebaseCommitRef } from "@pwrgit/shared";
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
let finishTidy: () => void = () => undefined;
let finishApply: () => void = () => undefined;
let selectTwo: () => void = () => undefined;
let clearCalls = 0;
const bridge = {
  profileId: "demo", platform: "darwin",
  dispatch: async (name: string, req: { commits?: RebaseCommitRef[]; op?: string }) => {
    switch (name) {
      case "agent:availability":
        return ok({ profileId: "demo", jobs: { commitMessage: job("commitMessage"), historyEditing: job("historyEditing") } });
      case "graph:log": return ok({ commits });
      case "rebase:draft": return ok({ op: req.op, valid: true,
        steps: [...(req.commits ?? [])].reverse().map((c) => ({ action: "pick", shortHash: c.hash.slice(0, 7), subject: c.subject })),
        summary: `→ ${req.commits?.length ?? 0} commits` });
      case "agent:tidyPlan": return new Promise((resolve) => {
        finishTidy = () => resolve(err({ kind: "agent", code: "cancelled", message: "Cancelled. Nothing changed." }));
      });
      case "agent:cancel": return ok({ cancelled: true });
      case "rebase:check": return ok({ status: "clean", approvalToken: "demo-approval", sourceHead: "demo-head", message: "ok",
        proof: { commitCount: 3, resultCount: 3, steps: 3, tree: "d".repeat(40), durationMs: 600 } });
      case "rebase:apply": return new Promise((resolve) => { finishApply = () => resolve(ok({})); });
      default: return ok(null);
    }
  },
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["theme"] = "light";
document.documentElement.dataset["platform"] = "darwin";

function Scenes() {
  const [selected, setSelected] = useState(commits.map((c) => c.hash));
  selectTwo = () => setSelected(commits.slice(0, 2).map((c) => c.hash));
  return <div className="harness-grid">
    <section className="harness-scene" data-scene="tidy">
      <div className="harness-label"><h2>After cancelling Tidy</h2><p>Cancel was clicked and the cancelled request finished.<br />The selection still contains three commits.</p></div>
      <RebaseTab worktreeId="demo-tidy" sourceHead="demo-head" op="tidy" selectedHashes={commits.map((c) => c.hash)} branch="feat/csv-export" onClear={() => undefined} />
    </section>
    <section className="harness-scene" data-scene="apply">
      <div className="harness-label"><h2>After changing selection during Apply</h2><p>Apply began for three commits. A new, unchecked<br />two-commit selection is now open. The old Apply finished.</p></div>
      <RebaseTab worktreeId="demo-apply" sourceHead="demo-head" op="reorder" selectedHashes={selected} branch="feat/csv-export" onClear={() => { clearCalls += 1; }} />
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
  ready, finishTidy: () => finishTidy(), finishApply: () => finishApply(), selectTwo: () => selectTwo(), clearCalls: () => clearCalls
};
