import type { CommitAuthorPerson } from "./types";

/**
 * The key main's people store and every renderer use for one commit author.
 *
 * It is the email, normalized exactly as the identity service normalizes it
 * before hashing an author-account cache key: forges link command-line commits
 * to accounts by email, so two spellings of a name are one person and one
 * address in two cases is one person too.
 */
export function commitAuthorPersonKey(email: string): string {
  return email.trim().normalize("NFC").toLowerCase();
}

/** Most commits per author a renderer tells main about; main caps it too. */
export const COMMIT_AUTHOR_INTEREST_COMMITS = 3;

/**
 * The `people:replaceInterest` author list for some commits, in the order
 * given: each author once, at their first commit, with up to
 * `COMMIT_AUTHOR_INTEREST_COMMITS` of their commits in that order. Pass the
 * most prominent commits first. Authors with no usable email are left out.
 */
export function commitAuthorInterest(
  commits: Iterable<{ hash: string; authorName: string; authorEmail: string }>
): Array<{ name: string; email: string; commitHashes: string[] }> {
  const byKey = new Map<string, { name: string; email: string; commitHashes: string[] }>();
  for (const commit of commits) {
    const key = commitAuthorPersonKey(commit.authorEmail);
    if (key === "") continue;
    const author = byKey.get(key);
    if (author === undefined) {
      byKey.set(key, {
        name: commit.authorName,
        email: commit.authorEmail,
        commitHashes: [commit.hash]
      });
    } else if (author.commitHashes.length < COMMIT_AUTHOR_INTEREST_COMMITS) {
      author.commitHashes.push(commit.hash);
    }
  }
  return [...byKey.values()];
}

/**
 * Fold people from main into what a renderer holds. The `people:replaceInterest`
 * reply and `people:changed` deltas can land in either order (each waits on its
 * own avatar decode), so an older answer must not replace a newer one: a
 * `pending` never erases an answer, and an answer never replaces a later-checked
 * one. Returns `current` itself when nothing changed.
 */
export function mergeCommitAuthorPeople(
  current: Record<string, CommitAuthorPerson>,
  incoming: Record<string, CommitAuthorPerson>
): Record<string, CommitAuthorPerson> {
  let next = current;
  for (const [key, person] of Object.entries(incoming)) {
    const held = next[key];
    if (held === person || (held !== undefined && isOlderPerson(person, held))) continue;
    if (next === current) next = { ...current };
    next[key] = person;
  }
  return next;
}

function isOlderPerson(incoming: CommitAuthorPerson, held: CommitAuthorPerson): boolean {
  if (incoming.state === "pending" && (held.state === "proven" || held.state === "none")) {
    return true;
  }
  return (incoming.checkedAt ?? Number.NEGATIVE_INFINITY) <
    (held.checkedAt ?? Number.NEGATIVE_INFINITY);
}
