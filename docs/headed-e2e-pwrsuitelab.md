# Visible Electron E2E in PwrSuiteLab

Operator procedure for running PwrGit's full-app Playwright tests on the
dedicated PwrSuiteLab E2E VM. Electron opens real desktop windows even when
Playwright is invoked without `--headed`; omitting that flag does not make
`launchApp()` headless. This procedure applies to individual specs, retries,
design/docs screenshot specs and direct Playwright commands. Existing GitHub
Actions workflows keep using their configured runners. Genuinely hidden
`harness/electron-main.cjs` workflows (`show:false`, no Dock activation) can
run locally. Writing or debugging specs is covered by
[apps/desktop/e2e/AGENTS.md](../apps/desktop/e2e/AGENTS.md).

## Through PwrSuiteLab Control MCP

Use **PwrSuiteLab Control MCP** by default. Discover its live tools and
input schemas, then read its served `manage-pwrlab-e2e` skill: `skills/list` →
`skills/get` → `resources/read` (older clients: `resources/list` →
`resources/read`, using `skill://manage-pwrlab-e2e/SKILL.md`). In PwrAgent,
discover connected tools with `search_mcp_tools` and invoke them through
`call_mcp_tool`. Keep Control open. Its Operate grant authorizes exposed MCP
actions without per-operation native confirmation; Read only does not.
Controller ownership, target, and transport checks still apply.

If discovery fails, inspect `manage_mcp_connections` with `describe_thread`:
distinguish an unselected connection from `reauthorization_required`, transport
failure, or a ready connection with a missing tool. Reauthorization requires
the operator in Settings → Plugins. A tool schema error is a different failure
(see below). Report the specific blocker and keep the physical desktop free
of test windows. An inaccessible or busy VM never authorizes local E2E.

1. Call `lab_status` and use the exact dedicated E2E target from `roles.e2e`.
   Never select a GHA runner, base image, or the physical Mac desktop. Check
   status again before submitting: idle shutdown or another owner can change
   state while you prepare. A stopped VM is normal: `lab_e2e_run` starts it
   when needed. No separate `lab_e2e_start` or reservation is needed for a job.
   Guest lock/session/SSH fields that are `not_collected` while stopped stay
   unknown until Control's startup and admission checks.
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

On-demand startup can borrow one eligible configured GHA runner if both Tart
slots are occupied. Control preserves its active job for up to ten minutes;
the deadline never authorizes interruption. Missing lifecycle grants, unsafe
capacity, unknown ownership or a drain timeout must be reported. Do not
manually stop runners or submit competing lifecycle operations. Control
collects completed runs, stops only an agent-started E2E VM, and restores only
its borrowed runner. A VM already running before the request stays running.

Keep the returned request ID **and `run_id`**. Poll `lab_request_status` with
the request ID; a completed launch request or `job_state: running` does not
mean tests passed. Use `lab_e2e_collect` with the exact target and returned
`run_id` for run progress and artifacts; poll its request ID if still executing.
Read `e2e.log` and requested artifacts under the returned `artifact_directory`
(relative to the selected PwrSuiteLab checkout). Report tested commit, exit
code, and artifact completeness; distinguish checkout/setup/baseline failures
from test failures. Keep raw logs and artifacts out of Git. Collect the saved
run first even if the VM stopped: previously collected same-owner results
remain available. If collection explicitly reports `e2e_vm_stopped` because
artifacts were never collected, start that exact target when authorized
capacity permits, then collect the saved run. Never rerun tests for retrieval.

## Repository launch guard

`launchApp` checks the host before allocating test data or launching Electron.
Outside GitHub Actions, it requires macOS virtual hardware and the canonical
repository path `~/PwrLab/runs/<mcp-run-id>/checkout`, with that same run ID in
the guest display lock `~/PwrLab/locks/e2e/run-id`. This matches Control's
repository-job contract and prevents the same direct Playwright command from
opening the app on a developer's desktop. The hidden harness never calls this
guard. `CI=true` does not bypass it.

This is an accidental-launch guard, not an authorization boundary. Control
owns exact-target admission, reservations and workload ownership. Do not set
`GITHUB_ACTIONS` locally, fabricate owner files, or relax the guard to work
around an unavailable lab. A changed guest staging contract needs a reviewed
guard update; a refusal should identify that mismatch, not trigger local E2E.

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

## When MCP is unavailable

Report the connection, authorization, capacity or ownership blocker and the
validation that remains undone. Continue safe Node/unit or hidden-harness
work. Legacy script launchers use a different checkout contract and are not
an automatic fallback for guarded full-app tests. Any separate operator-led
lab repair or alternative workflow must preserve exact-target authorization,
strict SSH and existing owners; an MCP refusal never authorizes a bypass.

