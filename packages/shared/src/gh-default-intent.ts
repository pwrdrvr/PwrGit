import type { GhDefaultRepository } from "./git-discovery";

type Candidate = GhDefaultRepository["candidates"][number];

/**
 * gh's default repository against what PwrGit was told about this fork.
 *
 * "Pull from origin only" (the fork has moved on from its original) is the
 * user saying the work lives on `origin` now. gh does not hear it: unless
 * `gh repo set-default` ran, it still ranks `upstream` first and opens pull
 * requests there. And a default someone once pointed at `upstream` on purpose
 * is `set`, so the plain ambiguity warning stays quiet about it.
 *
 * Null when gh already targets the remote's repository, or when there is
 * nothing to compare (no reading, no GitHub remotes, or the remote is not a
 * GitHub repository gh would consider).
 */
export function ghDefaultMismatch(
  gh: GhDefaultRepository | null,
  remote: string
): { intended: Candidate; current: string | null } | null {
  if (gh === null || gh.status === "none") return null;
  const intended = gh.candidates.find((candidate) => candidate.remotes.includes(remote));
  if (intended === undefined) return null;
  const agrees =
    gh.status !== "invalid" &&
    gh.repository !== null &&
    gh.host === intended.host &&
    gh.repository.toLowerCase() === intended.repository.toLowerCase();
  return agrees ? null : { intended, current: gh.repository };
}

/**
 * What the header chip and the setup sheet say, or null for nothing.
 *
 * `movedOnRemote` is the remote PwrGit pulls from after "Pull from origin
 * only", or null when the user has not said the fork moved on.
 * `useRemote` is the remote a "point gh here" action should write.
 */
export function ghDefaultNotice(
  gh: GhDefaultRepository | null,
  movedOnRemote: string | null
): { text: string; useRemote: string | null } | null {
  if (gh === null) return null;
  if (movedOnRemote !== null) {
    const mismatch = ghDefaultMismatch(gh, movedOnRemote);
    if (mismatch !== null) {
      const target = mismatch.current ?? "a repository it cannot read";
      return {
        text:
          `PwrGit pulls from ${movedOnRemote} only, because this fork has moved on, ` +
          `but gh still opens pull requests on ${target}. ` +
          `Point gh at ${mismatch.intended.repository}.`,
        useRemote: movedOnRemote
      };
    }
    // gh already agrees with the fork; an ambiguity the user resolved by
    // moving on is not worth a chip. Only when the fork IS one of gh's
    // candidates: a removed or non-GitHub remote resolves nothing.
    const forkSeen = gh.candidates.some((candidate) => candidate.remotes.includes(movedOnRemote));
    if (forkSeen && gh.status === "ambiguous") return null;
  }
  if (gh.warning === null) return null;
  const origin = gh.candidates.find((candidate) => candidate.remotes.includes("origin"));
  return { text: gh.warning, useRemote: origin === undefined ? null : "origin" };
}
