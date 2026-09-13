# Contrived `gh` / `glab`

Shell stubs that answer only what PwrGit's forge code asks — `--version`,
`auth status`, and the per-host token lookup. They exist so the Settings →
Forges captures in `design/` are **100% contrived**: no real account, instance
or token can reach an image that ships in a public repo.

`design-shots.spec.ts` puts this directory on `PATH` ahead of any real CLI.
They are not part of the normal e2e run — nothing else should depend on them.
