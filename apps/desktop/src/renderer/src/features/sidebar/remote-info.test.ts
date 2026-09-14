import { describe, expect, it } from "vitest";
import {
  remoteHostname,
  remoteUrlLines,
  remoteWebUrl,
  remoteWhere,
  remoteWire
} from "./remote-info";

describe("remoteWire", () => {
  it("reads the wire off the URL rather than guessing it", () => {
    expect(remoteWire("git@github.com:desktop/dugite.git")).toBe("SSH");
    expect(remoteWire("ssh://git@github.com:22/desktop/dugite.git")).toBe("SSH");
    expect(remoteWire("https://github.com/desktop/dugite.git")).toBe("HTTPS");
    expect(remoteWire("http://gitlab.internal/team/app.git")).toBe("HTTP");
    expect(remoteWire("git://github.com/desktop/dugite.git")).toBe("git");
  });

  it("calls a path a path, on either platform", () => {
    // The scp pattern would happily read `C:` as a host and `\repos\x` as a
    // path, which is how a Windows checkout ends up labelled SSH.
    expect(remoteWire("C:\\repos\\mirror.git")).toBe("local");
    expect(remoteWire("/srv/git/mirror.git")).toBe("local");
    expect(remoteWire("file:///srv/git/mirror.git")).toBe("local");
    expect(remoteWire("../sibling")).toBe("local");
  });
});

describe("remoteWhere", () => {
  it("names the host, not a product", () => {
    // A git remote is never evidence of a forge — the chip beside this makes
    // the product claim, and only for a host something actually recognises.
    expect(remoteWhere("git@github.com:desktop/dugite.git")).toBe(
      "SSH to github.com"
    );
    expect(remoteWhere("https://git.acme.internal/team/app.git")).toBe(
      "HTTPS to git.acme.internal"
    );
  });

  it("says something true about a remote with no host", () => {
    expect(remoteWhere("/srv/git/mirror.git")).toBe("A local path");
  });
});

describe("remoteHostname", () => {
  it("survives a user and a port", () => {
    expect(remoteHostname("ssh://git@github.com:2222/o/r.git")).toBe(
      "github.com"
    );
    expect(remoteHostname("GIT@GitHub.com:o/r.git")).toBe("github.com");
    expect(remoteHostname("/srv/git/mirror.git")).toBeNull();
  });
});

describe("remoteWebUrl", () => {
  it("offers a page only for a host a product claims", () => {
    expect(remoteWebUrl("git@github.com:desktop/dugite.git")).toBe(
      "https://github.com/desktop/dugite"
    );
    expect(remoteWebUrl("https://gitlab.com/group/sub/app.git")).toBe(
      "https://gitlab.com/group/sub/app"
    );
  });

  it("invents nothing for a host nothing recognises", () => {
    // A bare repo on a NAS parses as a remote perfectly well. Handing the user
    // a link into it is worse than handing them none.
    expect(remoteWebUrl("git@nas.local:backups/mirror.git")).toBeNull();
    expect(remoteWebUrl("/srv/git/mirror.git")).toBeNull();
  });

  it("follows an override to a self-managed instance", () => {
    expect(
      remoteWebUrl("git@git.acme.com:team/app.git", { "git.acme.com": "gitlab" })
    ).toBe("https://git.acme.com/team/app");
  });
});

describe("remoteUrlLines", () => {
  it("says URL once when git keeps one", () => {
    expect(
      remoteUrlLines({ fetchUrl: "git@github.com:o/r.git", pushUrl: "" })
    ).toEqual([{ label: "URL", url: "git@github.com:o/r.git" }]);
    expect(
      remoteUrlLines({
        fetchUrl: "git@github.com:o/r.git",
        pushUrl: "git@github.com:o/r.git"
      })
    ).toEqual([{ label: "URL", url: "git@github.com:o/r.git" }]);
  });

  it("says both when they differ, which is the case one line misreports", () => {
    expect(
      remoteUrlLines({
        fetchUrl: "https://github.com/o/r.git",
        pushUrl: "git@github.com:o/r.git"
      })
    ).toEqual([
      { label: "Fetch", url: "https://github.com/o/r.git" },
      { label: "Push", url: "git@github.com:o/r.git" }
    ]);
  });
});
