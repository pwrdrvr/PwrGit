import { describe, expect, it } from "vitest";
import type { DiscoveredForgeHost } from "./cli-hosts";
import { ForgeHosts, ForgeHostsView } from "./hosts";

const view = (
  discovered: DiscoveredForgeHost[],
  hosts: Record<
    string,
    { kind?: "github" | "gitlab"; enabled?: boolean; label?: string }
  > = {}
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
        kindSource: "auto",
        enabled: true,
        enabledSource: "auto",
        origin: "cli",
        cli: "gh",
        account: "o.dev",
        scopes: ["repo"]
      }
    ]);
  });

  it("carries the name the user gave a host, unresolved", () => {
    // Carried rather than derived here: deriving a short name is the
    // renderer's job, and a second derivation in main would be one more thing
    // to keep in step with the one drawing the chips.
    const rows = view([], {
      "ghe.acme.example": { kind: "github", label: "Acme" }
    }).rows();
    expect(rows[0]?.label).toBe("Acme");
  });

  it("leaves the name absent for a host nobody has named", () => {
    // Absent means "nobody decided", which is what leaves the derivation in
    // charge. An empty string would be a name of its own.
    const named = view([], { "a.example": { kind: "github", label: "" } }).rows();
    expect(named[0]?.label).toBeUndefined();
    const unnamed = view([{ kind: "github", host: "github.com" }]).rows();
    expect(unnamed[0]?.label).toBeUndefined();
    expect("label" in (unnamed[0] ?? {})).toBe(false);
  });

  it("distinguishes a chosen product from a derived one", () => {
    // `origin` answers "does a CLI hold an account here", `kindSource` answers
    // "did a person choose this product". Settings gates its Remove control on
    // the second: gating on the first offered to clear the entry of a host the
    // user had merely switched off, which turned that host back ON and dropped
    // the row that could undo it.
    const chosen = view([], { "git.contoso.dev": { kind: "gitlab" } }).rows();
    expect(chosen[0]?.kindSource).toBe("config");

    // Switched off, product never chosen: the kind comes from the SaaS
    // fallback, so there is nothing for the user to withdraw.
    const derived = view([], { "github.com": { enabled: false } }).rows();
    expect(derived[0]?.origin).toBe("config");
    expect(derived[0]?.kindSource).toBe("auto");
  });

  it("names glab for a GitLab row, so the sign-in command is right", () => {
    const rows = view([], { "git.contoso.dev": { kind: "gitlab" } }).rows();
    expect(rows[0]?.cli).toBe("glab");
    expect(rows[0]?.origin).toBe("config");
    // On by default: a known forge is readable unless somebody turned it off.
    expect(rows[0]?.enabled).toBe(true);
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
