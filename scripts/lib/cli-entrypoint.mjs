import { pathToFileURL } from "node:url";

/**
 * True when `moduleUrl` names the module Node was asked to run.
 *
 * Every script in scripts/ is both an importable module (its checks are unit
 * tested) and a CLI, so each needs this guard around its `runCli()`. Three
 * copies had grown, in two spellings that normalize the path differently.
 * `pathToFileURL(process.argv[1]).href` is the one to keep: it compares two
 * file URLs, so it is indifferent to the separator and drive-letter casing
 * Windows hands us in `process.argv[1]`.
 *
 * `process.argv[1]` is undefined when Node runs `--eval` or a REPL, which is
 * not an entrypoint for anything here.
 */
export function isCliEntrypoint(moduleUrl) {
  return process.argv[1] !== undefined && moduleUrl === pathToFileURL(process.argv[1]).href;
}
