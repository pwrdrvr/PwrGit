# gitlab — AGENTS.md

GitLab support via the `glab` CLI. Read `../forge/AGENTS.md` first — the
spawning, redaction and provider contract all live there.

- **`glab-cli.ts` is a `ForgeCliSpec`, nothing more.** GitLab's token zoo is
  wider than GitHub's (personal, project, group, OAuth, runner, deploy and CI
  job tokens all grant API access and all have distinct prefixes), so every
  prefix belongs in `tokenPrefixes`. They contain `-`, which is why the shared
  runner's truncation guard admits hyphens.
- **Talk to the REST API through `glab api`, not to `glab`'s subcommands.**
  `fork` uses `POST /projects/:id/fork` rather than `glab repo fork` because
  it returns the new project as JSON — including the `import_status` the
  clone has to wait on — and its parameters are stable across `glab` versions
  in a way the command's flags are not.
- **A fork is not ready when the call returns.** GitLab queues the copy;
  `import_status` walks `scheduled` → `started` → `finished`. `awaitImport`
  polls, and a `failed` status is surfaced rather than waited out. GitHub
  needs none of this — `gh repo fork` waits internally.
- **A project path is not `owner/name`.** Subgroups nest arbitrarily
  (`acme/platform/team/api` is one project), so everything before the last
  segment is the owner, and the whole path is URL-encoded to address it
  (`encodeProjectPath`). Code that assumes two segments will silently address
  the wrong project.
- **`path`, not `name`.** GitLab's `name` is a human title and may contain
  spaces; `path` is the URL segment, and it is what a checkout folder is
  named after.
- **The root of a fork chain costs extra reads.** GitLab reports only
  `forked_from_project` (the immediate parent), so `resolveRoot` walks the
  chain — bounded at 8 hops. That root is what makes `upstream` unambiguous
  when someone forks a fork.
- **Self-hosted instances are named from the project's own `web_url`**, not
  assumed to be gitlab.com. A badge saying "GITLAB" for code that lives on
  `gitlab.acme.io` misstates where it is.

Everything here is unit-tested against recorded response shapes
(`gitlab-provider.test.ts`), because CI has no `glab` and no GitLab account.
