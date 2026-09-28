# Gerrit

- This adapter reads public REST endpoints anonymously. No token extraction,
  Google sign-in, fork, upload or review mutation is implemented.
- The Git host and review URL can differ. Use the explicit host setting or
  documented site mapping; never replace arbitrary hostname suffixes.
- `branch` in ChangeInfo is the target branch. It must never enter source-branch
  PR matching. `headRefName` carries the validated immutable patch-set ref here.
- Fetch each patch set into `change/<number>/<patch-set>` without force or an
  upstream. A new patch set must not overwrite local work on an older one.
- Public API success can establish public repository visibility; it says
  nothing about the user's push permissions. No invented `viewerCanPush`.
- Preserve XSSI validation, response limits, and complete pagination. A failed
  read is not an empty list and must not remove cached changes.
