import { DEFAULT_AI_PROVIDER_SETTINGS, type AiProviderSettingsSnapshot } from "@pwrgit/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  shell: { openExternal: vi.fn(async () => undefined) }
}));
// The bus logs every failed Result; these tests fail commands on purpose.
vi.mock("../logs", () => ({ logMain: vi.fn() }));

import { CommandBus } from "../command-bus";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import { registerAiProviderHandlers } from "./ai-provider-handlers";
import { AiProviderService, type AiProviderServiceDependencies } from "./ai-provider-service";
import { AiProviderSettingsStore } from "./ai-provider-settings";

type Deps = AiProviderServiceDependencies;

const databases: DB[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const profiles = new ProfileService(db);
  const work = profiles.create({ name: "Work", email: "work@example.com" });
  const store = new AiProviderSettingsStore(db);
  const deps = {
    settings: store,
    discoverCodex: vi.fn<Deps["discoverCodex"]>(async () => ({
      candidates: [
        { command: "/usr/local/bin/codex", source: "path", executable: true, selected: true }
      ]
    })),
    checkCodexAuth: vi.fn<Deps["checkCodexAuth"]>(async (params) => ({
      profile: params.profile,
      codexHome: params.codexHome,
      authenticated: true,
      status: "authenticated",
      outcome: "answered"
    })),
    discoverAcp: vi.fn<Deps["discoverAcp"]>(async () => []),
    listCodexModels: vi.fn<Deps["listCodexModels"]>(async () => []),
    listAcpModels: vi.fn<Deps["listAcpModels"]>(async () => []),
    listCodexAuthProfiles: vi.fn<Deps["listCodexAuthProfiles"]>(() => ({
      profileRoot: "/home/me/.codex/profiles",
      effectiveCodexHome: "/home/me/.codex",
      profiles: []
    })),
    startCodexLogin: vi.fn<Deps["startCodexLogin"]>(async (params) => ({
      profile: params.profile,
      codexHome: params.codexHome,
      started: true
    })),
    environmentFor: vi.fn<Deps["environmentFor"]>((profileId) => ({
      env: { CODEX_HOME: "/home/me/.codex", PWRGIT_PROFILE_ID: profileId },
      codexHome: "/home/me/.codex",
      authProfile: ""
    })),
    acpModelCache: { load: () => undefined, save: () => undefined },
    codexModelCache: { load: () => undefined, save: () => undefined, findLabel: () => undefined },
    scratchDir: "/tmp/pwrgit-agent",
    now: () => 0,
    maxAgeMs: 60_000,
    discoveryDisabled: false
  } satisfies Deps;
  const onChanged = vi.fn<(snapshot: AiProviderSettingsSnapshot) => void>();
  const bus = new CommandBus();
  registerAiProviderHandlers(bus, {
    service: new AiProviderService(deps),
    store,
    profiles,
    onChanged
  });
  return { bus, db, deps, onChanged, store, work };
}

describe("aiProviders handlers", () => {
  it("refuses every command for a profile that does not exist, before probing anything", async () => {
    const { bus, deps } = fixture();
    const profileId = "ghost";

    const results = await Promise.all([
      bus.dispatch("aiProviders:read", { profileId }),
      bus.dispatch("aiProviders:update", { profileId, patch: { guidance: "x" } }),
      bus.dispatch("aiProviders:discoverCodex", { profileId }),
      bus.dispatch("aiProviders:discoverAcp", { profileId }),
      bus.dispatch("aiProviders:codexModels", { profileId }),
      bus.dispatch("aiProviders:acpModels", { profileId, agentId: "grok" }),
      bus.dispatch("aiProviders:codexAuthProfiles", { profileId }),
      bus.dispatch("aiProviders:codexLogin", { profileId })
    ]);

    for (const result of results) {
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "validation", code: "unknown_profile" }
      });
    }
    expect(deps.discoverCodex).not.toHaveBeenCalled();
    expect(deps.discoverAcp).not.toHaveBeenCalled();
    expect(deps.startCodexLogin).not.toHaveBeenCalled();
  });

  it("writes no row for a profile that does not exist, so none is left for a recycled id", async () => {
    const { bus, db, onChanged } = fixture();

    await bus.dispatch("aiProviders:update", { profileId: "ghost", patch: { guidance: "x" } });

    const rows = db
      .prepare("SELECT key FROM app_meta WHERE key LIKE 'profile:ghost:%'")
      .all() as { key: string }[];
    expect(rows).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("refuses a profile id that is not a string", async () => {
    const { bus } = fixture();
    expect(
      await bus.dispatch("aiProviders:read", { profileId: 42 as unknown as string })
    ).toMatchObject({ ok: false, error: { code: "unknown_profile" } });
  });

  it("reads a profile's settings as a snapshot", async () => {
    const { bus, work } = fixture();
    expect(await bus.dispatch("aiProviders:read", { profileId: work.id })).toEqual({
      ok: true,
      value: { profileId: work.id, settings: DEFAULT_AI_PROVIDER_SETTINGS }
    });
  });

  it("narrows an update, persists it, and hands the fresh snapshot to onChanged", async () => {
    const { bus, onChanged, store, work } = fixture();

    const result = await bus.dispatch("aiProviders:update", {
      profileId: work.id,
      // Shaped like the renderer's type, carrying what IPC can smuggle in.
      patch: {
        acp: { enabledAgentIds: ["gemini", "kimi"] as never },
        codex: { pinnedPath: "bin/codex" },
        guidance: "Be brief.\u0007"
      }
    });

    const expected = {
      profileId: work.id,
      settings: {
        ...DEFAULT_AI_PROVIDER_SETTINGS,
        acp: { enabledAgentIds: ["kimi"], agents: {} },
        guidance: "Be brief."
      }
    };
    expect(result).toEqual({ ok: true, value: expected });
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(expected);
    expect(store.read(work.id)).toEqual(expected.settings);
  });

  it("refuses an agent PwrGit does not offer before the service can start it", async () => {
    const { bus, deps, store, work } = fixture();
    store.update(work.id, { acp: { enabledAgentIds: ["grok"] } });

    const result = await bus.dispatch("aiProviders:acpModels", {
      profileId: work.id,
      agentId: "gemini" as never
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "validation", code: "unknown_agent" } });
    expect(deps.discoverAcp).not.toHaveBeenCalled();
    expect(deps.listAcpModels).not.toHaveBeenCalled();
  });

  it("answers a Codex discovery that throws with a discovery_failed Result", async () => {
    const { bus, deps, work } = fixture();
    deps.discoverCodex.mockRejectedValue(new Error("spawn codex EACCES"));

    const result = await bus.dispatch("aiProviders:discoverCodex", { profileId: work.id });

    // `handler_threw` would mean the throw escaped to the bus's backstop.
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "agent", code: "discovery_failed", message: "spawn codex EACCES" }
    });
  });

  it("answers an ACP discovery that throws with a discovery_failed Result", async () => {
    const { bus, deps, work } = fixture();
    deps.discoverAcp.mockRejectedValue({ reason: "no message here" });

    expect(await bus.dispatch("aiProviders:discoverAcp", { profileId: work.id })).toMatchObject({
      ok: false,
      error: { code: "discovery_failed", message: "Agent discovery failed." }
    });
  });

  it("passes Refresh through as a forced re-probe", async () => {
    const { bus, deps, work } = fixture();
    await bus.dispatch("aiProviders:discoverCodex", { profileId: work.id });
    await bus.dispatch("aiProviders:discoverCodex", { profileId: work.id });
    expect(deps.discoverCodex).toHaveBeenCalledTimes(1);

    await bus.dispatch("aiProviders:discoverCodex", { profileId: work.id, force: true });
    expect(deps.discoverCodex).toHaveBeenCalledTimes(2);
  });

  it("returns the service's own Result for model listing", async () => {
    const { bus, deps, work } = fixture();
    deps.discoverCodex.mockResolvedValue({ candidates: [] });
    expect(await bus.dispatch("aiProviders:codexModels", { profileId: work.id })).toMatchObject({
      ok: false,
      error: { code: "codex_unavailable" }
    });
  });
});
