# main/ai — AGENTS.md

Outbound agents: the Codex CLI and ACP agents PwrGit hands work to. Not to be
confused with `../agent-access/` and `../local-agents/` (Settings → Local
Agents), which govern agents calling *into* PwrGit over MCP. Ported from
PwrSnap's AI provider settings; keep the file and class names aligned with
PwrSnap so fixes can move between the two.

## One owner: `AiProviderService`

`index.ts` builds exactly one (`createAiProviderService`) and registers the
`aiProviders:*` handlers on it. Everything that needs an agent asks this
service; nothing else calls `discoverCodexCommands` or
`discoverLocalAcpAgentInstances`. Two owners would mean two caches, two sets
of probes, and a Settings screen describing a binary other than the one a job
runs.

**A feature runs a job through `resolveJob`**:

```ts
const job = await aiProviders.resolveJob({ profileId, jobId: "rebaseReview", signal });
if (!job.ok) return job;            // unavailable | signed_out | cancelled | discovery_failed
const { backend, model, effort, guidance } = job.value;
// backend.kind === "codex": spawn backend.command with backend.env
// backend.kind === "acp":   hand backend.agent + backend.strategy to the kit
```

- `backend.env` is complete: the profile's CODEX_HOME and `PWRGIT_PROFILE_ID`
  are already applied. Pass it through; don't rebuild it with
  `agentEnvForPwrGitProfile`.
- `model` / `effort` of `null` mean "the backend's default". Keep the job's own
  fallback (rebase review's is `effort: "low"`) for that case.
- ACP efforts are already collapsed to `"low" | "high"` (`acp-effort.ts`).
- `guidance` is the operator's free text. Append it to the prompt as
  preferences. It never widens what a job may do: tools, sandbox and the
  output schema stay the job's.
- The provider comes from `effectiveJobProvider`, which Settings uses too. That
  is why the provider a row shows and the one that runs cannot disagree.

For display, `discoverCodex` and `discoverAcp` serve the same cached answers as
Settings.

## Settings are per profile

They are stored in `app_meta` under `profile:<id>:ai-providers`
(`ai-provider-settings.ts`), inside the profile's reserved namespace, so
`ProfileService.delete` clears them without knowing the key exists. Every write
and every read off disk goes through `sanitizeAiProviderSettingsPatch`. Paths
must be absolute (`isAbsoluteExecutablePath`), because they are spawned
without a shell.

Discovery is cached by its inputs: the Codex mode, the pinned path and the
account; the enabled agents and their paths. So two profiles with identical
inputs share one probe, and a changed setting is a plain cache miss, with no
invalidation step to forget. For that reason a cached probe carries **no
environment**: the env holds the caller's `PWRGIT_PROFILE_ID`, and each call
joins the shared probe with its own. A cached env once handed the first
profile's id to every later profile's job.

## A job declares whether ACP may run it

`AI_JOBS[jobId].acp` lives in `packages/shared/src/ai-providers.ts`.
`rebaseReview` is `false`: its session runs with no tools, and an ACP agent
can't be held to that. A stored ACP choice on such a job resolves to Codex. It
never resolves to the agent. Before flipping the flag on a new job, show that
the job's boundary holds on the ACP path.

## No Gemini

Gemini is not a PwrGit agent: it doesn't work. It is absent from
`BUILT_IN_ACP_AGENT_IDS`, `PWRGIT_ACP_STRATEGIES` filters it out of the kit's
strategies, and the sanitizer drops it from stored settings. Don't add it back
as a disabled entry. Tests assert that it is absent.
