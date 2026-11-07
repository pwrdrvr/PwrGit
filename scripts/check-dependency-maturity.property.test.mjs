import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseLockedPackages, parseMaturityPolicy } from "./check-dependency-maturity.mjs";
import { applyVariant, BOM, proseLine, semver, textVariant } from "./test-support/line-endings.mjs";

const packageName = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9-]{0,10}$/),
  fc
    .tuple(fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/), fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/))
    .map(([scope, name]) => `@${scope}/${name}`),
);

const filler = fc.oneof(
  proseLine.map((line) => `# ${line.replaceAll("#", "")}`),
  fc.constant(""),
);

// ---- pnpm-workspace.yaml -------------------------------------------------

/** One cooldown setting and its exclusions, and the file a person might write for them. */
const workspace = fc
  .record({
    minutes: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: undefined }),
    underscores: fc.boolean(),
    ageComment: fc.boolean(),
    exclusions: fc.option(
      fc.array(
        fc.record({
          entry: fc.oneof(packageName, fc.tuple(packageName, semver).map(([n, v]) => `${n}@${v}`)),
          quote: fc.nat({ max: 2 }),
          comment: fc.boolean(),
          before: fc.array(filler, { maxLength: 2 }),
        }),
        { maxLength: 4 },
      ),
      { nil: undefined },
    ),
    // Other top-level settings, any of which may come first in the file.
    others: fc.array(
      fc.oneof(
        fc.constant(["packages:", "  - apps/*", "  - packages/*"]),
        fc.constant(["allowBuilds:", "  esbuild: true"]),
        fc.constant(["globalPnpmfile: null"]),
        filler.map((line) => [line]),
      ),
      { maxLength: 4 },
    ),
    ageAt: fc.nat(),
    exclusionsAt: fc.nat(),
  })
  .map((shape) => {
    const blocks = [...shape.others];
    if (shape.minutes !== undefined) {
      const digits = shape.underscores
        ? String(shape.minutes).replace(/\B(?=(\d{3})+(?!\d))/g, "_")
        : String(shape.minutes);
      blocks.splice(shape.ageAt % (blocks.length + 1), 0, [
        `minimumReleaseAge: ${digits}${shape.ageComment ? "  # seven days" : ""}`,
      ]);
    }
    if (shape.exclusions !== undefined) {
      blocks.splice(shape.exclusionsAt % (blocks.length + 1), 0, [
        "minimumReleaseAgeExclude:",
        ...shape.exclusions.flatMap(({ entry, quote, comment, before }) => [
          ...before,
          `  - ${["", "'", '"'][quote]}${entry}${["", "'", '"'][quote]}${comment ? "  # why" : ""}`,
        ]),
      ]);
    }
    return {
      text: `${blocks.flat().join("\n")}\n`,
      expected: {
        minimumReleaseAgeMinutes: shape.minutes,
        exclusions: (shape.exclusions ?? []).map(({ entry }) => entry),
      },
    };
  });

describe("parseMaturityPolicy (property)", () => {
  it("reads back the cooldown and exclusions it was written with, in any line-ending, BOM or final-newline form", () => {
    fc.assert(
      fc.property(workspace, textVariant(), ({ text, expected }, variant) => {
        expect(parseMaturityPolicy(applyVariant(variant, text))).toEqual(expected);
      }),
    );
  });
});

// ---- pnpm-lock.yaml ------------------------------------------------------

const lockedPackage = fc.record({
  name: packageName,
  version: fc.oneof(
    { weight: 4, arbitrary: semver },
    // Resolutions with no registry publish time: never audited.
    fc.constantFrom("link:../shared", "file:vendor/pkg.tgz"),
  ),
  quote: fc.boolean(),
  peers: fc.boolean(),
});

/** One lockfile document, as pnpm writes it. */
const lockDocument = fc
  .record({ packages: fc.array(lockedPackage, { maxLength: 5 }), separator: fc.boolean() })
  .map(({ packages, separator }) => ({
    packages,
    lines: [
      ...(separator ? ["---"] : []),
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    devDependencies:",
      "      vitest:",
      "        specifier: ^4.1.12",
      "        version: 4.1.12",
      "",
      "packages:",
      "",
      ...packages.flatMap(({ name, version, quote }) => {
        const key = quote ? `'${name}@${version}'` : `${name}@${version}`;
        return [`  ${key}:`, "    resolution: {integrity: sha512-AAAA}", "    engines: {node: '>=18'}", ""];
      }),
      "snapshots:",
      "",
      // The same releases again, which must not be counted twice.
      ...packages.flatMap(({ name, version, peers }) => [
        `  ${name}@${version}${peers ? "(zod@4.5.1)" : ""}: {}`,
        "",
      ]),
    ],
  }));

const lockfile = fc.array(lockDocument, { minLength: 1, maxLength: 2 }).map((documents) => {
  const seen = new Set();
  const expected = [];
  for (const { name, version } of documents.flatMap((document) => document.packages)) {
    if (!/^\d/.test(version) || seen.has(`${name}@${version}`)) continue;
    seen.add(`${name}@${version}`);
    expected.push({ name, version });
  }
  // pnpm puts a separator between documents.
  const text = documents
    .map(({ lines }, index) => (index > 0 && lines[0] !== "---" ? ["---", ...lines] : lines).join("\n"))
    .join("\n");
  return { text: `${text}\n`, expected };
});

describe("parseLockedPackages (property)", () => {
  it("lists each registry package in `packages:` once, in any line-ending, BOM or final-newline form", () => {
    fc.assert(
      fc.property(lockfile, textVariant(), ({ text, expected }, variant) => {
        expect(parseLockedPackages(applyVariant(variant, text))).toEqual(expected);
      }),
    );
  });
});

describe("dependency maturity parsers (shrunk counterexamples)", () => {
  it("reads a cooldown on the first line of a pnpm-workspace.yaml that starts with a BOM", () => {
    // Shrunk from the property: the BOM hid `minimumReleaseAge`, and the
    // audit reported "sets no minimumReleaseAge".
    expect(parseMaturityPolicy(`${BOM}minimumReleaseAge: 0\n`)).toEqual({
      minimumReleaseAgeMinutes: 0,
      exclusions: [],
    });
  });

  it("keeps the exclusion list open across CRLF lines", () => {
    expect(
      parseMaturityPolicy("minimumReleaseAgeExclude:\r\n  # why\r\n  - 'zod@4.5.1'\r\n"),
    ).toEqual({ minimumReleaseAgeMinutes: undefined, exclusions: ["zod@4.5.1"] });
  });
});
