# forge/gitlab — AGENTS.md

GitLab, via the `glab` CLI. Read `../AGENTS.md` first — the spawner, the
provider seams, and the capability table all live there. What follows is only
what GitLab does differently, and each line is something that has already
cost a debugging session.

- **Talk to the REST API through `glab api`, not `glab`'s subcommands.**
  `repo-provider.ts` forks with `POST /projects/:id/fork` rather than
  `glab repo fork` because the endpoint returns the new project as JSON —
  including the `import_status` the clone must wait on — and its parameters
  are stable across `glab` versions in a way the command's flags are not.
- **A fork is not ready when the call returns.** GitLab queues the copy and
  walks `scheduled → started → finished`; `awaitImport` polls, and a `failed`
  status is surfaced rather than waited out. GitHub needs none of this —
  `gh repo fork` waits internally.
- **A project path is not `owner/name`.** Subgroups nest arbitrarily
  (`pwrdrvr/qa/forge/PwrGit-Test` is one project), so everything before the
  last segment is the namespace, and the whole path is URL-encoded to address
  it (`encodeProjectPath`). Code that assumes two segments silently addresses
  the wrong project. The test fixture is deliberately four deep.
- **`path`, not `name`.** GitLab's `name` is a human title and may contain
  spaces; `path` is the URL segment, and it is what a checkout folder is
  named after.
- **The root of a fork chain costs extra reads.** GitLab reports only
  `forked_from_project` (the immediate parent), so `resolveRoot` walks the
  chain, bounded at 8 hops. That root is what makes `upstream` unambiguous
  when someone forks a fork.
- **Self-hosted instances are named from the project's own `web_url`**, not
  assumed to be gitlab.com. A badge reading "GITLAB" for code that lives on
  `gitlab.acme.io` misstates where it is.
- **A failed fork POST is not proof the fork exists.** The 409 path exists for
  "you already forked this"; any other failure can leave an unrelated project
  at the target path, so the read-back must confirm it descends from the
  source before it is treated as the fork.
- **Groups are groups, not organizations.** `ownerKindLabel` picks the noun by
  host; the fork-target list is the one place a user chooses between them.

Fork and identity paths are unit-tested against recorded response shapes, and
have been exercised live against a private nested-group fixture.
