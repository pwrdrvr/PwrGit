import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RebaseCommitRef } from "@pwrgit/shared";
import {
  globalConfigFile,
  identityEnvOverrides,
  IDENTITY_ENV_VARIABLES,
  inspectCommitIdentity,
  parseRawLog,
  predictPwrGitIdentity,
  resolveMachineIdentity,
  resolveOutsideIdentity,
  writeGlobalIdentity
} from "./commit-identity";
import { commitChanges } from "./git-service";
import { applyRebase, dryRunRebase } from "./rebase-assistant";
import { createSystemGit } from "./test-support/system-git";
import { readSeedIdentity } from "../profiles/git-identity";

// Every case runs in a sandbox: its own HOME and XDG_CONFIG_HOME, no system
// config, and none of the identity variables of whoever runs the suite. A
// developer's own ~/.gitconfig would otherwise decide half of these answers.

type Sandbox = {
  root: string;
  home: string;
  env: NodeJS.ProcessEnv;
  /** Fixture Git (the one on PATH), in the sandbox's environment. */
  git: (cwd: string, ...args: string[]) => string;
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(extra: NodeJS.ProcessEnv = {}): Sandbox {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pwrgit-identity-")));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const variable of IDENTITY_ENV_VARIABLES) delete env[variable];
  for (const variable of [
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT"
  ]) {
    delete env[variable];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    ...extra
  });
  return {
    root,
    home,
    env,
    git: (cwd, ...args) =>
      execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim()
  };
}

function writeGlobal(box: Sandbox, text: string): string {
  const path = join(box.home, ".gitconfig");
  writeFileSync(path, text);
  return path;
}

function repo(box: Sandbox, ...segments: string[]): string {
  const path = join(box.root, ...segments);
  mkdirSync(path, { recursive: true });
  box.git(path, "init", "-q", "-b", "main");
  box.git(path, "config", "core.autocrlf", "false");
  return path;
}

/** A commit made by someone else, as a terminal would make it. */
function commitAs(box: Sandbox, cwd: string, who: string, email: string, message: string): void {
  writeFileSync(join(cwd, `${message.split("\n")[0]!.replace(/\W+/g, "-")}.txt`), message);
  box.git(cwd, "add", ".");
  box.git(cwd, "-c", `user.name=${who}`, "-c", `user.email=${email}`, "commit", "-q", "-m", message);
}

function stage(cwd: string, name: string): void {
  writeFileSync(join(cwd, name), `${name}\n`);
}

const PROFILE = { email: "rowan@vale.example", name: "Rowan Vale" };

describe("what Git outside PwrGit resolves", () => {
  it("reports missing when nothing is configured and Git may not guess", async () => {
    const box = sandbox();
    writeGlobal(box, "[user]\n\tuseConfigOnly = true\n");
    const cwd = repo(box, "plain");
    const outside = await resolveOutsideIdentity(createSystemGit({ env: box.env }), cwd);
    expect(outside.kind).toBe("missing");
    if (outside.kind !== "missing") return;
    expect(outside.message).toMatch(/auto-detection is disabled|email|name/i);
  });

  it("tells a guess from a configured identity", async () => {
    // EMAIL is Git's own fallback when no user.email is configured — one of
    // the guesses `user.useConfigOnly` forbids — so it stands in, on every
    // OS, for the login@hostname address macOS builds.
    const box = sandbox({ EMAIL: "rowan@Rowans-MBP.local" });
    writeGlobal(box, "[user]\n\tname = Rowan Vale\n");
    const cwd = repo(box, "plain");
    const outside = await resolveOutsideIdentity(createSystemGit({ env: box.env }), cwd);
    expect(outside).toEqual({
      kind: "guessed",
      author: { name: "Rowan Vale", email: "rowan@Rowans-MBP.local" }
    });
  });

  it("finds an identity kept only in the XDG config file", async () => {
    const box = sandbox();
    const xdg = join(box.home, ".config", "git");
    mkdirSync(xdg, { recursive: true });
    writeFileSync(join(xdg, "config"), "[user]\n\tname = Rowan Vale\n\temail = rowan@xdg.example\n");
    const git = createSystemGit({ env: box.env });
    const machine = await resolveMachineIdentity(git, box.root, box.env);
    expect(machine.outside.kind).toBe("configured");
    if (machine.outside.kind !== "configured") return;
    expect(machine.outside.author.email).toBe("rowan@xdg.example");
    expect(machine.config.find((entry) => entry.key === "user.email")).toMatchObject({
      scope: "global",
      origin: join(xdg, "config"),
      value: "rowan@xdg.example"
    });
    // No ~/.gitconfig, so `git config --global` writes the XDG file.
    expect(machine.globalFile).toBe(join(xdg, "config"));
  });

  it("follows includeIf per checkout, and names the included file", async () => {
    const box = sandbox();
    const work = join(box.root, "work");
    const include = join(box.root, "work.inc");
    writeFileSync(include, "[user]\n\temail = rowan@acme.example\n");
    writeGlobal(
      box,
      `[user]\n\tname = Rowan Vale\n\temail = rowan@vale.example\n[includeIf "gitdir:${work.replace(/\\/g, "/")}/"]\n\tpath = ${include.replace(/\\/g, "/")}\n`
    );
    const workRepo = repo(box, "work", "api");
    const homeRepo = repo(box, "personal", "site");
    const git = createSystemGit({ env: box.env });

    const atWork = await inspectCommitIdentity(git, workRepo, "wt-work", { name: "Personal", email: PROFILE.email, authorName: PROFILE.name }, box.env);
    const atHome = await inspectCommitIdentity(git, homeRepo, "wt-home", { name: "Personal", email: PROFILE.email, authorName: PROFILE.name }, box.env);

    expect(atWork.outside).toMatchObject({ kind: "configured", author: { email: "rowan@acme.example" } });
    expect(atHome.outside).toMatchObject({ kind: "configured", author: { email: "rowan@vale.example" } });
    const deciding = atWork.config.filter((entry) => entry.key === "user.email").at(-1);
    expect(deciding?.origin.replace(/\\/g, "/")).toBe(include.replace(/\\/g, "/"));
    // PwrGit's own commit records the profile in both places.
    for (const inspection of [atWork, atHome]) {
      expect(inspection.pwrgit).toMatchObject({
        ok: true,
        author: PROFILE,
        committer: PROFILE
      });
    }
  });

  it("separates two worktrees of one repository by worktree config", async () => {
    const box = sandbox();
    writeGlobal(box, "[user]\n\tname = Rowan Vale\n\temail = rowan@vale.example\n");
    const main = repo(box, "repo");
    commitAs(box, main, "Rowan Vale", "rowan@vale.example", "base");
    box.git(main, "config", "extensions.worktreeConfig", "true");
    const linked = join(box.root, "repo-hotfix");
    box.git(main, "worktree", "add", "-q", linked, "-b", "hotfix");
    box.git(linked, "config", "--worktree", "user.email", "rowan@hotfix.example");
    const git = createSystemGit({ env: box.env });

    const inMain = await resolveOutsideIdentity(git, main);
    const inLinked = await resolveOutsideIdentity(git, linked);
    expect(inMain).toMatchObject({ author: { email: "rowan@vale.example" } });
    expect(inLinked).toMatchObject({ author: { email: "rowan@hotfix.example" } });

    const linkedConfig = (await inspectCommitIdentity(git, linked, "wt", { name: "P", email: PROFILE.email, authorName: null }, box.env)).config;
    expect(linkedConfig.at(-1)).toMatchObject({ key: "user.email", scope: "worktree", value: "rowan@hotfix.example" });
  });
});

describe("PwrGit records the profile, whatever else is in force", () => {
  it("beats a repository's author.email, which used to win over -c user.email", async () => {
    const box = sandbox();
    writeGlobal(box, "[user]\n\tname = Someone\n\temail = someone@example.test\n");
    const cwd = repo(box, "repo");
    box.git(cwd, "config", "author.email", "bot@ci.example");
    box.git(cwd, "config", "committer.email", "bot@ci.example");
    const git = createSystemGit({ env: box.env });

    const outside = await resolveOutsideIdentity(git, cwd);
    expect(outside).toMatchObject({ kind: "configured", author: { email: "bot@ci.example" } });
    expect(await predictPwrGitIdentity(git, cwd, PROFILE)).toMatchObject({
      ok: true,
      author: PROFILE,
      committer: PROFILE
    });

    stage(cwd, "a.txt");
    box.git(cwd, "add", ".");
    const made = await commitChanges(git, cwd, "add a", PROFILE);
    expect(made.ok).toBe(true);
    expect(box.git(cwd, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(
      "Rowan Vale <rowan@vale.example>|Rowan Vale <rowan@vale.example>"
    );
  });

  it("removes inherited identity variables, and still reports them", async () => {
    const box = sandbox({
      GIT_AUTHOR_EMAIL: "ci-bot@acme.example",
      GIT_COMMITTER_NAME: "CI Bot"
    });
    writeGlobal(box, "[user]\n\tname = Someone\n\temail = someone@example.test\n");
    const cwd = repo(box, "repo");
    const git = createSystemGit({ env: box.env });

    expect(await predictPwrGitIdentity(git, cwd, PROFILE)).toMatchObject({
      ok: true,
      author: PROFILE,
      committer: PROFILE
    });
    stage(cwd, "a.txt");
    box.git(cwd, "add", ".");
    expect((await commitChanges(git, cwd, "add a", PROFILE)).ok).toBe(true);
    expect(box.git(cwd, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(
      "Rowan Vale <rowan@vale.example>|Rowan Vale <rowan@vale.example>"
    );
    expect(identityEnvOverrides(box.env)).toEqual([
      { variable: "GIT_AUTHOR_EMAIL", value: "ci-bot@acme.example" },
      { variable: "GIT_COMMITTER_NAME", value: "CI Bot" }
    ]);
  });

  it("takes the name from Git when the profile has none, and blocks when nothing has one", async () => {
    const box = sandbox();
    writeGlobal(box, "[user]\n\tuseConfigOnly = true\n\tname = Rowan From Git\n");
    const cwd = repo(box, "repo");
    const git = createSystemGit({ env: box.env });
    expect(await predictPwrGitIdentity(git, cwd, { email: PROFILE.email })).toMatchObject({
      ok: true,
      author: { name: "Rowan From Git", email: PROFILE.email },
      nameSource: "git",
      emailSource: "profile"
    });

    box.git(cwd, "config", "--global", "--unset", "user.name");
    const blocked = await predictPwrGitIdentity(git, cwd, { email: PROFILE.email });
    expect(blocked).toMatchObject({ ok: false, problem: "no_name" });
    stage(cwd, "a.txt");
    box.git(cwd, "add", ".");
    // The prediction is the commit: Git refuses for the same reason.
    expect((await commitChanges(git, cwd, "add a", { email: PROFILE.email })).ok).toBe(false);
  });

  it("never records an empty email, and never a guessed one, for a profile with no email", async () => {
    const box = sandbox({ EMAIL: "rowan@Rowans-MBP.local" });
    writeGlobal(box, "[user]\n\tname = Rowan Vale\n");
    const cwd = repo(box, "repo");
    const git = createSystemGit({ env: box.env });
    const prediction = await predictPwrGitIdentity(git, cwd, { email: "", name: "Rowan Vale" });
    expect(prediction).toMatchObject({ ok: false, problem: "no_email" });

    stage(cwd, "a.txt");
    box.git(cwd, "add", ".");
    expect((await commitChanges(git, cwd, "add a", { email: "", name: "Rowan Vale" })).ok).toBe(false);

    box.git(cwd, "config", "--global", "user.email", "rowan@vale.example");
    expect(await predictPwrGitIdentity(git, cwd, { email: "", name: "Rowan Vale" })).toMatchObject({
      ok: true,
      author: PROFILE,
      emailSource: "git"
    });
  });

  it("amend keeps the original author and records the profile as committer", async () => {
    const box = sandbox();
    writeGlobal(box, "[user]\n\tname = Someone\n\temail = someone@example.test\n");
    const cwd = repo(box, "repo");
    commitAs(box, cwd, "Kit Moreau", "kit@moreau.example", "kit's change");
    const git = createSystemGit({ env: box.env });

    const inspection = await inspectCommitIdentity(git, cwd, "wt", { name: "P", email: PROFILE.email, authorName: PROFILE.name }, box.env);
    expect(inspection.recent[0]?.author).toEqual({ name: "Kit Moreau", email: "kit@moreau.example" });

    stage(cwd, "b.txt");
    box.git(cwd, "add", ".");
    expect((await commitChanges(git, cwd, "kit's change, amended", PROFILE, { amend: true })).ok).toBe(true);
    expect(box.git(cwd, "log", "-1", "--format=%an <%ae>|%cn <%ce>")).toBe(
      "Kit Moreau <kit@moreau.example>|Rowan Vale <rowan@vale.example>"
    );
  });
});

describe("recorded identities and signing", () => {
  it("reads co-author trailers and a signature header without verifying anything", async () => {
    const box = sandbox();
    writeGlobal(box, "[user]\n\tname = Rowan Vale\n\temail = rowan@vale.example\n");
    const cwd = repo(box, "repo");
    commitAs(box, cwd, "Rowan Vale", "4242+rowanv@users.noreply.github.com", "pair\n\nCo-authored-by: Kit Moreau <kit@moreau.example>");
    // A signed commit object written by hand: the header is what `--pretty=raw`
    // exposes, and checking for it needs no signer and no allowed-signers file.
    const tree = box.git(cwd, "rev-parse", "HEAD^{tree}");
    const parent = box.git(cwd, "rev-parse", "HEAD");
    const object = [
      `tree ${tree}`,
      `parent ${parent}`,
      "author Rowan Vale <rowan@vale.example> 1791000000 +0000",
      "committer Rowan Vale <rowan@vale.example> 1791000000 +0000",
      "gpgsig -----BEGIN SSH SIGNATURE-----",
      " ZmFrZQ==",
      " -----END SSH SIGNATURE-----",
      "",
      "signed by hand",
      ""
    ].join("\n");
    const objectFile = join(box.root, "commit-object");
    writeFileSync(objectFile, object);
    const signed = box.git(cwd, "hash-object", "-t", "commit", "-w", objectFile);
    box.git(cwd, "update-ref", "refs/heads/main", signed);

    const git = createSystemGit({ env: box.env });
    const inspection = await inspectCommitIdentity(git, cwd, "wt", { name: "P", email: PROFILE.email, authorName: null }, box.env);
    expect(inspection.recent.map((commit) => [commit.hash.slice(0, 7), commit.signed, commit.coAuthors])).toEqual([
      [signed.slice(0, 7), true, []],
      [parent.slice(0, 7), false, ["Kit Moreau <kit@moreau.example>"]]
    ]);
    expect(inspection.recent[1]?.author.email).toBe("4242+rowanv@users.noreply.github.com");
  });

  it("reports an unborn branch as no history, not a failure", async () => {
    const box = sandbox();
    writeGlobal(box, "[user]\n\tname = Rowan Vale\n\temail = rowan@vale.example\n");
    const cwd = repo(box, "empty");
    const inspection = await inspectCommitIdentity(createSystemGit({ env: box.env }), cwd, "wt", { name: "P", email: PROFILE.email, authorName: null }, box.env);
    expect(inspection.recent).toEqual([]);
    expect(inspection.pwrgit.ok).toBe(true);
  });

  it("reads signing from config without trying to sign", async () => {
    const box = sandbox();
    writeGlobal(
      box,
      "[user]\n\tname = Rowan Vale\n\temail = rowan@vale.example\n\tsigningkey = ~/.ssh/id_ed25519.pub\n[gpg]\n\tformat = ssh\n[commit]\n\tgpgsign\n"
    );
    const cwd = repo(box, "repo");
    const git = createSystemGit({ env: box.env });
    const on = await inspectCommitIdentity(git, cwd, "wt", { name: "P", email: PROFILE.email, authorName: null }, box.env);
    expect(on.signing).toEqual({ enabled: true, format: "ssh", key: "~/.ssh/id_ed25519.pub" });

    box.git(cwd, "config", "commit.gpgsign", "false");
    const off = await inspectCommitIdentity(git, cwd, "wt", { name: "P", email: PROFILE.email, authorName: null }, box.env);
    expect(off.signing).toEqual({ enabled: false });
  });
});

describe("parseRawLog", () => {
  it("does not mistake a message line for a header", () => {
    const parsed = parseRawLog(
      [
        "commit 1111111111111111111111111111111111111111",
        "tree 2222222222222222222222222222222222222222",
        "author A <a@x> 1 +0000",
        "committer C <c@x> 1 +0000",
        "",
        "    commit 3333333",
        "    gpgsig in a message is just text",
        "    Co-authored-by: Kit <kit@x>",
        ""
      ].join("\n")
    );
    expect(parsed).toEqual([
      {
        hash: "1111111111111111111111111111111111111111",
        author: { name: "A", email: "a@x" },
        committer: { name: "C", email: "c@x" },
        coAuthors: ["Kit <kit@x>"],
        signed: false
      }
    ]);
  });
});

describe("writing the global identity", () => {
  it("writes where Git's own --global would, and a repository override keeps winning", async () => {
    const box = sandbox();
    const cwd = repo(box, "repo");
    box.git(cwd, "config", "user.email", "rowan@acme.example");
    const git = createSystemGit({ env: box.env });

    const target = globalConfigFile(box.env);
    expect(target).toBe(join(box.home, ".gitconfig"));
    const written = await writeGlobalIdentity(git, " Rowan Vale ", "rowan@vale.example", box.root);
    expect(written.ok).toBe(true);
    expect(readFileSync(target, "utf8")).toMatch(/name = Rowan Vale\n\s*email = rowan@vale.example/);

    const machine = await resolveMachineIdentity(git, box.root, box.env);
    expect(machine.outside).toMatchObject({ kind: "configured", author: PROFILE });
    expect(await resolveOutsideIdentity(git, cwd)).toMatchObject({
      author: { email: "rowan@acme.example" }
    });
  });

  it("refuses an address Git would mangle", async () => {
    const box = sandbox();
    const git = createSystemGit({ env: box.env });
    for (const [name, email] of [
      ["Rowan", ""],
      ["Rowan\nVale", "rowan@vale.example"],
      ["Rowan", "<rowan@vale.example>"],
      ["Rowan", "not-an-address"]
    ] as const) {
      expect((await writeGlobalIdentity(git, name, email, box.root)).ok).toBe(false);
    }
  });

  it("seeds the first profile from Git, not from a regex over the file", async () => {
    const box = sandbox();
    const included = join(box.root, "identity.inc");
    writeFileSync(included, "[user]\n\tname = Dana Whitfield\n\temail = dana@example.com\n");
    // A [github] name ahead of [user], and the identity kept in an include:
    // the old regex seeded the handle as the author and found no email.
    const global = writeGlobal(
      box,
      `[github]\n\tname = dwhitfield\n[include]\n\tpath = ${included.replace(/\\/g, "/")}\n`
    );
    const seeded = await readSeedIdentity(createSystemGit({ env: box.env }), global);
    expect(seeded).toEqual({ name: "Dana Whitfield", email: "dana@example.com" });
  });
});

const posix = process.platform !== "win32";

describe.runIf(posix)("the rebase assistant and Git's signing config", () => {
  /** A gpg stand-in that signs anything and logs each time it is asked. */
  function fakeSigner(box: Sandbox, fail = false): { program: string; log: string } {
    const log = join(box.root, "signer.log");
    const program = join(box.root, "fake-gpg");
    writeFileSync(
      program,
      fail
        ? `#!/bin/sh\necho called >> "${log}"\ncat >/dev/null\necho "gpg: signing failed: No secret key" >&2\nexit 2\n`
        : [
            "#!/bin/sh",
            `echo called >> "${log}"`,
            "cat >/dev/null",
            "echo '[GNUPG:] BEGIN_SIGNING' >&2",
            "echo '[GNUPG:] SIG_CREATED D 22 8 00 1791000000 FAKE' >&2",
            "echo '-----BEGIN PGP SIGNATURE-----'",
            "echo 'ZmFrZQ=='",
            "echo '-----END PGP SIGNATURE-----'",
            ""
          ].join("\n")
    );
    chmodSync(program, 0o755);
    writeFileSync(log, "");
    return { program, log };
  }

  function topCommits(box: Sandbox, cwd: string, count: number): RebaseCommitRef[] {
    return box
      .git(cwd, "log", `-n${count}`, "--format=%H%x1f%s")
      .split("\n")
      .map((line) => {
        const [hash = "", subject = ""] = line.split("\x1f");
        return { hash, subject };
      })
      .reverse();
  }

  function signedRepo(box: Sandbox, program: string): string {
    writeGlobal(
      box,
      `[user]\n\tname = Rowan Vale\n\temail = rowan@vale.example\n\tsigningkey = FAKE\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${program}\n`
    );
    const cwd = repo(box, "repo");
    for (const name of ["c0", "c1", "c2", "c3"]) {
      writeFileSync(join(cwd, `${name}.txt`), `${name}\n`);
      box.git(cwd, "add", ".");
      box.git(cwd, "-c", "commit.gpgsign=false", "commit", "-q", "-m", name);
    }
    return cwd;
  }

  it("checks without the signer, then signs every rewritten commit on apply", async () => {
    const box = sandbox();
    const signer = fakeSigner(box);
    const cwd = signedRepo(box, signer.program);
    const git = createSystemGit({ env: box.env });
    const commits = topCommits(box, cwd, 2);

    const checked = await dryRunRebase(git, cwd, commits, "reorder", PROFILE);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(readFileSync(signer.log, "utf8")).toBe("");

    const applied = await applyRebase(git, cwd, commits, "reorder", PROFILE, {
      head: checked.value.sourceHead,
      headRef: checked.value.sourceRef
    });
    expect(applied.ok).toBe(true);
    const rewritten = await inspectCommitIdentity(git, cwd, "wt", { name: "P", email: PROFILE.email, authorName: PROFILE.name }, box.env);
    expect(rewritten.recent.slice(0, 2).map((commit) => commit.signed)).toEqual([true, true]);
    expect(rewritten.recent.slice(0, 2).map((commit) => commit.committer)).toEqual([PROFILE, PROFILE]);
    expect(rewritten.signing).toEqual({ enabled: true, format: "openpgp", key: "FAKE" });
  });

  it("reports a refusing signer as a signing failure and leaves the branch where it was", async () => {
    const box = sandbox();
    const signer = fakeSigner(box, true);
    const cwd = signedRepo(box, signer.program);
    const git = createSystemGit({ env: box.env });
    const commits = topCommits(box, cwd, 2);
    const before = box.git(cwd, "rev-parse", "HEAD");

    const checked = await dryRunRebase(git, cwd, commits, "reorder", PROFILE);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const applied = await applyRebase(git, cwd, commits, "reorder", PROFILE, {
      head: checked.value.sourceHead,
      headRef: checked.value.sourceRef
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error.code).toBe("signing_failed");
    expect(applied.error.message).toMatch(/couldn’t sign/);
    expect(box.git(cwd, "rev-parse", "HEAD")).toBe(before);
    expect(box.git(cwd, "status", "--porcelain")).toBe("");
  });
});
