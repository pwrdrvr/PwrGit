# Sign in with ChatGPT

PwrGit is free. The free MIT app can use your ChatGPT plan for commit-message
drafts, Squash messages and Tidy history proposals. There is no PwrGit payment,
upgrade or paid-tier gate. AI is off by default for every profile.
[Learn more](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
about using your plan in other apps.

In Settings → AI Providers, choose the profile and select **Continue with
ChatGPT**. The system browser asks for identity and optional plan usage. Signing
in alone does not turn on AI or authorize inference. Choose **Sign in with
ChatGPT** for the desired jobs in AI Features and turn on AI after reading the
disclosure. A usable local Codex CLI is required; this provider does not require
Codex login. The first plan grant shows a welcome message.

When it pays for a request, the provider reads **Using ChatGPT plan**. **Manage
usage** opens [ChatGPT usage settings](https://chatgpt.com/settings/usage), also
the primary action when usage is exhausted. PwrGit does not buy credits, suggest
buying credits or invent a reset time. Credits are an OpenAI opt-in controlled
by the user. There is no retry around an ineligible account. The preview currently
supports Plus and Pro; Business and Enterprise plan usage is not available.
The model catalog is a choice of models, not an entitlement check. A completed
inference turn verifies access to that model for that request.

Each profile authorizes its own registration. Tokens are encrypted with the
OS-user's Electron safeStorage key in the local SQLite database, under the
profile's namespace. They are never copied from another profile, sent to a
PwrGit service, returned to the renderer or supplied to inbound Local Agents/MCP.
The installation host identifier is shared across PwrGit profiles and contains
no account identity. Disconnect clears local tokens, retains the issued
registration for reauthorization, and attempts to revoke the refresh token. If
revocation cannot be confirmed, PwrGit says so; disconnect the app in ChatGPT
settings as well. OS credential encryption must be available; a plaintext
fallback is refused.

Inference runs in an isolated local Codex app-server with no tools, repository
access, hosted MCP, image generation or general-purpose completion API. Only the
existing user-requested commit-message and history-editing jobs use this
provider. Refresh is serialized per profile and happens before a job when
needed; rotating tokens are replaced together. A new access token restarts
app-server and resumes the saved thread. No new background SIWC jobs are added.

## Operator steps before distribution

Harold must decide whether distributing PwrGit accepts the
[SIWC Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/). The terms
state that integration or use constitutes agreement. This implementation and
its PR do not submit an interest form, click acceptance, purchase anything or
sign in as Harold.

OpenAI documents an open-source, locally hosted lane and waitlist requirements
for paid or remotely hosted applications. **The company-distributed free MIT
case is undocumented.** PwrGit is a free local desktop app distributed by
PwrDrvr LLC; these facts fit the documented OSS/local lane but do not establish
that OpenAI has approved PwrDrvr. Harold alone decides whether to seek
clarification or submit the [interest form](https://openai.com/form/sign-in-with-chatgpt-interest/).
No DevKit package, source or logo asset is included; its noncommercial license
is not used for this independently authored protocol implementation.

After deciding those steps, Harold alone should manually test with a Plus or Pro
account: consent and cancellation, identity-only scope, first welcome, both
jobs, separate profiles, expired-token refresh, disconnect, reauthorization
using the saved issued ID, and usage-limit recovery through Manage usage.
Fixture tests and CI never contact OpenAI or open a real browser sign-in.

Protocol references: [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[profiles and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server),
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations),
and [UI/UX guidance](https://developers.openai.com/siwc/ui-ux-guidelines).
