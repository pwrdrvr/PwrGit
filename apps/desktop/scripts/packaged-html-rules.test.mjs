import { describe, expect, it } from "vitest";
import { sep } from "node:path";
import {
  asarExtractPath,
  findRemoteScript,
  isRendererHtmlEntry,
} from "./packaged-html-rules.mjs";

describe("packaged HTML rules", () => {
  it("scopes the scan to the app's own renderer HTML", () => {
    expect(isRendererHtmlEntry("/out/renderer/index.html")).toBe(true);
    expect(isRendererHtmlEntry("/out/renderer/index.htm")).toBe(true);
  });

  it("ignores dependency HTML the app never loads", () => {
    // electron-builder auto-includes the production node_modules tree. A
    // dependency's playground page pointing at a CDN is not a packaging defect
    // in this repository, and failing a release on it would tell the operator
    // to unset a flag that has nothing to do with the file.
    expect(isRendererHtmlEntry("/node_modules/some-dep/demo/playground.html")).toBe(false);
    expect(isRendererHtmlEntry("/out/renderer/assets/index.js")).toBe(false);
  });

  it("detects the DevTools bridge the gate exists to stop", () => {
    // The returned snippet is what the failure message prints, so it has to
    // carry enough of the tag for an operator to recognize the offender.
    const snippet = findRemoteScript('<script src="http://localhost:8097"></script>');
    expect(snippet).toContain("<script");
    expect(snippet).toContain("http://");
  });

  it("detects remote scripts across quoting and protocol forms", () => {
    for (const markup of [
      `<script src='https://cdn.example.com/x.js'></script>`,
      `<script src=https://cdn.example.com/x.js></script>`,
      `<script src="//cdn.example.com/x.js"></script>`,
      `<script\n  type="module"\n  src="https://cdn.example.com/x.js"\n></script>`,
      `<script defer SRC = "HTTP://cdn.example.com/x.js"></script>`
    ]) {
      expect(findRemoteScript(markup)).not.toBeNull();
    }
  });

  it("leaves local scripts alone", () => {
    for (const markup of [
      `<script type="module" crossorigin src="./assets/index-Dv9_pZYO.js"></script>`,
      `<script type="module" src="/src/main.tsx"></script>`,
      `<script>console.info("http://localhost:8097")</script>`
    ]) {
      expect(findRemoteScript(markup)).toBeNull();
    }
  });

  it("does not mistake hyphenated attributes for a src", () => {
    // `\bsrc` would match after the hyphen, failing a release over a
    // lazy-loading placeholder that loads nothing.
    expect(
      findRemoteScript('<script data-src="https://cdn.example.com/x.js"></script>')
    ).toBeNull();
  });

  it("still sees a remote src after a quoted attribute containing '>'", () => {
    // A plain `[^>]*` attribute run ends at the `>` inside the quoted value,
    // so the real src after it would never be reached.
    expect(
      findRemoteScript('<script data-cfg="a>b" src="https://cdn.example.com/x.js"></script>')
    ).not.toBeNull();
    expect(
      findRemoteScript(`<script data-cfg='x>y' src="//cdn.example.com/x.js"></script>`)
    ).not.toBeNull();
  });

  it("converts a listing entry to the path extractFile wants", () => {
    // `listPackage` output is normalized to forward slashes for matching, but
    // `@electron/asar` splits lookup paths on `path.sep`. On Windows a
    // forward-slash path collapses to one bogus segment and every entry fails
    // to resolve, so the gate rejects a clean bundle.
    expect(asarExtractPath("/out/renderer/index.html")).toBe(
      ["out", "renderer", "index.html"].join(sep)
    );
    expect(asarExtractPath("/out/index.html")).toBe(["out", "index.html"].join(sep));
  });

  it("strips exactly the archive-root slash", () => {
    expect(asarExtractPath("/out/a/b.html").startsWith(sep)).toBe(false);
  });
});
