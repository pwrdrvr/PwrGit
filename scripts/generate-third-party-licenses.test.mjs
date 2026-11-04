import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import {
  EMBEDDED_GIT_NOTICE_SOURCES,
  NOTICE_PNPM_FILTERS,
  SHIPPED_PACKAGE_NAMES,
  describeNoticeDrift,
  noticePackageKeys,
} from "./generate-third-party-licenses.mjs";

describe("pnpm selector", () => {
  // Pinned to the literal strings on purpose. Everything else in
  // `licenses:check` keeps passing when the `...` is dropped: the notice
  // regenerates smaller, matches itself, and the allowlist gate — which reads
  // this same selector — happily reports a pass over the packages it can no
  // longer see. This assertion is the only thing that fails.
  test("selects each shipped project plus its dependency projects", () => {
    expect(NOTICE_PNPM_FILTERS).toEqual([
      "@pwrgit/desktop...",
      "@pwrgit/mcp-server...",
    ]);
  });

  test("every filter carries the dependency-projects suffix", () => {
    for (const filter of NOTICE_PNPM_FILTERS) {
      expect(filter.endsWith("...")).toBe(true);
    }
  });

  // The Scope prose names the projects; only the selector takes the suffix.
  test("scope prose names the projects without the suffix", () => {
    expect(SHIPPED_PACKAGE_NAMES).toEqual([
      "@pwrgit/desktop",
      "@pwrgit/mcp-server",
    ]);
    expect(NOTICE_PNPM_FILTERS).toEqual(
      SHIPPED_PACKAGE_NAMES.map((name) => `${name}...`),
    );
  });
});

describe("notice package keys", () => {
  test("reads the Dependency Summary bullets", () => {
    const keys = noticePackageKeys(
      [
        "MIT",
        "~~~",
        "- left-pad@1.0.0 | https://example.test/left-pad",
        "- @scope/thing@2.3.4 | https://example.test/thing",
        "",
      ].join("\n"),
    );
    expect(keys).toEqual(new Set(["left-pad@1.0.0", "@scope/thing@2.3.4"]));
  });

  test("ignores Source Availability bullets", () => {
    const keys = noticePackageKeys(
      "- Git embedded runtime 2.53.0 (GPL-2.0-only): https://example.test/git",
    );
    expect(keys.size).toBe(0);
  });
});

describe("notice drift description", () => {
  const notice = (...bullets) =>
    ["Dependency Summary", "------------------", "", ...bullets, ""].join("\n");

  test("names packages the committed file is missing", () => {
    const message = describeNoticeDrift(
      notice("- a@1.0.0 | https://example.test/a"),
      notice("- a@1.0.0 | https://example.test/a", "- b@2.0.0 | https://example.test/b"),
    );
    expect(message).toBe("missing from the committed file: b@2.0.0");
  });

  test("names packages that are no longer generated", () => {
    const message = describeNoticeDrift(
      notice("- a@1.0.0 | https://example.test/a", "- b@2.0.0 | https://example.test/b"),
      notice("- a@1.0.0 | https://example.test/a"),
    );
    expect(message).toBe("no longer generated: b@2.0.0");
  });

  test("reports both directions of a version bump", () => {
    const message = describeNoticeDrift(
      notice("- a@1.0.0 | https://example.test/a"),
      notice("- a@1.1.0 | https://example.test/a"),
    );
    expect(message).toBe(
      "missing from the committed file: a@1.1.0; no longer generated: a@1.0.0",
    );
  });

  test("caps the names it prints", () => {
    const bullets = (count, offset) =>
      Array.from(
        { length: count },
        (_, index) => `- p${String(index + offset).padStart(3, "0")}@1.0.0 | https://example.test/p`,
      );
    const message = describeNoticeDrift(notice(), notice(...bullets(25, 0)));
    expect(message).toContain("(+5 more)");
    expect(message.split(", ").length).toBe(20);
  });

  test("falls back to the first differing line when the packages match", () => {
    const message = describeNoticeDrift(
      notice("- a@1.0.0 | https://example.test/a") + "Copyright 2025 Someone\n",
      notice("- a@1.0.0 | https://example.test/a") + "Copyright 2026 Someone\n",
    );
    expect(message).toContain("same package set; first difference at line");
    expect(message).toContain("Copyright 2025 Someone");
    expect(message).toContain("Copyright 2026 Someone");
  });

  // A committed notice truncated by a partial write or a bad merge: same
  // package set, but the file simply stops.
  test("says a side ended rather than quoting a sentinel as content", () => {
    const bullet = "- a@1.0.0 | https://example.test/a";
    const message = describeNoticeDrift(
      `${bullet}\nMIT`,
      `${bullet}\nMIT\nLicense text`,
    );
    // Unquoted, so it cannot read as a committed line whose text is
    // literally "<end of file>".
    expect(message).toContain("committed <end of file>");
    expect(message).toContain('generated "License text"');
    expect(message).not.toContain('"<end of file>"');
  });

  test("reports no difference for identical notices", () => {
    const text = notice("- a@1.0.0 | https://example.test/a");
    expect(describeNoticeDrift(text, text)).toBe("no difference found");
  });
});

describe("the custom Git runtime's CA bundle notice", () => {
  // The pinned manifest is the oracle: it carries the license hash the
  // runtime build sealed. A repin that moves the bundle without refreshing
  // the committed copies fails here, not in a license review.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(readFileSync(join(repoRoot, "apps/desktop/custom-git-runtime.json"), "utf8"));
  const dir = join(repoRoot, "apps/desktop/resources/custom-git");

  test("every Linux asset pins the same bundle, and macOS none", () => {
    const linux = Object.entries(manifest.assets).filter(([key]) => key.startsWith("linux-"));
    expect(linux.length).toBeGreaterThan(0);
    for (const [, asset] of linux) expect(asset.ca_bundle).toEqual(manifest.assets["linux-x64"].ca_bundle);
    expect(manifest.assets["darwin-universal"].ca_bundle).toBeUndefined();
  });

  test("the committed license is the one the runtime ships", () => {
    const bundle = manifest.assets["linux-x64"].ca_bundle;
    const bytes = readFileSync(join(dir, "LICENSE.ca-bundle"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(bundle.license_sha256);
  });

  test("the committed notice names the pinned bundle", () => {
    const bundle = manifest.assets["linux-x64"].ca_bundle;
    const notice = readFileSync(join(dir, "NOTICE.ca-bundle"), "utf8");
    expect(notice).toContain(bundle.url);
    expect(notice).toContain(`Bundle date: ${bundle.date}`);
    expect(notice).toContain(`SHA256: ${bundle.sha256}`);
  });

  test("both are in the generated notice sources, outside Windows' Git folder", () => {
    const entries = EMBEDDED_GIT_NOTICE_SOURCES.filter((entry) => entry.file.endsWith(".ca-bundle"));
    expect(entries.map((entry) => entry.file).sort()).toEqual(["LICENSE.ca-bundle", "NOTICE.ca-bundle"]);
    for (const entry of entries) {
      expect(entry.declaredLicense).toBe("MPL-2.0");
      expect(entry.directory).toBe(dir);
    }
  });
});
