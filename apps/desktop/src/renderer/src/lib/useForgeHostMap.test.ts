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
 *
 * Only the case a main-process spec cannot reach lives here — the rest is
 * `main/forge/hosts.test.ts`'s end-to-end block, which owns the enumerated and
 * switched-off paths. What is unique here is that a renderer spec may import
 * main (`.dependency-cruiser.cjs` exempts test files from
 * `renderer-does-not-import-main`, and not the other way round), so the two
 * sides of the channel can be asserted against each other at all.
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

});
