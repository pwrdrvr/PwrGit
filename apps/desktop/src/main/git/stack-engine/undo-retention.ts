import { isOid, StackGit } from "./git";

const namespace = "refs/pwrgit/undo/";
const maxAge = 14 * 24 * 60 * 60 * 1000;
const maxOperations = 50;

export async function expireStackUndo(git: StackGit, now: number): Promise<void> {
  const listing = await git.output(["for-each-ref", "--format=%(refname)%00%(objectname)", namespace]);
  const groups = new Map<string, { ref: string; oid: string }[]>();
  for (const line of listing.trimEnd().split("\n")) {
    const [ref, oid] = line.split("\0");
    const match = /^refs\/pwrgit\/undo\/([a-z0-9-]{1,80})\/(?:receipt|heads\/.+)$/.exec(ref);
    if (!match || !isOid(oid ?? "")) continue;
    const group = groups.get(match[1]) ?? [];
    group.push({ ref, oid });
    groups.set(match[1], group);
  }
  const operations = [];
  for (const [id, refs] of groups) {
    const manifest = refs.find(({ ref }) => ref === `${namespace}${id}/receipt`);
    if (!manifest) continue;
    try {
      const data = JSON.parse(await git.output(["cat-file", "blob", manifest.oid])) as { id?: string; when?: number };
      if (data.id === id && typeof data.when === "number" && Number.isFinite(data.when)) {
        operations.push({ refs, when: data.when });
      }
    } catch {
      // Keep refs whose receipt we cannot read.
    }
  }
  const expired = operations.sort((a, b) => b.when - a.when)
    .flatMap(({ refs, when }, index) => index >= maxOperations || now - when >= maxAge ? refs : []);
  if (!expired.length) return;
  const commands = expired.map(({ ref, oid }) => `delete ${ref} ${oid}`);
  await git.output(["update-ref", "--stdin"], ["start", ...commands, "prepare", "commit", ""].join("\n"));
}
