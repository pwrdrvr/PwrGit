import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { noticePackageKeys } from "./generate-third-party-licenses.mjs";
import { applyVariant, proseLine, semver, textVariant } from "./test-support/line-endings.mjs";

const packageKey = fc
  .tuple(
    fc.oneof(
      fc.stringMatching(/^[a-z][a-z0-9.-]{0,10}$/),
      fc
        .tuple(fc.stringMatching(/^[a-z][a-z0-9-]{0,6}$/), fc.stringMatching(/^[a-z][a-z0-9.-]{0,8}$/))
        .map(([scope, name]) => `@${scope}/${name}`),
    ),
    semver,
  )
  .map(([name, version]) => `${name}@${version}`);

/**
 * A notice: prose, Source Availability bullets and Dependency Summary
 * bullets, in any order, under the title the generator always writes first.
 * (Without the title a BOM lands on a bullet, which no generated notice has.)
 */
const notice = fc
  .array(
    fc.oneof(
      packageKey.map((key) => ({ key, line: `- ${key} | https://example.test/${key}` })),
      proseLine.map((line) => ({ line: `- Git embedded runtime ${line.replaceAll("|", "")}: https://example.test/git` })),
      proseLine.map((line) => ({ line: line.replaceAll("|", "") })),
      fc.constant({ line: "" }),
    ),
    { maxLength: 12 },
  )
  .map((entries) => ({
    text: `${["PwrGit Third-Party Licenses", "===========================", "", ...entries.map(({ line }) => line)].join("\n")}\n`,
    keys: new Set(entries.flatMap(({ key }) => (key === undefined ? [] : [key]))),
  }));

describe("noticePackageKeys (property)", () => {
  test("lists every Dependency Summary package in any line-ending, BOM or final-newline form", () => {
    fc.assert(
      fc.property(notice, textVariant(), ({ text, keys }, variant) => {
        expect(noticePackageKeys(applyVariant(variant, text))).toEqual(keys);
      }),
    );
  });
});
