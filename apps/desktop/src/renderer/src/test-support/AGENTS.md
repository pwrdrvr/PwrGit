# Renderer test support

React `act()` warnings fail tests through `apps/desktop/test-support/act-warning-runner.ts`, including
warnings hidden by console spies or emitted during teardown. The guard keeps
async callbacks attributed to the test that created them. Its intentionally
failing fixtures run only through `scripts/renderer-act-warning-guard.test.mjs`.

Await the actual update: mount-time requests, event callbacks, deferred replies
and timer advances belong inside an awaited `act()` scope, or a Testing Library
helper that waits for the resulting UI. Assert that result before teardown.
Do not suppress warnings, disable `IS_REACT_ACT_ENVIRONMENT`, or drain unrelated
work globally to make a test pass. Check component cleanup when work outlives
its owner; wrapping a test cannot fix a missing unsubscribe or stale reply.
