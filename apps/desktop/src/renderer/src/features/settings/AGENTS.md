# settings — AGENTS.md

The Settings window's panes. `SettingsLayout.tsx` holds the primitives; each
pane composes them and owns its own reads.

## Every pane's sections go inside a `SettingsSectionStack`

The stack is not decoration — it carries three things a pane silently loses
without it:

- `gap: 14px` and `max-width: 760px`, the column every pane is measured against;
- the collapse state its sections share, keyed by `paneId`;
- the registration that puts **Collapse all / Expand all** in the pane head.

Settings → Forges returned a bare fragment instead and rendered 919px-wide cards
with their borders touching, in a window where every other pane's were 760 with
14 between them. Nothing catches that: it type-checks, it bundles, and it only
shows up beside another pane. **`paneId` must be stable and unique** — it is the
key collapse state is remembered under, for the life of the window.

A `SettingsSection` outside a stack still renders, as a plain card with no
disclosure. That is deliberate and `AgentConsentWindow` relies on it: there is no
pane to remember a fold, so offering a chevron would promise one that cannot be
kept.

## The disclosure header is a `div[role="button"]`, and owes what that costs

Ported from PwrAgnt's `SettingsLayout`. A native `<button>` cannot wrap the
header, because it holds a heading, a description and a live status chip — so
the role is applied by hand, and everything a real button gets for free has to
be supplied:

- **Enter and Space** both toggle (SC 2.1.1), and Space must `preventDefault()`
  or it scrolls the pane instead.
- **`aria-label` names the section**, rather than letting the name be computed
  from the header's contents — that would read the whole description aloud on
  focus and change the button's name whenever the chip did.
- **The body is `inert` when folded**, not merely `aria-hidden`: `aria-hidden`
  alone leaves the controls inside focusable, so Tab walks into a closed section
  and lands on something invisible. It is not unmounted, so the body keeps its
  React state across a fold — but not its layout: the clip is `display: none`
  when folded, so a scroller inside comes back at the top.
- **Arrow keys rove between headers** (Up/Down/Home/End), which is why sections
  register their header element with the stack.

Collapse state is deliberately **not** persisted to settings: which sections you
had folded is a reading position, not a preference, and writing it would put a
settings write behind every click.

## A nav child is a route to a card, never a pane of its own

`SettingsWindow.tsx` renders the left nav. A section in `SETTINGS_NAV_GROUPS`
grows a caret and a sub-list; each child names a `SettingsSection` `sectionId`
inside the parent's pane, and clicking it scrolls to that card, unfolds it and
focuses its header (`SettingsSectionStack`'s `focusSection`). Nothing about a
child mounts a second pane, which is why a child can carry live status: it is
reporting on something already one click away.

Two things here are easy to get subtly wrong:

- **The request is an object, not the slug.** The stack honors a request once
  and then ignores it, because sections re-register whenever one is added or
  re-keyed — a probe landing is enough — and re-running the reveal would yank
  the scroll back while the reader was elsewhere. Comparing slugs instead would
  make the second click on a child do nothing at all, which is exactly the click
  a reader makes to get back to a card they scrolled away from.
- **A folded group hands its `aria-current` back to the parent row.** The
  sub-list is `inert` and `aria-hidden` when folded, so the child holding the
  marker is unreachable; without the handover the nav shows the reader nowhere.
  Navigating to a group always unfolds it, so the children are discoverable
  without anyone thinking to click a caret — only the caret folds one.

The dots are `aria-hidden`, so every state that is not "fine" also carries a
word, and the row's accessible name is the full sentence the pane's live region
reads (`forgeStateSentence`) rather than a second phrasing of it. An unprobed
product gets neither a dot nor a word: "we do not know" is honest, and a green
dot would be a wrong guess. `useForgeStatuses.ts` is the nav's read — one
`forge:status` on mount plus pushes, because main answers from cache and the
whole point of the children is a state the reader has *not* opened the pane for.

## Forges is one section per product

`ForgesSettings.tsx` is the pane — it holds both reads (`forge:hosts` and
`forge:status`) and maps `FORGE_KINDS`; `ForgeProductSection.tsx` is one
product's card. Both reads live in the pane because each answers for every
product at once, so a read per section would spawn N of each on mount, doubled
again under StrictMode.

Three behaviours here encode fixed bugs and must not regress — see
`ForgeHosts.test.tsx`, which pins all of them:

- **Remove is gated on `kindSource === "config"`, never `origin`.** `origin`
  says a CLI holds an account; `kindSource` says a person chose the product.
  Gating on `origin` put a Remove button on a host the user had merely switched
  off, and removing it there cleared the `enabled:false` and turned the host
  back on, with no row left to undo it.
- **The Add buttons stay disabled until the host list has loaded.** The
  duplicate check reads the rendered list; against an unloaded one it waves
  everything through, and an add landing on an existing host rewrites its
  product.
- **An add writes `{kind, enabled: true}`**, because main merges rather than
  replaces — a stale `enabled:false` would otherwise survive and the host would
  arrive switched off, moments after the dialog said PwrGit would talk to it.

Per-product wording — the label, the CLI name, the Add button and its helper
line, the SaaS host — comes from `FORGE_PRODUCTS`
(`packages/shared/src/forge-product.ts`), never from a table written here. Two
such tables already lived in this directory before the registry landed, and
`pnpm lint:forge-kinds` now fails any `kind === "github"` left in non-test
source. Tests are exempt on purpose: pinning one product's copy as a literal is
stating the expected value, and a test that reads the same table the component
reads cannot catch that table being wrong.

The rest is in `src/main/forge/AGENTS.md`, which owns why a product is chosen and
never guessed from a hostname.

## AI Providers and AI Features are per profile, in a window that is not

`AiProvidersSettings.tsx` has one card per provider (Codex, then the ACP
agents). `AiFeaturesSettings.tsx` has one card per section. Both read
`AiProvidersContext`, which sits above the nav **and** the panes. That
placement is deliberate: a provider's nav dot and its card chip are two
renderings of one `describeAiProviders` answer (`ai-provider-status.ts`), and
PwrAgnt shipped a green dot over a broken card when the two were computed
separately.

- **The window picks a profile; the panes show it.** Settings serves every
  profile, but AI settings belong to one. `SettingsWindow` resolves which one:
  the deep link's `profile`, else the reader's pick, else the active profile,
  else the first. The context is keyed by that id and drops every answer when
  it changes. The picker sits in each pane head, so nobody edits another
  profile's settings unawares.
- **Nothing is probed until someone asks.** `request()` is called when either
  AI pane mounts or the AI Providers group unfolds. Opening Settings on General
  spawns nothing. Main serves from cache; only Re-check forces a re-probe.
- **Model probes start the agent.** `aiProviders:acpModels` really starts the
  agent, so only an agent a job is routed to is probed on its own
  (`useInUseAcpModelProbes`). Any other agent is probed only when someone
  clicks "Check session".
- **Show what runs, not what is stored.** The provider select and the "Default
  for" rows both go through `effectiveJobProvider`. A job that refuses ACP
  (`AI_JOBS[job].acp === false`) offers only Codex and says why. A stored model
  the running backend doesn't list is cleared once, and only against a list
  that actually loaded, because an empty one may just be a failed read.
- **`update` returns the failure** (`null` on success), like `writeHost` in
  Forges, so each field can put its error beside itself.
- **AI is off until someone turns it on, per profile.** The switch lives at
  the bottom of the sidebar (`sidebar/AiFeaturesSwitch.tsx`) and again as AI
  Features' first card. Both go through `resolveAiToggleAction`
  (`ai-enablement.ts`), so they agree on when `AiConsentDialog` is shown: the
  first switch-on, and never again. Main refuses `enabled` without
  `consentAcceptedAt`, so skipping the dialog cannot switch it on. Only the
  sidebar checks readiness, and only when the switch is clicked; a switch that
  probed on mount would start `codex` in every window at launch. The dialog
  copy states what leaves the machine, so **a feature that sends more must
  update `AiConsentDialog` before it ships.**

Deep links: `settings:open {page, sub?, profileId?}` opens or focuses the
window. A new window boots on `#settings?page=…` (`parseSettingsRouteHash`); an
open one receives `settings:navigate`. Both are checked against
`SETTINGS_PAGE_SUBS` in `@pwrgit/shared`, the same table that decides which
nav rows expand. The main-side contract is in `src/main/ai/AGENTS.md`.
