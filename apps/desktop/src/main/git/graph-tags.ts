import { err, ok, type Result, type LaneGraph } from "@pwrgit/shared";
import type { GitExec } from "./dugite";

type Tags = NonNullable<LaneGraph["tags"]>;

/** Version-looking names are a local hint, not proof of a forge release. */
export function tagPriority(name: string, annotated: boolean): number {
  if (/^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(name)) return 3;
  if (annotated) return 2;
  return /^v?\d+\.\d+\.\d+-[0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)?$/.test(name) ? 1 : 0;
}

/** One compact scan, without annotation bodies or per-tag subprocesses. */
export async function readGraphTags(git: GitExec, cwd: string): Promise<Result<Tags>> {
  const result = await git([
    "for-each-ref", "--sort=-version:refname",
    "--format=%(refname:strip=2)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)",
    "refs/tags"
  ], cwd);
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) return err({ kind: "git", code: "tags_failed", message: result.value.stderr });
  const tags: Tags = {};
  for (const line of result.value.stdout.trimEnd().split("\n")) {
    const [name = "", type, object = "", peeledType, peeled = ""] = line.split("\0");
    const annotated = type === "tag";
    if ((annotated ? peeledType : type) !== "commit") continue;
    const hash = annotated ? peeled : object;
    const priority = tagPriority(name, annotated);
    const current = tags[hash];
    if (priority > 0 && (current === undefined || priority > tagPriority(current.name, current.kind === "annotated"))) {
      tags[hash] = { name, kind: annotated ? "annotated" : "lightweight" };
    }
  }
  return ok(tags);
}
