#!/usr/bin/env node

/**
 * Renderer color-literal lint.
 *
 * Walks every stylesheet under `apps/desktop/src/renderer/src/styles/` and
 * asserts that hex / rgb / rgba / hsl / hsla literals only appear inside the
 * token-definition blocks of `tokens.css`. Every other rule — in `tokens.css`
 * or anywhere else — must reference colors via `var(--token)` (or
 * `color-mix(in srgb, var(--token) X%, transparent)` for derived alphas).
 *
 * Ported from PwrAgnt, which keeps tokens and rules in a single `app.css` and
 * therefore only needs a selector allowlist. PwrGit splits them: `tokens.css`
 * holds the `:root` / `:root[data-theme="..."]` blocks and `app.css` holds the
 * rules. So the allowlist here is (file, selector), not selector alone — a
 * stray `:root { --x: #abc; }` in `app.css` is a violation, because the theme
 * blocks are meant to live in exactly one file.
 *
 * Without this, the next contributor who adds `color: #abcdef;` somewhere
 * silently breaks light-theme rendering: the literal doesn't flip with
 * `data-theme`.
 *
 * The check is intentionally CSS-only and shape-pure: no parser dependency, no
 * token-name validation, no contrast checking. It only answers one question:
 * "is this literal inside an allowlisted rule?" Hardcoded colors in `.tsx`
 * (SVG `fill=` / `stroke=` attributes, inline styles) are out of scope and
 * need a manual pass.
 *
 * Wire-up:
 *   - `pnpm lint:colors` runs it standalone.
 *   - `pnpm lint` runs it alongside licenses:check / typecheck, which is what
 *     CI invokes.
 */

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const stylesDir = resolve(repoRoot, "apps/desktop/src/renderer/src/styles");

// The one file allowed to declare raw color literals, and only inside the
// theme blocks listed below.
const TOKENS_FILE = "tokens.css";

// Rules whose bodies may contain raw color literals — the token-definition
// blocks. Anything else must use `var(--token)`.
//
// Matched against the rule's selector text after whitespace normalization,
// and only in TOKENS_FILE. To add a future theme (e.g. high-contrast), drop
// its selector here AND add the corresponding `:root[data-theme="..."]` block
// in tokens.css.
const ALLOWED_TOKEN_SELECTORS = new Set([
  ":root",
  ':root[data-theme="light"]',
  ':root[data-theme="dark"]',
]);

// Selector substrings whose rules may carry raw color literals because
// they're bespoke illustration assets, not chrome surfaces — they
// intentionally do not flow with the global theme. Use sparingly: prefer
// adding the surface to the regular token system so it themes correctly.
//
// Empty today. PwrGit's one illustration-shaped surface (the commit-graph
// lane palette) lives in tokens.css as --lane-1..--lane-8 with per-theme
// values, so it needs no exemption.
const ALLOWED_SELECTOR_SUBSTRINGS = [];

// Color literal patterns. Hex covers #abc / #abcd / #abcdef / #abcdefab.
// Functional notation covers rgb()/rgba()/hsl()/hsla() — the leading keyword
// is what triggers detection, so `color-mix(in srgb, ...)` is NOT matched (the
// `srgb` inside is bare, no leading `rgb(`).
//
// We deliberately do NOT flag the 147 CSS named colors (red, white, etc.) —
// they're rare enough in this codebase that the marginal value isn't worth the
// false-positive surface from things like `font-family: "Helvetica"` (string,
// stripped) or property values that share names (`color-scheme: dark`, etc.).
const COLOR_LITERAL_RE = /(#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\()/g;

runSelfTests();

const files = readdirSync(stylesDir)
  .filter((name) => name.endsWith(".css"))
  .sort();

if (files.length === 0) {
  console.error(`No stylesheets found under ${relative(repoRoot, stylesDir)}.`);
  process.exit(1);
}
if (!files.includes(TOKENS_FILE)) {
  console.error(
    `Expected ${TOKENS_FILE} under ${relative(repoRoot, stylesDir)} — the token blocks moved or were renamed. Update this script.`,
  );
  process.exit(1);
}

const findings = [];
for (const name of files) {
  const path = resolve(stylesDir, name);
  // Strip only comments at the source level (strings in selectors like
  // `:root[data-theme="light"]` must survive so the allowlist match works).
  // Strings inside rule bodies are stripped per-body in the scanner — see
  // `collectFindings`.
  const scrubbed = stripComments(readFileSync(path, "utf8"));
  for (const f of collectFindings(scrubbed, name)) {
    findings.push({ ...f, file: relative(repoRoot, path) });
  }
}

if (findings.length > 0) {
  console.error(
    `Raw color literals must live inside :root or :root[data-theme="..."] in ${TOKENS_FILE}.`,
  );
  console.error(
    "Use var(--token), or color-mix(in srgb, var(--token) <pct>%, transparent)",
  );
  console.error(`for derived alpha overlays. Define new tokens in ${TOKENS_FILE}.`);
  console.error("");
  for (const f of findings) {
    console.error(
      `- ${f.file}:${f.line} in \`${f.selector} { ... }\`: ${f.literal}`,
    );
  }
  process.exit(1);
}

console.log(
  `renderer color lint passed (${files.length} stylesheet${files.length === 1 ? "" : "s"})`,
);

/**
 * Replace each CSS block comment with same-length whitespace so line numbers
 * in the original source still resolve correctly. Strings are left intact at
 * the source level — the body scanner strips them locally so attribute-selector
 * strings like `data-theme="light"` survive for the allowlist match.
 */
function stripComments(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out.push(blank(text.slice(i, stop)));
      i = stop;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

/** Per-body string strip. Used when scanning a rule's body for color literals
 *  — prevents hex inside data-URLs (e.g. `url("data:...%23ff0000")`) from
 *  being treated as a violation. */
function stripStrings(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'") {
      const close = findStringClose(text, i + 1, c);
      out.push(blank(text.slice(i, close)));
      i = close;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

function findStringClose(text, start, quote) {
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    if (c === "\n") return i; // unterminated; stop at newline
    i += 1;
  }
  return text.length;
}

function blank(slice) {
  return slice.replace(/[^\n]/g, " ");
}

/**
 * Walk the CSS, tracking the rule-nesting stack and the start of the current
 * segment (selector or rule body). For every literal found in a rule body,
 * check whether the rule's selector is allowlisted for this file; if not,
 * record a finding.
 */
function collectFindings(text, fileName) {
  const findings = [];
  const stack = []; // Array<string> of selectors
  let segmentStart = 0;

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "{") {
      const selector = normalizeSelector(text.slice(segmentStart, i));
      stack.push(selector);
      segmentStart = i + 1;
    } else if (c === "}") {
      const body = text.slice(segmentStart, i);
      const selector = stack[stack.length - 1] ?? "";
      // Only check rules whose body directly contains declarations — at-rule
      // wrappers like `@media (...)` either delegate to nested rules (which we
      // check on their own pop) or hold declarations we'd also want to check.
      // Either way, this attributes a literal to the *innermost* rule
      // containing it, which is the semantically correct owner.
      if (!isAllowed(selector, fileName)) {
        for (const hit of findLiterals(body, segmentStart)) {
          findings.push({ selector, line: hit.line, literal: hit.text });
        }
      }
      stack.pop();
      segmentStart = i + 1;
    }
  }

  return findings;

  function findLiterals(body, bodyStartIndex) {
    const scannable = stripStrings(body);
    const out = [];
    COLOR_LITERAL_RE.lastIndex = 0;
    let m;
    while ((m = COLOR_LITERAL_RE.exec(scannable)) !== null) {
      const absoluteIndex = bodyStartIndex + m.index;
      out.push({ text: m[0], line: lineNumberAt(absoluteIndex) });
    }
    return out;
  }

  function lineNumberAt(position) {
    let line = 1;
    for (let j = 0; j < position; j += 1) {
      if (text[j] === "\n") line += 1;
    }
    return line;
  }
}

function normalizeSelector(raw) {
  return raw.trim().replace(/\s+/g, " ");
}

function isAllowed(selector, fileName) {
  if (fileName === TOKENS_FILE && ALLOWED_TOKEN_SELECTORS.has(selector)) {
    return true;
  }
  for (const substring of ALLOWED_SELECTOR_SUBSTRINGS) {
    if (selector.includes(substring)) return true;
  }
  return false;
}

function runSelfTests() {
  function findings(css, fileName = TOKENS_FILE) {
    return collectFindings(stripComments(css), fileName);
  }

  // 1. Allowlisted :root block in tokens.css — should pass.
  if (findings(":root { --bg: #000000; }").length !== 0) {
    throw new Error("self-test: :root literal was incorrectly flagged");
  }

  // 2. Allowlisted light-theme block in tokens.css — should pass.
  if (findings(':root[data-theme="light"] { --bg: #ffffff; }').length !== 0) {
    throw new Error("self-test: light-theme literal was incorrectly flagged");
  }

  // 3. The same :root block in a non-token file — should fail. This is the
  //    PwrGit-specific rule: theme blocks live in exactly one file.
  const strayRoot = findings(":root { --bg: #000000; }", "app.css");
  if (strayRoot.length !== 1) {
    throw new Error("self-test: :root outside tokens.css was not flagged");
  }

  // 4. Component rule with raw hex — should fail.
  const componentHex = findings(".graph-row { color: #ff0000; }", "app.css");
  if (componentHex.length !== 1 || componentHex[0].literal !== "#ff0000") {
    throw new Error("self-test: failed to flag raw hex in component rule");
  }

  // 5. Component rule with rgba — should fail.
  const componentRgba = findings(
    ".graph-row { background: rgba(255, 0, 0, 0.5); }",
    "app.css",
  );
  if (componentRgba.length !== 1) {
    throw new Error("self-test: failed to flag rgba in component rule");
  }

  // 6. color-mix using var() — should NOT flag.
  const colorMix = findings(
    ".x { background: color-mix(in srgb, var(--accent) 50%, transparent); }",
    "app.css",
  );
  if (colorMix.length !== 0) {
    throw new Error("self-test: color-mix(var(...)) incorrectly flagged");
  }

  // 7. Hex inside a /* comment */ — should not flag.
  const commented = findings(
    ".x { /* old: #ff0000 */ color: var(--bg-app); }",
    "app.css",
  );
  if (commented.length !== 0) {
    throw new Error("self-test: literal inside comment incorrectly flagged");
  }

  // 8. Hex inside a string (e.g. data URL) — should not flag.
  const stringed = findings(
    ".x { background: url('data:image/svg+xml,%23ff0000'); }",
    "app.css",
  );
  if (stringed.length !== 0) {
    throw new Error("self-test: literal inside string incorrectly flagged");
  }

  // 9. Literal inside a nested @media rule — should attribute to the inner
  //    rule and flag it.
  const nested = findings(
    "@media (max-width: 760px) { .x { color: #abc; } }",
    "app.css",
  );
  if (nested.length !== 1 || nested[0].selector !== ".x") {
    throw new Error("self-test: nested-rule literal mis-attributed");
  }

  // 10. Literal inside a @keyframes step — flagged, attributed to the step.
  const keyframe = findings(
    "@keyframes head-flash { 0% { background: #abc; } }",
    "app.css",
  );
  if (keyframe.length !== 1 || keyframe[0].selector !== "0%") {
    throw new Error("self-test: keyframe literal mis-attributed");
  }

  // 11. Line numbers survive comment stripping.
  const lineCheck = findings("/* a */\n.x { color: #f00; }", "app.css");
  if (lineCheck.length !== 1 || lineCheck[0].line !== 2) {
    throw new Error(
      `self-test: line number drifted under comment stripping (got ${lineCheck[0]?.line})`,
    );
  }
}
