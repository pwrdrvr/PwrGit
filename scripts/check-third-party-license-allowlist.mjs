#!/usr/bin/env node

/**
 * Gate the licenses in THIRD_PARTY_LICENSES against an explicit allowlist.
 *
 * This is the check that `generate-third-party-licenses.mjs` deliberately is
 * not. That script is a transcriber: it asks pnpm what the tree declares and
 * writes it into THIRD_PARTY_LICENSES verbatim, grouping by whatever license
 * string it is handed. It never judges the string. So before this gate existed,
 * a dependency flipping MIT -> GPL-3.0 (or a transitive GPL dep arriving in a
 * Dependabot bump) produced a new "GPL-3.0" section in the notice, and
 * `licenses:check` then PASSED, because the committed file matched the
 * generated one. Green CI, copyleft shipped, nobody told.
 *
 * `check-package-license-policy.mjs` does not cover it either: that script
 * asserts our own workspace package.json files declare MIT, and never looks at
 * a dependency.
 *
 * ## What is covered, exactly
 *
 * The scope is "the records the notice is built from", because the notice is
 * the artifact this gate protects. `main()` in the generator assembles those
 * from three sources, and this gate reads all three:
 *
 * 1. The npm production tree (`NOTICE_PNPM_ARGS.production`) — the surface that
 *    moves on its own under Dependabot. Must be permissive.
 * 2. `NOTICE_DEV_DEPENDENCIES` out of the `all` report. The generator pulls
 *    Electron in from there because Electron is a devDependency that ships;
 *    reading only the production report would leave the single largest shipped
 *    component ungated. Must be permissive.
 * 3. `EMBEDDED_GIT_NOTICE_SOURCES`, the Git, Git LFS, and Git Credential
 *    Manager runtimes Dugite downloads outside npm's package inventory. The
 *    only place strong copyleft is permitted, and only for an entry carrying
 *    the `copyleft` disclosure descriptor that puts its corresponding-source
 *    pointer in the notice.
 *
 * NOT covered, and deliberately so:
 *
 * - **Optional dependencies.** `--no-optional` is what makes the notice
 *   identical on every platform, so neither report enumerates them. An optional
 *   dependency that ships is disclosed by neither the notice nor this gate; it
 *   would have to be added to the notice's sources deliberately, which is the
 *   same edit that brings it under this gate.
 * - **devDependencies outside `NOTICE_DEV_DEPENDENCIES`.** Dev tooling does not
 *   ship, so its license is out of scope; gating it would turn an unrelated
 *   copyleft dev tool into a failed build. The tree does carry such licenses
 *   today (WTFPL, CC-BY-4.0) and they are correctly not our problem.
 * - **Chromium's own credits inside Electron**, which the notice points at
 *   upstream rather than reproducing, and which pnpm cannot enumerate.
 *
 * Strong copyleft (GPL, AGPL) outside the embedded-runtime carve-out, weak
 * copyleft (LGPL) anywhere, and source-available terms (BSL, SSPL, Commons
 * Clause) are permitted nowhere. Neither is an unresolvable string like
 * "UNLICENSED" or "SEE LICENSE IN ...", which fails to parse and is reported.
 */

import { pathToFileURL } from "node:url";

import {
  COPYLEFT_PATTERN,
  EMBEDDED_GIT_NOTICE_SOURCES,
  NOTICE_DEV_DEPENDENCIES,
  NOTICE_PNPM_ARGS,
  declaresCopyleft,
  flattenLicenseReport,
  runPnpmLicenses,
} from "./generate-third-party-licenses.mjs";

/**
 * SPDX identifiers that may appear anywhere in the shipped npm tree.
 *
 * Seeded from what the tree actually declares — Apache-2.0, BSD-2-Clause,
 * BSD-3-Clause, BlueOak-1.0.0, ISC, MIT, OFL-1.1, Python-2.0 — plus the
 * permissive ids the Pwr family treats as always-allowed (MPL-2.0, 0BSD,
 * Unlicense, CC0-1.0), which no dependency happens to declare today.
 *
 * PwrGit documented no allowlist at all before this gate, so nothing had to be
 * decided when a new license arrived; that is the drift an unenforced policy
 * accumulates. The reconciled list now lives in AGENTS.md.
 *
 * Adding an id here is a deliberate legal decision. Make it explicitly, in a
 * commit that says why — do not add one to make CI green.
 */
export const ALLOWED_LICENSE_IDS = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  // Permissive, MIT-like with an explicit patent grant. Arrives transitively
  // through sax.
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  // Weak copyleft at file scope only, and only over MPL files themselves.
  "MPL-2.0",
  // SIL Open Font License, covering the @fontsource/geist-* webfont assets the
  // renderer build emits. Copyleft only in the narrow sense that a derived FONT
  // must stay OFL; it places no condition on software that merely embeds it.
  "OFL-1.1",
  // Permissive, no copyleft clause. Arrives transitively via argparse.
  "Python-2.0",
  "Unlicense",
]);

/**
 * Copyleft ids an EMBEDDED_GIT_NOTICE_SOURCES entry may declare, and only while
 * carrying a `copyleft` descriptor.
 *
 * This is the carve-out that lets PwrGit ship Git. It is deliberately one id,
 * and deliberately not reachable from the npm surface: the same GPL-2.0-only
 * string on an ordinary dependency fails, because a dependency is linked into
 * the app rather than invoked as a separate executable, and because nothing
 * would put its corresponding source in the notice.
 *
 * Keep it narrow. Widening it is a licensing decision about a specific shipped
 * binary, not a way to unblock a build.
 */
export const ALLOWED_EMBEDDED_COPYLEFT_IDS = new Set(["GPL-2.0-only"]);

export class SpdxParseError extends Error {}

/**
 * SPDX short identifiers are case-insensitive, so every comparison folds case.
 * Without this a package declaring the perfectly legal `"license": "mit"` fails
 * the gate with no fix available short of allowlisting a lowercase duplicate.
 */
function foldCase(identifier) {
  return identifier.toLowerCase();
}

const ALLOWED_LICENSE_IDS_FOLDED = new Set(Array.from(ALLOWED_LICENSE_IDS, foldCase));
const ALLOWED_EMBEDDED_COPYLEFT_IDS_FOLDED = new Set(
  Array.from(ALLOWED_EMBEDDED_COPYLEFT_IDS, foldCase),
);

export function isPermissive(identifier) {
  return ALLOWED_LICENSE_IDS_FOLDED.has(foldCase(identifier));
}

/**
 * Embedded runtimes may additionally declare the carved-out copyleft id, so
 * "GPL-2.0-only" evaluates true for them and only them.
 */
export function isPermissiveOrDisclosedCopyleft(identifier) {
  return (
    isPermissive(identifier) || ALLOWED_EMBEDDED_COPYLEFT_IDS_FOLDED.has(foldCase(identifier))
  );
}

/**
 * Split an SPDX expression into identifiers, operators and parens.
 */
export function tokenizeSpdxExpression(expression) {
  return expression
    .replaceAll("(", " ( ")
    .replaceAll(")", " ) ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * True for a token that is punctuation or an operator rather than a license id.
 *
 * Shared by the parser and by disallowedIdentifiers so the two cannot disagree
 * about what counts as an identifier — a disagreement would print an operator
 * in a failure message as though it were a rejected license.
 */
export function isStructuralToken(token) {
  const upper = token.toUpperCase();
  return token === "(" || token === ")" || upper === "OR" || upper === "AND";
}

/**
 * Evaluate an SPDX expression against a predicate over bare identifiers.
 *
 * OR is satisfied by either side and AND by both, per SPDX — which is what
 * makes "(MIT OR WTFPL)" pass without WTFPL being allowlisted (we take the MIT
 * option), while "Apache-2.0 AND GPL-3.0" correctly fails (we are bound by
 * both). AND binds tighter than OR.
 *
 * Anything that does not parse — "SEE LICENSE IN LICENSE.md", a bare
 * "UNLICENSED", a WITH exception — throws, and the caller reports it as a
 * failure. Refusing to guess is the safe direction for a legal gate.
 */
export function evaluateSpdxExpression(expression, isAllowed) {
  const tokens = tokenizeSpdxExpression(expression);
  let position = 0;

  const peek = () => tokens[position];

  const parseExpression = () => {
    let value = parseTerm();
    while (peek()?.toUpperCase() === "OR") {
      position += 1;
      // Parse before combining: `||` short-circuits, and a skipped parse would
      // leave the cursor mid-expression and mis-report the trailing-token check.
      const right = parseTerm();
      value = value || right;
    }
    return value;
  };

  const parseTerm = () => {
    let value = parseFactor();
    while (peek()?.toUpperCase() === "AND") {
      position += 1;
      const right = parseFactor();
      value = value && right;
    }
    return value;
  };

  const parseFactor = () => {
    const token = tokens[position];
    if (token === undefined) {
      throw new SpdxParseError(`unexpected end of expression in ${JSON.stringify(expression)}`);
    }
    if (token === "(") {
      position += 1;
      const value = parseExpression();
      if (tokens[position] !== ")") {
        throw new SpdxParseError(`unbalanced parentheses in ${JSON.stringify(expression)}`);
      }
      position += 1;
      return value;
    }
    if (isStructuralToken(token)) {
      throw new SpdxParseError(
        `unexpected ${JSON.stringify(token)} in ${JSON.stringify(expression)}`,
      );
    }
    position += 1;
    return isAllowed(token);
  };

  const value = parseExpression();
  if (position !== tokens.length) {
    throw new SpdxParseError(
      `trailing ${JSON.stringify(tokens[position])} in ${JSON.stringify(expression)}`,
    );
  }
  return value;
}

/**
 * The bare identifiers in an expression that the predicate rejects.
 *
 * Only meaningful once evaluation has already failed: in a satisfied OR the
 * rejected half is irrelevant, so naming it would misdirect the reader.
 */
export function disallowedIdentifiers(expression, isAllowed) {
  return Array.from(
    new Set(
      tokenizeSpdxExpression(expression).filter(
        (token) => !isStructuralToken(token) && !isAllowed(token),
      ),
    ),
  );
}

/**
 * Check one set of records against one predicate.
 *
 * Both surfaces share this so an identical failure cannot grow different
 * guidance depending on which list the package came from. `subject` prefixes
 * the label ("" for an npm dep, "embedded runtime " for a bundled binary) and
 * `remedy` closes the message.
 */
function checkRecords(records, { isAllowed, subject = "", remedy }) {
  const failures = [];

  for (const record of records) {
    const label = `${subject}${record.name}@${record.version || "?"}`;
    let allowed;
    try {
      allowed = evaluateSpdxExpression(record.declaredLicense, isAllowed);
    } catch (error) {
      failures.push(
        `${label} declares ${JSON.stringify(record.declaredLicense)}, which is not a parseable ` +
          `SPDX expression (${error.message}). A dependency whose license cannot be read ` +
          `cannot be shipped.`,
      );
      continue;
    }
    if (allowed) continue;

    const offenders = disallowedIdentifiers(record.declaredLicense, isAllowed);
    const isCopyleft = offenders.some((id) => COPYLEFT_PATTERN.test(id));
    failures.push(
      `${label} declares ${JSON.stringify(record.declaredLicense)}; ` +
        `${offenders.join(", ")} ${offenders.length === 1 ? "is" : "are"} ${remedy}` +
        (isCopyleft
          ? " This is a copyleft license — do not allowlist it to make CI green; drop or replace" +
            " the dependency, or escalate the licensing decision."
          : ""),
    );
  }

  return failures;
}

export function checkNpmDependencyLicenses(records) {
  return checkRecords(records, {
    isAllowed: isPermissive,
    remedy: "not on the allowlist in scripts/check-third-party-license-allowlist.mjs.",
  });
}

/**
 * The devDependencies the notice discloses because they ship — Electron today.
 *
 * Filtered from the `all` report by the same set the generator merges them in
 * with, so the gate's coverage tracks the notice's contents.
 */
export function checkNoticeDevDependencyLicenses(allRecords) {
  return checkNpmDependencyLicenses(
    allRecords.filter((record) => NOTICE_DEV_DEPENDENCIES.has(record.name)),
  );
}

/**
 * The Dugite-provided runtimes, where the GPL-2.0-only carve-out applies.
 *
 * Two rules, and a record has to clear both: the expression must evaluate under
 * a predicate that adds only ALLOWED_EMBEDDED_COPYLEFT_IDS, and any copyleft it
 * names must be backed by a `copyleft` descriptor on the matching entry. The
 * second is what keeps the carve-out narrow — the id alone is never enough,
 * because the descriptor is what puts the corresponding-source pointer in the
 * notice.
 */
export function checkEmbeddedRuntimeLicenses(records, entries = EMBEDDED_GIT_NOTICE_SOURCES) {
  const carriesDescriptor = new Map(
    entries.map((entry) => [
      entry.name,
      typeof entry.copyleft?.correspondingSource === "string",
    ]),
  );

  const failures = checkRecords(records, {
    isAllowed: isPermissiveOrDisclosedCopyleft,
    subject: "embedded runtime ",
    remedy: "not permitted in a shipped artifact.",
  });

  for (const record of records) {
    if (!declaresCopyleft(record.declaredLicense)) continue;
    if (carriesDescriptor.get(record.name) === true) continue;
    failures.push(
      `embedded runtime ${record.name}@${record.version || "?"} declares a copyleft license ` +
        `(${record.declaredLicense}) but has no \`copyleft\` descriptor naming its corresponding ` +
        `source in EMBEDDED_GIT_NOTICE_SOURCES, so the notice would ship it with no source ` +
        `disclosure.`,
    );
  }

  return failures;
}

export function checkThirdPartyLicenseAllowlist({
  productionRecords = [],
  allRecords = [],
  embeddedRecords = EMBEDDED_GIT_NOTICE_SOURCES,
} = {}) {
  return [
    ...checkNpmDependencyLicenses(productionRecords),
    ...checkNoticeDevDependencyLicenses(allRecords),
    ...checkEmbeddedRuntimeLicenses(embeddedRecords),
  ].sort((a, b) => a.localeCompare(b));
}

function runCli() {
  // Two reports for the same reason the generator takes two: the production
  // tree, plus the `all` tree that Electron (a devDependency that ships) is
  // only visible in.
  const productionRecords = flattenLicenseReport(runPnpmLicenses(NOTICE_PNPM_ARGS.production));
  const allRecords = flattenLicenseReport(runPnpmLicenses(NOTICE_PNPM_ARGS.all));
  const failures = checkThirdPartyLicenseAllowlist({ productionRecords, allRecords });

  if (failures.length > 0) {
    console.error("third-party license allowlist check failed:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("third-party license allowlist check passed");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli();
}
