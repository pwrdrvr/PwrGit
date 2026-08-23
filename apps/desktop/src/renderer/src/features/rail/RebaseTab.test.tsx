import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SelectionBar } from "../graph/SelectionBar";
import { AgentProposalPanel, RebaseTab } from "./RebaseTab";

describe("rebase tool copy", () => {
  it("keeps the deterministic safe path explicit before any agent is requested", () => {
    const panel = renderToStaticMarkup(
      <RebaseTab
        worktreeId={null}
        sourceHead={null}
        selectedHashes={[]}
        op={null}
        onClear={() => undefined}
      />
    );
    const selection = renderToStaticMarkup(
      <SelectionBar
        count={2}
        onSquash={() => undefined}
        onReorder={() => undefined}
        onOpenRebaseTool={() => undefined}
        onClear={() => undefined}
      />
    );
    const copy = `${panel} ${selection}`;

    expect(copy).toContain("Rebase tool");
    expect(copy).toContain("Isolated check · hooks and signing disabled");
    expect(copy).toContain("Open rebase tool");
    expect(copy).toContain("inspect the exact plan");
  });

  it("leaves isolated check and apply usable when no safe agent is available", () => {
    const panel = renderToStaticMarkup(
      <AgentProposalPanel
        availability={{
          kind: "resolved",
          value: {
            profileId: "personal",
            status: "unavailable",
            selectedProviderId: null,
            message:
              "No safe local agent is available. PwrGit's deterministic plan, isolated check, and local apply remain available.",
            providers: [
              {
                id: "acp:gemini",
                kind: "acp",
                displayName: "Gemini",
                status: "unsupported",
                detail: "ACP cannot enforce the no-tools boundary."
              }
            ]
          }
        }}
        proposal={{ kind: "idle" }}
        onRequest={() => undefined}
        onCancel={() => undefined}
      />
    );

    expect(panel).toContain("No safe agent");
    expect(panel).toContain("deterministic plan");
    expect(panel).toContain("Gemini detected");
    expect(panel).not.toContain("Ask Codex to review");
  });

  it("does not claim discovery has started while availability is idle", () => {
    const panel = renderToStaticMarkup(
      <AgentProposalPanel
        availability={{ kind: "idle" }}
        proposal={{ kind: "idle" }}
        onRequest={() => undefined}
        onCancel={() => undefined}
      />
    );

    expect(panel).toBe("");
    expect(panel).not.toContain("Discovering");
  });

  it("labels structured agent output as proposal-only and retains explicit approval", () => {
    const panel = renderToStaticMarkup(
      <AgentProposalPanel
        availability={{
          kind: "resolved",
          value: {
            profileId: "personal",
            status: "ready",
            selectedProviderId: "codex",
            message: "Codex is ready.",
            providers: [
              {
                id: "codex",
                kind: "codex",
                displayName: "Codex",
                status: "ready",
                detail: "Ready.",
                version: "0.146.0"
              }
            ]
          }
        }}
        proposal={{
          kind: "complete",
          value: {
            requestId: "proposal-1",
            providerId: "codex",
            providerName: "Codex",
            operation: "squash",
            plan: {
              op: "squash",
              valid: true,
              summary: "one commit",
              steps: []
            },
            title: "Focused history",
            summary: "Combine the related work.",
            rationale: ["Both commits describe one change."],
            risks: ["Review the combined message."],
            confidence: "high",
            verdict: "proceed",
            generatedAt: "2026-08-23T12:00:00.000Z"
          }
        }}
        onRequest={() => undefined}
        onCancel={() => undefined}
      />
    );

    expect(panel).toContain("Codex proposes");
    expect(panel).toContain("Proposal only");
    expect(panel).toContain("Codex cannot run Git");
    expect(panel).toContain("explicit Apply click");
  });
});
