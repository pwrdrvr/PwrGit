/**
 * `git remote -v`, parsed.
 *
 * One definition because two callers with different jobs read the same
 * output: the identity refresh wants every host a checkout touches, and the
 * fork rewire wants the fetch URL of each remote by name. A second copy of
 * this regex is a second place for `git remote -v`'s format to be wrong.
 */

/** One row of `git remote -v`: a remote is listed once per direction. */
export type RemoteRow = {
  name: string;
  url: string;
  direction: "fetch" | "push";
};

/** `name\turl (fetch|push)`, which is `git remote -v`'s whole format. */
const REMOTE_LINE = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/;

/** Every row `git remote -v` printed, in the order Git listed them
 *  (alphabetical by name, fetch before push). Unparseable lines are skipped
 *  rather than failing the read: this output is also where a misconfigured
 *  remote shows up, and losing the rest of the list to it helps nobody. */
export function parseRemoteRows(stdout: string): RemoteRow[] {
  const rows: RemoteRow[] = [];
  for (const line of stdout.split("\n")) {
    const matched = REMOTE_LINE.exec(line.trim());
    if (matched === null) continue;
    const [, name, url, direction] = matched;
    if (name === undefined || url === undefined || direction === undefined) {
      continue;
    }
    rows.push({ name, url, direction: direction as "fetch" | "push" });
  }
  return rows;
}
