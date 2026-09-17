import { describe, expect, it } from "vitest";
import { PWRGIT_LINKS } from "./product";
import { releaseNotesUrl } from "./release-notes";

describe("releaseNotesUrl", () => {
  it("builds the tag page for a bare version, as AppUpdateStatus carries it", () => {
    expect(releaseNotesUrl("0.16.1")).toBe(
      "https://github.com/pwrdrvr/PwrGit/releases/tag/v0.16.1"
    );
  });

  it("builds the same page for a tag, as AppUpdateReleaseInfo carries it", () => {
    // `AppUpdateReleaseInfo.version` is GitHub's `tag_name` verbatim, so the
    // two sides of that seam must not need different call sites.
    expect(releaseNotesUrl("v0.16.1")).toBe(releaseNotesUrl("0.16.1"));
    expect(releaseNotesUrl("V0.16.1")).toBe(releaseNotesUrl("0.16.1"));
  });

  it("keeps prerelease identifiers, which is most of what this repo publishes", () => {
    expect(releaseNotesUrl("v0.16.0-beta.5")).toBe(
      "https://github.com/pwrdrvr/PwrGit/releases/tag/v0.16.0-beta.5"
    );
    expect(releaseNotesUrl("0.16.0-alpha.11")).toBe(
      "https://github.com/pwrdrvr/PwrGit/releases/tag/v0.16.0-alpha.11"
    );
    expect(releaseNotesUrl("0.16.0-prerelease")).toBe(
      "https://github.com/pwrdrvr/PwrGit/releases/tag/v0.16.0-prerelease"
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(releaseNotesUrl("  0.16.1  ")).toBe(releaseNotesUrl("0.16.1"));
  });

  it("escapes build metadata rather than letting `+` read as a space", () => {
    expect(releaseNotesUrl("0.16.1+build.3")).toBe(
      "https://github.com/pwrdrvr/PwrGit/releases/tag/v0.16.1%2Bbuild.3"
    );
  });

  it("answers undefined for anything this repo could not have tagged", () => {
    // No link beats a link onto a 404 — and a dev build's version is not a
    // published release at all.
    for (const version of [
      undefined,
      null,
      "",
      "   ",
      "latest",
      "0.16",
      "0.16.1.1",
      "0.16.x",
      "next"
    ]) {
      expect(releaseNotesUrl(version)).toBeUndefined();
    }
  });

  it("refuses a version that would escape the tag path", () => {
    // The regex is anchored precisely so a crafted version cannot compose a
    // URL that leaves `/pwrdrvr/PwrGit/releases/tag/`.
    for (const version of [
      "0.16.1/../../../evil",
      "0.16.1?x=1",
      "0.16.1#frag",
      "https://evil.example/0.16.1",
      "0.16.1 0.16.2",
      "0.16.1@evil.example",
      "0.16.1\\evil"
    ]) {
      expect(releaseNotesUrl(version)).toBeUndefined();
    }
  });

  it("composes URLs that stay on the published repository", () => {
    // `shell:openExternal` opens any credential-free http(s) URL, because
    // PwrGit opens PR links on arbitrary forges — so the narrowing that
    // matters here is the composer's own, not the gate's. Every URL it
    // produces has to stay under this repo's releases path.
    for (const url of [
      PWRGIT_LINKS.source,
      PWRGIT_LINKS.releases,
      releaseNotesUrl("0.16.1"),
      releaseNotesUrl("v0.16.0-beta.5"),
      releaseNotesUrl("0.16.1+build.3")
    ]) {
      expect(url).toBeDefined();
      expect(url?.startsWith("https://github.com/pwrdrvr/PwrGit")).toBe(true);
      expect(new URL(url as string).host).toBe("github.com");
    }
  });

  it("hangs off the repository address About already prints", () => {
    // This module declares no repo constant of its own: Settings → About shows
    // `PWRGIT_LINKS.source` verbatim beside a Copy button, so a second
    // spelling here would be visible to the user the day it drifted.
    expect(releaseNotesUrl("0.16.1")?.startsWith(PWRGIT_LINKS.source)).toBe(
      true
    );
  });
});
