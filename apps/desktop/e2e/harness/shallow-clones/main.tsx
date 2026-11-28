import { createRoot, type Root } from "react-dom/client";
import { ok, type Profile, type ShallowHistory } from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { CloneRepoDialog } from "../../../src/renderer/src/features/sidebar/CloneRepoDialog";
import { GraphRow, type GraphRowVM } from "../../../src/renderer/src/features/graph/GraphRow";
import { useHoverIntent } from "../../../src/renderer/src/lib/hoverIntent";
import { Note } from "./note";

// Everything here is contrived: an invented person, folders, repository and
// commits (design/Shallow Clones - UX Review's names).
const now = Date.parse("2026-11-27T15:00:00Z");
const noop = (): void => undefined;

const github = {
  kind: "github", cli: "gh", installed: true, loggedIn: true,
  capabilities: {
    batchedBranchLookup: true, batchedCommitAssociation: true, changeSizeAndTimeline: true,
    commitAuthorIdentity: true, commitSignatures: true, forkDefaultBranchOnly: true, addToMergeQueue: false
  },
  hosts: [{ host: "github.com", enabled: true, loggedIn: true }]
};
const api = {
  owner: "acme", name: "api", nameWithOwner: "acme/api", visibility: "public",
  host: "github", hostname: "github.com", viewerCanPush: true,
  sshUrl: "git@github.com:acme/api.git", httpsUrl: "https://github.com/acme/api.git", localPaths: []
};

const bridge = {
  profileId: "personal",
  platform: "darwin",
  appearance: { theme: "dark", resolvedTheme: "dark" },
  dispatch: async (name: string) => {
    switch (name) {
      case "repo:cloneCatalog": return ok({ owners: [], forges: [github] });
      case "forge:hosts": return ok({ overrides: {} });
      case "repo:cloneDestinations":
        return ok([{ path: "/Users/dana/src/acme", root: "/Users/dana/src", relativePath: "acme", repoCount: 4 }]);
      case "repo:searchCloneSources": return ok([api]);
      case "repo:checkCloneSource": return ok(api);
      case "repo:forkTargets": return ok([]);
      case "remote:deepenHistory": return new Promise(() => undefined);
      default: return ok([]);
    }
  },
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["platform"] = "darwin";

const PROFILE: Profile = {
  id: "personal", name: "Personal", email: "dana@example.com", mono: "P",
  roots: ["/Users/dana/src"], onboardingCompleted: true, showInMenu: true
};

const SUBJECTS = ["Bump parser to 4.2", "Handle empty config files", "Retry uploads on 503", "Split loader into modules"];
function rows(boundary: boolean): GraphRowVM[] {
  const through = [{ from: 0, to: 0 }];
  return SUBJECTS.map((subject, i) => {
    const hash = `${(0xa1b2c30 + i * 7919).toString(16)}${"0".repeat(33)}`;
    const last = i === SUBJECTS.length - 1;
    return {
      commit: {
        hash, shortHash: hash.slice(0, 7), parents: last ? [] : ["p"], subject,
        authorName: "Dana Whitfield", authorEmail: "dana@example.com",
        committedAt: new Date(now - (i + 1) * 9 * 3600_000).toISOString(), isMerge: false
      },
      row: { lane: 0, top: i === 0 ? [] : through, bottom: last ? [] : through },
      refs: i === 0 ? ["main"] : [],
      remoteRefs: i === 0 ? ["origin"] : [],
      isHead: i === 0, isHeadOnly: false, isMine: true, defaultBranch: "main",
      ...(boundary && last ? { shallowBoundary: true } : {})
    } as GraphRowVM;
  });
}

function Graph({ shallow }: { shallow: ShallowHistory | null }) {
  const hoverIntent = useHoverIntent();
  return (
    <div className="graph-harness" style={{ width: 640, padding: 12 }}>
      <div className="graph-scroll">
        <div className="graph-card">
          {rows(shallow !== null).map((vm) => (
            <GraphRow key={vm.commit.hash} vm={vm} laneCount={1} now={now} selected={false} focused={false}
              flashing={false} contextOpen={false} hoverIntent={hoverIntent} onOpen={noop} onShowContext={noop}
              onHideContext={noop} onFocusContext={() => false} onOpenContextMenu={noop} onShowPerson={noop} />
          ))}
        </div>
        {shallow !== null && <Note repoId="r" repoName="acme/api" worktreeId="w" shallow={shallow} />}
      </div>
    </div>
  );
}

let root: Root | null = null;
const harness = {
  ready: Promise.all(
    ['400 13px "Geist Sans"', '600 12px "Geist Sans"', '500 11px "Geist Mono"', '600 9px "Geist Mono"'].map((f) => document.fonts.load(f))
  ),
  mount(scene: "clone" | "graph" | "graph-single" | "graph-complete", theme: "light" | "dark"): void {
    root?.unmount();
    if (theme === "light") document.documentElement.dataset["theme"] = "light";
    else delete document.documentElement.dataset["theme"];
    root = createRoot(document.getElementById("root")!);
    const boundary = rows(true).at(-1)!.commit.hash;
    if (scene === "clone") {
      root.render(<CloneRepoDialog profile={PROFILE} onCloned={noop} onReveal={noop} onClose={noop} />);
    } else if (scene === "graph-complete") {
      root.render(<Graph shallow={null} />);
    } else {
      root.render(<Graph shallow={{ boundaries: [boundary], remote: "origin", fetchesOnly: scene === "graph-single" ? ["main"] : null }} />);
    }
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
