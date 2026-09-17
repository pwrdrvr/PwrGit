# features/update — AGENTS.md

## Two channels, and they are not redundant

`AppUpdateToast` subscribes to both `app:updateStatus` and
`app:updateCheckResult`, and collapsing them into one breaks the feature:

- **`app:updateStatus`** carries *what the updater is doing* — checking,
  available, downloading (with percent and bytes), downloaded, canceled,
  error. Every check moves it, including the hourly background ones.
- **`app:updateCheckResult`** is emitted from exactly one place —
  `menu-update-check.ts`, i.e. Help → Check for Updates. It is the only thing
  that distinguishes "the user is waiting for this answer" from "the hour hand
  looked again". Settings' own **Check for Update** button deliberately does
  not emit it: that surface reports its result inline, and a toast repeating
  the answer next to it would be saying the same thing twice.

So the live progress card is gated on having seen a `checking` tick on the
*result* channel, and is then driven by the *status* channel. A background
download must raise nothing: the user did not ask, and the only thing worth
interrupting them for is the finished, actionable offer.

`checking` is the one mid-flight value on the result channel; every other
value on it is an outcome, `available` included — that one only arrives when a
download was already running before the check started.

## In-flight gets a progress track; finished gets the countdown

`ToastHost` auto-dismisses a toast after 9s and paints `.app-toast__timer`
draining toward it. That is right for a notice that has finished talking and
wrong for work still running — a real download is minutes, and the old
"Checking for updates" toast expired while the check it reported was still
going, leaving the rest of the download invisible.

So: while a user-initiated check is working, this component renders its own
card (progress track, byte meter, Cancel) outside the toast store, with no
countdown. Only when the check settles does the outcome go to the store, where
the countdown is correct. Don't move the in-flight card back into
`showInfoToast`.

## Cancel is offered from `available`, so main must be ready by then

`updateProgressCopy` turns Cancel on as soon as the status reaches
`available` — before any bytes have moved. `auto-updater.ts` therefore
registers its `activeDownload` at that same moment, with an empty `cancel`
slot that electron-updater's token fills in once it exists, and honours a flag
that was already set (`applyPendingCancel`). Register it any later and there
is a window where the button is on screen and does nothing: the click sets
`canceling` in the renderer, main finds no download, and the update installs
anyway.

## A cancel is not an error

`{ status: "canceled" }` is its own status on purpose. `available` would
promise a download that is no longer running, and `error` would put a danger
eyebrow and an Open Logs button in front of someone who got exactly what they
asked for. electron-updater agrees: it deliberately does **not** dispatch its
`error` event for a cancellation, and emits `update-cancelled` instead.

The download's rejection is byte-identical to a network failure's, so
`auto-updater.ts` remembers that *it* asked (`activeDownload.canceled`) rather
than sniffing the error. Keep that flag the discriminator.

## The dev fake is the only way to see any of this

Real auto-update runs in packaged builds only, so `simulateDevUpdateCheck`
walks the whole machine — checking → available → a ramp of download percents →
downloaded — for a user-initiated check in `pnpm dev`. It ramps rather than
emitting one sample because a meter cannot be judged against a single frozen
percent, and it honours Cancel for the same reason. `PWRGIT_E2E_UPDATE_STEP_MS`
paces it so `e2e/update-check.spec.ts` can click a button that only exists
mid-download.

## A version the app names, it must also be able to describe

Every update surface prints a version number the user has never seen and cannot
look up from inside the app. Settings → About opens the license and third-party
notices that shipped INSIDE the running build — neither says what changed in it,
and by construction neither can say anything about the build being *offered*: a
v0.16.0 install cannot carry v0.16.1's notes. Before this, the four-slot matrix,
the `Update ready: v0.16.1` line, the toast's Restart card and the settled
outcome toasts all named a version with no way out to what is in it.

So: **any surface that renders a version renders a
[`ReleaseNotesLink`](./ReleaseNotesLink.tsx) beside it**, and the URL comes from
`releaseNotesUrl` in
[packages/shared/src/release-notes.ts](../../../../../../packages/shared/src/release-notes.ts)
— never composed at the call site.

Four things about that are load-bearing:

- **The URL is DERIVED from the version, not read from the feed.**
  `AppUpdateReleaseInfo.url` carries GitHub's `html_url` for the four published
  slots, but the STATUS surfaces have no feed record at all — `AppUpdateStatus`
  carries a bare version through every transition, including the ones
  electron-updater raises, which never saw our GitHub read. One composer that
  takes a version is the only thing all the surfaces can share. Deriving is
  exact because the release tag is `v` + the version, which
  `configureAutoUpdaterFeedForRelease` already assumes.
- **No URL means no control.** `releaseNotesUrl` answers `undefined` for a
  version that is not *shaped* like a tag this repo publishes, and
  `ReleaseNotesLink` renders `null` for it. It screens on shape, not existence —
  nothing can know a tag exists without asking GitHub, so the dev fake's
  `420.0.0` keeps a link and lands on GitHub's 404. That is the accepted edge;
  for every version a real update names, the tag exists by construction.
- **It is a `<button>`, never an `<a href>`.** PwrGit's windows install
  `setWindowOpenHandler`, so a middle-click on a real anchor is already handed
  to the OS — but nothing guards SAME-FRAME navigation outside the agent-consent
  window, so an ordinary left click on an `<a href>` would load github.com into
  the app frame. Pinned by `ReleaseNotesLink.test.tsx`.
- **Settings → Updates hangs it OUTSIDE the tile.** The slot tile is a
  `role="radio"`, and an interactive element nested in one is neither valid HTML
  nor keyboard-reachable — hence `.settings-slot-cell` wrapping the two. Every
  slot that resolved gets a link, not just the selected one: picking a slot
  rewrites which build the app installs, so reading the notes has to be possible
  without picking.

Two surfaces deliberately render nothing. The `checking` card has no version
yet, and the `skipped` / `error` toasts name none. On Settings → Updates the
status line yields to the Restart row when both would name the same version —
the Restart row has to win, because a window opened after a background download
shows that button with no status line beside it.
