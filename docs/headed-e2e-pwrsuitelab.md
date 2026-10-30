# Headed E2E in PwrSuiteLab

Operator procedure for running PwrGit's Playwright suite headed on the
dedicated PwrSuiteLab E2E VM. Writing or debugging specs is covered by
[apps/desktop/e2e/AGENTS.md](../apps/desktop/e2e/AGENTS.md).

## Through PwrSuiteLab Control MCP

Prefer the available **PwrSuiteLab Control MCP**. Discover its live tools and
input schemas, then read its served `manage-pwrlab-e2e` skill: `skills/list` →
`skills/get` → `resources/read` (older clients: `resources/list` →
`resources/read`, using `skill://manage-pwrlab-e2e/SKILL.md`). In PwrAgent,
discover connected tools with `search_mcp_tools` and invoke them through
`call_mcp_tool`. Keep Control open. Its Operate grant authorizes exposed MCP
actions without per-operation native confirmation; Read only does not.
Controller ownership, target, and transport checks still apply.

1. Call `lab_status` and use the exact dedicated E2E target from `roles.e2e`.
   Never select a GHA runner, base image, or the physical Mac desktop. Check
   status again before submitting: idle shutdown or another owner can change
   state while you prepare. `lab_e2e_run` starts the configured VM if needed.
2. Inspect this checkout's `.nvmrc`, `packageManager`, scripts and lockfile.
   Commit authorized changes and verify the **exact absolute worktree path**
   is clean; never discard changes to achieve that. Control stages committed
   HEAD plus locally available submodule/LFS content. Host environments,
   ignored files and Git credentials do not travel. No GitHub push or existing
   guest PwrGit checkout is required; the repository must be local to Control.
3. Supply top-level `agent_name`, `project_name`, and `thread_name` on **both**
   `lab_e2e_run` and `lab_e2e_acquire`, including runs consuming a reservation.
   Use the real caller, `PwrGit`, and current thread title (or a descriptive task
   title). If applicable and known, `pr_number` is a decimal **string**; omit
   it otherwise. These are display labels, not authorization. Keep paths,
   credentials and private access URLs out of attribution.
4. Submit a `job` with `repository`, ordered `setup` argv arrays, test `command`
   argv, bounded checkout-relative `artifacts`, and a timeout covering setup
   plus testing (maximum 14400 seconds). Commands run **only in the guest**.
   Shell functions/compound commands require an explicit `["bash", "-c", "…"]`.
   Select the repository's Node version and install its dependencies in setup;
   never copy another product's build recipe or install tools on the host.

Example job shape below assumes nvm is already present in the guest. Replace
the target, repository, attribution and test selector before submission; add
`pr_number` only when known. If the runtime manager is missing, follow the
served skill's guest-only setup guidance.

```json
{
  "target": "<exact E2E target from lab_status>",
  "agent_name": "PwrAgent",
  "project_name": "PwrGit",
  "thread_name": "Verify desktop startup",
  "job": {
    "repository": "/absolute/path/to/clean/PwrGit/worktree",
    "setup": [["bash", "-c", "set -e; source ~/.nvm/nvm.sh; nvm install; nvm use; corepack enable; pnpm install --frozen-lockfile"]],
    "command": ["bash", "-c", "set -e; source ~/.nvm/nvm.sh; nvm use; pnpm test:desktop-e2e --grep 'startup'"],
    "artifacts": ["apps/desktop/test-results"],
    "timeout_seconds": 3600
  }
}
```

`test:desktop-e2e` builds the Electron app through `pretest:e2e`. The install
stages both native artifacts. Use the narrowest useful test selection and
request only relevant output directories, never the entire checkout or secrets.
The default reporter is `list`; request an HTML report only if you enable it.

Keep the returned request ID **and `run_id`**. Poll `lab_request_status` with
the request ID; a completed launch request or `job_state: running` does not
mean tests passed. Use `lab_e2e_collect` with the exact target and returned
`run_id` for run progress and artifacts; poll its request ID if still executing.
Read `e2e.log` and requested artifacts under the returned `artifact_directory`
(relative to the selected PwrSuiteLab checkout). Report tested commit, exit
code, and artifact completeness; distinguish checkout/setup/baseline failures
from test failures. Keep raw logs and artifacts out of Git. If the VM stopped,
use `lab_e2e_start` on that target before collecting the saved run; never rerun
tests just to retrieve results.

## Schema errors, ownership and recovery

For `Invalid tool or arguments` or an invalid-arguments response, refresh the
live schema and inspect missing fields/types, especially caller attribution.
This is a schema mismatch to diagnose, not evidence that Operate was revoked.
Do not repeatedly resubmit the same invalid payload, reconnect to change
ownership, or bypass a refusal with scripts/SSH. If a tool is genuinely absent
or authorization is explicitly denied, report that separately.

No acquire is needed before a run. Control consumes this OAuth connection's
existing reservation atomically, or claims the display; other owners are
refused. After handoff, the guest job owns and releases its workload lock.
`lab_e2e_release` / **Release reservation** applies only to a caller-owned
reservation, never a workload lock. Use acquire/open/release for interactive
reservations, not as cleanup after a successful job handoff.

Read `lock_started_at` as UTC (`Z`) and `lock_age_seconds` as the full guest
owner-file age, independent of the chart window or Control uptime. Age alone
does not establish an orphan or an expiry. After launch/transport failure,
inspect the saved run before retrying: it may already be running. An
`interrupted` result is not a passing test. Preserve locks and use guarded
`lab_e2e_recover` for orphaned workloads; it refuses live sessions, active
reservations, malformed owners and unknown transport state. Never delete locks
manually or terminate another owner's session.

Control owns strict SSH, configured identity and pinned host trust. Do not
guess users, enumerate keys, accept new host keys, forward an SSH agent or
explore credentials. Missing VM baseline prerequisites require a separate
operator-authorized repair; test setup does not authorize rebuilding the VM,
changing allocation/network/access, or installing on the physical host.

## Script fallback only when MCP is unavailable

Read the selected PwrSuiteLab checkout's `AGENTS.md` and
`macos-tart/README.md` before using its configured controller. From the clean,
committed PwrGit worktree on the approved Tart host:

```sh
<lab>/macos-tart/run-e2e.sh --confirm-live-run --workload pwrgit \
  --local "$PWD" [playwright arguments...]
```

Replace `<lab>` and the optional arguments. Preserve the original controller
safety constraints: exact dedicated E2E guest (never a runner/base), configured
strict SSH transport and provisioning markers, host/guest display locks,
marked disposable checkout, and explicit workload. Existing sessions/locks
remain owned work. Legacy launchers cannot consume a Control reservation;
release only your own unused reservation through Control first. Preserve
controller flags and authorization requirements; never use fallback to evade
an MCP denial or validation error. Follow the lab's guarded stale-lock recovery
procedure, not manual deletion or repeated launch attempts. Record the tested
commit and collected results, leave artifacts outside Git, and stop only an
idle guest that the authorized workflow owns.

