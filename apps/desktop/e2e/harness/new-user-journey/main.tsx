import { createRoot, type Root } from "react-dom/client";
import {
  ok,
  type Profile,
  type ProposedFolder,
  type RepoSearchResult
} from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { Sidebar } from "../../../src/renderer/src/features/sidebar/Sidebar";
import { SidebarToolbar } from "../../../src/renderer/src/features/sidebar/SidebarToolbar";
import { CloneRepoDialog } from "../../../src/renderer/src/features/sidebar/CloneRepoDialog";
import { StartScreen } from "../../../src/renderer/src/features/onboarding/StartScreen";
import { OnboardingWizard } from "../../../src/renderer/src/features/onboarding/OnboardingWizard";
import { unansweredSteps, type WizardStep } from "../../../src/renderer/src/features/onboarding/steps";

// Everything here is contrived: an invented person, home folder, folders,
// repositories and accounts (design/New User Journey - UX Review's names).
const HOME = "/Users/dana";
const SUGGESTED = ["projects", "github", "git"].map((name) => ({
  name,
  path: `${HOME}/${name}`,
  display: `~/${name}`,
  exists: false
}));

function folder(rel: string, repos: string[], extra: Partial<ProposedFolder> = {}): ProposedFolder {
  const path = `${HOME}/${rel}`;
  return {
    path,
    display: `~/${rel}`,
    isRepository: false,
    repositories: repos.map((name) => ({
      key: `${path}/${name}/.git`,
      name: name.split("/").at(-1)!,
      checkouts: [`${path}/${name}`],
      primaryFound: true,
      indexable: true
    })),
    worktreeCount: 0,
    ownerFolders: 0,
    checked: true,
    selectable: true,
    note: null,
    ...extra
  };
}

const FOUND: RepoSearchResult = {
  home: HOME,
  folders: [
    folder("code", ["ledger-api", "ledger-web", "telemetry", "notes-sync", "ops-scripts"]),
    folder(
      "github",
      ["acme/atlas", "acme/harbor", "acme/lantern", "dana-w/blog", "dana-w/dotvim", "dana-w/recipes", "oss/parser", "oss/linter", "oss/bench"],
      { ownerFolders: 3 }
    ),
    folder("work", ["billing", "pipeline"]),
    folder("dotfiles", ["."], { isRepository: true }),
    folder("trees", [], {
      checked: false,
      worktreeCount: 4,
      note: { kind: "worktrees-of", repositoryFolders: [`${HOME}/code`] }
    })
  ],
  foldersOpened: 717,
  stoppedEarly: null,
  includedProtected: false,
  protectedSkipped: [`${HOME}/Desktop`, `${HOME}/Documents`, `${HOME}/Downloads`],
  refused: [],
  cloudSkipped: [],
  protectedAskFirst: true,
  homeIsRepository: false
};
// The dotfiles row is the repository itself.
FOUND.folders[3]!.repositories = [
  { key: `${HOME}/dotfiles/.git`, name: "dotfiles", checkouts: [`${HOME}/dotfiles`], primaryFound: true, indexable: true }
];
FOUND.folders[4]!.repositories = [
  { key: `${HOME}/code/ledger-api/.git`, name: "ledger-api", checkouts: [`${HOME}/trees/fix-1`, `${HOME}/trees/fix-2`], primaryFound: true, indexable: true },
  { key: `${HOME}/code/ledger-web/.git`, name: "ledger-web", checkouts: [`${HOME}/trees/review`, `${HOME}/trees/spike`], primaryFound: true, indexable: true }
];
const NOTHING: RepoSearchResult = { ...FOUND, folders: [], foldersOpened: 212 };

type SearchMode = "found" | "nothing" | "running";
let searchMode: SearchMode = "found";
const listeners = new Map<string, Set<(payload: unknown) => void>>();
const emit = (channel: string, payload: unknown): void => {
  for (const l of listeners.get(channel) ?? []) l(payload);
};

const github = {
  kind: "github", cli: "gh", installed: true, loggedIn: true,
  capabilities: {
    batchedBranchLookup: true, batchedCommitAssociation: true,
    changeSizeAndTimeline: true, commitAuthorIdentity: true, forkDefaultBranchOnly: true
  },
  hosts: [{ host: "github.com", enabled: true, loggedIn: true }]
};
const atlas = {
  owner: "acme",
  name: "atlas",
  nameWithOwner: "acme/atlas",
  visibility: "public",
  host: "github",
  hostname: "github.com",
  viewerCanPush: true,
  sshUrl: "git@github.com:acme/atlas.git",
  httpsUrl: "https://github.com/acme/atlas.git",
  localPaths: []
};

const bridge = {
  profileId: "personal",
  platform: "darwin",
  appearance: { theme: "dark", resolvedTheme: "dark" },
  dispatch: async (name: string, req: { searchId?: string }) => {
    switch (name) {
      case "profile:suggestedRoots":
        return ok(SUGGESTED);
      case "profile:createRoot":
        return ok({ path: `${HOME}/projects`, created: true, repos: [] });
      case "git:readIdentity":
        return ok({ name: "Dana Whitfield", email: "dana@example.com", conditionalDirs: [] });
      case "forge:status":
        return ok([github]);
      case "repo:searchHome":
        if (searchMode === "running") {
          setTimeout(() => emit("repo:searchProgress", {
            searchId: req.searchId, profileId: "personal", foldersOpened: 212, repositoriesFound: 14
          }), 10);
          return new Promise(() => undefined);
        }
        return ok(searchMode === "found" ? FOUND : NOTHING);
      case "repo:cloneCatalog":
        return ok({ owners: [], forges: [github] });
      case "forge:hosts":
        return ok({ overrides: {} });
      case "repo:searchCloneSources":
        return ok([atlas]);
      case "repo:checkCloneSource":
        return ok(atlas);
      case "repo:forkTargets":
        return ok([{ login: "dana-w", kind: "user", host: "github" }]);
      case "repo:forkPreflight":
        return ok({
          source: atlas,
          target: { owner: "dana-w", name: "atlas", nameWithOwner: "dana-w/atlas" },
          upstreamChoices: [{ nameWithOwner: "acme/atlas", url: "https://github.com/acme/atlas" }]
        });
      case "app:readUpdateStatus":
        return ok({ status: "idle" });
      default:
        return ok([]);
    }
  },
  on: (channel: string, listener: (payload: unknown) => void) => {
    const set = listeners.get(channel) ?? new Set();
    set.add(listener);
    listeners.set(channel, set);
    return () => set.delete(listener);
  }
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["platform"] = "darwin";

const PROFILE: Profile = {
  id: "personal",
  name: "Personal",
  email: "",
  mono: "P",
  roots: [],
  onboardingCompleted: true,
  showInMenu: true
};

const noop = (): void => undefined;
const ready = { status: "ready" } as const;

function Window(props: { profile: Profile; searching: boolean; width: number }) {
  const { profile } = props;
  const unanswered = unansweredSteps({
    authorName: profile.authorName ?? null,
    email: profile.email,
    forgeConnected: profile.email === "" ? false : true
  });
  return (
    <div className="app" style={{ width: props.width, height: 640 }}>
      <div className="app-body" style={{ gridTemplateColumns: "300px minmax(0, 1fr) 0px", height: "100%" }}>
        <Sidebar
          profiles={[profile]}
          activeProfile={profile}
          profileLoadState={ready}
          onRetryProfiles={noop}
          onSwitchProfile={noop}
          repos={[]}
          repoLoadState={ready}
          onRetryRepos={noop}
          selectedWorktreeId={null}
          onSelectWorktree={noop}
          onSetRepoPin={noop}
          onSetWorktreePin={noop}
          onSetBranchPin={noop}
          onRemoveWorktree={noop}
          onRemoveWorktrees={async () => ({ removed: [], failed: [] }) as never}
          onCreateWorktree={async () => null}
          onPersistOrder={noop}
          onPersistRepoOrder={noop}
          refreshingRepoIds={new Set()}
          onRefreshRepo={noop}
          onRefreshPullRequest={noop}
          onCloneRepo={noop}
          onForkRepo={noop}
          onForkCheckout={noop}
          onAddFolder={noop}
          onFindRepositories={noop}
          onExpandRepo={noop}
          onNewProfile={noop}
          onManageProfile={noop}
          platform="darwin"
        />
        <main className="pane pane--main" data-testid="main">
          <StartScreen
            profile={profile}
            scanning={false}
            searching={props.searching}
            onSearchingChange={noop}
            onAddFolders={noop}
            onClone={noop}
            onSetRoots={async () => undefined}
            unanswered={unanswered}
            onFinishSetup={noop}
          />
        </main>
        <div />
      </div>
    </div>
  );
}

let root: Root | null = null;
const harness = {
  ready: (async () => {
    await Promise.all(
      ['400 13px "Geist Sans"', '500 12px "Geist Sans"', '600 13px "Geist Sans"', '650 20px "Geist Sans"', '600 12px "Geist Mono"', '500 11px "Geist Mono"'].map((font) =>
        document.fonts.load(font)
      )
    );
    await document.fonts.ready;
  })(),
  mount(scene: string, theme: "light" | "dark", opts: { width?: number; step?: WizardStep; search?: SearchMode; roots?: string[] } = {}): void {
    root?.unmount();
    if (theme === "light") document.documentElement.dataset["theme"] = "light";
    else delete document.documentElement.dataset["theme"];
    searchMode = opts.search ?? "found";
    root = createRoot(document.getElementById("root")!);
    const profile: Profile = {
      ...PROFILE,
      roots: opts.roots ?? [],
      ...(scene === "window-folder" ? { email: "dana@example.com", authorName: "Dana Whitfield" } : {})
    };
    if (scene === "window" || scene === "window-folder" || scene === "window-search") {
      root.render(<Window profile={profile} searching={scene === "window-search"} width={opts.width ?? 1100} />);
    } else if (scene === "pane") {
      // The start screen alone in a narrow main pane (sidebar collapsed).
      root.render(
        <div className="app" style={{ width: opts.width ?? 420, height: 640 }}>
          <main className="pane pane--main" style={{ height: "100%" }}>
            <StartScreen
              profile={profile}
              scanning={false}
              searching={false}
              onSearchingChange={noop}
              onAddFolders={noop}
              onClone={noop}
              onSetRoots={async () => undefined}
              unanswered={unansweredSteps({ authorName: null, email: "", forgeConnected: false })}
              onFinishSetup={noop}
            />
          </main>
        </div>
      );
    } else if (scene === "menu") {
      root.render(
        <div className="pane pane--sidebar" style={{ width: 320 }}>
          <SidebarToolbar
            hasProfile
            rootCount={0}
            repoCount={0}
            onAddFolder={noop}
            onFindRepositories={noop}
            onRescanFolders={noop}
            onClone={noop}
            onFork={noop}
            onSync={noop}
            onMaintenance={noop}
          />
        </div>
      );
    } else if (scene === "wizard") {
      root.render(
        <OnboardingWizard
          profile={{ ...profile, email: "dana@example.com", authorName: "Dana Whitfield" }}
          repos={[]}
          isReplay
          {...(opts.step === undefined ? {} : { initialStep: opts.step })}
          pickDirectories={async () => []}
          onSetRoots={async () => undefined}
          onSetIdentity={async () => undefined}
          onDismiss={noop}
          onOpenClone={noop}
        />
      );
    } else if (scene === "clone") {
      root.render(
        <CloneRepoDialog profile={profile} onCloned={noop} onReveal={noop} onClose={noop} />
      );
    }
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
