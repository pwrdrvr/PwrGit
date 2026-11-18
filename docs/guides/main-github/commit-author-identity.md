# Commit-author identity

This guide covers how commit authors are matched to forge accounts and avatars, and how the people store schedules those lookups. Code paths in backticks are relative to [apps/desktop/src/main/github](../../../apps/desktop/src/main/github/AGENTS.md).

## Commit-author identity

- **Commit-author identity.**
  - Fetch only an exact full SHA from a recognized forge `origin`. Accept a
    login/avatar only after the SHA and the local Git author name/email match.
  - The match is GitHub's commit `author`. If null, a unique PR for that SHA
    can supply the account, only if its login matches the Git author name or
    email local part.
  - **A match is not proof of authorship.** It says whose email the commit
    carries. UI says "matched", never "proven". Only a commit whose signature
    is valid, not made by GitHub (`wasSignedByGitHub`, e.g. `web-flow`), and
    made by the linked account (`signer.login`, case-blind) may read
    "verified" (`signedByAuthor`). It is stored per exact commit
    (`signature_verified`), never on the reusable email→account row, and a
    PR-fallback account drops the signature.
  - SQLite stores the proof and a conflict-safe hashed email→account
    association, so the author's other commits paint at once in all repos.
    **The association never answers a network lookup on GitHub**
    (`commitSignatures`): it paints, marked `signatureUnchecked`, and the
    exact commit is still asked, or no signature is ever seen. Forges that
    report no signature still reuse it without asking.
  - **Batched.** The transport asks up to 50 exact commits per
    `gh api graphql` request (aliased `object(oid: $cN)`, SHAs as variables,
    container checked; `../forge/github/commit-author-transport.ts`).
    `requestMany` plans each commit locally and sends only the due ones, each
    request one turn of the two-at-a-time queue. Opt-in live check:
    `PWRGIT_GH_ORACLE=1 pnpm vitest run commit-author-transport.oracle`.
  - 64px avatars are deduplicated under
    `userData/cache/github-avatar-thumbnails` with fetch/access timestamps.
    IPC exposes only a versioned local `pwrgit-avatar://` URL, never the
    source URL or path. Its protocol handler reads the opaque thumbnail and
    lets Chromium cache it.
  - Its `gh api` transport intentionally does not share the PR client's
    token flow. GitLab's half: `../forge/gitlab/commit-author-transport.ts`.
- **Only the people store asks a forge about an author**
  (`commit-author-people.ts`). Renderers register who they show with
  `people:replaceInterest` and get cached answers. The store visits a few
  authors per tick on its own clock and pushes `people:changed`.
  - A tick spends at most `PEOPLE_REQUESTS_PER_TICK` (4) forge requests. On a
    batching forge one request carries every interest commit (up to 3) of as
    many due authors as fit, so a graph's people cost ⌈authors/16⌉ requests;
    a single-commit forge (GitLab) spends one per author, rotating commits.
    An author is settled only when no commit is `signatureUnchecked` (never
    asked; an unpushed commit was asked, so it does not hold an author open).
    `commit-author-people.model.test.ts` holds the budget.
  - `cacheOnly` lookups (the registration read,
    `github:hydrateCommitAuthorIdentities`) never call a forge or download a
    thumbnail, however stale the row.
  - Do not add on-demand hover revalidation (one was removed): a sweep down a
    history column becomes an API burst. Change the store's schedule instead.
  - Registering again must never move a visit earlier (pinned by tests).
- **Commit-author identity is forge-wide** (`../forge/AGENTS.md`). The
  service keeps its `GitHub*` names and hydrate channel but routes any
  recognized `origin` to that forge's credential-opaque transport. A product
  with `commitAuthorIdentity: false` is never asked.
