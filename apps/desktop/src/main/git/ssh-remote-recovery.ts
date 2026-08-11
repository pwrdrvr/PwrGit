import {
  err,
  ok,
  type PwrGitError,
  type Result,
  type SshRemoteRecovery
} from "@pwrgit/shared";
import { requireExit0, type GitExec } from "./dugite";

export const SSH_RECOVERY_TEST_TIMEOUT_MS = 15_000;

// BatchMode prevents password, passphrase, and host-key confirmation prompts
// from reopening the GUI process's controlling terminal. User ~/.ssh/config,
// ssh-agent identities, ProxyJump, and host aliases still apply.
export const SSH_RECOVERY_COMMAND =
  "ssh -oBatchMode=yes -oNumberOfPasswordPrompts=0 -oConnectTimeout=10 -oConnectionAttempts=1";

export function githubHttpsToSsh(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, rawRepo] = parts;
  if (owner === undefined || rawRepo === undefined) return null;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (owner === "" || repo === "") return null;
  return `git@github.com:${owner}/${repo}.git`;
}

async function output(
  git: GitExec,
  cwd: string,
  args: string[]
): Promise<Result<string>> {
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  return checked.ok ? ok(checked.value.stdout.trim()) : checked;
}

/** Inspect only local Git config; this never contacts a remote. */
export async function inspectSshRemoteRecovery(
  git: GitExec,
  cwd: string
): Promise<Result<SshRemoteRecovery | null>> {
  const branch = await output(git, cwd, ["branch", "--show-current"]);
  if (!branch.ok) return branch;
  if (branch.value === "") return ok(null);

  const remote = await output(git, cwd, [
    "config",
    "--get",
    `branch.${branch.value}.remote`
  ]);
  if (!remote.ok) {
    return remote.error.code === "exit_1" ? ok(null) : remote;
  }
  if (remote.value === "" || remote.value === ".") return ok(null);

  const fetchUrl = await output(git, cwd, [
    "remote",
    "get-url",
    remote.value
  ]);
  if (!fetchUrl.ok) return fetchUrl;
  const sshUrl = githubHttpsToSsh(fetchUrl.value);
  if (sshUrl === null) return ok(null);

  const pushUrlsRaw = await git(
    ["config", "--get-all", `remote.${remote.value}.pushurl`],
    cwd
  );
  if (!pushUrlsRaw.ok) return pushUrlsRaw;
  if (pushUrlsRaw.value.exitCode !== 0 && pushUrlsRaw.value.exitCode !== 1) {
    const checked = requireExit0(pushUrlsRaw.value, [
      "config",
      "--get-all",
      `remote.${remote.value}.pushurl`
    ]);
    if (!checked.ok) return err(checked.error);
    return err({
      kind: "remote",
      code: "remote_config_failed",
      message: "Could not inspect the remote push URL configuration."
    });
  }
  const pushUrlWillAlsoChange = pushUrlsRaw.value.stdout.trim() === "";

  return ok({
    remote: remote.value,
    httpsUrl: fetchUrl.value,
    sshUrl,
    pushUrlWillAlsoChange
  });
}

function sameRecovery(
  current: SshRemoteRecovery | null,
  reviewed: SshRemoteRecovery
): boolean {
  return (
    current !== null &&
    current.remote === reviewed.remote &&
    current.httpsUrl === reviewed.httpsUrl &&
    current.sshUrl === reviewed.sshUrl &&
    current.pushUrlWillAlsoChange === reviewed.pushUrlWillAlsoChange
  );
}

async function revalidateRecovery(
  git: GitExec,
  cwd: string,
  reviewed: SshRemoteRecovery
): Promise<Result<SshRemoteRecovery>> {
  const inspected = await inspectSshRemoteRecovery(git, cwd);
  if (!inspected.ok) return inspected;
  if (!sameRecovery(inspected.value, reviewed)) {
    return err({
      kind: "remote",
      code: "remote_changed",
      message:
        "The checked-out branch, upstream, or remote URL changed. Pull again to inspect the current authentication failure."
    });
  }
  return ok(reviewed);
}

function sshTestFailure(stderr: string): PwrGitError {
  const detail = stderr.trim();
  if (/host key verification failed|authenticity of host/i.test(detail)) {
    return {
      kind: "remote",
      code: "ssh_host_unverified",
      message:
        "SSH could not verify github.com on this machine. Verify the GitHub SSH host key outside PwrGit, then test again."
    };
  }
  if (/permission denied|publickey|could not read from remote repository/i.test(detail)) {
    return {
      kind: "remote",
      code: "ssh_authentication_failed",
      message:
        "SSH reached GitHub but could not read this repository with the available keys."
    };
  }
  return {
    kind: "remote",
    code: "ssh_test_failed",
    message:
      "SSH could not read this repository. Check the network, SSH configuration, and repository access, then test again."
  };
}

/** Test Git ref access only. No fetch, ref update, checkout, or LFS transfer. */
export async function testSshRemoteRecovery(
  git: GitExec,
  cwd: string,
  reviewed: SshRemoteRecovery,
  timeoutMs = SSH_RECOVERY_TEST_TIMEOUT_MS
): Promise<Result<void>> {
  const valid = await revalidateRecovery(git, cwd, reviewed);
  if (!valid.ok) return valid;

  const controller = new AbortController();
  const timeoutError: PwrGitError = {
    kind: "remote",
    code: "ssh_test_timed_out",
    message: `SSH did not complete within ${Math.ceil(timeoutMs / 1_000)} seconds.`
  };
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    const raw = await git(
      ["ls-remote", "--symref", reviewed.sshUrl, "HEAD"],
      cwd,
      {
        signal: controller.signal,
        killSignal: "SIGKILL",
        env: { GIT_SSH_COMMAND: SSH_RECOVERY_COMMAND }
      }
    );
    if (!raw.ok) return raw;
    return raw.value.exitCode === 0
      ? ok(undefined)
      : err(sshTestFailure(raw.value.stderr));
  } finally {
    clearTimeout(timer);
  }
}

/** Change only the reviewed fetch URL; an explicit custom pushurl is kept. */
export async function applySshRemoteRecovery(
  git: GitExec,
  cwd: string,
  reviewed: SshRemoteRecovery
): Promise<Result<void>> {
  const valid = await revalidateRecovery(git, cwd, reviewed);
  if (!valid.ok) return valid;
  const args = ["remote", "set-url", reviewed.remote, reviewed.sshUrl];
  const raw = await git(args, cwd);
  if (!raw.ok) return raw;
  const checked = requireExit0(raw.value, args);
  if (!checked.ok) {
    return err({
      kind: "remote",
      code: "remote_update_failed",
      message: checked.error.message
    });
  }
  return ok(undefined);
}
