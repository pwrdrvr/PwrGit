import { normalize } from "node:path";

// Content rules for HTML that ships inside app.asar.
//
// The forbidden-pattern table in `verify-asar-contents.mjs` answers "may this
// file be in the bundle at all". These answer "is the content of a file that
// may be in the bundle acceptable", which needs the bytes rather than the
// path. Kept in their own module so they are unit-testable: the verifier
// itself is a top-level script that calls `process.exit`, so nothing can
// import it.

/**
 * The app's own renderer HTML, as `listPackage` spells it (leading slash,
 * backslashes already normalized to forward slashes by the verifier).
 *
 * Scoped to `/out/` on purpose. electron-builder ships `out/**` plus the
 * auto-included production `node_modules`, and a dependency that vendors a
 * playground page pointing at a CDN is not this repository's problem: the app
 * never loads it, and failing a release on it would tell the operator to unset
 * a flag that has nothing to do with the file.
 */
export function isRendererHtmlEntry(entry) {
  return /^\/out\/.*\.html?$/i.test(entry);
}

/**
 * A `<script src>` pointing anywhere outside the asar: absolute http(s) or
 * protocol-relative.
 *
 * The whitespace before `src` is load-bearing. `\bsrc` would also match the
 * hyphenated attributes (`data-src`, `x-src`) that lazy-loaders use as inert
 * placeholders, and flagging one of those would fail a release over markup
 * that loads nothing.
 *
 * The attribute run is quote-aware rather than a plain `[^>]*`: a `>` inside a
 * quoted value would end that run early, so a remote `src` after it would go
 * unseen. This gate is cheaper to make slightly broad than to let one through.
 */
const REMOTE_SCRIPT_PATTERN =
  /<script\b(?:[^>"']|"[^"]*"|'[^']*')*\ssrc\s*=\s*["']?(?:https?:)?\/\//i;

export function findRemoteScript(contents) {
  return REMOTE_SCRIPT_PATTERN.exec(contents)?.[0] ?? null;
}

/**
 * Turn a `listPackage` entry into the path `asar.extractFile` wants.
 *
 * Two conversions, both required. The leading slash goes because extractFile
 * addresses from the archive root. The separators go back to the platform's
 * because the verifier normalizes the listing to forward slashes for pattern
 * matching, while `@electron/asar` splits lookup paths on `path.sep` — on
 * Windows `"out/renderer".split("\\")` is one bogus segment, so every entry
 * would fail to resolve and the gate would fail a perfectly clean build.
 */
export function asarExtractPath(entry) {
  return normalize(entry.replace(/^\//, ""));
}
