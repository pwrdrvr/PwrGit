import { describe, expect, test } from "vitest";

import {
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

  test("reports no difference for identical notices", () => {
    const text = notice("- a@1.0.0 | https://example.test/a");
    expect(describeNoticeDrift(text, text)).toBe("no difference found");
  });
});
