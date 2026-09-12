import { describe, expect, it } from "vitest";
import {
  derivedForgeHostName,
  FORGE_HOST_LABEL_MAX,
  forgeHostName,
  resolveForgeHostNames,
  sanitizeForgeHostLabel
} from "./forge-host-name";

describe("derivedForgeHostName", () => {
  it("names a product's own instance after the product", () => {
    expect(derivedForgeHostName("github.com", "github")).toBe("GitHub");
    expect(derivedForgeHostName("gitlab.com", "gitlab")).toBe("GitLab");
  });

  it("skips generic hosting words to reach the company's own name", () => {
    expect(derivedForgeHostName("gitlab.example.com", "gitlab")).toBe("example");
    expect(derivedForgeHostName("ghe.acme.example", "github")).toBe("acme");
    expect(derivedForgeHostName("git.acme.io", "gitlab")).toBe("acme");
    expect(derivedForgeHostName("code.acme.co.uk", "github")).toBe("acme");
  });

  it("keeps the chip short on a deeply nested corporate host", () => {
    // The case this whole module exists for: a chip cannot carry this
    // hostname, and the first meaningful label is the one a human uses.
    expect(
      derivedForgeHostName(
        "github.acme.huge-corp.southeast.us.corp",
        "github"
      )
    ).toBe("acme");
  });

  it("never answers with the TLD", () => {
    expect(derivedForgeHostName("acme.com", "github")).toBe("acme");
    // Single label: there is no TLD to drop, so the label itself is the name.
    expect(derivedForgeHostName("gitbox", "other")).toBe("gitbox");
  });

  it("falls back to the first label when every candidate is generic", () => {
    expect(derivedForgeHostName("git.code.com", "gitlab")).toBe("git");
  });

  it("reads the product off `host`, never off the hostname", () => {
    // The product-name shortcut fires only when the hostname IS that
    // product's own instance. A host that resolved to GitLab does not become
    // "GitHub" by being spelled that way — it falls through to the label
    // derivation like any other self-managed host.
    expect(derivedForgeHostName("github.com", "gitlab")).toBe("github");
  });

  it("names an unclaimed host without inventing a product for it", () => {
    expect(derivedForgeHostName("gitlab.example.com", "other")).toBe("example");
  });
});

describe("sanitizeForgeHostLabel", () => {
  it("trims and collapses whitespace", () => {
    expect(sanitizeForgeHostLabel("  Acme   Corp ")).toBe("Acme Corp");
  });

  it("answers null for a label that says nothing, which clears it", () => {
    expect(sanitizeForgeHostLabel("")).toBeNull();
    expect(sanitizeForgeHostLabel("   ")).toBeNull();
  });

  it("replaces control and format characters rather than dropping them", () => {
    // A bidi override would reorder the text drawn around the chip.
    expect(sanitizeForgeHostLabel("Ac‮me")).toBe("Ac me");
    expect(sanitizeForgeHostLabel("one\ntwo")).toBe("one two");
  });

  it("caps the length without splitting a surrogate pair", () => {
    const long = "🙂".repeat(FORGE_HOST_LABEL_MAX + 5);
    const capped = sanitizeForgeHostLabel(long);
    expect(capped).not.toBeNull();
    expect([...(capped ?? "")]).toHaveLength(FORGE_HOST_LABEL_MAX);
    expect(capped).not.toContain("�");
  });

  it("caps a plain over-long label to the maximum", () => {
    const capped = sanitizeForgeHostLabel("a".repeat(100));
    expect(capped).toBe("a".repeat(FORGE_HOST_LABEL_MAX));
  });
});

describe("forgeHostName", () => {
  it("prefers what the user called it", () => {
    expect(
      forgeHostName({
        hostname: "github.acme.huge-corp.southeast.us.corp",
        host: "github",
        label: "Acme"
      })
    ).toBe("Acme");
  });

  it("falls back to the derived name for a label that says nothing", () => {
    expect(
      forgeHostName({ hostname: "gitlab.example.com", host: "gitlab", label: "  " })
    ).toBe("example");
  });
});

describe("resolveForgeHostNames", () => {
  it("names each host independently when nothing collides", () => {
    const names = resolveForgeHostNames([
      { hostname: "github.com", host: "github" },
      { hostname: "gitlab.com", host: "gitlab" },
      { hostname: "ghe.acme.example", host: "github" }
    ]);
    expect(names.get("github.com")).toBe("GitHub");
    expect(names.get("gitlab.com")).toBe("GitLab");
    expect(names.get("ghe.acme.example")).toBe("acme");
  });

  it("abandons a derived name that lands on two hosts", () => {
    // Both derive to "acme", which would answer "which one?" with the same
    // word twice — worse than the long hostname it replaced.
    const names = resolveForgeHostNames([
      { hostname: "github.acme.example", host: "github" },
      { hostname: "gitlab.acme.example", host: "gitlab" }
    ]);
    expect(names.get("github.acme.example")).toBe("github.acme.example");
    expect(names.get("gitlab.acme.example")).toBe("gitlab.acme.example");
  });

  it("keeps a user's name even when it collides with a derived one", () => {
    const names = resolveForgeHostNames([
      { hostname: "github.acme.example", host: "github", label: "acme" },
      { hostname: "gitlab.acme.example", host: "gitlab" }
    ]);
    expect(names.get("github.acme.example")).toBe("acme");
    // The derived side is alone in the derived pool, so it keeps its name.
    expect(names.get("gitlab.acme.example")).toBe("acme");
  });

  it("compares derived names case-insensitively", () => {
    const names = resolveForgeHostNames([
      { hostname: "github.com", host: "github" },
      // Resolves to GitHub too — a hand-added Enterprise host on a name that
      // derives to the same word.
      { hostname: "github.example", host: "other" }
    ]);
    expect(names.get("github.com")).toBe("github.com");
    expect(names.get("github.example")).toBe("github.example");
  });

  it("names a hostname listed twice once", () => {
    const names = resolveForgeHostNames([
      { hostname: "ghe.acme.example", host: "github" },
      { hostname: "ghe.acme.example", host: "github" }
    ]);
    expect(names.size).toBe(1);
    expect(names.get("ghe.acme.example")).toBe("acme");
  });

  it("is empty for an empty list", () => {
    expect(resolveForgeHostNames([]).size).toBe(0);
  });
});
