# src/main/ai — AGENTS.md

The local-agent half of history editing: Squash message drafts, commit-box
drafts, and Tidy plans. See `apps/desktop/AGENTS.md` for app-wide facts.

## The agent proposes; PwrGit proves

Nothing here changes Git. The handlers read (selection check, diff collection)
and return a draft or a proposal. Every history change goes through
`rebase:check` → `rebase:apply` in `src/main/git/rebase-handlers.ts`, whichever
path wrote the plan, and the isolated check proves the same three things for all
of them: each selected commit used exactly once, a clean replay, and a final
tree identical to the tip. Don't add a shortcut from an agent result to apply.

- **A Tidy plan is only accepted if it passes `validateProgramShape`.**
  `parseTidyProposal` resolves abbreviated hashes against the selection and
  refuses anything else. The approval binds the program's *shape* (members);
  messages are data and may be edited after the check.
- **Revisions are bounded on this side** (`MAX_TIDY_REVISIONS`). The renderer
  asks automatically after a conflict, so the bound cannot live only there.

## What the agent sees

`agent-input.ts` builds it and records it in the manifest the operator opens
from "Details". Lockfiles, snapshots, binaries, keys and `.env*` files are never
sent; diffs are cut to a line budget. If you widen what is sent, the manifest
has to say so too — it is the operator's only view of it.

Repository text is untrusted. It goes into the prompt as JSON under "data, not
instructions", and the one stable base instruction says so. Keep task rules in
the prompt, not in `baseInstructions`: changing that string re-creates the
Codex worker thread.

## Providers

Codex runs with no tools in a scratch workspace outside every repository. ACP
agents are listed as detected but unsupported until they can run under the
same boundary. Gemini is left out of discovery entirely: its CLI does not work
under agent-kit, so listing it would offer a broken choice.
