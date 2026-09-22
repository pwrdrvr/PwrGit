import {
  AI_GUIDANCE_MAX_LENGTH,
  DEFAULT_AI_PROVIDER_SETTINGS,
  type AiProviderSettings
} from "@pwrgit/shared";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "../persistence/db";
import { ProfileService } from "../profiles/profile-service";
import {
  AiProviderSettingsStore,
  applyAiProviderSettingsPatch,
  normalizeStoredAiProviderSettings,
  sanitizeAiProviderSettingsPatch
} from "./ai-provider-settings";

// Path validation follows the host platform, so fixtures do too: the suite
// runs on the Windows CI runner as well.
const WINDOWS = process.platform === "win32";
const abs = (name: string): string => (WINDOWS ? `C:\\tools\\${name}` : `/usr/local/bin/${name}`);
const pathOfLength = (length: number): string => {
  const root = WINDOWS ? "C:\\" : "/";
  return root + "a".repeat(length - root.length);
};

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("sanitizeAiProviderSettingsPatch", () => {
  it("answers an empty patch for anything that is not a record", () => {
    for (const value of [undefined, null, "codex", 42, [], [{ guidance: "x" }]]) {
      expect(sanitizeAiProviderSettingsPatch(value)).toEqual({});
    }
  });

  it("drops unknown keys, unknown agents and Gemini everywhere they can appear", () => {
    expect(
      sanitizeAiProviderSettingsPatch({
        nonsense: true,
        codex: { mode: "manual", extra: 1 },
        acp: {
          enabledAgentIds: ["gemini", "codex", "grok", "grok", 7, "GROK"],
          agents: {
            gemini: { overridePath: abs("gemini") },
            bogus: { overridePath: abs("bogus") },
            kimi: { overridePath: abs("kimi"), sneaky: "x" }
          }
        },
        jobs: {
          nonsenseJob: { provider: "codex" },
          rebaseReview: { provider: "gemini", model: "has spaces", reasoning: "HIGH" }
        }
      })
    ).toEqual({
      acp: {
        // De-duplicated too: a doubled id would render a doubled row.
        enabledAgentIds: ["grok"],
        agents: { kimi: { overridePath: abs("kimi") } }
      }
    });
  });

  it("keeps every clear, because a dropped clear leaves a choice no control can remove", () => {
    const clears = {
      codex: { pinnedPath: "", authProfile: null },
      acp: { enabledAgentIds: [], agents: { grok: { overridePath: "", selectedPath: "" } } },
      jobs: { rebaseReview: { provider: "", model: "", reasoning: "" } },
      guidance: ""
    };
    expect(sanitizeAiProviderSettingsPatch(clears)).toEqual(clears);
  });

  it("reads a blanked path field as a clear", () => {
    expect(sanitizeAiProviderSettingsPatch({ codex: { pinnedPath: "   " } })).toEqual({
      codex: { pinnedPath: "" }
    });
  });

  it("keeps an absolute path, trimmed", () => {
    expect(
      sanitizeAiProviderSettingsPatch({ codex: { mode: "pinned", pinnedPath: `  ${abs("codex")}\n` } })
    ).toEqual({ codex: { mode: "pinned", pinnedPath: abs("codex") } });
  });

  it("rejects a relative path, which would spawn against main's working directory", () => {
    for (const pinnedPath of ["codex", "bin/codex", "./codex", "../codex"]) {
      expect(sanitizeAiProviderSettingsPatch({ codex: { pinnedPath } })).toEqual({});
    }
  });

  it("rejects a path carrying a NUL or a second line", () => {
    expect(sanitizeAiProviderSettingsPatch({ codex: { pinnedPath: abs("co\0dex") } })).toEqual({});
    expect(
      sanitizeAiProviderSettingsPatch({ codex: { pinnedPath: `${abs("codex")}\n--yolo` } })
    ).toEqual({});
  });

  it("bounds a path's length", () => {
    expect(sanitizeAiProviderSettingsPatch({ codex: { pinnedPath: pathOfLength(4096) } })).toEqual({
      codex: { pinnedPath: pathOfLength(4096) }
    });
    expect(sanitizeAiProviderSettingsPatch({ codex: { pinnedPath: pathOfLength(4097) } })).toEqual(
      {}
    );
  });

  it("applies the same path rule to an agent's override and pinned install", () => {
    expect(
      sanitizeAiProviderSettingsPatch({
        acp: {
          agents: {
            grok: { overridePath: "grok", selectedPath: abs("grok") },
            // Nothing valid left: the agent is dropped rather than sent as {}.
            qwen: { overridePath: "qwen", selectedPath: 7 }
          }
        }
      })
    ).toEqual({ acp: { agents: { grok: { selectedPath: abs("grok") } } } });
  });

  it("keeps a well-formed Codex auth profile name, trimmed", () => {
    expect(sanitizeAiProviderSettingsPatch({ codex: { authProfile: " work_2 " } })).toEqual({
      codex: { authProfile: "work_2" }
    });
  });

  it("keeps the System default ('') distinct from following the profile (null)", () => {
    expect(sanitizeAiProviderSettingsPatch({ codex: { authProfile: "" } })).toEqual({
      codex: { authProfile: "" }
    });
    expect(sanitizeAiProviderSettingsPatch({ codex: { authProfile: null } })).toEqual({
      codex: { authProfile: null }
    });
  });

  it("rejects auth profile names that are not a Codex profile directory name", () => {
    for (const authProfile of ["Work", "../work", "work/../x", "con", "a".repeat(33), 7]) {
      expect(sanitizeAiProviderSettingsPatch({ codex: { authProfile } })).toEqual({});
    }
  });

  it("shape-checks a job's provider, model and reasoning", () => {
    expect(
      sanitizeAiProviderSettingsPatch({
        jobs: {
          rebaseReview: {
            // Allowed here even though this job is Codex-only: which provider
            // a job may run on is effectiveJobProvider's call, at read time.
            provider: "grok",
            model: "openai/gpt-5.1-codex:latest",
            reasoning: "xhigh"
          }
        }
      })
    ).toEqual({
      jobs: {
        rebaseReview: { provider: "grok", model: "openai/gpt-5.1-codex:latest", reasoning: "xhigh" }
      }
    });
    expect(
      sanitizeAiProviderSettingsPatch({
        jobs: {
          rebaseReview: { provider: "claude", model: "m".repeat(201), reasoning: "r".repeat(41) }
        }
      })
    ).toEqual({});
  });

  it("strips control characters from guidance but keeps its line breaks and tabs", () => {
    expect(
      sanitizeAiProviderSettingsPatch({
        guidance: "Prefer\tsmall commits.\nNo\u0000 bells\u0007, no \u001b[31mcolor\u007f."
      })
    ).toEqual({ guidance: "Prefer\tsmall commits.\nNo bells, no [31mcolor." });
  });

  it("stores guidance line breaks as LF and drops C1 controls", () => {
    // A Windows textarea hands back CRLF; a lone CR is an old-Mac break.
    expect(
      sanitizeAiProviderSettingsPatch({ guidance: "One\r\nTwo\rThree\u0085\u009b." }).guidance
    ).toBe("One\nTwo\nThree.");
  });

  it("caps guidance, counting only the characters that survive stripping", () => {
    expect(
      sanitizeAiProviderSettingsPatch({ guidance: "a".repeat(AI_GUIDANCE_MAX_LENGTH + 50) }).guidance
    ).toHaveLength(AI_GUIDANCE_MAX_LENGTH);
    expect(
      sanitizeAiProviderSettingsPatch({
        guidance: "\u0000".repeat(100) + "b".repeat(AI_GUIDANCE_MAX_LENGTH)
      }).guidance
    ).toBe("b".repeat(AI_GUIDANCE_MAX_LENGTH));
  });

  it("drops guidance that is not text", () => {
    expect(sanitizeAiProviderSettingsPatch({ guidance: ["x"] })).toEqual({});
  });

  it("keeps a boolean switch and nothing that merely looks like one", () => {
    expect(sanitizeAiProviderSettingsPatch({ enabled: false })).toEqual({ enabled: false });
    expect(sanitizeAiProviderSettingsPatch({ enabled: true })).toEqual({ enabled: true });
    for (const enabled of ["true", 1, null]) {
      expect(sanitizeAiProviderSettingsPatch({ enabled })).toEqual({});
    }
  });

  it("keeps a consent time only when it is a zoned ISO instant, stored as UTC", () => {
    expect(
      sanitizeAiProviderSettingsPatch({ consentAcceptedAt: "2026-09-01T14:00:00+02:00" })
    ).toEqual({ consentAcceptedAt: "2026-09-01T12:00:00.000Z" });
    for (const consentAcceptedAt of [
      "1",
      "2026-09-01",
      "2026-09-01T12:00:00",
      "2026-13-45T99:00:00Z",
      "yesterday",
      Date.now(),
      null
    ]) {
      expect(sanitizeAiProviderSettingsPatch({ consentAcceptedAt })).toEqual({});
    }
  });
});

describe("applyAiProviderSettingsPatch", () => {
  function configured(): AiProviderSettings {
    return {
      enabled: true,
      consentAcceptedAt: "2026-09-01T12:00:00.000Z",
      codex: { mode: "pinned", pinnedPath: abs("codex"), authProfile: "work" },
      acp: {
        enabledAgentIds: ["grok", "qwen"],
        agents: { grok: { overridePath: abs("grok-custom") }, qwen: { selectedPath: abs("qwen") } }
      },
      jobs: { rebaseReview: { provider: "codex", model: "gpt-5", reasoning: "high" } },
      guidance: "Be brief."
    };
  }

  it("leaves everything alone for an empty patch, without mutating its input", () => {
    const current = deepFreeze(configured());
    expect(applyAiProviderSettingsPatch(current, {})).toEqual(configured());
  });

  it("merges Codex field by field, so one control's write keeps the others' choices", () => {
    const next = applyAiProviderSettingsPatch(configured(), { codex: { mode: "auto" } });
    expect(next.codex).toEqual({ mode: "auto", pinnedPath: abs("codex"), authProfile: "work" });
  });

  it("turns authProfile null into following the profile, and keeps '' as the System default", () => {
    expect(
      applyAiProviderSettingsPatch(configured(), { codex: { authProfile: null } }).codex
    ).not.toHaveProperty("authProfile");
    expect(
      applyAiProviderSettingsPatch(configured(), { codex: { authProfile: "" } }).codex.authProfile
    ).toBe("");
  });

  it("merges an agent's path preferences field by field and deletes cleared ones", () => {
    let settings = applyAiProviderSettingsPatch(configured(), {
      acp: { agents: { grok: { selectedPath: abs("grok") } } }
    });
    expect(settings.acp.agents.grok).toEqual({
      overridePath: abs("grok-custom"),
      selectedPath: abs("grok")
    });

    settings = applyAiProviderSettingsPatch(settings, { acp: { agents: { grok: { overridePath: "" } } } });
    expect(settings.acp.agents.grok).toEqual({ selectedPath: abs("grok") });

    // With nothing chosen the agent is back to auto, stored as no entry at all.
    settings = applyAiProviderSettingsPatch(settings, { acp: { agents: { grok: { selectedPath: "" } } } });
    expect(settings.acp.agents).not.toHaveProperty("grok");
    expect(settings.acp.agents.qwen).toEqual({ selectedPath: abs("qwen") });
  });

  it("replaces the enabled list only when the patch carries one", () => {
    expect(
      applyAiProviderSettingsPatch(configured(), { guidance: "x" }).acp.enabledAgentIds
    ).toEqual(["grok", "qwen"]);
    expect(
      applyAiProviderSettingsPatch(configured(), { acp: { enabledAgentIds: [] } }).acp
        .enabledAgentIds
    ).toEqual([]);
  });

  it("merges a job's choices and turns each clear into an absence", () => {
    const next = applyAiProviderSettingsPatch(configured(), {
      jobs: { rebaseReview: { model: "", reasoning: "low" } }
    });
    expect(next.jobs.rebaseReview).toEqual({ provider: "codex", reasoning: "low" });

    const cleared = applyAiProviderSettingsPatch(next, {
      jobs: { rebaseReview: { provider: "", reasoning: "" } }
    });
    expect(cleared.jobs.rebaseReview).toEqual({});
  });

  it("is off by default, and cannot be switched on before the disclosure was accepted", () => {
    expect(DEFAULT_AI_PROVIDER_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_AI_PROVIDER_SETTINGS.consentAcceptedAt).toBeNull();
    const refused = applyAiProviderSettingsPatch(DEFAULT_AI_PROVIDER_SETTINGS, { enabled: true });
    expect(refused.enabled).toBe(false);
    expect(refused.consentAcceptedAt).toBeNull();
  });

  it("switches on with the disclosure's acceptance, and keeps that acceptance across off and on", () => {
    const on = applyAiProviderSettingsPatch(DEFAULT_AI_PROVIDER_SETTINGS, {
      enabled: true,
      consentAcceptedAt: "2026-09-01T12:00:00.000Z"
    });
    expect(on).toMatchObject({ enabled: true, consentAcceptedAt: "2026-09-01T12:00:00.000Z" });
    const off = applyAiProviderSettingsPatch(on, { enabled: false });
    expect(off).toMatchObject({ enabled: false, consentAcceptedAt: "2026-09-01T12:00:00.000Z" });
    expect(applyAiProviderSettingsPatch(off, { enabled: true }).enabled).toBe(true);
  });

  it("leaves the switch where it was when a patch is about something else", () => {
    expect(applyAiProviderSettingsPatch(configured(), { guidance: "x" }).enabled).toBe(true);
    expect(
      applyAiProviderSettingsPatch(DEFAULT_AI_PROVIDER_SETTINGS, { guidance: "x" }).enabled
    ).toBe(false);
  });

  it("clears guidance with '' and keeps it when the patch is silent", () => {
    expect(applyAiProviderSettingsPatch(configured(), { guidance: "" }).guidance).toBe("");
    expect(applyAiProviderSettingsPatch(configured(), { codex: { mode: "auto" } }).guidance).toBe(
      "Be brief."
    );
  });
});

describe("normalizeStoredAiProviderSettings", () => {
  it("answers the defaults for corrupt or foreign values", () => {
    for (const value of [null, "junk", 42, [], { codex: "pinned", acp: 3, jobs: [] }]) {
      expect(normalizeStoredAiProviderSettings(value)).toEqual(DEFAULT_AI_PROVIDER_SETTINGS);
    }
  });

  it("round-trips a well-formed stored row unchanged", () => {
    const stored: AiProviderSettings = {
      enabled: true,
      consentAcceptedAt: "2026-09-01T12:00:00.000Z",
      codex: { mode: "pinned", pinnedPath: abs("codex"), authProfile: "" },
      acp: {
        enabledAgentIds: ["qwen", "kimi"],
        agents: { kimi: { overridePath: abs("kimi"), selectedPath: abs("kimi-2") } }
      },
      jobs: { rebaseReview: { provider: "codex", model: "gpt-5", reasoning: "medium" } },
      guidance: "Line one.\n\tIndented."
    };
    expect(normalizeStoredAiProviderSettings(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });

  it("reads a stored switch that is on without an acceptance as off", () => {
    expect(normalizeStoredAiProviderSettings({ enabled: true }).enabled).toBe(false);
    expect(
      normalizeStoredAiProviderSettings({ enabled: true, consentAcceptedAt: "not a time" }).enabled
    ).toBe(false);
  });

  it("makes a stored Gemini choice disappear, wherever it was written", () => {
    const next = normalizeStoredAiProviderSettings({
      acp: {
        enabledAgentIds: ["gemini", "kimi"],
        agents: { gemini: { overridePath: abs("gemini") } }
      },
      jobs: { rebaseReview: { provider: "gemini" } }
    });
    expect(next.acp).toEqual({ enabledAgentIds: ["kimi"], agents: {} });
    expect(next.jobs.rebaseReview).toEqual({});
  });

  it("never hands out the shared defaults object", () => {
    const next = normalizeStoredAiProviderSettings(null);
    next.acp.enabledAgentIds.push("grok");
    next.jobs.rebaseReview.model = "mutated";
    expect(DEFAULT_AI_PROVIDER_SETTINGS.acp.enabledAgentIds).toEqual([]);
    expect(DEFAULT_AI_PROVIDER_SETTINGS.jobs.rebaseReview).toEqual({});
  });
});

describe("AiProviderSettingsStore", () => {
  const databases: DB[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function fixture() {
    const db = openDatabase(":memory:");
    databases.push(db);
    const profiles = new ProfileService(db);
    const work = profiles.create({ name: "Work", email: "work@example.com" });
    const personal = profiles.create({ name: "Personal", email: "me@example.com" });
    return { db, profiles, store: new AiProviderSettingsStore(db), work, personal };
  }

  function storedRow(db: DB, key: string): string | undefined {
    return (
      db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
        | { value: string }
        | undefined
    )?.value;
  }

  it("reads the defaults for a profile that never saved any, as a private copy", () => {
    const { store, work } = fixture();
    const first = store.read(work.id);
    expect(first).toEqual(DEFAULT_AI_PROVIDER_SETTINGS);
    first.acp.enabledAgentIds.push("grok");
    expect(store.read(work.id).acp.enabledAgentIds).toEqual([]);
  });

  it("stores settings in the profile's own app_meta namespace", () => {
    const { db, store, work } = fixture();
    const saved = store.update(work.id, { codex: { authProfile: "work" } });
    const raw = storedRow(db, `profile:${work.id}:ai-providers`);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw ?? "null")).toEqual(saved);
  });

  it("merges successive single-field writes and reads them back", () => {
    const { store, work } = fixture();
    store.update(work.id, { acp: { enabledAgentIds: ["kimi"] } });
    store.update(work.id, { jobs: { rebaseReview: { reasoning: "high" } } });
    const read = store.read(work.id);
    expect(read.acp.enabledAgentIds).toEqual(["kimi"]);
    expect(read.jobs.rebaseReview).toEqual({ reasoning: "high" });
  });

  it("keeps each profile's settings apart", () => {
    const { store, work, personal } = fixture();
    store.update(work.id, { codex: { authProfile: "work" }, guidance: "Work voice." });
    expect(store.read(personal.id)).toEqual(DEFAULT_AI_PROVIDER_SETTINGS);
    expect(store.read(work.id).guidance).toBe("Work voice.");
  });

  it("reads a corrupt row as the defaults, and the next write repairs it", () => {
    const { db, store, work } = fixture();
    db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?)").run(
      `profile:${work.id}:ai-providers`,
      "{not json"
    );
    expect(store.read(work.id)).toEqual(DEFAULT_AI_PROVIDER_SETTINGS);

    store.update(work.id, { guidance: "repaired" });
    expect(store.read(work.id).guidance).toBe("repaired");
  });

  it("narrows a hand-edited row on the way out", () => {
    const { db, store, work } = fixture();
    db.prepare("INSERT INTO app_meta (key, value) VALUES (?, ?)").run(
      `profile:${work.id}:ai-providers`,
      JSON.stringify({ acp: { enabledAgentIds: ["gemini", "qwen"] }, codex: { pinnedPath: "codex" } })
    );
    const read = store.read(work.id);
    expect(read.acp.enabledAgentIds).toEqual(["qwen"]);
    expect(read.codex.pinnedPath).toBe("");
  });

  it("is removed with its profile, and only its profile", () => {
    // Deletion clears the `profile:<id>:` namespace without knowing this key;
    // the settings must live inside it for that to cover them.
    const { db, profiles, store, work, personal } = fixture();
    store.update(work.id, { guidance: "work" });
    store.update(personal.id, { guidance: "personal" });

    const deleted = profiles.delete({ profileId: work.id, expectedName: work.name });
    expect(deleted.ok).toBe(true);

    expect(storedRow(db, `profile:${work.id}:ai-providers`)).toBeUndefined();
    expect(store.read(personal.id).guidance).toBe("personal");
  });
});
