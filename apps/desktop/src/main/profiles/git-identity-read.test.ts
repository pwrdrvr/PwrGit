import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { readEffectiveGitIdentity } from "./git-identity-read";
import { readGitIdentityDefaults } from "./git-identity";
import type { GitExec } from "../git/dugite";

/** A GitExec that answers `config --get <key>` from a map; anything unset
 *  exits 1 with no output, which is what real git does. */
function gitReturning(values: Record<string, string>): GitExec {
  return vi.fn(async (args: string[]) => {
    const key = args[2] ?? "";
    const value = values[key];
    return ok({
      stdout: value ?? "",
      stderr: "",
      exitCode: value === undefined ? 1 : 0
    });
  }) as unknown as GitExec;
}

function configFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pwrgit-identity-"));
  const path = join(dir, ".gitconfig");
  writeFileSync(path, contents, "utf8");
  return path;
}

describe("readEffectiveGitIdentity", () => {
  it("reports what git reports, not what the file looks like", async () => {
    const identity = await readEffectiveGitIdentity(
      gitReturning({
        "user.name": "Dana Whitfield",
        "user.email": "dana@example.com"
      }),
      "/somewhere",
      configFile("")
    );
    expect(identity.name).toBe("Dana Whitfield");
    expect(identity.email).toBe("dana@example.com");
  });

  it("treats an unset key as 'not configured' rather than an error", async () => {
    const identity = await readEffectiveGitIdentity(
      gitReturning({}),
      "/somewhere",
      configFile("")
    );
    expect(identity).toEqual({
      name: null,
      email: null,
      conditionalDirs: []
    });
  });

  it("lists the directories a conditional include re-points identity for", async () => {
    const path = configFile(
      [
        "[user]",
        "\tname = Dana Whitfield",
        "\temail = dana@example.com",
        '[includeIf "gitdir:~/work/"]',
        "\tpath = ~/.gitconfig-work",
        '[includeIf "gitdir/i:~/Contract/"]',
        "\tpath = ~/.gitconfig-contract"
      ].join("\n")
    );
    const identity = await readEffectiveGitIdentity(
      gitReturning({ "user.name": "Dana Whitfield" }),
      "/somewhere",
      path
    );
    // Both spellings git accepts, and case-insensitive `gitdir/i` too.
    expect(identity.conditionalDirs).toEqual(["~/work/", "~/Contract/"]);
  });

  it("survives a missing config file — that is 'no conditions', not a crash", async () => {
    const identity = await readEffectiveGitIdentity(
      gitReturning({ "user.email": "dana@example.com" }),
      "/somewhere",
      join(tmpdir(), "pwrgit-does-not-exist", ".gitconfig")
    );
    expect(identity.email).toBe("dana@example.com");
    expect(identity.conditionalDirs).toEqual([]);
  });
});

/**
 * The reason this module exists. These are the seed's actual answers — it is
 * documented best-effort and is not wrong to ship, but it must never be what
 * the wizard puts on screen as "commits will be signed off as this".
 */
describe("why the wizard does not reuse the first-run seed", () => {
  it("seed: reads a name and an email out of different sections", () => {
    const path = configFile(
      [
        "[github]",
        "\tname = dwhitfield",
        "[user]",
        "\tname = Dana Whitfield",
        "\temail = dana@example.com"
      ].join("\n")
    );
    // The forge handle, paired with the [user] email — one identity from two
    // sections, because the regex has no notion of which section it is in.
    expect(readGitIdentityDefaults(path)).toEqual({
      name: "dwhitfield",
      email: "dana@example.com"
    });
  });

  it("seed: comes back empty when the identity lives in an included file", () => {
    const path = configFile(
      ["[include]", "\tpath = ~/.gitconfig.d/identity", "[core]", "\teditor = nvim"].join(
        "\n"
      )
    );
    expect(readGitIdentityDefaults(path)).toEqual({});
  });

  it("git: answers both cases correctly, which is why the wizard asks it", async () => {
    const identity = await readEffectiveGitIdentity(
      gitReturning({
        "user.name": "Dana Whitfield",
        "user.email": "dana@example.com"
      }),
      "/somewhere",
      configFile("[include]\n\tpath = ~/.gitconfig.d/identity\n")
    );
    expect(identity.name).toBe("Dana Whitfield");
    expect(identity.email).toBe("dana@example.com");
  });
});
