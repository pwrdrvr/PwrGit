import { describe, expect, it } from "vitest";
import type { DiscoveredForgeHost } from "./cli-hosts";
import { ForgeHosts, ForgeHostsView } from "./hosts";

const view = (
  discovered: DiscoveredForgeHost[],
  hosts: Record<string, { kind?: "github" | "gitlab"; enabled?: boolean }> = {}
) =>
  new ForgeHostsView(
    new ForgeHosts({
      readSettings: () => ({ hosts }),
      discovered: () => discovered,
      env: {}
    }),
    async () => undefined
  );

describe("ForgeHostsView.rows", () => {
  it("renders a signed-in host with its account, CLI and scopes", () => {
    const rows = view([
      { kind: "github", host: "github.acme-inc.com", account: "o.dev", scopes: ["repo"] }
    ]).rows();
    expect(rows).toEqual([
      {
        host: "github.acme-inc.com",
        kind: "github",
        enabled: true,
        enabledSource: "auto",
        origin: "cli",
        cli: "gh",
        account: "o.dev",
        scopes: ["repo"]
      }
    ]);
  });

  it("names glab for a GitLab row, so the sign-in command is right", () => {
    const rows = view([], { "git.contoso.dev": { kind: "gitlab" } }).rows();
    expect(rows[0]?.cli).toBe("glab");
    expect(rows[0]?.origin).toBe("config");
    expect(rows[0]?.enabled).toBe(false);
  });

  it("reports an explicit off as a config decision, not a derived one", () => {
    // The pane needs the distinction: "off because you said so" must not read
    // the same as "off because nothing is signed in".
    const rows = view([{ kind: "gitlab", host: "gitlab.com" }], {
      "gitlab.com": { enabled: false }
    }).rows();
    expect(rows[0]).toMatchObject({ enabled: false, enabledSource: "config" });
  });

  it("never emits a row for a host with no forge", () => {
    expect(view([], { "nas.local": { enabled: true } }).rows()).toEqual([]);
  });
});
