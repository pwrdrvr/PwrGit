import { describe, expect, it } from "vitest";
import { err, ok, type Repo, type Worktree } from "@pwrgit/shared";
import { diagnosticsCopiedToast, diagnosticsRepository } from "./diagnosticsCopy";

const repo = { name: "atlas", path: "/src/atlas" } as Repo;
const worktree = { path: "/src/atlas-wt", branch: "feat/x" } as Worktree;
const failure = err({ kind: "unknown", code: "clipboard", message: "pasteboard busy" } as const);

describe("diagnosticsRepository", () => {
  it("sends the selected repository and worktree", () => {
    expect(diagnosticsRepository(repo, worktree)).toEqual({
      name: "atlas",
      path: "/src/atlas",
      worktreePath: "/src/atlas-wt",
      branch: "feat/x"
    });
  });

  it("sends a repository without a worktree, and nothing without a repository", () => {
    expect(diagnosticsRepository(repo, null)).toEqual({
      name: "atlas",
      path: "/src/atlas",
      worktreePath: null,
      branch: null
    });
    expect(diagnosticsRepository(null, worktree)).toBeNull();
  });
});

describe("diagnosticsCopiedToast", () => {
  it("confirms the repository when the re-copy landed", () => {
    expect(diagnosticsCopiedToast(true, ok({ written: true }))).toMatchObject({
      tone: "info",
      message: expect.stringContaining("this window's repository")
    });
  });

  it("stays quiet when the user copied something else meanwhile", () => {
    expect(diagnosticsCopiedToast(true, ok({ written: false }))).toBeNull();
  });

  it("confirms main's copy, without the repository, when only the re-copy failed", () => {
    const toast = diagnosticsCopiedToast(true, failure);
    expect(toast?.tone).toBe("info");
    expect(toast?.message).not.toContain("repository");
  });

  it("reports an error when neither copy reached the clipboard", () => {
    expect(diagnosticsCopiedToast(false, failure)).toEqual({
      tone: "error",
      message: "pasteboard busy"
    });
  });
});
