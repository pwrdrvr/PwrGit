/**
 * When a ⌘K query *is* a thing's name — one rule for the search SQL, main's
 * ranking and the palette.
 *
 * Three places used to decide it, three ways: SQLite's `COLLATE NOCASE`
 * (ASCII only), main's NFKD fold, and the renderer's NFC lowercase. Typing
 * `übersicht` for a repository named `Übersicht` passed main's test and failed
 * SQL's, so the repository lost its place ahead of the result cap and never
 * reached main at all.
 *
 * The key ignores surrounding whitespace, case and diacritics, as the index's
 * `unicode61 remove_diacritics 2` tokenizer does: `Café`, ` cafe ` and `CAFÉ`
 * are one name.
 */

const ASCII = /^[\x00-\x7f]*$/;

const stripMarks = (value: string): string =>
  value.normalize("NFKD").replace(/\p{M}/gu, "");

/**
 * Case is folded one code point at a time, upper then lower. Whole-string
 * `toLowerCase` is context-sensitive (a word-final `Σ` becomes `ς`, a medial
 * one `σ`), so the same letters could fold two ways; per code point they fold
 * one way, and `ß`, `ẞ` and `SS` all meet at `ss`. Marks are stripped again
 * afterwards because a case map can add one (`İ` lowers to `i` + a dot above).
 */
export function searchNameKey(value: string): string {
  // Most names are ASCII, where all of the below is `toLowerCase`. The search
  // SQL calls this once per matched row, on the main process.
  if (ASCII.test(value)) return value.trim().toLowerCase();
  // Trim after decomposing: NFKD can leave a space at either end (a spacing
  // diaeresis `¨` is a space and a combining mark).
  const folded = Array.from(stripMarks(value), (char) =>
    char.toUpperCase().toLowerCase()
  ).join("");
  return stripMarks(folded).trim();
}

/** The final segment of a path, with either platform's separators. */
export function searchPathLeaf(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
}
