#!/usr/bin/env node

// Fails when the repository-root AGENTS.md outgrows the agent instruction
// budget. Codex reads at most `project_doc_max_bytes` (32 KiB by default) of
// AGENTS.md content and silently drops the rest. Claude Code loads the whole
// file into every thread's first turn. The limit leaves headroom under 32 KiB
// for nested AGENTS.md files on the path to a deeper working directory.
//
// Dependency-free on purpose: CI's changed-files classifier runs it from a
// sparse checkout with no install, so docs-only PRs are checked too.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isCliEntrypoint } from "./lib/cli-entrypoint.mjs";

export const ROOT_AGENTS_MD_MAX_BYTES = 24 * 1024;

export function checkAgentInstructionsSize(bytes, maxBytes = ROOT_AGENTS_MD_MAX_BYTES) {
  if (bytes <= maxBytes) return { ok: true, bytes, maxBytes };
  return {
    ok: false,
    bytes,
    maxBytes,
    message:
      `AGENTS.md is ${bytes} bytes; the limit is ${maxBytes} bytes `
      + `(${bytes - maxBytes} over). Codex truncates AGENTS.md content past `
      + "32 KiB and Claude Code loads all of it on every first turn. Move "
      + "detailed sections into linked documents (a nested AGENTS.md beside "
      + "the code, or docs/) and keep a short rule plus a when-to-read line "
      + "in AGENTS.md.",
  };
}

function runCli() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bytes = readFileSync(join(repoRoot, "AGENTS.md")).byteLength;
  const result = checkAgentInstructionsSize(bytes);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(`AGENTS.md is ${bytes} of ${result.maxBytes} bytes.`);
}

if (isCliEntrypoint(import.meta.url)) runCli();
