import { describe, expect, it } from "vitest";
import { parseForgeRemote, type ForgeHostRow } from "@pwrgit/shared";
import { forgeHostMap } from "./useForgeHostMap";
// Main-process imports from a renderer spec: allowed for vitest specs
// specifically, so the two sides of a contract can be asserted together —
// see the header of `.dependency-cruiser.cjs`.
import { parseGlabHosts } from "../../../main/forge/cli-hosts";
import { ForgeHosts, ForgeHostsView } from "../../../main/forge/hosts";

const row = (over: Partial<ForgeHostRow> = {}): ForgeHostRow => ({
  host: "gitlab.acme-corp.example",
  kind: "gitlab",
  enabled: true,
  enabledSource: "auto",
  origin: "cli",
  cli: "glab",
  ...over
});

describe("forgeHostMap", () => {
  it("turns forge:hosts rows into the classifier's host map", () => {
    expect(
      forgeHostMap([row(), row({ host: "ghe.acme-corp.example", kind: "github" })])
    ).toEqual({
      "gitlab.acme-corp.example": "gitlab",
      "ghe.acme-corp.example": "github"
    });
  });

  it("keeps a disabled host, which is a known forge that is switched off", () => {
    // "Which forge runs here" and "may we talk to it" are separate questions;
    // main's `overrides()` keeps disabled hosts for the same reason. Dropping
    // one would make a host the user switched off read as an unknown forge —
    // a different message, and a different fix.
    expect(forgeHostMap([row({ enabled: false })])).toEqual({
      "gitlab.acme-corp.example": "gitlab"
    });
  });

  it("is empty for no rows, which resolves the two SaaS hosts and nothing else", () => {
    expect(forgeHostMap([])).toEqual({});
    expect(parseForgeRemote("git@github.com:o/r.git", forgeHostMap([]))?.host).toBe(
      "github"
    );
  });
});

describe("the renderer's map and main's overrides", () => {
  // The contract this spec exists for: a self-managed instance `glab` is
  // signed in to must classify the same way in the clone/fork dialogs as it
  // does for change-request status in main. One list, two readers — and a
  // `gitlab.*` hostname is not a third answer any more.
  const status = `gitlab.acme-corp.example
  ✓ Logged in to gitlab.acme-corp.example as a.dev (keyring)
`;
  const hosts = new ForgeHosts({
    readSettings: () => ({ hosts: {} }),
    discovered: () => parseGlabHosts(status),
    env: {}
  });

  it("agree on every enumerated host", () => {
    const rows = new ForgeHostsView(hosts, async () => {}).rows();
    expect(forgeHostMap(rows)).toEqual(hosts.overrides());
  });

  it("classify a pasted remote on that host identically", () => {
    const rows = new ForgeHostsView(hosts, async () => {}).rows();
    const url = "git@gitlab.acme-corp.example:acme/platform/billing.git";
    expect(parseForgeRemote(url, forgeHostMap(rows))).toMatchObject({
      host: "gitlab",
      hostname: "gitlab.acme-corp.example",
      nameWithOwner: "acme/platform/billing"
    });
    // And without the list it is `other` — the state this whole plumbing
    // exists to avoid leaving the dialogs in.
    expect(parseForgeRemote(url)?.host).toBe("other");
  });
});
