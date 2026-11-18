# Remotes, fetch, push and tags

This guide covers remote commands: tag fetching, activity tracking, change events, publishing, credentials and SSH host trust. It was moved from
[apps/desktop/src/main/git/AGENTS.md](../../../apps/desktop/src/main/git/AGENTS.md).

## Fetch never rewrites a tag; the published remote is compared, not trusted

Git keeps one `refs/tags/*` for every remote, and an ordinary fetch only adds
missing names. A tag re-cut on origin therefore stays at its old object here.
`tag-sources.ts` handles that beside Git's namespace, not inside it. Design:
`design/Published Tags - UX Review.dc.html`.

- **No fetch helper passes `--tags`, `--force` or `--prune-tags`.** They
  override `remote.<name>.tagOpt=--no-tags`, download every tag-only history,
  and let the last remote fetched rewrite a shared name. Never edit the
  user's config to add tag refspecs either.
- **A remote's tags live in SQLite** (`remote_tags`, 0047), keyed by remote,
  from one `ls-remote --tags`. A Git ref cannot point at objects that are not
  here. The publisher is the chosen remote, else origin, else nobody; never
  the last one fetched.
- **Listing is a full scan (protocol v2 has no "changed since").** So it never
  rides on every Fetch: explicit Refresh is a tracked activity. The automatic
  checks live in `tag-auto-check.ts` (own timeout, no lock, yield to tracked
  work, never `--no-tags`): the Tags tab's (stale after 10 min) and the one
  after every Fetch or Pull, toolbar, bulk or timed (stale after 1 h, else a
  name + id recount). The second obeys the sync menu's "Check tags after
  sync" (`general.tagCheckAfterSync`, on by default), runs at most
  `TAG_CHECK_CONCURRENCY` at once, and shares one check per repository. An
  unchanged re-listing writes one SQLite row. No cap: a moved old tag is
  found by the next listing.
- **Adopting is one tag:** `fetch --no-tags <remote> +refs/tags/<n>:<staging>`,
  check the staged object is the reviewed one, then one `update-ref --stdin`
  that pins the previous value under `refs/pwrgit/replaced-tags/<ms>/<n>`,
  swaps `refs/tags/<n>` with its old value as the lease, and drops the staging
  ref. An OID kept only in SQLite would not survive `gc`.
- **A moved tag is marked wherever it is drawn by name, not only counted.**
  The sidebar's preview rows (`repo:refs` `tagMoves`) and the lineage
  (`graph:lanes` `movedTags`, computed per request, never cached with the
  lanes) both read `TagSourceStore.moves`, the same comparison as the count.
  Their chips take the value through the Tags tab's one flow
  (`take-published-tag.ts`). PwrAgent's re-cut v1.4.1 was counted in
  "10 tags differ" while its row and chip looked current. A re-count returns
  true when the differing *set* moves, even at the same count; that is what
  emits `graph:changed`. Design: `design/Moved Tags Where You Look - UX Review.dc.html`.
- **Read local tags as name + id only** for comparisons. `objecttype`,
  `*objectname` or `creatordate` read every object (27 ms -> ~400 ms on 20,000
  tags). The tab's creator-date order is cached until that listing changes.
- `tag-sources.test.ts` pins first-run conflicts, primary vs other remotes,
  tag-only history, `--no-tags`, kind changes, stale reviews and the
  20,000-tag cost. Its cost line prints with `--reporter=verbose`.
- The rules themselves are property and model tests, with git as the oracle:
  `fetch-tags.property.test.ts` (no sync rewrites a tag, follows tag-only
  history or ignores `--no-tags`), `tag-sources.git.property.test.ts`
  (statuses, the stored count, Take and Keep through the handlers),
  `tag-sources.property.test.ts` (parsing, classification, the sidebar and
  Tags tab naming one publisher, concurrent and stopped listings) and
  `tag-auto-check.property.test.ts` (the ceiling, the switch, `--no-tags`
  and the failure back-off under any interleaving). Run them after any
  change here.

## Every long-running remote command registers an activity

**Wrap every command that reaches a remote in `tracked()` in
`remote-handlers.ts`, not only toolbar commands. Do not call `execGit`
directly.**

`remote-activity.ts` holds one record per live fetch / pull / push. The
toolbar popover, the elsewhere-toast and the cancel button read it. Three
fields carry what a spinner cannot show:

- **`queued`.** An operation waits for `WorktreeOperationQueue`'s repository
  lock before it runs Git. The watchdog starts only when the lock is held. So
  register BEFORE you take the lock.
- **`silent` / `lastOutputAt`.** `--progress` is forced on fetch and push
  (`forceProgress`), so silence there is evidence. Local phases promise no
  output, so the renderer warns about silence only in network phases.
- **`command` + `tail`.** Git's own words: which command, and what it printed
  last. These diagnose a wedged transfer.

Rules:

- **Cancel and the watchdog must both reach Git.** Pull combines them with
  `AbortSignal.any([watchdog.signal, activity.signal])`. Passing one silently
  disables the other. Rollback/recovery is deliberately NOT cancellable,
  because a stopped rollback leaves a broken checkout.
- **A cancel is an outcome, not a failure.** `safePullError` returns it
  unchanged and the pull logs at `info`. The renderer shows a neutral flash, no
  error toast. Do not route `code: "canceled"` into the failure path.
- Output lines go through `sanitizeGitLogDetail` on the way in, so a
  credential in a remote URL never reaches the record, the event or the
  clipboard.
- `remote:planPushRefs` and `remote:pushRefs` (a sidebar dialog, not the
  header) are tracked and repo-scoped (`worktreeId: null`), because no checkout
  owns a push to named remotes. The review fetches EVERY destination remote.
  Every network command they run forces `--progress`, or the silence warning
  would be false.
- `collapseProgress` (git-service.ts) is the other half. Git writes the
  progress meter with CR. Without it, a rejection's stderr reaches the review
  table behind every repaint of "Writing objects".

Why: a present but unanswering SSH agent (1Password's, with 1Password stopped
or locked) blocks Git forever with no output. Timeouts are in *minutes*,
because a large clone looks the same. So `silent` is per command, and Cancel
exists.

**The exceptions are `remote:checkSelected`, the automatic check behind the
header's "up to date", and the automatic published-tag check
(`TagAutoChecks`, `tag-auto-check.ts`).** The registry drives the header's buttons. Registered,
this check showed "Preparing local changes…" on Fetch and locked Pull and Push
every minute. It stays out because it cannot wedge: it has its own 12s
timeout, holds the repository lock only for ref writes (`ls-remote` runs
unlocked), and `tracked()` aborts it so a user's fetch never queues behind it.
The tag check meets the same three (20s timeout, no lock, `yield`), and also
skips a repository whose tracked operation is live.
A background check without all three belongs in the registry.

## `repo:changed` names its repositories when it can

Pass `repoIds` when known repositories changed in place (a fetch, a branch,
a tag, a worktree, a state re-read). The sidebar then re-reads only those
rows (`repo:list` with `repoIds`), and every other repository keeps its
object. Without it, each window re-reads the whole profile and every
expanded repository re-runs `repo:refs`. Over a bulk fetch that was one git
call per expanded repository per repository fetched.

Leave `repoIds` off only when the list or its order may move: a scan, clone,
fork, removal, hide, pin or reorder.

A change that only moves refs (a new branch on a remote) changes no
checkout's state, so the worktree refresher says nothing. That is why
`refreshRemoteBranches` in `remote-handlers.ts` names its repository: it is
the only signal that reloads that repository's Branches and Remotes.

## Publishing a branch asks for a remote, never a name

`remote:push` with `publish` runs `git push --set-upstream -- <remote> HEAD`.

- The `--` is needed because `git remote add -- -x` is accepted, and Git would
  read that name as an option.
- The branch keeps its own name. `push.default=simple` (Git's default) refuses
  a plain push to a differently named upstream. Publish under another name and
  the next Push fails, with only a terminal to fix it. `remote.test.ts`
  verifies this.

A failed push's `message` is the **reason** (`pushFailureHeadline`). Git's
stderr goes in `PwrGitError.detail`.

- The renderer's headline is the first line of `message`. Git's first line is
  `To <url>`, which the user already knows.
- The headline is Git's first line that says *why*, not the first `fatal:`.
  That line usually wraps the cause printed before it ("Could not read from
  remote repository" after "Permission denied (publickey)").
- The card's Git-output block, Copy and the command log read `detail`. Never
  show a PwrGit sentence there as Git output.

## A missing credential reads the same from fetch, pull and push

`classifyAuthFailure` (`remote-handlers.ts`) maps "Git had no credential it
may prompt for" to `authentication_required` for all three toolbar
operations. The worktree header answers with `SshRemoteRecoveryDialog`. Pull
still rewrites the message through `safePullError`.

- **It reads `detail` as well as `message`**, because a push's message is the
  `pushFailureHeadline` sentence. It never overrides `canceled`,
  `push_denied` (the forge accepted the credential, and an SSH key signs in as
  the same account) or the pull watchdog's codes.
- **Offer a push the change only if the push uses the URL being changed.**
  `inspectSshPushRecovery` returns null for a separate `pushurl` and for a
  `pushRemote` / `pushDefault` that names another remote. Otherwise PwrGit
  tests and rewrites a URL the push never used.

## SSH host approval

`ssh-host-trust.ts` keeps scanned keys in expiring, window-bound proposals.

- The renderer approves an opaque proposal ID. It never submits key bytes or
  a known_hosts path.
- Inspection sends no account credentials.
- Approval appends only the displayed key. It refuses existing trust entries,
  published-key mismatches, and configuration or trust changes since
  inspection.
- Keep the terminal fallback for custom SSH commands, proxy routing, aliases
  and trust files. Do not bypass those settings or replace existing keys to
  make a clone succeed.
