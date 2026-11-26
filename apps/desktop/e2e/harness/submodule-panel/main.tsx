import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ok, type SubmoduleSnapshot, type Worktree } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { ChangesTab } from "../../../src/renderer/src/features/rail/ChangesTab";

const SHARED_REMEDY =
  "Restore a matching .gitmodules entry with a reviewed URL before initializing, or remove the gitlink if it was added accidentally.";

const PASSIVE_SNAPSHOT: SubmoduleSnapshot = {
  truncated: false,
  issues: [],
  submodules: [
    {
      name: ".vendor/acme-toolkit/submodules/codec",
      path: ".vendor/acme-toolkit/submodules/codec",
      depth: 0,
      pinnedCommit: "e02e9d405b8848909f4f746b61b12a663f631c7c",
      indexCommit: "e02e9d405b8848909f4f746b61b12a663f631c7c",
      checkoutState: "uninitialized",
      relation: "unknown",
      dirty: null,
      detached: null,
      pinnedTags: [],
      issues: [
        {
          code: "gitmodules_entry_missing",
          severity: "error",
          message:
            "The parent records a gitlink here, but .gitmodules has no matching path.",
          remedy: SHARED_REMEDY
        },
        {
          code: "checkout_uninitialized",
          severity: "warning",
          message: "This submodule has not been initialized.",
          remedy: SHARED_REMEDY
        }
      ]
    },
    {
      name: ".vendor/acme-toolkit/submodules/runner",
      path: ".vendor/acme-toolkit/submodules/runner",
      depth: 0,
      pinnedCommit: "493909133db04153348eabc503f4e30cf0033d96",
      indexCommit: "493909133db04153348eabc503f4e30cf0033d96",
      checkoutState: "uninitialized",
      relation: "unknown",
      dirty: null,
      detached: null,
      pinnedTags: [],
      issues: [
        {
          code: "gitmodules_entry_missing",
          severity: "error",
          message:
            "The parent records a gitlink here, but .gitmodules has no matching path.",
          remedy: SHARED_REMEDY
        },
        {
          code: "checkout_uninitialized",
          severity: "warning",
          message: "This submodule has not been initialized.",
          remedy: SHARED_REMEDY
        }
      ]
    }
  ]
};

const ACTIVE_SNAPSHOT: SubmoduleSnapshot = {
  truncated: false,
  issues: [],
  submodules: [
    {
      name: "core",
      path: "modules/core",
      depth: 0,
      pinnedCommit: "1111111111111111111111111111111111111111",
      indexCommit: "1111111111111111111111111111111111111111",
      checkedOutCommit: "3333333333333333333333333333333333333333",
      checkoutState: "checked_out",
      relation: "ahead_of_pin",
      dirty: true,
      detached: true,
      pinnedTags: ["v2.1.0"],
      configuredBranch: "main",
      configuredUrl: "https://example.test/acme/core.git",
      initializedUrl: "https://example.test/acme/core.git",
      issues: []
    },
    {
      name: "protocol-buffers-schema",
      path: "protocol-buffers-schema",
      depth: 0,
      pinnedCommit: "4444444444444444444444444444444444444444",
      indexCommit: "4444444444444444444444444444444444444444",
      checkoutState: "deinitialized",
      relation: "unknown",
      dirty: null,
      detached: null,
      pinnedTags: [],
      configuredUrl: "https://example.test/acme/protocol-buffers-schema.git",
      issues: [
        {
          code: "checkout_deinitialized",
          severity: "warning",
          message:
            "This submodule was deinitialized; its Git data is still retained locally.",
          remedy:
            "Reinitialize it from the parent after reviewing the configured URL."
        }
      ]
    }
  ]
};

const bridge = {
  profileId: null as string | null,
  platform: "darwin",
  appearance: { theme: "light", resolvedTheme: "light" },
  dispatch: async (name: string, req: unknown): Promise<unknown> => {
    const worktreeId = (req as { worktreeId?: string } | null)?.worktreeId;
    if (name === "changes:list") {
      return ok({ staged: [], unstaged: [] });
    }
    if (name === "changes:ignoredSummary") {
      return ok({ count: 0, worktreeCount: 1, rules: [] });
    }
    if (name === "submodules:list") {
      return ok(worktreeId === "wt-active" ? ACTIVE_SNAPSHOT : PASSIVE_SNAPSHOT);
    }
    return ok(null);
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

const noop = (): void => undefined;

function RailScene({
  id,
  title,
  worktreeId
}: {
  id: string;
  title: string;
  worktreeId: string;
}) {
  return (
    <div data-scene={id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          font: "600 11px/1.3 var(--font-sans)",
          color: "var(--text-secondary)"
        }}
      >
        {title}
      </div>
      <aside
        className="pane pane--rail"
        style={{
          width: 312,
          height: 590,
          border: "1px solid var(--border-default)",
          borderRadius: 10,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column"
        }}
      >
        <div className="rail__bar">
          <button type="button" className="rail-tab is-active">
            <span className="rail-tab__label">Changes</span>
          </button>
          <button type="button" className="rail-tab">
            <span className="rail-tab__label">Stashes</span>
          </button>
          <button type="button" className="rail-tab">
            <span className="rail-tab__label">Rebase</span>
          </button>
        </div>
        <ChangesTab
          worktree={{ id: worktreeId, head: "abcdef12" } as Worktree}
          activeEmail="dev@example.test"
          onOpenDiff={noop}
          onOpenFileInsight={noop}
          activeFile={null}
        />
      </aside>
    </div>
  );
}

void Promise.all([
  '400 13px "Geist Sans"',
  '500 12px "Geist Sans"',
  '600 13px "Geist Sans"',
  '700 15px "Geist Sans"',
  '400 11px "Geist Mono"',
  '500 11px "Geist Mono"',
  '600 11px "Geist Mono"'
].map((font) => document.fonts.load(font)))
  .then(() => document.fonts.ready)
  .then(() => {
    createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <div
        style={{
          display: "flex",
          gap: 18,
          padding: 20,
          background: "var(--bg-canvas)",
          minHeight: "100vh",
          boxSizing: "border-box"
        }}
      >
        <RailScene
          id="passive-default"
          title="Clean worktree · 2 unconfigured gitlinks (default)"
          worktreeId="wt-passive"
        />
        <RailScene
          id="passive-expanded"
          title="Clean worktree · Submodules expanded on demand"
          worktreeId="wt-passive-open"
        />
        <RailScene
          id="active-change"
          title="Clean parent · 1 dirty submodule ahead of pin"
          worktreeId="wt-active"
        />
      </div>
    </StrictMode>
  );
  });
