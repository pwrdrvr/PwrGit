# features/agent — AGENTS.md

The renderer half of the agent jobs (commit messages, history editing). Main's
contract — `resolveJob`, the AI switch, what is sent — is in
`src/main/ai/AGENTS.md`; this directory only asks and displays.

- **Ask per job, never decide.** `useAgent(jobId)` reads `agent:availability`,
  which is main's resolver answering the question a request asks. Don't derive
  "ready" from `aiProviders:read` or discovery here: they can disagree with
  what a request would run on. `aiProviders:changed` for this window's profile
  re-asks; another profile's is ignored.
- **AI off is quiet.** `disabled` means offer the non-AI path: no agent link,
  no auto-draft, no Tidy on the selection bar (`useAgentOffered`, a boolean
  snapshot so `App` does not re-render on store updates). The chip reads
  "AI off" and its menu links to Settings. With AI on but unusable (no Codex,
  signed out), say main's message once and link to AI Providers.
- **The chip's choice is one request's.** Model and effort default from
  Settings → AI Features in main; `AgentChoice` overrides them for the request
  in flight and is dropped with the selection (`RebaseTab`). Efforts are the
  picked model's own `supportedReasoningEfforts`.
- **Don't probe to render.** A profile with AI off answers `agent:availability`
  without spawning anything. Models (`aiProviders:codexModels`) start Codex's
  app-server, so they load when the chip opens, not on mount.
- **Deep links go through `openAiSettings`**, which passes this window's
  `profileId`: Settings is one window shared by every profile.
