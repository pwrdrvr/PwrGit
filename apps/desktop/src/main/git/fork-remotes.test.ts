import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyForkRemotes,
  forkRemoteUrl,
  planUpstreamRemote,
  readCheckoutRemotes,
  remoteProtocol,
  UPSTREAM_REMOTE
} from "./fork-remotes";
import { createSystemGit } from "./test-support/system-git";

const systemGit = createSystemGit();

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop()!, { recursive: true, force: true });
  }
});

function repoWithOrigin(originUrl: string): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-remotes-")));
  created.push(path);
  mkdirSync(path, { recursive: true });
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: path, stdio: "ignore" });
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@pwrgit.com"]);
  git(["config", "user.name", "T"]);
  git(["config", "core.autocrlf", "false"]);
  writeFileSync(join(path, "README.md"), "# test\n");
  git(["add", "."]);
  git(["commit", "-m", "init"]);
  git(["remote", "add", "origin", originUrl]);
  // What a clone leaves behind, and the thing the rewire must not disturb.
  git(["config", "branch.main.remote", "origin"]);
  git(["config", "branch.main.merge", "refs/heads/main"]);
  return path;
}

function config(path: string, key: string): string {
  return execFileSync("git", ["config", "--get", key], {
    cwd: path,
    encoding: "utf8"
  }).trim();
}

describe("remoteProtocol", () => {
  it("reads scp-style and ssh:// as SSH", () => {
    expect(remoteProtocol("git@github.com:desktop/dugite.git")).toBe("ssh");
    expect(remoteProtocol("ssh://git@ghe.acme.example/desktop/dugite.git")).toBe(
      "ssh"
    );
  });

  it("reads http(s) as HTTPS", () => {
    expect(remoteProtocol("https://github.com/desktop/dugite.git")).toBe("https");
    expect(remoteProtocol("http://gitlab.example.com/g/p.git")).toBe("https");
  });

  it("does not answer SSH for a URL that merely contains a colon", () => {
    // A checkout that authenticates over HTTPS must not be handed an SSH URL
    // it has no key for.
    expect(remoteProtocol("https://user@github.com/o/n.git")).toBe("https");
  });
});

describe("planUpstreamRemote", () => {
  const original = { hostname: "github.com", nameWithOwner: "desktop/dugite" };

  it("takes `upstream` when nothing claims it", () => {
    expect(
      planUpstreamRemote(
        [{ name: "origin", url: "git@github.com:desktop/dugite.git" }],
        original
      )
    ).toEqual({ name: UPSTREAM_REMOTE, existing: false });
  });

  it("reuses a remote that already points at the original", () => {
    // Re-adding would fail, and renaming someone's remote is not ours to do.
    expect(
      planUpstreamRemote(
        [
          { name: "origin", url: "git@github.com:desktop/dugite.git" },
          { name: "original", url: "https://github.com/desktop/dugite.git" }
        ],
        original
      )
    ).toEqual({ name: "original", existing: true });
  });

  it("never counts `origin` as the remote that already points there", () => {
    // It is the remote being re-pointed, so it matches by definition right now
    // — and reusing it would mean adding nothing and losing the original.
    expect(
      planUpstreamRemote(
        [{ name: "origin", url: "git@github.com:desktop/dugite.git" }],
        original
      ).existing
    ).toBe(false);
  });

  it("suffixes rather than clobbering an `upstream` that points elsewhere", () => {
    expect(
      planUpstreamRemote(
        [
          { name: "origin", url: "git@github.com:desktop/dugite.git" },
          { name: "upstream", url: "git@github.com:someone/else.git" }
        ],
        original
      )
    ).toEqual({ name: "upstream-2", existing: false });
  });

  it("distinguishes the same slug on another instance", () => {
    // Two instances can host the same slug; a remote on the wrong one is not
    // this repository.
    expect(
      planUpstreamRemote(
        [
          { name: "origin", url: "git@ghe.acme.example:desktop/dugite.git" },
          { name: "saas", url: "git@github.com:desktop/dugite.git" }
        ],
        { hostname: "ghe.acme.example", nameWithOwner: "desktop/dugite" }
      )
    ).toEqual({ name: UPSTREAM_REMOTE, existing: false });
  });

  it("never reports a name it only ran out of options on as existing", () => {
    // `existing` means "a remote already points at the original". Saying it
    // here because the NAME is taken tells `applyForkRemotes` to add nothing
    // and tells the dialog a remote already points there — a checkout left
    // with no remote for the original, silently. Reported as a plain add so
    // the `git remote add` that cannot succeed is the thing that says so.
    const crowded = [
      { name: "origin", url: "git@github.com:desktop/dugite.git" },
      { name: UPSTREAM_REMOTE, url: "git@github.com:someone/else.git" },
      ...Array.from({ length: 99 }, (_unused, index) => ({
        name: `${UPSTREAM_REMOTE}-${index + 2}`,
        url: `git@github.com:someone/else-${index}.git`
      }))
    ];
    expect(planUpstreamRemote(crowded, original)).toEqual({
      name: `${UPSTREAM_REMOTE}-100`,
      existing: false
    });
  });
});

describe("readCheckoutRemotes", () => {
  it("reports each remote once, with its fetch URL", async () => {
    const path = repoWithOrigin("git@github.com:desktop/dugite.git");
    execFileSync("git", ["remote", "add", "mirror", "https://example.com/m.git"], {
      cwd: path,
      stdio: "ignore"
    });
    const remotes = await readCheckoutRemotes(systemGit, path);
    expect(remotes.ok && remotes.value).toEqual([
      { name: "mirror", url: "https://example.com/m.git" },
      { name: "origin", url: "git@github.com:desktop/dugite.git" }
    ]);
  });
});

describe("applyForkRemotes", () => {
  it("leaves every local branch tracking origin — which is now the fork", async () => {
    // The invariant the whole operation turns on. `git remote rename origin
    // upstream` rewrites `branch.*.remote`, so the natural-reading order would
    // leave main tracking the repository the user just established they cannot
    // push to. Adding upstream first and re-pointing origin in place does not.
    const path = repoWithOrigin("git@github.com:desktop/dugite.git");
    const applied = await applyForkRemotes(systemGit, path, {
      originUrl: "git@github.com:huntharo/dugite.git",
      upstream: {
        name: UPSTREAM_REMOTE,
        url: "git@github.com:desktop/dugite.git",
        existing: false
      }
    });
    expect(applied.ok).toBe(true);
    expect(config(path, "branch.main.remote")).toBe("origin");
    expect(config(path, "remote.origin.url")).toBe(
      "git@github.com:huntharo/dugite.git"
    );
    expect(config(path, `remote.${UPSTREAM_REMOTE}.url`)).toBe(
      "git@github.com:desktop/dugite.git"
    );
  });

  it("adds nothing for an upstream remote that already exists", async () => {
    const path = repoWithOrigin("git@github.com:desktop/dugite.git");
    execFileSync(
      "git",
      ["remote", "add", "original", "git@github.com:desktop/dugite.git"],
      { cwd: path, stdio: "ignore" }
    );
    const applied = await applyForkRemotes(systemGit, path, {
      originUrl: "git@github.com:huntharo/dugite.git",
      upstream: {
        name: "original",
        url: "git@github.com:desktop/dugite.git",
        existing: true
      }
    });
    expect(applied.ok).toBe(true);
    expect(config(path, "remote.original.url")).toBe(
      "git@github.com:desktop/dugite.git"
    );
  });

  it("re-points a separate push URL, which is where pushes actually go", async () => {
    // origin's fetch URL alone decides nothing about where a push lands.
    // Leaving a stale pushurl behind is the silent failure this flow exists to
    // remove.
    const path = repoWithOrigin("https://github.com/desktop/dugite.git");
    execFileSync(
      "git",
      ["remote", "set-url", "--push", "origin", "git@github.com:desktop/dugite.git"],
      { cwd: path, stdio: "ignore" }
    );
    const applied = await applyForkRemotes(systemGit, path, {
      originUrl: "https://github.com/huntharo/dugite.git",
      upstream: null
    });
    expect(applied.ok).toBe(true);
    expect(config(path, "remote.origin.pushurl")).toBe(
      "https://github.com/huntharo/dugite.git"
    );
  });

  it("leaves an ordinary remote without inventing a push URL", async () => {
    const path = repoWithOrigin("https://github.com/desktop/dugite.git");
    const applied = await applyForkRemotes(systemGit, path, {
      originUrl: "https://github.com/huntharo/dugite.git",
      upstream: null
    });
    expect(applied.ok).toBe(true);
    const pushUrl = await systemGit(
      ["config", "--get-all", "remote.origin.pushurl"],
      path
    );
    expect(pushUrl.ok && pushUrl.value.stdout.trim()).toBe("");
  });
});

describe("forkRemoteUrl", () => {
  it("writes the fork in the protocol origin already speaks", () => {
    expect(forkRemoteUrl("ssh", "github.com", "huntharo/dugite")).toBe(
      "git@github.com:huntharo/dugite.git"
    );
    expect(forkRemoteUrl("https", "github.com", "huntharo/dugite")).toBe(
      "https://github.com/huntharo/dugite.git"
    );
  });

  it("keeps the port the remote it replaces was reached on", () => {
    // A self-managed forge on 2222 is the case protocol + hostname cannot
    // express: composing from those alone hands the checkout port 22 and it
    // stops connecting, on a remote that worked a moment earlier.
    expect(
      forkRemoteUrl(
        "ssh",
        "git.corp.example",
        "octo-dev/widget-core",
        "ssh://git@git.corp.example:2222/acme/widget-core.git"
      )
    ).toBe("ssh://git@git.corp.example:2222/octo-dev/widget-core.git");
  });

  it("keeps the scp-style spelling and its user", () => {
    expect(
      forkRemoteUrl(
        "ssh",
        "git.corp.example",
        "octo-dev/widget-core",
        "deploy@git.corp.example:acme/widget-core.git"
      )
    ).toBe("deploy@git.corp.example:octo-dev/widget-core.git");
  });

  it("falls back to the canonical pair when the template is not a remote", () => {
    expect(
      forkRemoteUrl("https", "github.com", "octo-dev/widget-core", "   ")
    ).toBe("https://github.com/octo-dev/widget-core.git");
  });
});
