import { join } from "node:path";
import type { DiscoveredAcpAgentGroup } from "@pwrdrvr/agent-acp";
import type {
  CodexAuthProfileCandidate,
  CodexAuthStatusResponse,
  CodexDiscoverySnapshot,
  CodexStatusOutcome
} from "@pwrdrvr/codex-discovery";
import {
  AI_JOBS,
  DEFAULT_AI_PROVIDER_SETTINGS,
  type AiCodexSettings,
  type AiProviderSettings,
  type CodexModelOption,
  type ProfileId
} from "@pwrgit/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  shell: { openExternal: vi.fn(async () => undefined) }
}));

import {
  AiProviderService,
  type AiProviderServiceDependencies,
  type CodexEnvironment
} from "./ai-provider-service";
import { codexModelCacheKey } from "./codex-model-cache";

type Deps = AiProviderServiceDependencies;

const CODEX = "/usr/local/bin/codex";
const SCRATCH = "/tmp/pwrgit-agent";
const MAX_AGE_MS = 60_000;
const DEFAULT_HOME = "/home/me/.codex";

// Stands in for `codexEnvironmentFor`: an explicit auth profile wins, and
// "follow the profile" lands on a same-named Codex profile only for "work".
function fakeEnvironment(profileId: ProfileId, codex: AiCodexSettings): CodexEnvironment {
  const authProfile = codex.authProfile ?? (profileId === "work" ? "work" : "");
  const codexHome = authProfile === "" ? DEFAULT_HOME : `${DEFAULT_HOME}/profiles/${authProfile}`;
  return {
    env: { PATH: "/usr/bin", CODEX_HOME: codexHome, PWRGIT_PROFILE_ID: profileId },
    codexHome,
    authProfile
  };
}

function codexSnapshot(selected = true): CodexDiscoverySnapshot {
  return {
    candidates: [
      { command: CODEX, source: "path", executable: selected, selected, version: "0.130.0" }
    ]
  };
}

function authAnswer(
  params: { codexHome: string; profile: string },
  status: CodexAuthStatusResponse["status"],
  outcome: CodexStatusOutcome = "answered"
): CodexAuthStatusResponse {
  return {
    profile: params.profile,
    codexHome: params.codexHome,
    authenticated: status === "authenticated",
    status,
    outcome
  };
}

function codexModel(id: string, displayName = id): CodexModelOption {
  return {
    id,
    model: id,
    displayName,
    description: "",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
    isDefault: false
  };
}

function acpGroup(
  strategyId: string,
  commands: string[],
  env: Record<string, string> = {}
): DiscoveredAcpAgentGroup {
  return {
    strategyId,
    backendId: `acp:${strategyId}`,
    name: strategyId,
    args: ["--acp"],
    env,
    instances: commands.map((command, index) => ({
      command,
      source: "path",
      version: `1.${index}.0`
    })),
    discoveredAt: 1_700_000_000_000
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Every profile starts switched on here, so each test is about the resolver
 *  and not the switch; the one test about the switch turns it off. */
const SWITCHED_ON: AiProviderSettings = {
  ...structuredClone(DEFAULT_AI_PROVIDER_SETTINGS),
  enabled: true,
  consentAcceptedAt: "2026-09-01T12:00:00.000Z"
};

function harness(options: { discoveryDisabled?: boolean } = {}) {
  const stored = new Map<ProfileId, AiProviderSettings>();
  const clock = { now: Date.parse("2026-09-19T12:00:00.000Z") };
  const deps = {
    settings: {
      read: (profileId: ProfileId) =>
        structuredClone(stored.get(profileId) ?? SWITCHED_ON)
    },
    discoverCodex: vi.fn<Deps["discoverCodex"]>(async () => codexSnapshot()),
    checkCodexAuth: vi.fn<Deps["checkCodexAuth"]>(async (params) =>
      authAnswer(params, "authenticated")
    ),
    discoverAcp: vi.fn<Deps["discoverAcp"]>(async () => []),
    listCodexModels: vi.fn<Deps["listCodexModels"]>(async () => [codexModel("gpt-5-codex")]),
    listAcpModels: vi.fn<Deps["listAcpModels"]>(async () => [{ id: "grok-4", label: "Grok 4" }]),
    listCodexAuthProfiles: vi.fn<Deps["listCodexAuthProfiles"]>(() => ({
      profileRoot: `${DEFAULT_HOME}/profiles`,
      effectiveCodexHome: DEFAULT_HOME,
      profiles: []
    })),
    startCodexLogin: vi.fn<Deps["startCodexLogin"]>(async (params) => ({
      profile: params.profile,
      codexHome: params.codexHome,
      started: true
    })),
    environmentFor: vi.fn<Deps["environmentFor"]>(fakeEnvironment),
    acpModelCache: {
      load: vi.fn<Deps["acpModelCache"]["load"]>(() => undefined),
      save: vi.fn<Deps["acpModelCache"]["save"]>()
    },
    codexModelCache: {
      load: vi.fn<Deps["codexModelCache"]["load"]>(() => undefined),
      save: vi.fn<Deps["codexModelCache"]["save"]>(),
      findLabel: vi.fn<Deps["codexModelCache"]["findLabel"]>(() => undefined)
    },
    scratchDir: SCRATCH,
    now: () => clock.now,
    maxAgeMs: MAX_AGE_MS,
    discoveryDisabled: options.discoveryDisabled ?? false,
    onDispose: vi.fn()
  } satisfies Deps;

  function configure(profileId: ProfileId, mutate: (settings: AiProviderSettings) => void): void {
    const next = structuredClone(stored.get(profileId) ?? SWITCHED_ON);
    mutate(next);
    stored.set(profileId, next);
  }

  return { service: new AiProviderService(deps), deps, clock, configure };
}

describe("AiProviderService", () => {
  describe("Codex discovery", () => {
    it("reports the binary that will run and whether its account is signed in", async () => {
      const { service, deps } = harness();

      const discovery = await service.discoverCodex("personal");

      expect(discovery.resolvedPath).toBe(CODEX);
      expect(discovery.candidates).toEqual([
        { path: CODEX, source: "path", version: "0.130.0", available: true }
      ]);
      expect(discovery.auth).toMatchObject({
        status: "authenticated",
        profile: "",
        profileLabel: "System default",
        codexHome: DEFAULT_HOME
      });
      expect(deps.checkCodexAuth).toHaveBeenCalledWith(
        expect.objectContaining({ command: CODEX, codexHome: DEFAULT_HOME, profile: "" })
      );
    });

    it("skips the sign-in check when no Codex resolved", async () => {
      const { service, deps } = harness();
      deps.discoverCodex.mockResolvedValue(codexSnapshot(false));

      const discovery = await service.discoverCodex("personal");

      expect(discovery.resolvedPath).toBeNull();
      expect(discovery.auth).toBeNull();
      expect(deps.checkCodexAuth).not.toHaveBeenCalled();
    });

    it("hands discovery a pinned path only in pinned mode", async () => {
      const { service, deps, configure } = harness();
      configure("personal", (s) => {
        s.codex = { mode: "auto", pinnedPath: "/opt/codex" };
      });
      await service.discoverCodex("personal");
      expect(deps.discoverCodex.mock.calls[0]?.[0]).not.toHaveProperty("configuredCommand");

      configure("personal", (s) => {
        s.codex.mode = "pinned";
      });
      await service.discoverCodex("personal");
      expect(deps.discoverCodex.mock.calls[1]?.[0]).toMatchObject({
        configuredCommand: "/opt/codex"
      });
    });

    it("serves a cached answer until it ages out", async () => {
      const { service, deps, clock } = harness();
      await service.discoverCodex("personal");
      clock.now += MAX_AGE_MS - 1;
      await service.discoverCodex("personal");
      expect(deps.discoverCodex).toHaveBeenCalledTimes(1);

      clock.now += 1;
      await service.discoverCodex("personal");
      expect(deps.discoverCodex).toHaveBeenCalledTimes(2);
    });

    it("re-probes on force", async () => {
      const { service, deps } = harness();
      await service.discoverCodex("personal");
      await service.discoverCodex("personal", { force: true });
      expect(deps.discoverCodex).toHaveBeenCalledTimes(2);
    });

    it("shares one probe between concurrent asks, a forced one included", async () => {
      const { service, deps } = harness();
      const probe = deferred<CodexDiscoverySnapshot>();
      deps.discoverCodex.mockReturnValue(probe.promise);

      const asks = [
        service.discoverCodex("personal"),
        service.discoverCodex("personal"),
        service.discoverCodex("personal", { force: true })
      ];
      probe.resolve(codexSnapshot());
      const [first, ...rest] = await Promise.all(asks);

      expect(deps.discoverCodex).toHaveBeenCalledTimes(1);
      for (const answer of rest) expect(answer).toBe(first);
    });

    it("does not cache a probe that failed", async () => {
      const { service, deps } = harness();
      deps.discoverCodex.mockRejectedValueOnce(new Error("spawn EAGAIN"));

      await expect(service.discoverCodex("personal")).rejects.toThrow("spawn EAGAIN");
      await expect(service.discoverCodex("personal")).resolves.toMatchObject({ resolvedPath: CODEX });
      expect(deps.discoverCodex).toHaveBeenCalledTimes(2);
    });

    it("treats a changed account as a plain cache miss", async () => {
      const { service, deps, configure } = harness();
      configure("personal", (s) => {
        s.codex.authProfile = "side";
      });
      await service.discoverCodex("personal");
      configure("personal", (s) => {
        s.codex.authProfile = "";
      });
      const discovery = await service.discoverCodex("personal");

      expect(deps.discoverCodex).toHaveBeenCalledTimes(2);
      expect(discovery.auth?.codexHome).toBe(DEFAULT_HOME);
    });
  });

  describe("ACP discovery", () => {
    it("lists every PwrGit agent and marks the install spawns will use", async () => {
      const { service, deps, configure } = harness();
      deps.discoverAcp.mockResolvedValue([acpGroup("grok", ["/a/grok", "/b/grok"])]);
      configure("personal", (s) => {
        s.acp.agents.grok = { selectedPath: "/b/grok" };
      });

      const discovery = await service.discoverAcp("personal");

      expect(discovery.agents.map((agent) => [agent.id, agent.installed])).toEqual([
        ["grok", true],
        ["kimi", false],
        ["qwen", false]
      ]);
      expect(discovery.agents[0]?.activeCommand).toBe("/b/grok");
    });

    it("scans every agent for Settings, so a disabled one can be found and enabled", async () => {
      const { service, deps } = harness();
      await service.discoverAcp("personal");
      const strategies = deps.discoverAcp.mock.calls[0]?.[0].strategies ?? [];
      expect(strategies.map((strategy) => strategy.id)).toEqual(["grok", "kimi", "qwen"]);
    });

    it("re-reads a changed pin without re-probing, because a pin is not a discovery input", async () => {
      const { service, deps, configure } = harness();
      deps.discoverAcp.mockResolvedValue([acpGroup("grok", ["/a/grok", "/b/grok"])]);
      expect((await service.discoverAcp("personal")).agents[0]?.activeCommand).toBe("/a/grok");

      configure("personal", (s) => {
        s.acp.agents.grok = { selectedPath: "/b/grok" };
      });
      expect((await service.discoverAcp("personal")).agents[0]?.activeCommand).toBe("/b/grok");
      expect(deps.discoverAcp).toHaveBeenCalledTimes(1);
    });

    it("re-probes when an enabled agent's override path changes, and probes it", async () => {
      const { service, deps, configure } = harness();
      await service.discoverAcp("personal");
      configure("personal", (s) => {
        s.acp.enabledAgentIds = ["grok"];
        s.acp.agents.grok = { overridePath: "/custom/grok" };
      });
      await service.discoverAcp("personal");

      expect(deps.discoverAcp).toHaveBeenCalledTimes(2);
      expect(deps.discoverAcp.mock.calls[1]?.[0].overrides).toEqual({ grok: "/custom/grok" });
    });

    it("neither probes nor re-probes for a path typed for a disabled agent", async () => {
      const { service, deps, configure } = harness();
      await service.discoverAcp("personal");
      configure("personal", (s) => {
        s.acp.agents.grok = { overridePath: "/custom/grok" };
      });
      await service.discoverAcp("personal");

      expect(deps.discoverAcp).toHaveBeenCalledTimes(1);
      expect(deps.discoverAcp.mock.calls[0]?.[0]).not.toHaveProperty("overrides");
    });
  });

  describe("with discovery disabled", () => {
    it("answers nothing installed without probing this machine", async () => {
      const { service, deps } = harness({ discoveryDisabled: true });

      expect(await service.discoverCodex("personal")).toMatchObject({
        candidates: [],
        resolvedPath: null,
        auth: null
      });
      expect((await service.discoverAcp("personal")).agents.every((a) => !a.installed)).toBe(true);
      expect(deps.discoverCodex).not.toHaveBeenCalled();
      expect(deps.discoverAcp).not.toHaveBeenCalled();
    });
  });

  describe("codexModels", () => {
    it("answers codex_unavailable, without listing, when no Codex resolves", async () => {
      const { service, deps } = harness();
      deps.discoverCodex.mockResolvedValue(codexSnapshot(false));

      const result = await service.codexModels("personal");

      expect(result).toMatchObject({ ok: false, error: { code: "codex_unavailable" } });
      expect(deps.listCodexModels).not.toHaveBeenCalled();
    });

    it("serves the disk cache before listing, and memory after that", async () => {
      const { service, deps } = harness();
      const persisted = [codexModel("gpt-5", "GPT-5")];
      deps.codexModelCache.load.mockReturnValue({ models: persisted, discoveredAt: "earlier" });

      expect(await service.codexModels("personal")).toEqual({ ok: true, value: { models: persisted } });
      expect(await service.codexModels("personal")).toEqual({ ok: true, value: { models: persisted } });

      expect(deps.codexModelCache.load).toHaveBeenCalledTimes(1);
      expect(deps.codexModelCache.load).toHaveBeenCalledWith(codexModelCacheKey(CODEX, DEFAULT_HOME));
      expect(deps.listCodexModels).not.toHaveBeenCalled();
    });

    it("lists on a miss under the profile's env, persists the list, then serves memory", async () => {
      const { service, deps, clock } = harness();

      const result = await service.codexModels("personal");
      await service.codexModels("personal");

      expect(result).toEqual({ ok: true, value: { models: [codexModel("gpt-5-codex")] } });
      expect(deps.listCodexModels).toHaveBeenCalledTimes(1);
      expect(deps.listCodexModels).toHaveBeenCalledWith({
        command: CODEX,
        env: fakeEnvironment("personal", DEFAULT_AI_PROVIDER_SETTINGS.codex).env,
        includeHidden: false
      });
      expect(deps.codexModelCache.save).toHaveBeenCalledWith(codexModelCacheKey(CODEX, DEFAULT_HOME), {
        models: [codexModel("gpt-5-codex")],
        discoveredAt: new Date(clock.now).toISOString()
      });
    });

    it("does not treat an empty persisted list as a hit", async () => {
      const { service, deps } = harness();
      deps.codexModelCache.load.mockReturnValue({ models: [], discoveredAt: "earlier" });
      await service.codexModels("personal");
      expect(deps.listCodexModels).toHaveBeenCalledTimes(1);
    });

    it("does not persist an empty list over a good one", async () => {
      const { service, deps } = harness();
      deps.listCodexModels.mockResolvedValue([]);
      expect(await service.codexModels("personal")).toEqual({ ok: true, value: { models: [] } });
      expect(deps.codexModelCache.save).not.toHaveBeenCalled();
    });

    it("does not treat an empty listing as a memory hit, so the next ask re-lists", async () => {
      const { service, deps } = harness();
      deps.listCodexModels.mockResolvedValue([]);
      await service.codexModels("personal");
      await service.codexModels("personal");
      // An empty answer held in memory would shadow a list that is there now.
      expect(deps.listCodexModels).toHaveBeenCalledTimes(2);
    });

    it("bypasses memory and disk on refresh", async () => {
      const { service, deps } = harness();
      deps.codexModelCache.load.mockReturnValue({ models: [codexModel("old")], discoveredAt: "x" });
      await service.codexModels("personal");
      const refreshed = await service.codexModels("personal", { refresh: true });

      expect(deps.listCodexModels).toHaveBeenCalledTimes(1);
      expect(refreshed).toEqual({ ok: true, value: { models: [codexModel("gpt-5-codex")] } });
    });

    it("keeps each account's list apart", async () => {
      const { service, deps, configure } = harness();
      await service.codexModels("personal");
      configure("personal", (s) => {
        s.codex.authProfile = "side";
      });
      await service.codexModels("personal");
      expect(deps.listCodexModels).toHaveBeenCalledTimes(2);
    });

    it("shares one listing between concurrent asks", async () => {
      const { service, deps } = harness();
      const listing = deferred<CodexModelOption[]>();
      deps.listCodexModels.mockReturnValue(listing.promise);

      const asks = Promise.all([service.codexModels("personal"), service.codexModels("personal")]);
      // Both asks first await discovery; let them reach the lister.
      await vi.waitFor(() => expect(deps.listCodexModels).toHaveBeenCalled());
      listing.resolve([codexModel("gpt-5")]);
      await asks;

      expect(deps.listCodexModels).toHaveBeenCalledTimes(1);
    });

    it("answers a failed listing as a codex_models_failed Result", async () => {
      const { service, deps } = harness();
      deps.listCodexModels.mockRejectedValue(new Error("app-server exited 1"));
      expect(await service.codexModels("personal")).toMatchObject({
        ok: false,
        error: { kind: "agent", code: "codex_models_failed", message: "app-server exited 1" }
      });
    });
  });

  describe("acpModels", () => {
    it("never starts a disabled agent, not even to list its models", async () => {
      const { service, deps } = harness();
      deps.discoverAcp.mockResolvedValue([acpGroup("grok", ["/a/grok"])]);

      expect(await service.acpModels("personal", "grok")).toEqual({
        ok: true,
        value: { agentId: "grok", models: [] }
      });
      expect(deps.discoverAcp).not.toHaveBeenCalled();
      expect(deps.listAcpModels).not.toHaveBeenCalled();
    });

    it("answers an empty list for an enabled agent that is not installed", async () => {
      const { service, deps, configure } = harness();
      configure("personal", (s) => {
        s.acp.enabledAgentIds = ["grok"];
      });
      expect(await service.acpModels("personal", "grok")).toEqual({
        ok: true,
        value: { agentId: "grok", models: [] }
      });
      expect(deps.listAcpModels).not.toHaveBeenCalled();
    });

    it("lists from the active install, in scratch space, and persists what it read", async () => {
      const { service, deps, configure } = harness();
      configure("personal", (s) => {
        s.acp.enabledAgentIds = ["grok"];
        s.acp.agents.grok = { selectedPath: "/b/grok" };
      });
      deps.discoverAcp.mockResolvedValue([
        acpGroup("grok", ["/a/grok", "/b/grok"], { PATH: "/grok/bin", GROK_ACP: "1" })
      ]);

      const result = await service.acpModels("personal", "grok");

      expect(result).toEqual({
        ok: true,
        value: { agentId: "grok", models: [{ id: "grok-4", label: "Grok 4" }] }
      });
      const call = deps.listAcpModels.mock.calls[0]?.[0];
      expect(call?.strategy.id).toBe("grok");
      expect(call?.command).toBe("/b/grok");
      expect(call?.args).toEqual(["--acp"]);
      // The agent's own env is layered over the profile's, never under it.
      expect(call?.env).toMatchObject({
        PATH: "/grok/bin",
        GROK_ACP: "1",
        CODEX_HOME: DEFAULT_HOME,
        PWRGIT_PROFILE_ID: "personal"
      });
      expect(call?.cwd).toBe(join(SCRATCH, "acp-models", "grok"));
      expect(deps.acpModelCache.save).toHaveBeenCalledWith(
        "grok",
        expect.objectContaining({ command: "/b/grok", models: [{ id: "grok-4", label: "Grok 4" }] })
      );
    });

    it("does not persist an empty list over a good one", async () => {
      const { service, deps, configure } = harness();
      configure("personal", (settings) => {
        settings.acp.enabledAgentIds = ["grok"];
      });
      deps.discoverAcp.mockResolvedValue([acpGroup("grok", ["/a/grok"])]);
      deps.listAcpModels.mockResolvedValue([]);

      expect(await service.acpModels("personal", "grok")).toEqual({
        ok: true,
        value: { agentId: "grok", models: [] }
      });
      // The list on disk is a good one until a probe brings back a better one;
      // an empty answer is not a hit on the way back in, so writing it would
      // only cost the next launch a spawn.
      expect(deps.acpModelCache.save).not.toHaveBeenCalled();
    });

    it("serves a persisted list only when it came from the active install", async () => {
      const { service, deps, configure } = harness();
      configure("personal", (s) => {
        s.acp.enabledAgentIds = ["grok"];
      });
      deps.discoverAcp.mockResolvedValue([acpGroup("grok", ["/a/grok"])]);
      const persisted = [{ id: "grok-3", label: "Grok 3" }];
      deps.acpModelCache.load.mockReturnValue({
        models: persisted,
        command: "/other/grok",
        discoveredAt: "x"
      });

      await service.acpModels("personal", "grok");
      expect(deps.listAcpModels).toHaveBeenCalledTimes(1);

      const second = harness();
      second.configure("personal", (s) => {
        s.acp.enabledAgentIds = ["grok"];
      });
      second.deps.discoverAcp.mockResolvedValue([acpGroup("grok", ["/a/grok"])]);
      second.deps.acpModelCache.load.mockReturnValue({
        models: persisted,
        command: "/a/grok",
        discoveredAt: "x"
      });
      expect(await second.service.acpModels("personal", "grok")).toEqual({
        ok: true,
        value: { agentId: "grok", models: persisted }
      });
      expect(second.deps.listAcpModels).not.toHaveBeenCalled();
    });

    it("re-lists after an empty answer instead of letting it shadow a retry", async () => {
      const { service, deps, configure } = harness();
      configure("personal", (s) => {
        s.acp.enabledAgentIds = ["grok"];
      });
      deps.discoverAcp.mockResolvedValue([acpGroup("grok", ["/a/grok"])]);
      deps.listAcpModels.mockResolvedValueOnce([]);

      await service.acpModels("personal", "grok");
      const retried = await service.acpModels("personal", "grok");

      expect(deps.listAcpModels).toHaveBeenCalledTimes(2);
      expect(retried).toEqual({
        ok: true,
        value: { agentId: "grok", models: [{ id: "grok-4", label: "Grok 4" }] }
      });
    });

    it("answers failures as Results: discovery, then listing", async () => {
      const { service, deps, configure } = harness();
      configure("personal", (s) => {
        s.acp.enabledAgentIds = ["grok"];
      });
      deps.discoverAcp.mockRejectedValueOnce(new Error("PATH scan failed"));
      expect(await service.acpModels("personal", "grok")).toMatchObject({
        ok: false,
        error: { code: "acp_discovery_failed", message: "PATH scan failed" }
      });

      deps.discoverAcp.mockResolvedValue([acpGroup("grok", ["/a/grok"])]);
      deps.listAcpModels.mockRejectedValue(new Error("session/new timed out"));
      expect(await service.acpModels("personal", "grok")).toMatchObject({
        ok: false,
        error: { code: "acp_models_failed", message: "session/new timed out" }
      });
    });
  });

  describe("codexAuthProfiles", () => {
    function candidate(
      name: string,
      extra: Partial<CodexAuthProfileCandidate> = {}
    ): CodexAuthProfileCandidate {
      return {
        name,
        displayName: name === "" ? "System default" : name,
        codexHome: name === "" ? DEFAULT_HOME : `${DEFAULT_HOME}/profiles/${name}`,
        source: name === "" ? "default" : "directory",
        exists: true,
        selected: false,
        hasAuthFile: true,
        hasConfigFile: false,
        ...extra
      };
    }

    it("offers accounts that exist, the System default always, and the configured one", async () => {
      const { service, deps, configure } = harness();
      configure("work", (s) => {
        s.codex.authProfile = "fresh";
      });
      deps.listCodexAuthProfiles.mockReturnValue({
        profileRoot: `${DEFAULT_HOME}/profiles`,
        effectiveCodexHome: `${DEFAULT_HOME}/profiles/fresh`,
        profiles: [
          candidate("", { exists: false, hasAuthFile: false }),
          candidate("side", { accountEmail: "side@example.com" }),
          candidate("fresh", { exists: false, hasAuthFile: false, source: "config" }),
          candidate("ghost", { exists: false, hasAuthFile: false })
        ],
        error: "profiles directory unreadable"
      });

      const list = service.codexAuthProfiles("work");

      expect(list.profiles).toEqual([
        { name: "", displayName: "System default", codexHome: DEFAULT_HOME, hasAuthFile: false },
        {
          name: "side",
          displayName: "side",
          codexHome: `${DEFAULT_HOME}/profiles/side`,
          hasAuthFile: true,
          email: "side@example.com"
        },
        {
          name: "fresh",
          displayName: "fresh",
          codexHome: `${DEFAULT_HOME}/profiles/fresh`,
          hasAuthFile: false
        }
      ]);
      expect(list.error).toBe("profiles directory unreadable");
      expect(deps.listCodexAuthProfiles).toHaveBeenCalledWith(
        expect.objectContaining({ configuredProfile: "fresh" })
      );
    });

    it("says which account following the profile would use, whatever is configured", () => {
      const { service, configure } = harness();
      configure("work", (s) => {
        s.codex.authProfile = "";
      });
      // "work" follows to its same-named Codex profile, while the explicit
      // System default choice stays in force.
      expect(service.codexAuthProfiles("work").followed).toBe("work");
      expect(service.codexAuthProfiles("personal").followed).toBe("");
    });
  });

  describe("codexLogin", () => {
    it("answers codex_unavailable when there is no Codex to sign in with", async () => {
      const { service, deps } = harness();
      deps.discoverCodex.mockResolvedValue(codexSnapshot(false));
      expect(await service.codexLogin("personal")).toMatchObject({
        ok: false,
        error: { code: "codex_unavailable" }
      });
      expect(deps.startCodexLogin).not.toHaveBeenCalled();
    });

    it("signs in the account this profile resolves to, then re-checks sign-in", async () => {
      const { service, deps } = harness();
      await service.discoverCodex("work");
      deps.startCodexLogin.mockResolvedValue({
        profile: "work",
        codexHome: `${DEFAULT_HOME}/profiles/work`,
        started: true,
        detail: "Opened the browser"
      });

      const result = await service.codexLogin("work");
      await service.discoverCodex("work");

      expect(result).toEqual({
        ok: true,
        value: { profile: "work", started: true, detail: "Opened the browser" }
      });
      expect(deps.startCodexLogin).toHaveBeenCalledWith({
        codexHome: `${DEFAULT_HOME}/profiles/work`,
        command: CODEX,
        profile: "work"
      });
      // The cached "signed out" must not outlive the login that fixed it.
      expect(deps.discoverCodex).toHaveBeenCalledTimes(2);
    });

    it("answers a failed login as a codex_login_failed Result", async () => {
      const { service, deps } = harness();
      deps.startCodexLogin.mockRejectedValue(new Error("port 1455 in use"));
      expect(await service.codexLogin("personal")).toMatchObject({
        ok: false,
        error: { code: "codex_login_failed", message: "port 1455 in use" }
      });
    });
  });

  describe("resolveJob", () => {
    it("answers disabled, and starts nothing, while the profile's AI switch is off", async () => {
      const { service, deps, configure } = harness();
      configure("work", (s) => {
        s.enabled = false;
      });

      const result = await service.resolveJob({ profileId: "work", jobId: "historyEditing" });

      expect(result).toMatchObject({ ok: false, error: { kind: "agent", code: "disabled" } });
      if (!result.ok) expect(result.error.message).toContain("sidebar");
      expect(deps.discoverCodex).not.toHaveBeenCalled();
      expect(deps.discoverAcp).not.toHaveBeenCalled();
      expect(deps.checkCodexAuth).not.toHaveBeenCalled();
      // The other profile's switch is its own.
      expect(
        await service.resolveJob({ profileId: "personal", jobId: "historyEditing" })
      ).toMatchObject({ ok: true });
    });

    it("resolves a Codex job with the profile's model, effort and guidance", async () => {
      const { service, deps, configure } = harness();
      configure("work", (s) => {
        s.jobs.historyEditing = { model: "gpt-5-codex", reasoning: "high" };
        s.guidance = "Explain like I'm the reviewer.";
      });
      deps.codexModelCache.findLabel.mockReturnValue("GPT-5 Codex");

      const result = await service.resolveJob({ profileId: "work", jobId: "historyEditing" });

      const environment = fakeEnvironment("work", DEFAULT_AI_PROVIDER_SETTINGS.codex);
      expect(result).toEqual({
        ok: true,
        value: {
          profileId: "work",
          jobId: "historyEditing",
          guidance: "Explain like I'm the reviewer.",
          model: "gpt-5-codex",
          modelLabel: "GPT-5 Codex",
          effort: "high",
          backend: {
            kind: "codex",
            providerId: "codex",
            displayName: "Codex",
            command: CODEX,
            version: "0.130.0",
            env: environment.env,
            codexHome: environment.codexHome,
            authProfile: "work"
          }
        }
      });
    });

    it("leaves model and effort null, meaning the backend's own default, when unset", async () => {
      const { service, deps } = harness();
      const result = await service.resolveJob({ profileId: "personal", jobId: "historyEditing" });
      expect(result).toMatchObject({ ok: true, value: { model: null, modelLabel: null, effort: null } });
      expect(deps.codexModelCache.findLabel).not.toHaveBeenCalled();
    });

    it("answers unavailable when no usable Codex is found", async () => {
      const { service, deps } = harness();
      deps.discoverCodex.mockResolvedValue(codexSnapshot(false));
      const result = await service.resolveJob({ profileId: "personal", jobId: "historyEditing" });
      expect(result).toMatchObject({ ok: false, error: { kind: "agent", code: "unavailable" } });
      if (!result.ok) expect(result.error.message).toContain(AI_JOBS.historyEditing.label);
    });

    it("answers signed_out, naming the account, when Codex says it is signed out", async () => {
      const { service, deps } = harness();
      deps.checkCodexAuth.mockImplementation(async (params) => authAnswer(params, "unauthenticated"));

      expect(await service.resolveJob({ profileId: "work", jobId: "historyEditing" })).toMatchObject({
        ok: false,
        error: { code: "signed_out", message: "Codex is not signed in for work." }
      });
      expect(
        await service.resolveJob({ profileId: "personal", jobId: "historyEditing" })
      ).toMatchObject({
        ok: false,
        error: { code: "signed_out", message: "Codex is not signed in for System default." }
      });
    });

    it("does not block a job on a sign-in check that never answered", async () => {
      const { service, deps } = harness();
      deps.checkCodexAuth.mockImplementation(async (params) =>
        authAnswer(params, "unauthenticated", "timed_out")
      );
      const result = await service.resolveJob({ profileId: "personal", jobId: "historyEditing" });
      expect(result.ok).toBe(true);
    });

    it("runs history editing on Codex even when an enabled agent is its stored provider", async () => {
      const { service, deps, configure } = harness();
      configure("personal", (s) => {
        s.acp.enabledAgentIds = ["grok"];
        s.jobs.historyEditing = { provider: "grok", reasoning: "medium" };
      });
      deps.discoverAcp.mockResolvedValue([acpGroup("grok", ["/a/grok"])]);

      const result = await service.resolveJob({ profileId: "personal", jobId: "historyEditing" });

      expect(result).toMatchObject({
        ok: true,
        value: { backend: { kind: "codex", command: CODEX }, effort: "medium" }
      });
      expect(deps.discoverAcp).not.toHaveBeenCalled();
    });

    it("answers from cache, and re-probes on refresh", async () => {
      const { service, deps } = harness();
      await service.resolveJob({ profileId: "personal", jobId: "historyEditing" });
      await service.resolveJob({ profileId: "personal", jobId: "historyEditing" });
      expect(deps.discoverCodex).toHaveBeenCalledTimes(1);
      await service.resolveJob({ profileId: "personal", jobId: "historyEditing", refresh: true });
      expect(deps.discoverCodex).toHaveBeenCalledTimes(2);
    });

    it("answers cancelled for a caller whose signal is already aborted", async () => {
      const { service } = harness();
      const controller = new AbortController();
      controller.abort();
      expect(
        await service.resolveJob({
          profileId: "personal",
          jobId: "historyEditing",
          signal: controller.signal
        })
      ).toMatchObject({ ok: false, error: { code: "cancelled" } });
    });

    it("cancels one caller without stopping the probe others joined", async () => {
      const { service, deps } = harness();
      const probe = deferred<CodexDiscoverySnapshot>();
      deps.discoverCodex.mockReturnValue(probe.promise);
      const controller = new AbortController();

      const cancelled = service.resolveJob({
        profileId: "personal",
        jobId: "historyEditing",
        signal: controller.signal
      });
      const patient = service.resolveJob({ profileId: "personal", jobId: "historyEditing" });
      controller.abort();
      expect(await cancelled).toMatchObject({ ok: false, error: { code: "cancelled" } });

      probe.resolve(codexSnapshot());
      expect(await patient).toMatchObject({ ok: true, value: { backend: { command: CODEX } } });
      expect(deps.discoverCodex).toHaveBeenCalledTimes(1);
    });

    it("answers a probe that throws as discovery_failed", async () => {
      const { service, deps } = harness();
      deps.discoverCodex.mockRejectedValue(new Error("spawn codex EACCES"));
      expect(await service.resolveJob({ profileId: "personal", jobId: "historyEditing" })).toMatchObject(
        { ok: false, error: { code: "discovery_failed", message: "spawn codex EACCES" } }
      );
    });

    it("hands each profile its own PWRGIT_PROFILE_ID when two profiles share one Codex probe", async () => {
      // Discovery is shared between profiles whose Codex inputs match (mode,
      // pinned path, CODEX_HOME, account). The cached answer once carried the
      // environment of whichever profile probed first, so the second
      // profile's job ran as the first.
      const { service, deps } = harness();

      const alpha = await service.resolveJob({ profileId: "alpha", jobId: "historyEditing" });
      const beta = await service.resolveJob({ profileId: "beta", jobId: "historyEditing" });

      expect(deps.discoverCodex).toHaveBeenCalledTimes(1);
      expect(alpha).toMatchObject({ ok: true, value: { backend: { env: { PWRGIT_PROFILE_ID: "alpha" } } } });
      expect(beta).toMatchObject({ ok: true, value: { backend: { env: { PWRGIT_PROFILE_ID: "beta" } } } });
    });

    describe("on a job that accepts ACP", () => {
      // No shipped job accepts ACP yet; open history editing to stand in for
      // the next one so the ACP branch runs against the real rules.
      const historyEditing = AI_JOBS.historyEditing;
      const original = historyEditing.acp;
      beforeEach(() => {
        historyEditing.acp = true;
      });
      afterEach(() => {
        historyEditing.acp = original;
      });

      function withGrok(reasoning?: string) {
        const h = harness();
        h.configure("personal", (s) => {
          s.acp.enabledAgentIds = ["grok"];
          s.acp.agents.grok = { selectedPath: "/b/grok" };
          s.jobs.historyEditing = {
            provider: "grok",
            model: "grok-4",
            ...(reasoning !== undefined ? { reasoning } : {})
          };
        });
        h.deps.discoverAcp.mockResolvedValue([
          acpGroup("grok", ["/a/grok", "/b/grok"], { GROK_ACP: "1" })
        ]);
        return h;
      }

      it("resolves the enabled agent's active install, ready for the kit", async () => {
        const { service, deps } = withGrok("medium");

        const result = await service.resolveJob({ profileId: "personal", jobId: "historyEditing" });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const { backend } = result.value;
        expect(backend.kind).toBe("acp");
        if (backend.kind !== "acp") return;
        expect(backend.providerId).toBe("grok");
        expect(backend.displayName).toBe("Grok");
        expect(backend.strategy.id).toBe("grok");
        expect(backend.agent).toEqual({
          strategyId: "grok",
          backendId: "acp:grok",
          name: "grok",
          command: "/b/grok",
          args: ["--acp"],
          env: { GROK_ACP: "1" },
          discoveredAt: 1_700_000_000_000,
          version: "1.1.0"
        });
        expect(backend.env).toMatchObject({ GROK_ACP: "1", PWRGIT_PROFILE_ID: "personal" });
        expect(deps.discoverCodex).not.toHaveBeenCalled();
      });

      it("collapses the effort to the two thinking states an agent honors", async () => {
        const medium = withGrok("medium");
        expect(
          await medium.service.resolveJob({ profileId: "personal", jobId: "historyEditing" })
        ).toMatchObject({ ok: true, value: { effort: "high" } });

        const low = withGrok("low");
        expect(
          await low.service.resolveJob({ profileId: "personal", jobId: "historyEditing" })
        ).toMatchObject({ ok: true, value: { effort: "low" } });

        const unset = withGrok();
        expect(
          await unset.service.resolveJob({ profileId: "personal", jobId: "historyEditing" })
        ).toMatchObject({ ok: true, value: { effort: null } });
      });

      it("names the model once the agent's list has been read", async () => {
        const { service } = withGrok();
        expect(
          await service.resolveJob({ profileId: "personal", jobId: "historyEditing" })
        ).toMatchObject({ ok: true, value: { model: "grok-4", modelLabel: null } });

        await service.acpModels("personal", "grok");
        expect(
          await service.resolveJob({ profileId: "personal", jobId: "historyEditing" })
        ).toMatchObject({ ok: true, value: { model: "grok-4", modelLabel: "Grok 4" } });
      });

      it("answers unavailable for an enabled agent that is not installed", async () => {
        const { service, deps } = withGrok();
        deps.discoverAcp.mockResolvedValue([]);
        expect(
          await service.resolveJob({ profileId: "personal", jobId: "historyEditing" })
        ).toMatchObject({
          ok: false,
          error: { code: "unavailable", message: "Grok is enabled but not installed." }
        });
      });

      it("runs a job on Codex once its agent is disabled, as its Settings row says", async () => {
        const { service, configure } = withGrok();
        configure("personal", (s) => {
          s.acp.enabledAgentIds = [];
        });
        expect(
          await service.resolveJob({ profileId: "personal", jobId: "historyEditing" })
        ).toMatchObject({ ok: true, value: { backend: { kind: "codex" } } });
      });
    });
  });

  describe("dispose", () => {
    it("stops probes in flight, runs the owner's cleanup, and forgets cached answers", async () => {
      const { service, deps } = harness();
      await service.discoverCodex("personal");
      const probeSignal = deps.discoverCodex.mock.calls[0]?.[0].signal;
      expect(probeSignal?.aborted).toBe(false);

      service.dispose();

      expect(probeSignal?.aborted).toBe(true);
      expect(deps.onDispose).toHaveBeenCalledTimes(1);
      await service.discoverCodex("personal");
      expect(deps.discoverCodex).toHaveBeenCalledTimes(2);
    });
  });
});
