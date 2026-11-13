import { err, ok, type Result, type LaneGraph } from "@pwrgit/shared";
import type { GitExec } from "./dugite";

type Tags = NonNullable<LaneGraph["tags"]>;

/** Version-looking names are a local hint, not proof of a forge release. */
export function tagPriority(name: string, annotated: boolean): number {
  if (/^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(name)) return 3;
  if (annotated) return 2;
  return /^v?\d+\.\d+\.\d+-[0-9A-Za-z.-]+(?:\+[0-9A-Za-z.-]+)?$/.test(name) ? 1 : 0;
}

/** Every local tag that peels to a commit: name, its own object, the commit. */
export type GraphLocalTag = { name: string; objectId: string; targetId: string };

/** One compact scan, without annotation bodies or per-tag subprocesses. */
export async function readGraphTags(git: GitExec, cwd: string): Promise<Result<Tags>> {
  const index = await readGraphTagIndex(git, cwd);
  return index.ok ? ok(index.value.prominent) : index;
}

/**
 * The same scan, keeping every commit-peeling tag as well as the prominent
 * one per commit: the lineage compares those with the published remote.
 */
export async function readGraphTagIndex(
  git: GitExec,
  cwd: string
): Promise<Result<{ prominent: Tags; all: GraphLocalTag[] }>> {
  const result = await git([
    "for-each-ref", "--sort=-version:refname",
    "--format=%(refname:strip=2)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)",
    "refs/tags"
  ], cwd);
  if (!result.ok) return result;
  if (result.value.exitCode !== 0) return err({ kind: "git", code: "tags_failed", message: result.value.stderr });
  const tags: Tags = {};
  const all: GraphLocalTag[] = [];
  for (const line of result.value.stdout.trimEnd().split("\n")) {
    const [name = "", type, object = "", peeledType, peeled = ""] = line.split("\0");
    const annotated = type === "tag";
    if ((annotated ? peeledType : type) !== "commit") continue;
    const hash = annotated ? peeled : object;
    all.push({ name, objectId: object, targetId: hash });
    const priority = tagPriority(name, annotated);
    const current = tags[hash];
    if (priority > 0 && (current === undefined || priority > tagPriority(current.name, current.kind === "annotated"))) {
      tags[hash] = { name, kind: annotated ? "annotated" : "lightweight" };
    }
  }
  return ok({ prominent: tags, all });
}
