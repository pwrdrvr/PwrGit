# features/update — AGENTS.md

## Two channels, and they are not redundant

`AppUpdateToast` subscribes to both `app:updateStatus` and
`app:updateCheckResult`, and collapsing them into one breaks the feature:

- **`app:updateStatus`** carries *what the updater is doing* — checking,
  available, downloading (with percent and bytes), downloaded, canceled,
  error. Every check moves it, including the hourly background ones.
- **`app:updateCheckResult`** is emitted **only** for a check the user asked
  for (`menu-update-check.ts`, and `app:checkForUpdate` from Settings). It is
  the only thing that distinguishes "the user is waiting for this answer" from
  "the hour hand looked again".

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
