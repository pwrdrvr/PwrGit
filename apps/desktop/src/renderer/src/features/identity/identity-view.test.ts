import { describe, expect, it } from "vitest";
import {
  amendPreview,
  commitTags,
  footerView,
  identityDiagnostics,
  outsideView,
  provisionalFooter,
  pwrgitSourceLine,
  rebaseIdentityLine,
  signingLine
} from "./identity-view";
import { KIT, ROWAN, inspection, recorded } from "./identity-test-fixtures";

describe("footerView", () => {
  it("is one quiet line when Git records the profile", () => {
    expect(footerView(inspection())).toEqual({
      kind: "quiet",
      line: "as Rowan Vale <rowan@vale.example>"
    });
  });

  it("shows the stored email until Git has answered", () => {
    expect(provisionalFooter("rowan@vale.example")).toEqual({ kind: "quiet", line: "as rowan@vale.example" });
    expect(provisionalFooter("")).toEqual({ kind: "quiet", line: "as —" });
  });

  it("blocks only when Git itself would refuse, and names the fix", () => {
    const noName = footerView(
      inspection({ pwrgit: { ok: false, problem: "no_name", message: "empty ident name not allowed" } })
    );
    expect(noName).toEqual({
      kind: "blocked",
      message: "Git has no name to record for this commit.",
      action: "Add an author name to Personal…"
    });
    const noEmail = footerView(
      inspection({ pwrgit: { ok: false, problem: "no_email", message: "no email was given" } })
    );
    expect(noEmail.kind === "blocked" && noEmail.action).toBe("Add a commit email to Personal…");
  });

  it("draws two lines when author and committer differ", () => {
    const view = footerView(
      inspection({
        pwrgit: { ok: true, author: ROWAN, committer: KIT, nameSource: "profile", emailSource: "profile" }
      })
    );
    expect(view).toEqual({
      kind: "split",
      author: "Rowan Vale <rowan@vale.example>",
      committer: "Kit Moreau <kit@moreau.example>"
    });
  });
});

describe("amendPreview", () => {
  it("names the author Amend keeps, and the committer only when it is someone else", () => {
    expect(amendPreview(inspection({ recent: [recorded({ author: KIT })] }))).toEqual({
      author: "Kit Moreau <kit@moreau.example>",
      committer: "Rowan Vale <rowan@vale.example>"
    });
    expect(amendPreview(inspection())).toEqual({
      author: "Rowan Vale <rowan@vale.example>",
      committer: null
    });
  });

  it("has nothing to preview on an unborn branch", () => {
    expect(amendPreview(inspection({ recent: [] }))).toBeNull();
  });
});

describe("pwrgitSourceLine", () => {
  it("names the file Git took a missing profile name from", () => {
    const line = pwrgitSourceLine(
      inspection({
        pwrgit: { ok: true, author: ROWAN, committer: ROWAN, nameSource: "git", emailSource: "profile" },
        config: [{ key: "user.name", value: ROWAN.name, scope: "global", origin: "/home/rowan/.gitconfig" }]
      })
    );
    expect(line).toBe(
      "Name from Git’s user.name in /home/rowan/.gitconfig; email from your Personal profile"
    );
  });
});

describe("pwrgitSourceLine, with nothing configured", () => {
  it("says Git guessed a name it found in no config file", () => {
    const line = pwrgitSourceLine(
      inspection({
        pwrgit: { ok: true, author: ROWAN, committer: ROWAN, nameSource: "git", emailSource: "profile" },
        config: []
      })
    );
    expect(line).toBe("Name guessed by Git from this computer’s account; email from your Personal profile");
  });

  it("names author.name when that, not user.name, supplied it", () => {
    const line = pwrgitSourceLine(
      inspection({
        pwrgit: { ok: true, author: ROWAN, committer: ROWAN, nameSource: "git", emailSource: "profile" },
        config: [
          { key: "user.name", value: "Someone", scope: "global", origin: "/home/rowan/.gitconfig" },
          { key: "author.name", value: ROWAN.name, scope: "local", origin: ".git/config" }
        ]
      })
    );
    expect(line).toBe("Name from Git’s author.name in .git/config; email from your Personal profile");
  });
});

describe("outsideView", () => {
  it("does not blame the host name for an address the shell exported", () => {
    const view = outsideView(
      { kind: "guessed", author: { name: "Rowan Vale", email: ROWAN.email }, source: "environment" },
      "machine"
    );
    expect(view.consequence).toContain("from the EMAIL environment variable");
    expect(view.consequence).not.toContain("computer’s name");
  });

  it("says what a terminal commit does when Git is guessing", () => {
    const view = outsideView({ kind: "guessed", author: { name: "Rowan Vale", email: "rowan@Rowans-MBP.local" }, source: "system" }, "machine");
    expect(view.status).toBe("guessed");
    expect(view.consequence).toContain("record rowan@Rowans-MBP.local");
    expect(view.consequence).toContain("on this computer");
  });

  it("says a terminal commit fails when Git has nothing", () => {
    const view = outsideView({ kind: "missing", message: "x" }, "checkout");
    expect(view.rows.map((row) => row.value)).toEqual(["Not configured", "Not configured"]);
    expect(view.consequence).toContain("“Author identity unknown”");
  });

  it("is silent when Git is configured", () => {
    expect(outsideView({ kind: "configured", author: ROWAN, committer: ROWAN }, "checkout").consequence).toBeNull();
  });
});

describe("commitTags", () => {
  it("labels a noreply address rather than flagging it", () => {
    const noreply = { name: "Rowan Vale", email: "4242+rowanv@users.noreply.github.com" };
    const tags = commitTags(recorded({ author: noreply, committer: noreply }), ROWAN.email);
    expect(tags).toEqual(["GitHub noreply", "differs from profile"]);
  });

  it("counts co-authors and notes a signature header", () => {
    expect(
      commitTags(recorded({ coAuthors: ["Kit Moreau <kit@moreau.example>"], signed: true }), ROWAN.email)
    ).toEqual(["+1 co-author", "Signed"]);
  });

  it("never says differs when the profile has no email to differ from", () => {
    expect(commitTags(recorded({ author: KIT, committer: KIT }), "")).toEqual([]);
  });

  it("names a committer who is not the author", () => {
    expect(commitTags(recorded({ author: KIT }), ROWAN.email)).toEqual([
      "differs from profile",
      "committed by rowan@vale.example"
    ]);
  });
});

describe("signing and rebase disclosure", () => {
  it("names the key the rebase assistant will sign with", () => {
    const signed = inspection({ signing: { enabled: true, format: "ssh", key: "~/.ssh/id_ed25519.pub" } });
    expect(signingLine(signed.signing)).toBe("Signed with SSH key ~/.ssh/id_ed25519.pub");
    expect(rebaseIdentityLine(signed)).toBe(
      "Apply keeps each commit’s author and records Rowan Vale <rowan@vale.example> as committer, signed with SSH key ~/.ssh/id_ed25519.pub."
    );
    expect(rebaseIdentityLine(inspection())).toContain("as committer, unsigned.");
  });

  it("puts every source in the copied diagnostics", () => {
    const text = identityDiagnostics(
      inspection({
        config: [{ key: "user.email", value: ROWAN.email, scope: "local", origin: ".git/config" }],
        env: [{ variable: "GIT_AUTHOR_EMAIL", value: "env@x.example" }]
      })
    );
    expect(text).toContain("config user.email=rowan@vale.example [local] .git/config");
    expect(text).toContain("env GIT_AUTHOR_EMAIL=env@x.example");
    expect(text).toContain("Git outside PwrGit: not configured");
  });
});
