#!/usr/bin/env node

// Keeps the AGENTS.md instruction tree inside what agents actually read.
//
// Codex concatenates every AGENTS.md from the repository root down to its
// working directory and stops at `project_doc_max_bytes` (32 KiB by default),
// silently dropping the rest. Claude Code loads the root file into every
// thread's first turn and each nested file whole when it works there. So:
//
// - the root AGENTS.md stays under ROOT_AGENTS_MD_MAX_BYTES;
// - every root-to-directory chain of AGENTS.md files stays under
//   AGENTS_MD_CHAIN_MAX_BYTES, which leaves headroom under 32 KiB for a
//   user's global instructions;
// - every relative link in an AGENTS.md, or in a guide under docs/guides/,
//   resolves, including its #heading anchor, because moved detail is only
//   reachable through those links.
//
// Dependency-free on purpose: CI's changed-files classifier runs it on every
// PR, docs-only ones included, before any install.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

export const ROOT_AGENTS_MD_MAX_BYTES = 24 * 1024;
export const AGENTS_MD_CHAIN_MAX_BYTES = 28 * 1024;

const FIX =
  "Move detailed sections into linked documents under docs/guides/ and keep "
  + "a short rule plus a when-to-read line in AGENTS.md.";

export function checkAgentInstructionsSize(bytes, maxBytes = ROOT_AGENTS_MD_MAX_BYTES) {
  if (bytes <= maxBytes) return { ok: true, bytes, maxBytes };
  return {
    ok: false,
    bytes,
    maxBytes,
    message:
      `AGENTS.md is ${bytes} bytes; the limit is ${maxBytes} bytes `
      + `(${bytes - maxBytes} over). Codex truncates AGENTS.md content past `
      + "32 KiB and Claude Code loads all of it on every first turn. "
      + FIX.replace("AGENTS.md.", "AGENTS.md, with a when-to-read line for each."),
  };
}

function directoryOf(path) {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}

/**
 * For every directory that holds an AGENTS.md, the files Codex concatenates
 * when it starts there: each AGENTS.md from the root down. Directories without
 * one read the same chain as their nearest ancestor that has one.
 *
 * @param {Map<string, number>} sizes repo-relative POSIX AGENTS.md path → bytes
 */
export function agentInstructionChains(sizes) {
  const byDirectory = new Map([...sizes].map(([path, bytes]) => [directoryOf(path), { path, bytes }]));
  return [...byDirectory.keys()].sort().map((dir) => {
    const prefixes = dir === "" ? [""] : ["", ...dir.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/"))];
    const files = prefixes.filter((prefix) => byDirectory.has(prefix)).map((prefix) => byDirectory.get(prefix));
    return { dir, files, total: files.reduce((sum, file) => sum + file.bytes, 0) };
  });
}

export function checkAgentInstructionChains(sizes, maxBytes = AGENTS_MD_CHAIN_MAX_BYTES) {
  return agentInstructionChains(sizes)
    .filter(({ total }) => total > maxBytes)
    .map(({ dir, files, total }) => ({
      dir,
      total,
      over: total - maxBytes,
      message:
        `${dir || "(root)"}: Codex reads ${total} bytes of AGENTS.md here `
        + `(${files.map(({ path, bytes }) => `${path} ${bytes}`).join(" + ")}); `
        + `the limit is ${maxBytes} bytes (${total - maxBytes} over). ${FIX}`,
    }));
}

function stripCode(markdown) {
  return markdown.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
}

/**
 * The anchors GitHub generates for the headings in `markdown`
 * (github-slugger: lowercase, drop punctuation, spaces become hyphens,
 * repeats get -1, -2, ...), plus explicit `<a id="...">` / `name` anchors.
 *
 * @param {string} markdown
 */
export function headingAnchors(markdown) {
  const anchors = new Set();
  const seen = new Map();
  const prose = stripCode(markdown);
  for (const [, heading] of prose.matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const text = heading
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/[`*]/g, "");
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  for (const [, id] of prose.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(id);
  return anchors;
}

/**
 * Relative link targets in `markdown` that do not exist. Code spans and
 * fenced blocks are ignored; URLs and in-page anchors are not files.
 *
 * @param {string} markdown
 * @param {string} fromPath repo-relative POSIX path of the markdown file
 * @param {(path: string) => boolean} exists repo-relative POSIX path → exists
 * @param {(path: string) => string | undefined} [read] repo-relative path →
 *   markdown, to check `#anchor`s; anchors are not checked without it
 */
export function brokenRelativeLinks(markdown, fromPath, exists, read) {
  const prose = stripCode(markdown).replace(/`[^`\n]*`/g, "");
  const broken = [];
  for (const [, rawTarget] of prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) continue;
    const [pathPart, anchor] = rawTarget.split("#");
    let target = pathPart;
    try {
      target = decodeURI(target);
    } catch {
      // Keep the raw spelling; it will be reported if it does not exist.
    }
    const resolved = target === ""
      ? fromPath
      : target.startsWith("/")
        ? posix.normalize(target.slice(1))
        : posix.normalize(posix.join(directoryOf(fromPath), target));
    if (resolved.startsWith("../") || !exists(resolved.replace(/\/$/, "") || ".")) {
      broken.push(rawTarget);
      continue;
    }
    if (anchor && read && resolved.endsWith(".md")) {
      const source = resolved === fromPath ? markdown : read(resolved);
      let decoded = anchor;
      try {
        decoded = decodeURIComponent(anchor);
      } catch {
        // Compare the raw spelling.
      }
      if (source !== undefined && !headingAnchors(source).has(decoded.toLowerCase())) broken.push(rawTarget);
    }
  }
  return broken;
}

function listFiles(repoRoot) {
  const output = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(output.split("\0").filter(Boolean))].filter((path) => existsSync(join(repoRoot, path)));
}

export function runChecks(repoRoot) {
  const files = listFiles(repoRoot);
  const errors = [];
  const sizes = new Map(
    files.filter((path) => posix.basename(path) === "AGENTS.md")
      .map((path) => [path, readFileSync(join(repoRoot, path)).byteLength]),
  );
  const root = checkAgentInstructionsSize(sizes.get("AGENTS.md") ?? 0);
  if (!root.ok) errors.push(root.message);
  for (const failure of checkAgentInstructionChains(sizes)) errors.push(failure.message);
  const exists = (path) => existsSync(join(repoRoot, path));
  const read = (path) => readFileSync(join(repoRoot, path), "utf8");
  for (const path of files.filter((p) => posix.basename(p) === "AGENTS.md" || /^docs\/guides\/.+\.md$/.test(p))) {
    for (const target of brokenRelativeLinks(read(path), path, exists, read)) {
      errors.push(`${path}: link target ${target} does not exist (file or heading anchor).`);
    }
  }
  const chains = agentInstructionChains(sizes);
  const largest = chains.reduce((max, chain) => (chain.total > max.total ? chain : max), { total: 0, dir: "" });
  return { errors, rootBytes: root.bytes, files: sizes.size, largest };
}

function runCli() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { errors, rootBytes, files, largest } = runChecks(repoRoot);
  if (errors.length) {
    for (const error of errors) console.error(error);
    process.exit(1);
  }
  console.log(
    `AGENTS.md is ${rootBytes} of ${ROOT_AGENTS_MD_MAX_BYTES} bytes; the largest of ${files} `
    + `instruction chains is ${largest.dir || "(root)"} at ${largest.total} of `
    + `${AGENTS_MD_CHAIN_MAX_BYTES} bytes; all links resolve.`,
  );
}

if (isCliEntrypoint(import.meta.url)) runCli();
