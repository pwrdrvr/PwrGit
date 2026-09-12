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
  state and scroll position across a fold.
- **Arrow keys rove between headers** (Up/Down/Home/End), which is why sections
  register their header element with the stack.

Collapse state is deliberately **not** persisted to settings: which sections you
had folded is a reading position, not a preference, and writing it would put a
settings write behind every click.

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
