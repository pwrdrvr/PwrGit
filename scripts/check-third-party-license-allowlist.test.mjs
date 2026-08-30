import { describe, expect, test } from "vitest";

import {
  ALLOWED_EMBEDDED_COPYLEFT_IDS,
  ALLOWED_LICENSE_IDS,
  SpdxParseError,
  checkEmbeddedRuntimeLicenses,
  checkNoticeDevDependencyLicenses,
  checkNpmDependencyLicenses,
  checkThirdPartyLicenseAllowlist,
  disallowedIdentifiers,
  evaluateSpdxExpression,
  isPermissive,
  isPermissiveOrDisclosedCopyleft,
  isStructuralToken,
  tokenizeSpdxExpression,
} from "./check-third-party-license-allowlist.mjs";
import {
  EMBEDDED_GIT_NOTICE_SOURCES,
  NOTICE_DEV_DEPENDENCIES,
  declaresCopyleft,
  flattenLicenseReport,
  validateEmbeddedNoticeSource,
} from "./generate-third-party-licenses.mjs";

/**
 * Build records the way the CLI does — through the generator's own flattener,
 * so a change to the report shape breaks these tests rather than letting them
 * pass against a shape production never sees.
 */
function records(licenseToPackages) {
  const report = {};
  for (const [license, names] of Object.entries(licenseToPackages)) {
    report[license] = names.map((name) => ({
      name,
      versions: ["1.0.0"],
      paths: ["/tmp/x"],
    }));
  }
  return flattenLicenseReport(report);
}

describe("SPDX evaluation", () => {
  const allow = (id) => id === "MIT" || id === "Apache-2.0" || id === "BSD-2-Clause";

  test("a bare allowed identifier passes and a bare disallowed one fails", () => {
    expect(evaluateSpdxExpression("MIT", allow)).toBe(true);
    expect(evaluateSpdxExpression("GPL-3.0", allow)).toBe(false);
  });

  test("OR is satisfied by either side, so a dual license passes on its good half", () => {
    // This is why WTFPL never needs allowlisting: "(WTFPL OR MIT)" lets us take
    // the MIT option. Collapsing OR to AND here would fail a real dependency.
    expect(evaluateSpdxExpression("(WTFPL OR MIT)", allow)).toBe(true);
    expect(evaluateSpdxExpression("(BSD-2-Clause OR MIT OR Apache-2.0)", allow)).toBe(true);
    expect(evaluateSpdxExpression("(GPL-3.0 OR AGPL-3.0)", allow)).toBe(false);
  });

  test("AND requires both sides, so a permissive half cannot launder a copyleft half", () => {
    expect(evaluateSpdxExpression("Apache-2.0 AND MIT", allow)).toBe(true);
    expect(evaluateSpdxExpression("Apache-2.0 AND GPL-3.0", allow)).toBe(false);
  });

  test("AND binds tighter than OR, per SPDX", () => {
    // MIT OR (Apache-2.0 AND GPL-3.0) is satisfiable; (MIT OR Apache-2.0) AND
    // GPL-3.0 is not. Getting the precedence backwards would accept the latter.
    expect(evaluateSpdxExpression("MIT OR Apache-2.0 AND GPL-3.0", allow)).toBe(true);
    expect(evaluateSpdxExpression("(MIT OR Apache-2.0) AND GPL-3.0", allow)).toBe(false);
  });

  test("operators are recognized case-insensitively", () => {
    expect(evaluateSpdxExpression("MIT or GPL-3.0", allow)).toBe(true);
    expect(evaluateSpdxExpression("MIT and GPL-3.0", allow)).toBe(false);
  });

  test("nested parentheses are handled", () => {
    expect(evaluateSpdxExpression("((MIT))", allow)).toBe(true);
    expect(evaluateSpdxExpression("(MIT OR (Apache-2.0 AND GPL-3.0))", allow)).toBe(true);
  });

  test("tokenizer splits parens that are flush against identifiers", () => {
    expect(tokenizeSpdxExpression("(WTFPL OR MIT)")).toEqual([
      "(",
      "WTFPL",
      "OR",
      "MIT",
      ")",
    ]);
  });

  test("isStructuralToken is what both the parser and the reporter agree on", () => {
    // Sharing one predicate is the point: when they diverge, a failure message
    // can name "OR" as though it were a rejected license identifier.
    for (const token of ["(", ")", "OR", "AND", "or", "and"]) {
      expect(isStructuralToken(token), token).toBe(true);
    }
    for (const token of ["MIT", "GPL-3.0", "WITH"]) {
      expect(isStructuralToken(token), token).toBe(false);
    }
  });

  test("disallowedIdentifiers names only real identifiers, never operators", () => {
    expect(disallowedIdentifiers("(GPL-3.0 AND SSPL-1.0)", allow)).toEqual([
      "GPL-3.0",
      "SSPL-1.0",
    ]);
  });

  test("disallowedIdentifiers deduplicates a repeated offender", () => {
    expect(disallowedIdentifiers("GPL-3.0 AND GPL-3.0", allow)).toEqual(["GPL-3.0"]);
  });

  test("an unparseable expression throws rather than guessing", () => {
    // "SEE LICENSE IN ..." and a dangling operator must not silently evaluate
    // to true on some substring. For a legal gate, refusing to guess is the
    // safe direction.
    expect(() => evaluateSpdxExpression("MIT OR", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("(MIT", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("AND MIT", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("SEE LICENSE IN LICENSE.md", allow)).toThrow(
      SpdxParseError,
    );
  });

  test("a WITH exception throws instead of being read as its bare license", () => {
    // "MIT WITH <exception>" must not be accepted as plain MIT — the exception
    // is the part that changes the terms.
    expect(() => evaluateSpdxExpression("MIT WITH Classpath-exception-2.0", allow)).toThrow(
      SpdxParseError,
    );
  });

  test("an empty or whitespace-only license throws", () => {
    expect(() => evaluateSpdxExpression("", allow)).toThrow(SpdxParseError);
    expect(() => evaluateSpdxExpression("   ", allow)).toThrow(SpdxParseError);
  });
});

describe("case folding", () => {
  test("SPDX identifiers match case-insensitively, per the spec", () => {
    // A package declaring "license": "mit" is legal SPDX and exists in the
    // wild. Matching case-sensitively would turn that into an unfixable red
    // build.
    expect(isPermissive("MIT")).toBe(true);
    expect(isPermissive("mit")).toBe(true);
    expect(isPermissive("Apache-2.0")).toBe(true);
    expect(isPermissive("APACHE-2.0")).toBe(true);
  });

  test("folding case does not let a disallowed id through in any casing", () => {
    for (const id of ["GPL-3.0", "gpl-3.0", "Gpl-3.0", "AGPL-3.0", "agpl-3.0"]) {
      expect(isPermissive(id), id).toBe(false);
    }
  });

  test("the embedded carve-out folds case too, and only for its one id", () => {
    expect(isPermissiveOrDisclosedCopyleft("gpl-2.0-only")).toBe(true);
    expect(isPermissiveOrDisclosedCopyleft("GPL-2.0-or-later")).toBe(false);
    expect(isPermissiveOrDisclosedCopyleft("GPL-3.0")).toBe(false);
  });

  test("a lowercase declaration passes the npm check end to end", () => {
    expect(checkNpmDependencyLicenses(records({ mit: ["lowercase-dep"] }))).toEqual([]);
  });
});

describe("npm dependency licenses", () => {
  test("passes the license set the tree actually declared when the gate was written", () => {
    expect(
      checkNpmDependencyLicenses(
        records({
          MIT: ["react"],
          "Apache-2.0": ["b4a"],
          ISC: ["semver"],
          "BSD-2-Clause": ["json-schema-typed"],
          "BSD-3-Clause": ["qs"],
          "BlueOak-1.0.0": ["sax"],
          "OFL-1.1": ["@fontsource/geist-sans"],
          "Python-2.0": ["argparse"],
        }),
      ),
    ).toEqual([]);
  });

  test("rejects a dependency that flipped from MIT to GPL", () => {
    // The scenario this gate exists for: the generator would happily transcribe
    // a new "GPL-3.0" section into THIRD_PARTY_LICENSES and `--check` would
    // then pass, because the committed file matches the generated one.
    const failures = checkNpmDependencyLicenses(records({ "GPL-3.0": ["some-dep"] }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/some-dep@1\.0\.0/);
    expect(failures[0]).toMatch(/GPL-3\.0/);
    expect(failures[0]).toMatch(/not on the allowlist/);
  });

  test("rejects GPL-2.0-only on an ordinary npm dependency", () => {
    // The repo-specific half of the carve-out. PwrGit ships a GPL-2.0-only Git
    // binary, so the id is not universally forbidden here — but it is permitted
    // only for the named embedded runtime. An npm dependency arriving under it
    // is linked into the app and has no corresponding-source disclosure.
    const failures = checkNpmDependencyLicenses(records({ "GPL-2.0-only": ["some-dep"] }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/some-dep@1\.0\.0/);
    expect(failures[0]).toMatch(/GPL-2\.0-only/);
    expect(failures[0]).toMatch(/not on the allowlist/);
  });

  test("a copyleft failure warns against allowlisting it to go green", () => {
    const [failure] = checkNpmDependencyLicenses(records({ "AGPL-3.0-only": ["some-dep"] }));
    expect(failure).toMatch(/copyleft/);
    expect(failure).toMatch(/do not allowlist it to make CI green/);
  });

  test("the copyleft steer covers LGPL too, not just GPL and AGPL", () => {
    // An anchored pattern lets "LGPL-3.0-or-later" miss the steer, and the
    // reader loses the one line telling them not to allowlist their way out.
    const [failure] = checkNpmDependencyLicenses(records({ "LGPL-3.0-or-later": ["some-dep"] }));
    expect(failure).toMatch(/do not allowlist it to make CI green/);
  });

  test("a non-copyleft rejection does not carry the copyleft steer", () => {
    const [failure] = checkNpmDependencyLicenses(records({ "SSPL-1.0": ["some-dep"] }));
    expect(failure).toMatch(/not on the allowlist/);
    expect(failure).not.toMatch(/copyleft/);
  });

  test("rejects a transitive GPL dep dragged in by a bump", () => {
    const failures = checkNpmDependencyLicenses(
      records({ MIT: ["react", "dugite"], "GPL-2.0-or-later": ["sneaky-transitive"] }),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/sneaky-transitive/);
  });

  test("rejects weak copyleft on an ordinary npm dependency", () => {
    const failures = checkNpmDependencyLicenses(records({ "LGPL-3.0-or-later": ["some-dep"] }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/LGPL-3\.0-or-later/);
  });

  test("rejects source-available terms", () => {
    const failures = checkNpmDependencyLicenses(
      records({ "BUSL-1.1": ["source-available"], "SSPL-1.0": ["also-not-open"] }),
    );
    expect(failures).toHaveLength(2);
  });

  test("rejects an unresolvable license string", () => {
    const failures = checkNpmDependencyLicenses(
      records({ UNLICENSED: ["private-thing"], "SEE LICENSE IN LICENSE.md": ["vague-thing"] }),
    );
    expect(failures).toHaveLength(2);
    // Two different roads to the same closed door. "UNLICENSED" is a single
    // well-formed token that simply is not allowlisted, while "SEE LICENSE IN
    // LICENSE.md" cannot be parsed at all. Both must fail; only the second is
    // reported as unparseable.
    const [privateThing, vagueThing] = failures;
    expect(privateThing).toMatch(/private-thing/);
    expect(privateThing).toMatch(/not on the allowlist/);
    expect(vagueThing).toMatch(/vague-thing/);
    expect(vagueThing).toMatch(/not a parseable SPDX expression/);
  });

  test("names every offending dependency, not just the first", () => {
    const failures = checkNpmDependencyLicenses(
      records({ "GPL-3.0": ["one", "two"], MIT: ["ok"] }),
    );
    expect(failures).toHaveLength(2);
  });

  test("an empty tree produces no failures", () => {
    expect(checkNpmDependencyLicenses([])).toEqual([]);
  });
});

describe("shipped devDependencies", () => {
  test("Electron is gated even though --prod never reports it", () => {
    // Electron is a devDependency that ships, so the generator merges it in
    // from the `all` report. Reading only the production report would leave the
    // single largest shipped component with an unchecked license.
    expect(NOTICE_DEV_DEPENDENCIES.has("electron")).toBe(true);
    const failures = checkNoticeDevDependencyLicenses(records({ "GPL-3.0": ["electron"] }));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/electron/);
  });

  test("a permissive Electron passes", () => {
    expect(checkNoticeDevDependencyLicenses(records({ MIT: ["electron"] }))).toEqual([]);
  });

  test("devDependencies the notice does not disclose are not gated", () => {
    // Dev-only tooling does not ship, so its license is out of scope; gating it
    // would turn the tree's existing WTFPL and CC-BY-4.0 dev deps into a failed
    // build.
    expect(checkNoticeDevDependencyLicenses(records({ WTFPL: ["some-dev-tool"] }))).toEqual([]);
    expect(checkNoticeDevDependencyLicenses(records({ "GPL-3.0": ["other-dev-tool"] }))).toEqual(
      [],
    );
  });

  test("the embedded carve-out does not reach the devDependency surface", () => {
    // NOTICE_DEV_DEPENDENCIES is checked with the npm predicate, so Electron
    // turning GPL-2.0-only fails like any other linked component.
    const failures = checkNoticeDevDependencyLicenses(records({ "GPL-2.0-only": ["electron"] }));
    expect(failures).toHaveLength(1);
  });
});

describe("embedded Git runtimes", () => {
  const ENTRIES = [
    { name: "Git embedded runtime", copyleft: { correspondingSource: "https://example.test/git" } },
    { name: "Git LFS embedded runtime" },
  ];

  test("permits GPL-2.0-only for the disclosed Git runtime", () => {
    expect(
      checkEmbeddedRuntimeLicenses(
        [{ name: "Git embedded runtime", version: "2.53.0", declaredLicense: "GPL-2.0-only" }],
        ENTRIES,
      ),
    ).toEqual([]);
  });

  test("permits a permissive runtime with no descriptor at all", () => {
    expect(
      checkEmbeddedRuntimeLicenses(
        [{ name: "Git LFS embedded runtime", version: "3.7.1", declaredLicense: "MIT" }],
        ENTRIES,
      ),
    ).toEqual([]);
  });

  test("rejects GPL-2.0-only on a runtime with no copyleft descriptor", () => {
    // The disclosure is the condition, not the identifier. Such a record would
    // ship a GPL binary with no corresponding-source pointer in the notice.
    const failures = checkEmbeddedRuntimeLicenses(
      [{ name: "Git LFS embedded runtime", version: "3.7.1", declaredLicense: "GPL-2.0-only" }],
      ENTRIES,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/no `copyleft` descriptor/);
  });

  test("rejects a runtime absent from the entry list entirely", () => {
    const failures = checkEmbeddedRuntimeLicenses(
      [{ name: "Some other runtime", version: "1.0.0", declaredLicense: "GPL-2.0-only" }],
      ENTRIES,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/no `copyleft` descriptor/);
  });

  test("a descriptor with no correspondingSource does not unlock the carve-out", () => {
    const failures = checkEmbeddedRuntimeLicenses(
      [{ name: "Git embedded runtime", version: "2.53.0", declaredLicense: "GPL-2.0-only" }],
      [{ name: "Git embedded runtime", copyleft: {} }],
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/no `copyleft` descriptor/);
  });

  test("rejects a copyleft id outside the carve-out even with a descriptor", () => {
    // The carve-out is one identifier, not "copyleft that carries paperwork".
    // GPL-3.0 and AGPL change the terms the app itself would ship under.
    for (const declaredLicense of ["GPL-3.0", "AGPL-3.0-only", "LGPL-2.1-or-later"]) {
      const failures = checkEmbeddedRuntimeLicenses(
        [{ name: "Git embedded runtime", version: "2.53.0", declaredLicense }],
        ENTRIES,
      );
      expect(failures, declaredLicense).toHaveLength(1);
      expect(failures[0]).toMatch(/not permitted in a shipped artifact/);
      expect(failures[0]).toMatch(/do not allowlist it to make CI green/);
    }
  });

  test("rejects an unparseable license on a runtime", () => {
    const failures = checkEmbeddedRuntimeLicenses(
      [
        {
          name: "Git embedded runtime",
          version: "2.53.0",
          declaredLicense: "SEE LICENSE IN COPYING",
        },
      ],
      ENTRIES,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/not a parseable SPDX expression/);
  });

  test("a carve-out descriptor does not excuse a license nobody can read", () => {
    // The descriptor says where the source is; it says nothing about what the
    // terms are. An unreadable declaration still fails.
    const failures = checkEmbeddedRuntimeLicenses(
      [{ name: "Git embedded runtime", version: "2.53.0", declaredLicense: "UNLICENSED" }],
      ENTRIES,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/not permitted in a shipped artifact/);
  });

  test("an empty runtime list is not a failure", () => {
    expect(checkEmbeddedRuntimeLicenses([], ENTRIES)).toEqual([]);
  });

  test("the real EMBEDDED_GIT_NOTICE_SOURCES inventory passes its own gate", () => {
    // The committed inventory is what actually ships, so it is checked here
    // rather than only through the CLI.
    expect(checkEmbeddedRuntimeLicenses(EMBEDDED_GIT_NOTICE_SOURCES)).toEqual([]);
  });

  test("the real Git entry is the only copyleft one, and it is disclosed", () => {
    const copyleft = EMBEDDED_GIT_NOTICE_SOURCES.filter((entry) =>
      declaresCopyleft(entry.declaredLicense),
    );
    expect(copyleft.map((entry) => entry.name)).toEqual(["Git embedded runtime"]);
    expect(copyleft[0].declaredLicense).toBe("GPL-2.0-only");
    expect(copyleft[0].copyleft.correspondingSource).toMatch(/^https:\/\//);
  });
});

describe("generator-side disclosure guard", () => {
  test("accepts a permissive runtime with no descriptor", () => {
    expect(() =>
      validateEmbeddedNoticeSource({ name: "Git LFS", declaredLicense: "MIT" }),
    ).not.toThrow();
  });

  test("refuses to generate a notice for a copyleft runtime with no descriptor", () => {
    // The same rule as the gate, enforced from the generating side, so the hole
    // cannot be opened by editing only one of the two files.
    expect(() =>
      validateEmbeddedNoticeSource({ name: "Some runtime", declaredLicense: "GPL-2.0-only" }),
    ).toThrow(/corresponding source/);
  });

  test("refuses a descriptor with no correspondingSource URL", () => {
    expect(() =>
      validateEmbeddedNoticeSource({
        name: "Some runtime",
        declaredLicense: "GPL-2.0-only",
        copyleft: {},
      }),
    ).toThrow(/correspondingSource/);
  });
});

describe("allowlist contents", () => {
  test("no copyleft or source-available id is on the permissive allowlist", () => {
    for (const id of ALLOWED_LICENSE_IDS) {
      expect(id).not.toMatch(/GPL|SSPL|BUSL|Commons-Clause|Elastic|RSAL/i);
    }
  });

  test("the embedded carve-out stays narrow", () => {
    // Widening this is a licensing decision about a specific shipped binary.
    // A test that names the expected contents makes that decision visible in a
    // diff instead of arriving as one more entry in a set.
    expect(Array.from(ALLOWED_EMBEDDED_COPYLEFT_IDS)).toEqual(["GPL-2.0-only"]);
  });

  test("no allowlisted permissive id is also carved out for embedded copyleft", () => {
    for (const id of ALLOWED_EMBEDDED_COPYLEFT_IDS) {
      expect(isPermissive(id), id).toBe(false);
    }
  });
});

describe("combined check", () => {
  test("reports npm, devDependency and embedded failures together, sorted", () => {
    const failures = checkThirdPartyLicenseAllowlist({
      productionRecords: records({ "GPL-3.0": ["zzz-dep"] }),
      allRecords: records({ "GPL-3.0": ["electron"] }),
      embeddedRecords: [
        { name: "Git embedded runtime", version: "2.53.0", declaredLicense: "GPL-3.0" },
      ],
    });
    expect(failures).toHaveLength(3);
    expect(failures).toEqual([...failures].sort((a, b) => a.localeCompare(b)));
  });

  test("a clean tree produces no failures", () => {
    expect(
      checkThirdPartyLicenseAllowlist({
        productionRecords: records({ MIT: ["react"] }),
        allRecords: records({ MIT: ["electron"] }),
        embeddedRecords: [],
      }),
    ).toEqual([]);
  });

  test("omitted npm surfaces default to empty, and embedded defaults to the real inventory", () => {
    // Defaulting the embedded surface to [] would let a caller silently skip
    // the one place copyleft is permitted.
    expect(checkThirdPartyLicenseAllowlist()).toEqual([]);
    expect(checkThirdPartyLicenseAllowlist({ embeddedRecords: undefined })).toEqual([]);
  });
});
