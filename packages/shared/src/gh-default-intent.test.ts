import { describe, expect, it } from "vitest";
import { ghDefaultMismatch, ghDefaultNotice } from "./gh-default-intent";
import type { GhDefaultRepository } from "./git-discovery";

const FORK = { host: "github.com", repository: "pwrdrvr/PwrDisk", remotes: ["origin", "pwrdrvr"] };
const ORIGINAL = { host: "github.com", repository: "tobi/disktree", remotes: ["upstream"] };

function gh(partial: Partial<GhDefaultRepository>): GhDefaultRepository {
  return {
    status: "ambiguous",
    host: "github.com",
    repository: "tobi/disktree",
    remote: "upstream",
    candidates: [ORIGINAL, FORK],
    fix: "gh repo set-default pwrdrvr/PwrDisk",
    warning: "No gh default repository is set.",
    ...partial
  };
}

describe("gh default against a fork that moved on", () => {
  it("flags the unset default: gh still ranks upstream first", () => {
    const notice = ghDefaultNotice(gh({}), "origin");
    expect(notice?.text).toContain("gh still opens pull requests on tobi/disktree");
    expect(notice?.useRemote).toBe("origin");
  });

  // The case the plain ambiguity warning misses: someone once chose the
  // original on purpose, so the default is SET, and then the fork moved on.
  it("flags a default someone set to the original before the fork moved on", () => {
    const setToOriginal = gh({ status: "set", fix: null, warning: null });
    expect(ghDefaultNotice(setToOriginal, null)).toBeNull();
    expect(ghDefaultNotice(setToOriginal, "origin")?.useRemote).toBe("origin");
  });

  it("is quiet once gh targets the fork", () => {
    const setToFork = gh({ status: "set", repository: "pwrdrvr/PwrDisk", remote: "origin", fix: null, warning: null });
    expect(ghDefaultNotice(setToFork, "origin")).toBeNull();
    expect(ghDefaultMismatch(setToFork, "pwrdrvr")).toBeNull();
  });

  it("is quiet when gh's guess already lands on the fork", () => {
    const guessesFork = gh({ repository: "pwrdrvr/PwrDisk", remote: "origin" });
    expect(ghDefaultNotice(guessesFork, "origin")).toBeNull();
    expect(ghDefaultNotice(guessesFork, null)?.text).toBe("No gh default repository is set.");
  });

  it("treats an unreadable default as a mismatch", () => {
    expect(ghDefaultMismatch(gh({ status: "invalid", repository: null, host: null }), "origin")?.current).toBeNull();
  });

  it("has nothing to compare for a remote gh does not see", () => {
    expect(ghDefaultMismatch(gh({}), "gitlab-mirror")).toBeNull();
    expect(ghDefaultMismatch(null, "origin")).toBeNull();
  });
});

it("keeps the ambiguity warning when the moved-on remote is not one gh sees", () => {
  expect(ghDefaultNotice(gh({}), "gone")?.text).toBe("No gh default repository is set.");
});
