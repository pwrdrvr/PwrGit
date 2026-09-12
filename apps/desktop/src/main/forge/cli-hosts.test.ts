import { describe, expect, it } from "vitest";
import {
  discoverForgeHosts,
  parseGhHosts,
  parseGlabHosts
} from "./cli-hosts";

/** Verbatim shape of `gh auth status --json hosts` (gh 2.100.0). */
const GH_JSON = JSON.stringify({
  hosts: {
    "github.com": [
      {
        state: "success",
        active: true,
        host: "github.com",
        login: "octo-dev",
        tokenSource: "keyring",
        scopes: "gist, read:org, repo",
        gitProtocol: "ssh"
      }
    ],
    "github.acme-inc.com": [
      {
        state: "success",
        active: true,
        host: "github.acme-inc.com",
        login: "o.dev",
        tokenSource: "keyring",
        scopes: "repo",
        gitProtocol: "https"
      }
    ]
  }
});

/** Verbatim shape of `glab auth status --all` (glab 1.117.0), which glab
 *  writes to stderr, not stdout. */
const GLAB_TEXT = `gitlab.com
  ✓ Logged in to gitlab.com as octo-dev (keyring)
  ✓ Git operations for gitlab.com configured to use ssh protocol.
  ✓ API calls for gitlab.com are made over https protocol.
  ✓ REST API Endpoint: https://gitlab.com/api/v4/
  ✓ GraphQL Endpoint: https://gitlab.com/api/graphql/
  ✓ Token found in operating system keyring: **************************
gitlab.internal.example
  ✓ Logged in to gitlab.internal.example as o.dev (config)
  ✓ REST API Endpoint: https://gitlab.internal.example/api/v4/
`;

describe("parseGhHosts", () => {
  it("reads every host with its account and scopes", () => {
    expect(parseGhHosts(GH_JSON)).toEqual([
      {
        kind: "github",
        host: "github.com",
        account: "octo-dev",
        scopes: ["gist", "read:org", "repo"]
      },
      {
        kind: "github",
        host: "github.acme-inc.com",
        account: "o.dev",
        scopes: ["repo"]
      }
    ]);
  });

  it("takes the active account when a host has several", () => {
    // PwrGit reads with whatever `gh api --hostname` would use, and that is
    // the active account — not simply the first one listed.
    const json = JSON.stringify({
      hosts: {
        "github.com": [
          { login: "old-account", active: false, scopes: "repo" },
          { login: "current", active: true, scopes: "repo" }
        ]
      }
    });
    expect(parseGhHosts(json)[0]?.account).toBe("current");
  });

  it("returns nothing for a gh too old to know --json hosts", () => {
    // Old gh prints usage text to stdout rather than failing in a way we can
    // distinguish. Enumerating nothing is correct: the user adds hosts by hand.
    expect(parseGhHosts("Usage:  gh auth status [flags]\n")).toEqual([]);
  });

  it("survives a host entry with no accounts", () => {
    expect(parseGhHosts(JSON.stringify({ hosts: { "ghe.acme.com": [] } })))
      .toEqual([{ kind: "github", host: "ghe.acme.com" }]);
  });
});

describe("parseGlabHosts", () => {
  it("reads each instance and its account from the text report", () => {
    expect(parseGlabHosts(GLAB_TEXT)).toEqual([
      { kind: "gitlab", host: "gitlab.com", account: "octo-dev" },
      {
        kind: "gitlab",
        host: "gitlab.internal.example",
        account: "o.dev"
      }
    ]);
  });

  it("ignores a configured instance that is not logged in", () => {
    // glab lists instances it could not authenticate to. Those are not hosts
    // PwrGit can read, so they must not become enabled rows.
    const text = `gitlab.com
  ✓ Logged in to gitlab.com as octo-dev (keyring)
gitlab.broken.example
  x No token provided for gitlab.broken.example
`;
    expect(parseGlabHosts(text).map((entry) => entry.host)).toEqual([
      "gitlab.com"
    ]);
  });

  it("tolerates ANSI colour and CRLF", () => {
    // \u001b, not a literal ESC: the escape has to be visible here or the
    // test silently stops exercising ANSI at all.
    const text =
      "\u001b[0;32mgitlab.com\u001b[0m\r\n" +
      "  \u001b[0;32m✓\u001b[0m Logged in to gitlab.com as octo-dev (keyring)\r\n";
    expect(parseGlabHosts(text)).toEqual([
      { kind: "gitlab", host: "gitlab.com", account: "octo-dev" }
    ]);
  });

  it("returns nothing when glab is signed out entirely", () => {
    expect(parseGlabHosts("")).toEqual([]);
  });
});

describe("discoverForgeHosts", () => {
  it("merges both CLIs", async () => {
    const hosts = await discoverForgeHosts({
      gh: async () => GH_JSON,
      glabAuthStatus: async () => GLAB_TEXT
    });
    expect(hosts.map((entry) => `${entry.kind}:${entry.host}`)).toEqual([
      "github:github.com",
      "github:github.acme-inc.com",
      "gitlab:gitlab.com",
      "gitlab:gitlab.internal.example"
    ]);
  });

  it("contributes nothing for a CLI that is missing", async () => {
    // A machine with no glab is the ordinary case, not a failure to report.
    const hosts = await discoverForgeHosts({
      gh: async () => GH_JSON,
      glabAuthStatus: async () => {
        throw new Error("spawn glab ENOENT");
      }
    });
    expect(hosts.every((entry) => entry.kind === "github")).toBe(true);
    expect(hosts).toHaveLength(2);
  });

  it("returns nothing when neither CLI is installed", async () => {
    expect(
      await discoverForgeHosts({
        gh: async () => {
          throw new Error("spawn gh ENOENT");
        },
        glabAuthStatus: async () => {
          throw new Error("spawn glab ENOENT");
        }
      })
    ).toEqual([]);
  });
});
