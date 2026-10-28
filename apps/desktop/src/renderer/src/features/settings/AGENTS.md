# settings — AGENTS.md

The Settings window's panes. `SettingsLayout.tsx` holds the primitives. Each
pane composes them and owns its own reads.

## Every pane's sections go inside a `SettingsSectionStack`

Without the stack, a pane silently loses:

- `gap: 14px` and `max-width: 760px`, the column every pane matches;
- the shared collapse state, keyed by `paneId`;
- the **Collapse all / Expand all** registration in the pane head.

Settings → Forges once used a bare fragment and drew 919px cards with touching
borders. It type-checks and bundles; only a side-by-side look shows it.

- **`paneId` must be stable and unique.** It keys collapse state for the life
  of the window.
- A `SettingsSection` outside a stack renders as a plain card with no
  disclosure. `AgentConsentWindow` relies on this: with no pane to remember a
  fold, a chevron would make a false promise.

## The disclosure header is a `div[role="button"]`, and owes what that costs

Ported from PwrAgnt's `SettingsLayout`. A native `<button>` cannot wrap a
heading, a description and a live status chip, so you must supply what a real
button gets for free:

- **Enter and Space** both toggle (SC 2.1.1). Space must `preventDefault()`,
  or it scrolls the pane.
- **`aria-label` names the section.** A computed name would read the full
  description on focus and change whenever the chip changes.
- **The body is `inert` when folded**, not only `aria-hidden`. With
  `aria-hidden` alone, Tab goes into a closed section. The body stays mounted,
  so it keeps React state, but the clip is `display: none`, so an inner
  scroller returns to the top.
- **Arrow keys move between headers** (Up/Down/Home/End). That is why
  sections register their header element with the stack.

Do **not** persist collapse state to settings. It is a reading position, not a
preference, and persisting it adds a settings write per click.

## A nav child is a route to a card, never a pane of its own

`SettingsWindow.tsx` renders the left nav. A section in `SETTINGS_NAV_GROUPS`
(`settings-nav.ts`) gets a caret and a sub-list. Each child names a
`SettingsSection` `sectionId` in the parent's pane. A click scrolls to that
card, unfolds it and focuses its header (`SettingsSectionStack`'s
`focusSection`). A child mounts no second pane, so it can show live status
for something one click away.

Easy to get wrong:

- **The request is an object, not the slug.** The stack honors a request once.
  Sections re-register whenever one is added or re-keyed (a probe result is
  enough), and a repeated reveal would pull the scroll back. With slug
  comparison, the second click on a child would do nothing, and that is the
  click a reader uses to return to a card.
- **A folded group gives its `aria-current` back to the parent row.** The
  folded sub-list is `inert` and `aria-hidden`, so without the handover the
  nav marks nothing. Navigating to a group always unfolds it; only the caret
  folds one.

Status dots:

- Dots are `aria-hidden`, so every state that is not "fine" also shows a word.
- The row's accessible name is the pane live region's sentence
  (`forgeStateSentence`), not a second phrasing.
- An unprobed product gets no dot and no word. A green dot would be a guess.
- `useForgeStatuses.ts` is the nav's read: one `forge:status` on mount, plus
  pushes. Main answers from cache, because the children report on panes the
  reader has *not* opened.

## Forges is one section per product

`ForgesSettings.tsx` is the pane. It holds both reads (`forge:hosts`,
`forge:status`) and maps `FORGE_KINDS`. `ForgeProductSection.tsx` is one
product's card. Each read answers for every product, so per-section reads
would start N of each on mount, doubled under StrictMode.

Three fixed bugs that must not regress (`ForgeHosts.test.tsx` pins them):

- **Gate Remove on `kindSource === "config"`, never `origin`.** `origin` means
  a CLI holds an account; `kindSource` means a person chose the product.
  Gating on `origin` showed Remove on a switched-off host, and Remove cleared
  `enabled:false`, turning it back on with no row to undo it.
- **Keep the Add buttons disabled until the host list has loaded.** The
  duplicate check reads the rendered list. An unloaded list passes everything,
  and an add on an existing host rewrites its product.
- **An add writes `{kind, enabled: true}`.** Main merges, so a stale
  `enabled:false` would survive and the new host would arrive switched off.

Per-product wording (label, CLI name, Add button and helper line, SaaS host)
comes from `FORGE_PRODUCTS` (`packages/shared/src/forge-product.ts`). Never
write a local table here; two existed before the registry.
`pnpm lint:forge-kinds` fails any `kind === "github"` in non-test source.
Tests are exempt: a literal states the expected value, and a test reading the
component's table cannot catch an error in it.

`src/main/forge/AGENTS.md` explains why a product is chosen and never guessed
from a hostname.

## AI Providers and AI Features are per profile, in a window that is not

`AiProvidersSettings.tsx` has one card per provider (Codex, then ACP agents).
`AiFeaturesSettings.tsx` has one card per section. Both read
`AiProvidersContext`, which sits above the nav **and** the panes. Thus the nav
dot and the card chip render one `describeAiProviders` answer
(`ai-provider-status.ts`). PwrAgnt computed them separately and shipped a
green dot over a broken card.

- **The window picks a profile; the panes show it.** `SettingsWindow`
  resolves: deep link `profile`, else the reader's pick, else the active
  profile, else the first. The context is keyed by that id and drops every
  answer when it changes. The picker is in each pane head, so nobody edits
  another profile unawares.
- **Settings probes on demand.** `request()` runs when an AI pane mounts or
  the AI Providers group unfolds. Opening on General starts nothing. Main
  serves from cache; Re-check and Refresh models force a probe.
- **The launch notice probes Codex only when AI is enabled for its profile.**
  `CodexVersionNotice` shares Settings' discovery service. Its version warning
  is advisory; older models stay usable. Command and installer help live in
  the notice and the AI Providers Codex card. AI Features shows one linking
  line above the pickers, only while AI is on (every job runs on Codex).
  Model-list keys include the binary's version, so an in-place upgrade
  reloads the picker.
- **Model probes start the agent.** `aiProviders:acpModels` starts the agent,
  so only agents a job routes to are probed automatically
  (`useInUseAcpModelProbes`). Others are probed only on "Check session".
- **Show what runs, not what is stored.** The provider select and "Default
  for" rows use `effectiveJobProvider`. A job that refuses ACP
  (`AI_JOBS[job].acp === false`) offers only Codex and says why. A stored model
  the backend does not list is cleared once, only against a loaded list (an
  empty list can be a failed read).
- **`update` returns the failure** (`null` on success), like `writeHost` in
  Forges, so each field shows its own error.
- **AI is off until someone turns it on, per profile.** The switch is at the
  sidebar bottom (`sidebar/AiFeaturesSwitch.tsx`) and is AI Features' first
  card. Both use `resolveAiToggleAction` (`ai-enablement.ts`), so
  `AiConsentDialog` shows on the first switch-on only. Main refuses `enabled`
  without `consentAcceptedAt`, so skipping the dialog cannot enable AI. Only
  the sidebar checks readiness, on click; probing on mount would start `codex`
  in every window at launch. **A feature that sends more data must update
  `AiConsentDialog` before it ships**, because the dialog states what leaves
  the machine.

Deep links: `settings:open {page, sub?, profileId?}` opens or focuses the
window. A new window boots on `#settings?page=…` (`parseSettingsRouteHash`);
an open one receives `settings:navigate`. Both are checked against
`SETTINGS_PAGE_SUBS` in `@pwrgit/shared`, which also decides which nav rows
expand. Main-side contract: `src/main/ai/AGENTS.md`.
