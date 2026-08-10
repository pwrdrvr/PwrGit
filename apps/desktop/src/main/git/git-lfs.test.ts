import { describe, expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import type { GitExec, GitOutput } from "./dugite";
import { attributesRequireLfs, inspectGitLfs } from "./git-lfs";

function output(
  stdout = "",
  stderr = "",
  exitCode = 0
): ReturnType<typeof ok<GitOutput>> {
  return ok({ stdout, stderr, exitCode });
}

function probingGit(options: {
  indexedAttributes: string;
  version?: GitOutput;
  config?: GitOutput;
}): GitExec {
  return vi.fn(async (args) => {
    switch (args[0]) {
      case "ls-files":
        return output(".gitattributes\0");
      case "show":
        return output(options.indexedAttributes);
      case "lfs":
        return ok(
          options.version ?? {
            stdout: "git-lfs/3.7.1 (GitHub; darwin arm64)\n",
            stderr: "",
            exitCode: 0
          }
        );
      case "config":
        return ok(
          options.config ?? {
            stdout:
              "filter.lfs.process git-lfs filter-process\n" +
              "filter.lfs.required true\n" +
              "filter.lfs.clean git-lfs clean -- %f\n" +
              "filter.lfs.smudge git-lfs smudge -- %f\n",
            stderr: "",
            exitCode: 0
          }
        );
      default:
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
    }
  });
}

describe("Git LFS attributes", () => {
  it("finds active filter=lfs rules without treating comments as requirements", () => {
    expect(
      attributesRequireLfs(
        "# *.zip filter=lfs diff=lfs\n*.png filter=lfs diff=lfs merge=lfs -text\n"
      )
    ).toBe(true);
    expect(
      attributesRequireLfs(
        "# filter=lfs\n*.txt filter=lfs-preview\n*.md -filter=lfs\n"
      )
    ).toBe(false);
  });
});

describe("inspectGitLfs", () => {
  it("stops after tracked attributes when the checkout does not require LFS", async () => {
    const git = probingGit({ indexedAttributes: "* text=auto\n" });

    await expect(
      inspectGitLfs(git, "/repo", async () => "* text=auto\n")
    ).resolves.toEqual(
      ok({ required: false })
    );
    expect(git).toHaveBeenCalledTimes(1);
  });

  it("reports the available version and configured filters", async () => {
    const git = probingGit({
      indexedAttributes: "*.psd filter=lfs diff=lfs merge=lfs -text\n"
    });

    await expect(
      inspectGitLfs(
        git,
        "/repo",
        async () => "*.psd filter=lfs diff=lfs merge=lfs -text\n"
      )
    ).resolves.toEqual(
      ok({
        required: true,
        installed: true,
        configured: true,
        version: "git-lfs/3.7.1 (GitHub; darwin arm64)"
      })
    );
  });

  it("distinguishes a missing executable from missing filter configuration", async () => {
    const git = probingGit({
      indexedAttributes: "*.bin filter=lfs -text\n",
      version: {
        stdout: "",
        stderr: "git: 'lfs' is not a git command",
        exitCode: 1
      },
      config: { stdout: "", stderr: "", exitCode: 1 }
    });

    await expect(
      inspectGitLfs(git, "/repo", async () => "*.bin filter=lfs -text\n")
    ).resolves.toEqual(
      ok({ required: true, installed: false, configured: false })
    );
  });

  it("uses unstaged working-tree attributes instead of the index", async () => {
    const added = probingGit({ indexedAttributes: "* text=auto\n" });
    await expect(
      inspectGitLfs(
        added,
        "/repo",
        async () => "*.asset filter=lfs diff=lfs -text\n"
      )
    ).resolves.toEqual(
      ok({
        required: true,
        installed: true,
        configured: true,
        version: "git-lfs/3.7.1 (GitHub; darwin arm64)"
      })
    );
    expect(added).not.toHaveBeenCalledWith(
      ["show", ":./.gitattributes"],
      "/repo"
    );

    const removed = probingGit({
      indexedAttributes: "*.asset filter=lfs diff=lfs -text\n"
    });
    await expect(
      inspectGitLfs(removed, "/repo", async () => "* text=auto\n")
    ).resolves.toEqual(ok({ required: false }));
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it("falls back to indexed attributes when the worktree file is missing", async () => {
    const git = probingGit({
      indexedAttributes: "*.asset filter=lfs diff=lfs -text\n"
    });
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });

    await expect(
      inspectGitLfs(git, "/repo", async () => Promise.reject(missing))
    ).resolves.toEqual(
      ok({
        required: true,
        installed: true,
        configured: true,
        version: "git-lfs/3.7.1 (GitHub; darwin arm64)"
      })
    );
    expect(git).toHaveBeenCalledWith(
      ["show", ":./.gitattributes"],
      "/repo"
    );
  });
});
