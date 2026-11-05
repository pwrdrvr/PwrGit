import { describe, expect, it } from "vitest";
import {
  describeGhDefaultRisk,
  ghRemoteRank,
  parseGhResolvedConfig,
  resolveGhDefaultRepository,
  type GhRemoteInput
} from "./gh-default.js";

function remote(
  name: string,
  repository: string | null,
  resolved: string | null = null,
  host = "github.com"
): GhRemoteInput {
  return { name, host, repository, github: host === "github.com" || host === "ghe.acme.example", resolved };
}

// The PwrDisk checkout on 2026-11-04: origin and pwrdrvr are the fork,
// upstream is the original. `gh pr create` opened tobi/disktree#124.
const PWRDISK = [
  remote("origin", "pwrdrvr/PwrDisk"),
  remote("pwrdrvr", "pwrdrvr/PwrDisk"),
  remote("upstream", "tobi/disktree")
];

describe("gh default repository", () => {
  it("ranks remote names as gh does: upstream, github, origin, then the rest", () => {
    expect(["fork", "origin", "github", "upstream"].map(ghRemoteRank)).toEqual([0, 1, 2, 3]);
    expect(ghRemoteRank("UPSTREAM")).toBe(3);
  });

  it("flags the PwrDisk shape: unset, and gh would pick upstream", () => {
    const state = resolveGhDefaultRepository(PWRDISK);
    expect(state).toMatchObject({
      status: "ambiguous",
      repository: "tobi/disktree",
      remote: "upstream",
      fix: "gh repo set-default pwrdrvr/PwrDisk"
    });
    expect(state.candidates).toEqual([
      { host: "github.com", repository: "tobi/disktree", remotes: ["upstream"] },
      { host: "github.com", repository: "pwrdrvr/PwrDisk", remotes: ["origin", "pwrdrvr"] }
    ]);
    expect(describeGhDefaultRisk(state)).toContain("would target tobi/disktree (remote upstream)");
  });

  it("is settled once gh repo set-default wrote gh-resolved = base on origin", () => {
    const state = resolveGhDefaultRepository([
      remote("origin", "pwrdrvr/PwrDisk", "base"),
      remote("pwrdrvr", "pwrdrvr/PwrDisk"),
      remote("upstream", "tobi/disktree")
    ]);
    expect(state).toMatchObject({ status: "set", repository: "pwrdrvr/PwrDisk", remote: "origin", fix: null });
    expect(describeGhDefaultRisk(state)).toBeNull();
  });

  it("reads an owner/repo resolution on the remote's host", () => {
    const state = resolveGhDefaultRepository([
      remote("origin", "me/widget"),
      remote("upstream", "acme/widget", "me/widget")
    ]);
    expect(state).toMatchObject({ status: "set", repository: "me/widget", remote: "upstream" });
  });

  it("does not call same-URL duplicate remotes ambiguous", () => {
    const state = resolveGhDefaultRepository([
      remote("origin", "pwrdrvr/PwrDisk"),
      remote("pwrdrvr", "pwrdrvr/PwrDisk")
    ]);
    expect(state).toMatchObject({ status: "implicit", repository: "pwrdrvr/PwrDisk", remote: "origin", fix: null });
  });

  it("treats owner/name case as the same GitHub repository", () => {
    expect(resolveGhDefaultRepository([
      remote("origin", "PwrDrvr/PwrDisk"),
      remote("mirror", "pwrdrvr/pwrdisk")
    ]).status).toBe("implicit");
  });

  it("ranks a remote named github ahead of origin", () => {
    expect(resolveGhDefaultRepository([
      remote("origin", "me/widget"),
      remote("github", "acme/widget")
    ])).toMatchObject({ status: "ambiguous", repository: "acme/widget", remote: "github" });
  });

  it("breaks ties among other names alphabetically, as git remote -v lists them", () => {
    expect(resolveGhDefaultRepository([
      remote("zeta", "z/widget"),
      remote("alpha", "a/widget")
    ])).toMatchObject({ status: "ambiguous", repository: "a/widget", remote: "alpha", fix: "gh repo set-default a/widget" });
  });

  it("ignores remotes gh would not consider", () => {
    expect(resolveGhDefaultRepository([
      remote("origin", "me/widget"),
      remote("upstream", "acme/widget", null, "gitlab.com"),
      remote("nas", null)
    ])).toMatchObject({ status: "implicit", repository: "me/widget" });
    expect(resolveGhDefaultRepository([remote("origin", "group/widget", null, "gitlab.com")]).status).toBe("none");
  });

  it("names the host in the fix for an Enterprise host", () => {
    expect(resolveGhDefaultRepository([
      remote("origin", "me/widget", null, "ghe.acme.example"),
      remote("upstream", "acme/widget", null, "ghe.acme.example")
    ]).fix).toBe("gh repo set-default ghe.acme.example/me/widget");
  });

  it("reports a gh-resolved value gh cannot parse", () => {
    const state = resolveGhDefaultRepository([remote("origin", "me/widget", "nonsense")]);
    expect(state).toMatchObject({ status: "invalid", repository: null, remote: "origin" });
    expect(describeGhDefaultRisk(state)).toContain("remote.origin.gh-resolved");
  });

  it("parses gh-resolved config lines, last value winning like gh", () => {
    const parsed = parseGhResolvedConfig(
      "remote.origin.gh-resolved base\nremote.upstream.gh-resolved acme/widget\nremote.origin.gh-resolved me/widget\n"
    );
    expect([...parsed]).toEqual([["origin", "me/widget"], ["upstream", "acme/widget"]]);
  });
});
