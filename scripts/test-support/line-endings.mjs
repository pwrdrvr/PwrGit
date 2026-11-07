// Test-only helpers for metamorphic line-ending properties: rewrites of a
// text file that must not change what a parser reads from it.
//
// Why: the release gate once read a CRLF checkout of release.yml as "every
// Windows job missing" (#96), and no test caught it. Git for Windows defaults
// to `core.autocrlf=true`, editors there can add a byte-order mark, and an
// editor elsewhere may drop or add the final newline. A parser of a file a
// person or a tool writes should read all of those the same.

import fc from "fast-check";

export const BOM = "﻿";

export function toCrlf(text) {
  return text.replace(/\r?\n/g, "\r\n");
}

/**
 * Every rewrite, by name. `identity` comes first so fast-check shrinks a
 * failing assignment toward "this file unchanged", isolating the one rewrite
 * that matters.
 */
export const TEXT_VARIANTS = {
  identity: (text) => text,
  crlf: toCrlf,
  bom: (text) => `${BOM}${text}`,
  "bom+crlf": (text) => `${BOM}${toCrlf(text)}`,
  "extra trailing newline": (text) => `${text}\n`,
  "extra trailing crlf": (text) => `${toCrlf(text)}\r\n`,
  "no final newline": (text) => text.replace(/(?:\r?\n)+$/, ""),
};

export const TEXT_VARIANT_NAMES = Object.keys(TEXT_VARIANTS);

/** One variant name; pass `names` to narrow to the ones a format allows. */
export function textVariant(names = TEXT_VARIANT_NAMES) {
  return fc.constantFrom(...names);
}

export function applyVariant(name, text) {
  const rewrite = TEXT_VARIANTS[name];
  if (rewrite === undefined) throw new Error(`unknown text variant ${name}`);
  return rewrite(text);
}

/** A line of plain prose that cannot be mistaken for structure. */
export const proseLine = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789 .,()`'-"), {
    minLength: 1,
    maxLength: 30,
  })
  .map((chars) => chars.join("").trim())
  .filter((line) => line.length > 0);

/** A semver release: `1.2.3`, `1.2.3-beta.1`. */
export const semver = fc
  .tuple(
    fc.nat({ max: 30 }),
    fc.nat({ max: 99 }),
    fc.nat({ max: 99 }),
    fc.option(
      fc.tuple(fc.constantFrom("alpha", "beta", "rc", "prerelease"), fc.nat({ max: 9 })),
      { nil: undefined },
    ),
  )
  .map(([major, minor, patch, pre]) =>
    `${major}.${minor}.${patch}${pre === undefined ? "" : `-${pre[0]}.${pre[1]}`}`,
  );
