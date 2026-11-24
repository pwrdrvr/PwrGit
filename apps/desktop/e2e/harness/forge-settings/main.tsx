import { createRoot, type Root } from "react-dom/client";
import {
  FORGE_KINDS,
  FORGE_PRODUCTS,
  GENERAL_DEFAULTS,
  forgeCapabilities,
  ok,
  type AppSettingsSnapshot,
  type ForgeHostConfig,
  type ForgeKind,
  type ForgeStatus
} from "@pwrgit/shared";
import "../../../src/renderer/src/styles/app.css";
import { SettingsWindow } from "../../../src/renderer/src/features/settings/SettingsWindow";
import { ForgeHosts, ForgeHostsView } from "../../../src/main/forge/hosts";
import type { DiscoveredForgeHost } from "../../../src/main/forge/cli-hosts";

// Settings › Forges against a fake bridge, with main's REAL `ForgeHosts`
// deciding the rows and the probe targets, so a build from another commit
// shows what that commit's main would have sent. Only the probe itself is a
// stand-in (`status.ts` spawns CLIs): a target is signed in when the world
// says its CLI holds that host. Every host and account is contrived.
//
// Each view is a shrunk counterexample from
// `forge-surfaces.property.test.ts`.

type World = {
  installed: Record<ForgeKind, boolean>;
  /** What each CLI holds a credential for, and so reports: the ACTIVE
   *  account per host. */
  signedIn: Record<ForgeKind, Record<string, string>>;
  /** Further accounts `gh` holds on a host, not active. */
  moreAccounts?: Record<string, string[]>;
  settings: Record<string, ForgeHostConfig>;
  env: Record<string, string>;
};

export type View =
  /** gh reports a host the user added as GitLab. */
  | "cross-cli"
  /** An env allowlist gives gitlab.com to GitHub; glab is signed in there. */
  | "reassigned-saas"
  /** Two accounts on two Enterprise hosts: one pinned to its bot, one pinned
   *  to an account that has since signed out. */
  | "host-accounts";

const VIEWS: Record<View, World> = {
  "cross-cli": {
    installed: { github: true, gitlab: true, gitcafe: false },
    signedIn: {
      github: { "github.com": "octo-dev", "code.acme.example": "octo-dev" },
      gitlab: {},
      gitcafe: {}
    },
    settings: { "code.acme.example": { kind: "gitlab", enabled: true } },
    env: {}
  },
  "reassigned-saas": {
    installed: { github: true, gitlab: true, gitcafe: false },
    signedIn: { github: { "github.com": "octo-dev" }, gitlab: { "gitlab.com": "o.dev" }, gitcafe: {} },
    settings: {},
    env: { PWRGIT_GITHUB_HOSTS: "github.com,gitlab.com" }
  },
  "host-accounts": {
    installed: { github: true, gitlab: false, gitcafe: false },
    signedIn: {
      github: {
        "github.com": "octo-dev",
        "ghe.contoso-labs.test": "a.hopper",
        "ghe.build.test": "a.hopper"
      },
      gitlab: {},
      gitcafe: {}
    },
    moreAccounts: {
      "ghe.contoso-labs.test": ["release-bot"],
      "ghe.build.test": ["release-bot"]
    },
    settings: {
      "ghe.contoso-labs.test": { account: "release-bot" },
      "ghe.build.test": { account: "b.liskov" }
    },
    env: {}
  }
};

function discovered(world: World): DiscoveredForgeHost[] {
  return FORGE_KINDS.flatMap((kind) =>
    world.installed[kind]
      ? Object.entries(world.signedIn[kind]).map(([host, account]) => ({
          kind,
          host,
          account,
          accounts: [account, ...(world.moreAccounts?.[host] ?? [])].map((login) => ({
            host,
            login,
            active: login === account
          }))
        }))
      : []
  );
}

/** `ForgeStatusService.probeOne`, over the world's sign-ins. */
function statuses(world: World, hosts: ForgeHosts): ForgeStatus[] {
  const targets = hosts.statusTargets();
  return FORGE_KINDS.map((kind) => {
    const base = { kind, cli: FORGE_PRODUCTS[kind].cli, capabilities: forgeCapabilities(kind) };
    if (!world.installed[kind]) return { ...base, installed: false, loggedIn: false, hosts: [] };
    const probed = targets
      .filter((target) => target.kind === kind)
      .map((target) => ({
        host: target.host,
        enabled: target.enabled,
        assumed: target.assumed === true,
        // A pinned account the CLI does not hold reads nothing, as
        // `GitHubCredentials.token` answers. A build whose targets carry no
        // account (before the choice existed) reads as the active one.
        loggedIn:
          target.enabled &&
          target.host in world.signedIn[kind] &&
          (target.account === undefined ||
            [world.signedIn[kind][target.host], ...(world.moreAccounts?.[target.host] ?? [])].includes(
              target.account
            ))
      }));
    return {
      ...base,
      installed: true,
      loggedIn: probed.some((entry) => entry.loggedIn),
      hosts: probed
        .filter((entry) => !entry.assumed)
        .map(({ host, enabled, loggedIn }) => ({ host, enabled, loggedIn }))
    };
  });
}

let world = VIEWS["cross-cli"];
let theme: "light" | "dark" = "light";
const read = () => {
  const found = discovered(world);
  const hosts = new ForgeHosts({
    readSettings: () => ({ hosts: world.settings }),
    discovered: () => found,
    env: world.env
  });
  return { hosts, view: new ForgeHostsView(hosts, async () => {}) };
};

const snapshot = { general: GENERAL_DEFAULTS } as AppSettingsSnapshot;
const bridge = {
  profileId: null,
  platform: "darwin",
  get appearance() {
    return { theme, resolvedTheme: theme };
  },
  getAppMenuModel: async () => [],
  popupAppMenu: () => undefined,
  runWindowControl: async () => undefined,
  readWindowFrameState: async () => null,
  onWindowFrameState: () => () => undefined,
  dispatch: async (name: string) => {
    if (name === "settings:read") return ok(snapshot);
    if (name === "appearance:read") return ok({ theme, resolvedTheme: theme });
    if (name === "profile:list") {
      return ok({
        activeProfileId: "demo",
        profiles: [{ id: "demo", name: "Demo", email: "demo@example.com", mono: "D", roots: [], onboardingCompleted: true, showInMenu: true }]
      });
    }
    if (name === "forge:status") {
      const { hosts } = read();
      return ok({ forges: statuses(world, hosts) });
    }
    if (name === "forge:hosts") {
      const { view } = read();
      return ok({ hosts: view.rows(), overrides: view.overrides() });
    }
    if (name === "repo:hiddenList") return ok([]);
    return ok(null);
  },
  on: () => () => undefined
};
(window as unknown as { pwrgit: typeof bridge }).pwrgit = bridge;
document.documentElement.dataset["theme"] = "light";
document.documentElement.dataset["platform"] = "darwin";

let root: Root | null = null;
const harness = {
  ready: (async () => {
    await Promise.all([
      '400 13px "Geist Sans"', '500 11px "Geist Sans"', '600 13px "Geist Sans"', '700 12px "Geist Sans"',
      '400 11px "Geist Mono"', '500 10px "Geist Mono"', '600 11px "Geist Mono"'
    ].map((font) => document.fonts.load(font)));
    await document.fonts.ready;
  })(),
  mount(view: View, nextTheme: "light" | "dark" = "light"): void {
    root?.unmount();
    world = VIEWS[view];
    theme = nextTheme;
    document.documentElement.dataset["theme"] = nextTheme;
    window.location.hash = "#settings?page=forges";
    root = createRoot(document.getElementById("root")!);
    root.render(<SettingsWindow />);
  }
};
(window as unknown as { __harness: typeof harness }).__harness = harness;
