import { describe, expect, it } from "vitest";
import { parseForgeRemote } from "@pwrgit/shared";
// Main-process imports from a renderer spec: allowed for vitest specs
// specifically, so the two sides of a contract can be asserted together —
// see the header of `.dependency-cruiser.cjs`.
import { parseGlabHosts } from "../../../main/forge/cli-hosts";
import { ForgeHosts, ForgeHostsView } from "../../../main/forge/hosts";

/**
 * The contract `useForgeHostMap` exists for: the map the clone and fork
 * dialogs classify a pasted URL with is the map main resolves with, not a
 * second derivation of it. `forge:hosts` ships `ForgeHosts.overrides()`
 * directly, so this spec pins what that channel carries.
 */
const status = `gitlab.acme-corp.example
  ✓ Logged in to gitlab.acme-corp.example as a.dev (keyring)
`;

const view = (env: NodeJS.ProcessEnv = {}, hosts = {}): ForgeHostsView =>
  new ForgeHostsView(
    new ForgeHosts({
      readSettings: () => ({ hosts }),
      discovered: () => parseGlabHosts(status),
      env
    }),
    async () => {}
  );

describe("the map forge:hosts ships", () => {
  it("places a CLI-enumerated self-managed instance", () => {
    expect(view().overrides()).toEqual({
      "gitlab.acme-corp.example": "gitlab"
    });
    const url = "git@gitlab.acme-corp.example:acme/platform/billing.git";
    expect(parseForgeRemote(url, view().overrides())).toMatchObject({
      host: "gitlab",
      hostname: "gitlab.acme-corp.example",
      nameWithOwner: "acme/platform/billing"
    });
    // And without the list it is `other` — the state this plumbing exists to
    // avoid leaving the dialogs in.
    expect(parseForgeRemote(url)?.host).toBe("other");
  });

  it("carries a host named only by the env allowlist", () => {
    // The regression that made deriving the map from `rows()` wrong: `list()`
    // is "what has a settings row", and an env-allowlisted host has none — so
    // main resolved it and the dialogs read the same URL as `other`.
    const scoped = view({ PWRGIT_GITHUB_HOSTS: "ghe.acme-corp.example" });
    expect(scoped.overrides()["ghe.acme-corp.example"]).toBe("github");
    expect(scoped.rows().map((row) => row.host)).not.toContain(
      "ghe.acme-corp.example"
    );
    expect(
      parseForgeRemote(
        "git@ghe.acme-corp.example:acme/api.git",
        scoped.overrides()
      )?.host
    ).toBe("github");
  });

  it("keeps a host the user switched off", () => {
    // "Which forge runs here" and "may we talk to it" are separate questions.
    // The map answers the first; `isEnabled` answers the second, and main
    // gates on it at every site that would spawn a CLI.
    const off = view({}, {
      "gitlab.acme-corp.example": { enabled: false }
    });
    expect(off.overrides()["gitlab.acme-corp.example"]).toBe("gitlab");
    expect(off.rows()[0]?.enabled).toBe(false);
  });
});
