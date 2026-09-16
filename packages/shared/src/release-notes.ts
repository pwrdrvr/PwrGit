// Where a version's release notes live, and the one place that composes the
// URL.
//
// PwrGit publishes every build as a GitHub Release, and the notes for a
// version are on that release's page. Nothing in the app could reach them
// before this module: Settings → About's Releases row opens the release
// INDEX, and the bundled license/notices documents describe the build that is
// RUNNING — neither says anything about the version being offered to you. A
// v0.16.0 install cannot carry v0.16.1's notes. So every surface that names a
// version also needs a way out to the published page, and they all compose it
// here so they cannot disagree.
//
// The URL is DERIVED from the version rather than read from the feed, even
// though `AppUpdateReleaseInfo.url` carries GitHub's own `html_url` for the
// four published slots. Two reasons:
//
//   - The status surfaces have no feed record to read. `AppUpdateStatus`
//     carries a bare version through checking/available/downloading/
//     downloaded/canceled/error, and plumbing a URL onto every one of those
//     transitions — including the ones electron-updater raises, which never
//     saw our GitHub read — is a lot of wire for a string that is a pure
//     function of the version.
//   - `html_url` is remote data. `shell:openExternal` would open it, because
//     that gate allows any credential-free http(s) URL (PwrGit opens PR links
//     on arbitrary forges), so a URL we compose from a version we already
//     trust is the narrower of the two.
//
// Deriving is exact because the release tag IS `v` + the version: every tag
// this repo has published matches, `pnpm release:check` enforces that a
// `vX.Y.Z` tag agrees with `apps/desktop/package.json`, and
// `configureAutoUpdaterFeedForRelease` in main/auto-updater.ts already builds
// its asset URL on the same assumption.

// This module deliberately declares NO repository constant of its own.
// `PWRGIT_LINKS.source` and `PWRGIT_LINKS.releases` already are those strings,
// Settings → About prints them verbatim beside a Copy button, and a second
// spelling of one repo would be an unread duplicate waiting to drift.

import { PWRGIT_LINKS } from "./product";

/** Tag shape the release lane publishes: `0.16.0`, `0.16.0-beta.1`, with an
 *  optional `+build` suffix. Anchored, so a version carrying a path
 *  separator, a scheme or a query cannot reach the template below. */
const SEMVER =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The GitHub release page for one version, or `undefined` when the version is
 * not one this repo could have tagged.
 *
 * Accepts a bare version (`0.16.1`, as `AppUpdateStatus` carries it) or a tag
 * (`v0.16.1`, as `AppUpdateReleaseInfo.version` carries it — that field holds
 * GitHub's `tag_name` verbatim), so a caller never has to know which side of
 * that seam its string came from.
 *
 * Returning `undefined` rather than a best-effort URL is the point: a link
 * that isn't there is a smaller failure than one that lands on a 404.
 *
 * What it screens on is the SHAPE of a tag this repo publishes, not the
 * existence of the release — nothing here can know that without asking GitHub,
 * and no surface can afford a round-trip before it paints. So a well-formed
 * version that was never tagged still composes a URL: `420.0.0`, the dev
 * fake's, is the one that actually occurs, and it lands on GitHub's own 404
 * naming the tag. Accepted, because for every version a real update names, the
 * tag exists by construction.
 */
export function releaseNotesUrl(
  version: string | undefined | null
): string | undefined {
  if (typeof version !== "string") return undefined;
  const tag = version.trim().replace(/^v/i, "");
  if (!SEMVER.test(tag)) return undefined;
  // Everything SEMVER admits is already URL-safe except `+`, which has to be
  // escaped or GitHub reads it as a space.
  return `${PWRGIT_LINKS.source}/releases/tag/v${encodeURIComponent(tag)}`;
}
