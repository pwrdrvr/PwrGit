import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { releaseNotesMatch } from "./publish-desktop-release.mjs";
import { applyVariant, proseLine, textVariant, toCrlf } from "./test-support/line-endings.mjs";

const notes = fc
  .array(
    fc.oneof(proseLine.map((line) => `- ${line}`), proseLine.map((line) => `### ${line}`), fc.constant("")),
    { minLength: 1, maxLength: 8 },
  )
  .map((lines) => `${lines.join("\n")}\n`)
  .filter((text) => text.trim() !== "");

describe("release notes comparison (property)", () => {
  test("a body matches its notes however either is line-ended", () => {
    fc.assert(
      fc.property(notes, textVariant(), textVariant(), (text, bodyForm, fileForm) => {
        expect(releaseNotesMatch(applyVariant(bodyForm, text), applyVariant(fileForm, text))).toBe(true);
      }),
    );
  });

  test("a body with another line does not match, however it is line-ended", () => {
    fc.assert(
      fc.property(notes, proseLine, textVariant(), (text, extra, bodyForm) => {
        const edited = `${text}- ${extra}\n`;
        expect(releaseNotesMatch(applyVariant(bodyForm, edited), text)).toBe(false);
      }),
    );
  });
});

describe("release notes comparison (shrunk counterexample)", () => {
  test("a body saved from GitHub's web form (CRLF) still matches the LF notes file", () => {
    // Before releaseNotesMatch, `body.trim() !== notes.trim()` refused this,
    // so re-running publication after a no-op edit of the release reported
    // "metadata differs from the checked changelog notes".
    const text = "- a\n\n- b\n";
    expect(releaseNotesMatch(toCrlf(text), text)).toBe(true);
  });
});
