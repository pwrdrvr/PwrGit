/**
 * "Take me to the commit box" — the answer to a dirty-switch prompt that means
 * *these changes belong on the branch I am already on*.
 *
 * A module-level signal rather than a prop chain because the asking happens in
 * `branchSwitch.ts`, which is a plain async module with no place in the tree,
 * and the answering happens in the rail, five levels down a different branch of
 * it. Same shape as `dialogs.ts` next door, for the same reason.
 *
 * The payload is a counter, not a boolean: asking twice in a row must pull the
 * rail over twice, and a boolean that is already `true` is not a new event.
 */
let requests = 0;
const listeners = new Set<() => void>();

export function subscribeCommitNudges(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function commitNudgeCount(): number {
  return requests;
}

/** Pull the rail to Changes and put the caret in the commit message. */
export function nudgeToCommit(): void {
  requests += 1;
  for (const listener of listeners) listener();
}
