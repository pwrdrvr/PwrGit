import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { routedRemotes } from "./fork-route";
import {
  eligibleSiblingForkRemotes,
  isForkSyncRemoteEnabled,
  repoForkSyncEligibility
} from "./fork-sync";
import type { RemoteEndpoint, RemoteForgeIdentity, RepoIdentity } from "./types";

const identSegment = fc
  .stringMatching(/^[a-z][a-z0-9-]{1,10}$/)
  .filter((s) => !s.endsWith("-"));

const slugArb = fc
  .tuple(identSegment, identSegment)
  .map(([owner, repo]) => `${owner}/${repo}`);

const remoteNameArb = fc
  .stringMatching(/^[a-z][a-z0-9_-]{1,10}$/)
  .filter((name) => name !== "origin" && name !== "upstream");

const ghUrl = (slug: string, host = "github.com"): string =>
  `git@${host}:${slug}.git`;

describe("multi-fork sync rules (properties)", () => {
  it("never admits a sibling remote without confirmed write access, matching push URL, and matching fork parent/root", () => {
    fc.assert(
      fc.property(
        slugArb,
        slugArb,
        fc.array(
          fc.record({
            name: remoteNameArb,
            fetchSlug: slugArb,
            samePush: fc.boolean(),
            hasExtraPush: fc.boolean(),
            otherPushSlug: slugArb,
            sameHost: fc.boolean(),
            knownInForge: fc.boolean(),
            viewerCanPush: fc.constantFrom(true, false, undefined),
            parentKind: fc.constantFrom("source", "root", "unrelated", "none")
          }),
          { maxLength: 8 }
        ),
        (sourceSlug, originSlug, specs) => {
          fc.pre(sourceSlug.toLowerCase() !== originSlug.toLowerCase());
          const usedNames = new Set(["origin", "upstream"]);
          const uniqueSpecs = specs.filter((spec) => {
            if (usedNames.has(spec.name)) return false;
            usedNames.add(spec.name);
            return true;
          });

          const identity: RepoIdentity = {
            host: "github",
            hostname: "github.com",
            owner: originSlug.split("/")[0]!,
            name: originSlug.split("/")[1]!,
            nameWithOwner: originSlug,
            visibility: "public",
            viewerCanPush: true,
            parent: {
              nameWithOwner: sourceSlug,
              url: `https://github.com/${sourceSlug}`
            }
          };

          const endpoints: RemoteEndpoint[] = [
            { name: "origin", fetchUrl: ghUrl(originSlug), pushUrl: ghUrl(originSlug) },
            { name: "upstream", fetchUrl: ghUrl(sourceSlug), pushUrl: ghUrl(sourceSlug) }
          ];
          const remoteIdentities: RemoteForgeIdentity[] = [];
          const seenMeta = new Set<string>();

          for (const spec of uniqueSpecs) {
            const host = spec.sameHost ? "github.com" : "gitlab.com";
            const pushSlug = spec.samePush ? spec.fetchSlug : spec.otherPushSlug;
            endpoints.push({
              name: spec.name,
              fetchUrl: ghUrl(spec.fetchSlug, host),
              pushUrl: ghUrl(pushSlug, host),
              ...(spec.hasExtraPush ? { pushUrls: [ghUrl(pushSlug, host), ghUrl(spec.fetchSlug, "mirror.example")] } : {})
            });
            const metaKey = `${host}\0${spec.fetchSlug.toLowerCase()}`;
            if (spec.knownInForge && !seenMeta.has(metaKey)) {
              seenMeta.add(metaKey);
              remoteIdentities.push({
                hostname: host,
                nameWithOwner: spec.fetchSlug,
                ...(spec.viewerCanPush === undefined
                  ? {}
                  : { viewerCanPush: spec.viewerCanPush }),
                ...(spec.parentKind === "source"
                  ? { parent: sourceSlug }
                  : spec.parentKind === "root"
                    ? { parent: originSlug, root: sourceSlug }
                    : spec.parentKind === "unrelated"
                      ? { parent: "stranger/unrelated" }
                      : {})
              });
            }
          }

          const eligible = eligibleSiblingForkRemotes(endpoints, {
            sourceRemote: "upstream",
            trackedRemote: "origin",
            identity,
            remoteIdentities
          });

          const metaByKey = new Map(
            remoteIdentities.map((m) => [
              `${m.hostname.toLowerCase()}\0${m.nameWithOwner.toLowerCase()}`,
              m
            ])
          );
          const emittedSlugs = new Set<string>();
          for (const entry of eligible) {
            // Never includes source or tracked remote.
            expect(entry.remote).not.toBe("upstream");
            expect(entry.remote).not.toBe("origin");
            expect(entry.nameWithOwner.toLowerCase()).not.toBe(sourceSlug.toLowerCase());
            expect(entry.nameWithOwner.toLowerCase()).not.toBe(originSlug.toLowerCase());
            // Deduplicated by repository slug.
            expect(emittedSlugs.has(entry.nameWithOwner.toLowerCase())).toBe(false);
            emittedSlugs.add(entry.nameWithOwner.toLowerCase());
            // Confirmed writable and in the source's fork network.
            expect(entry.viewerCanPush).toBe(true);
            const endpoint = endpoints.find((e) => e.name === entry.remote)!;
            expect(endpoint.fetchUrl.toLowerCase()).toBe(endpoint.pushUrl.toLowerCase());
            expect(endpoint.pushUrls).toBeUndefined();
            const meta = metaByKey.get(
              `github.com\0${entry.nameWithOwner.toLowerCase()}`
            );
            expect(meta).toBeDefined();
            expect(meta!.viewerCanPush).toBe(true);
            expect(
              meta!.parent?.toLowerCase() === sourceSlug.toLowerCase() ||
                meta!.root?.toLowerCase() === sourceSlug.toLowerCase()
            ).toBe(true);
          }

          // Differential: repoForkSyncEligibility agrees with
          // eligibleSiblingForkRemotes on every non-origin remote.
          const repoMap = repoForkSyncEligibility(endpoints, {
            identity,
            remoteIdentities,
            prefs: new Map()
          });
          const repoEligibleNonOrigin = [...repoMap.entries()]
            .filter(([name, info]) => name !== "origin" && info.eligible)
            .map(([name]) => name)
            .sort();
          expect(repoEligibleNonOrigin).toEqual(
            eligible.map((entry) => entry.remote).sort()
          );
        }
      )
    );
  });

  it("enables all writable fork remotes by default and honors per-remote opt-outs independently", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(remoteNameArb, { minLength: 1, maxLength: 8 }),
        fc.array(fc.tuple(fc.nat(), fc.boolean()), { maxLength: 20 }),
        (remotes, toggles) => {
          const prefs = new Map<string, boolean>();
          // Default before any user toggle: every remote is enabled.
          for (const remote of remotes) {
            expect(isForkSyncRemoteEnabled(remote, prefs)).toBe(true);
          }
          const model = new Map(remotes.map((r) => [r, true]));
          for (const [idx, enabled] of toggles) {
            const target = remotes[idx % remotes.length]!;
            prefs.set(target, enabled);
            model.set(target, enabled);
            for (const remote of remotes) {
              expect(isForkSyncRemoteEnabled(remote, prefs)).toBe(model.get(remote));
            }
          }
        }
      )
    );
  });

  it("routedRemotes marks confirmed sibling forks as fork and withholds canPush on mismatched push URLs", () => {
    const identity: RepoIdentity = {
      host: "github",
      hostname: "github.com",
      owner: "pwrdrvr",
      name: "t3code",
      nameWithOwner: "pwrdrvr/t3code",
      visibility: "public",
      viewerCanPush: true,
      parent: {
        nameWithOwner: "pingdotgg/t3code",
        url: "https://github.com/pingdotgg/t3code"
      }
    };
    const rows = routedRemotes(
      identity,
      [
        { name: "origin", fetchUrl: ghUrl("pwrdrvr/t3code"), pushUrl: ghUrl("pwrdrvr/t3code") },
        { name: "upstream", fetchUrl: ghUrl("pingdotgg/t3code"), pushUrl: ghUrl("pingdotgg/t3code") },
        { name: "huntharo", fetchUrl: ghUrl("huntharo/t3code"), pushUrl: ghUrl("huntharo/t3code") },
        { name: "readonly", fetchUrl: ghUrl("alice/t3code"), pushUrl: ghUrl("alice/t3code") },
        { name: "mirror", fetchUrl: ghUrl("bob/t3code"), pushUrl: ghUrl("other/mirror") }
      ],
      {},
      [
        { hostname: "github.com", nameWithOwner: "huntharo/t3code", viewerCanPush: true, parent: "pingdotgg/t3code" },
        { hostname: "github.com", nameWithOwner: "alice/t3code", viewerCanPush: false, parent: "pingdotgg/t3code" },
        { hostname: "github.com", nameWithOwner: "bob/t3code", viewerCanPush: true, parent: "pingdotgg/t3code" }
      ]
    );
    expect(rows).toEqual([
      { name: "origin", nameWithOwner: "pwrdrvr/t3code", role: "fork", canPush: true },
      { name: "upstream", nameWithOwner: "pingdotgg/t3code", role: "original" },
      { name: "huntharo", nameWithOwner: "huntharo/t3code", role: "fork", canPush: true },
      { name: "readonly", nameWithOwner: "alice/t3code", role: "fork", canPush: false },
      { name: "mirror", nameWithOwner: "bob/t3code", role: "fork" }
    ]);
  });

  it("only assigns sibling roles on the original's forge instance", () => {
    fc.assert(fc.property(slugArb, fc.boolean(), fc.boolean(), (parent, sameHost, useRoot) => {
      const identity: RepoIdentity = {
        host: "github", hostname: "github.com", owner: "home", name: "app",
        nameWithOwner: "home/app", visibility: "public",
        parent: { nameWithOwner: parent, url: `https://github.com/${parent}` }
      };
      const host = sameHost ? "github.com" : "gitlab.com";
      const sibling = ghUrl("sibling/app", host);
      const rows = routedRemotes(identity, [
        { name: "origin", fetchUrl: ghUrl("home/app"), pushUrl: ghUrl("home/app") },
        { name: "peer", fetchUrl: sibling, pushUrl: sibling }
      ], {}, [{
        hostname: host, nameWithOwner: "sibling/app", viewerCanPush: true,
        ...(useRoot ? { root: parent } : { parent })
      }]);
      expect(rows[1]?.role).toBe(sameHost ? "fork" : "other");
    }));
  });

  it("prefers origin as a sibling fork when the checked-out branch tracks another fork remote", () => {
    const identity: RepoIdentity = {
      host: "github",
      hostname: "github.com",
      owner: "pwrdrvr",
      name: "t3code",
      nameWithOwner: "pwrdrvr/t3code",
      visibility: "public",
      viewerCanPush: true,
      parent: {
        nameWithOwner: "pingdotgg/t3code",
        url: "https://github.com/pingdotgg/t3code"
      }
    };
    const eligible = eligibleSiblingForkRemotes(
      [
        { name: "huntharo", fetchUrl: ghUrl("huntharo/t3code"), pushUrl: ghUrl("huntharo/t3code") },
        { name: "origin", fetchUrl: ghUrl("pwrdrvr/t3code"), pushUrl: ghUrl("pwrdrvr/t3code") },
        { name: "upstream", fetchUrl: ghUrl("pingdotgg/t3code"), pushUrl: ghUrl("pingdotgg/t3code") }
      ],
      {
        sourceRemote: "upstream",
        trackedRemote: "huntharo",
        identity,
        remoteIdentities: [
          {
            hostname: "github.com",
            nameWithOwner: "huntharo/t3code",
            viewerCanPush: true,
            parent: "pingdotgg/t3code"
          }
        ]
      }
    );
    expect(eligible.map((e) => e.remote)).toEqual(["origin"]);
  });
});
