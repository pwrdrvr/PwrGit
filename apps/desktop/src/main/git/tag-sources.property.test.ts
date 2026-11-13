import fc from "fast-check";
import { err, ok, type TagSyncStatus } from "@pwrgit/shared";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../persistence/db";
import type { GitExec } from "./dugite";
import {
  compareTags,
  parseLsRemoteTags,
  TagSources,
  type KeepDecision,
  type ListedTag,
  type LocalTagRef,
  type RemoteConfig
} from "./tag-sources";

/*
 * Properties, a differential test and a scheduler model for tag-sources.ts
 * (docs/property-model-oracle-testing.md). Real-git oracles live in
 * fetch-tags.property.test.ts and tag-sources.git.property.test.ts.
 */

// A few names and objects, so local and published values collide often.
const NAMES = ["v1.0.0", "v1.2.3", "v2.0.0", "v10.0.0", "nightly", "wip/bisect", "legacy/2019-import"];
const IDS = ["a", "b", "c", "d"].map((c) => c.repeat(40));
const name = fc.constantFrom(...NAMES);
const id = fc.constantFrom(...IDS);

const listedTag = fc.record({ name, objectId: id, targetId: id, annotated: fc.boolean() }).map(
  (tag): ListedTag => (tag.annotated ? tag : { ...tag, targetId: tag.objectId })
);
const listing = fc.uniqueArray(listedTag, { selector: (tag) => tag.name, maxLength: NAMES.length });

/** What `git ls-remote --tags` prints: refname order, a tag object's peel line right after it. */
function renderLsRemote(tags: ListedTag[]): string {
  return [...tags]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((tag) => [
      `${tag.objectId}\trefs/tags/${tag.name}`,
      ...(tag.annotated ? [`${tag.targetId}\trefs/tags/${tag.name}^{}`] : [])
    ])
    .map((line) => `${line}\n`)
    .join("");
}

/** The status rules of design 1b, one name at a time. */
function expectedStatus(
  local: LocalTagRef | undefined,
  published: Map<string, ListedTag> | null,
  keep: KeepDecision | undefined,
  tagName: string
): TagSyncStatus {
  const remote = published?.get(tagName);
  if (local === undefined) return "remote_only";
  if (published === null) return "unchecked";
  if (remote === undefined) return "local_only";
  if (remote.objectId === local.objectId) return "same";
  return keep?.localObjectId === local.objectId && keep.remoteObjectId === remote.objectId ? "kept_local" : "differs";
}

describe("parsing and comparing", () => {
  it("parses every listing git can print back to the tags it describes", () => {
    fc.assert(
      fc.property(listing, (tags) => {
        const parsed = parseLsRemoteTags(renderLsRemote(tags));
        const byName = (a: ListedTag, b: ListedTag) => a.name.localeCompare(b.name);
        expect([...parsed].sort(byName)).toEqual([...tags].sort(byName));
      })
    );
  });

  it("lists each name once, local order first, with the status its pair of values says", () => {
    const local = fc.uniqueArray(fc.record({ name, objectId: id }), { selector: (tag) => tag.name, maxLength: NAMES.length });
    const keeps = fc.dictionary(name, fc.record({ localObjectId: id, remoteObjectId: id }), { maxKeys: 4 });
    fc.assert(
      fc.property(local, fc.option(listing, { nil: null }), keeps, (localTags, listed, keepRecord) => {
        const published = listed === null ? null : new Map(listed.map((tag) => [tag.name, tag]));
        const keepMap = new Map(Object.entries(keepRecord));
        const { rows, counts } = compareTags(localTags, published, keepMap);

        const localNames = localTags.map((tag) => tag.name);
        const remoteOnly = (listed ?? []).map((tag) => tag.name).filter((tagName) => !localNames.includes(tagName));
        expect(rows.slice(0, localNames.length).map((row) => row.name)).toEqual(localNames);
        expect(new Set(rows.slice(localNames.length).map((row) => row.name))).toEqual(new Set(remoteOnly));
        expect(rows).toHaveLength(localNames.length + remoteOnly.length);

        for (const row of rows) {
          const mine = localTags.find((tag) => tag.name === row.name);
          expect(row.status).toBe(expectedStatus(mine, published, keepMap.get(row.name), row.name));
          expect(row.local).toEqual(mine ?? null);
          expect(row.published).toEqual(published?.get(row.name) ?? null);
        }
        const tally = (status: TagSyncStatus) => rows.filter((row) => row.status === status).length;
        expect(counts).toEqual({
          all: rows.length,
          differs: tally("differs"),
          keptLocal: tally("kept_local"),
          remoteOnly: tally("remote_only"),
          localOnly: tally("local_only")
        });
      })
    );
  });
});

const db = openDatabase(":memory:");
db.prepare("INSERT INTO profiles (id, name, email) VALUES ('p1', 'P', 'p@example.com')").run();
db.prepare("INSERT INTO repos (id, profile_id, name, path) VALUES ('repo-1', 'p1', 'proj', '/repo')").run();
afterAll(() => db.close());

function resetStore(): void {
  db.prepare("DELETE FROM repo_tag_source").run();
  db.prepare("DELETE FROM remote_tag_snapshots").run();
  db.prepare("DELETE FROM tag_keep_local").run();
}

describe("the sidebar and the Tags tab agree on the publisher", () => {
  const REMOTES = ["origin", "upstream", "fork", "mirror"];
  it("the sidebar line names the Tags tab's publisher and that remote's stored count, or nothing", () => {
    fc.assert(
      fc.property(
        fc.subarray(REMOTES),
        fc.option(fc.constantFrom(...REMOTES), { nil: null }),
        fc.dictionary(fc.constantFrom(...REMOTES), fc.nat(3)),
        (configured, chosen, differsByRemote) => {
          resetStore();
          // A fresh service each run: its caches must not outlive the reset.
          const sources = new TagSources(db);
          for (const [remote, differs] of Object.entries(differsByRemote)) {
            sources.store.recordListing("repo-1", remote, `/${remote}.git`, [], 1);
            sources.store.setDiffers("repo-1", remote, differs);
          }
          if (chosen !== null) sources.setPrimary("repo-1", chosen);
          const configs: RemoteConfig[] = configured.map((remote) => ({ name: remote, url: `/${remote}.git`, tagOpt: null }));

          const tab = sources.resolve("repo-1", configs).state.primary;
          const sidebar = sources.store.attention("repo-1", configured);
          const stored = tab === null ? undefined : differsByRemote[tab];
          expect(sidebar).toEqual(tab !== null && stored !== undefined && stored > 0 ? { remote: tab, differs: stored } : undefined);
        }
      )
    );
  });
});

describe("rows drawn as moved are the rows counted as differing", () => {
  const localTags = fc.uniqueArray(fc.record({ name, objectId: id }), { selector: (tag) => tag.name, maxLength: NAMES.length });
  const keepRecord = fc.dictionary(name, fc.record({ localObjectId: id, remoteObjectId: id }), { maxKeys: 4 });
  const REMOTES = ["origin", "upstream"];

  it("moves() names exactly the publisher's differing tags, each with the publisher's value", () => {
    fc.assert(
      fc.property(
        localTags,
        fc.dictionary(fc.constantFrom(...REMOTES), listing),
        keepRecord,
        fc.subarray(REMOTES),
        fc.option(fc.constantFrom(...REMOTES), { nil: null }),
        (local, listings, keeps, configured, chosen) => {
          resetStore();
          const sources = new TagSources(db);
          for (const [remote, listed] of Object.entries(listings)) {
            sources.store.recordListing("repo-1", remote, `/${remote}.git`, listed, 1);
            for (const [tagName, keep] of Object.entries(keeps)) sources.store.setKeep("repo-1", remote, tagName, keep, 1);
          }
          if (chosen !== null) sources.setPrimary("repo-1", chosen);
          const configs = configured.map((remote): RemoteConfig => ({ name: remote, url: `/${remote}.git`, tagOpt: null }));
          const publisher = sources.resolve("repo-1", configs).state.primary;
          const listed = publisher === null ? undefined : listings[publisher];
          const published = listed === undefined ? null : new Map(listed.map((tag) => [tag.name, tag]));

          const moves = sources.store.moves("repo-1", configured, local);
          const expected = local.filter(
            (tag) => expectedStatus(tag, published, keeps[tag.name], tag.name) === "differs"
          );
          expect([...moves.keys()].sort()).toEqual(expected.map((tag) => tag.name).sort());
          for (const tag of expected) {
            const value = published!.get(tag.name)!;
            expect(moves.get(tag.name)).toEqual({
              remote: publisher,
              objectId: value.objectId,
              targetId: value.targetId,
              kind: value.annotated ? "annotated" : "lightweight"
            });
          }
          // The count line and the marks come from one comparison.
          sources.store.setDiffers("repo-1", publisher ?? "none", expected.length);
          expect(sources.store.attention("repo-1", configured)?.differs ?? 0).toBe(publisher === null || listed === undefined ? 0 : expected.length);
        }
      )
    );
  });

  it("a re-count reports a redraw whenever the differing set changes, also at the same count", async () => {
    // The lineage redraws only when told, and a count alone missed a tag that
    // moved while another was taken: 10 differ before, 10 after.
    const state = fc.record({ local: localTags, listed: listing });
    await fc.assert(
      fc.asyncProperty(fc.array(state, { minLength: 1, maxLength: 6 }), async (states) => {
        resetStore();
        const sources = new TagSources(db);
        let previous: { count: number; set: string } = { count: 0, set: "" };
        for (const { local, listed } of states) {
          const git: GitExec = async () =>
            ok({ stdout: local.map((tag) => `${tag.objectId} refs/tags/${tag.name}\n`).join(""), stderr: "", exitCode: 0 });
          sources.store.recordListing("repo-1", "origin", "/origin.git", listed, 1);
          const published = new Map(listed.map((tag) => [tag.name, tag]));
          const differing = local
            .filter((tag) => expectedStatus(tag, published, undefined, tag.name) === "differs")
            .map((tag) => `${tag.name}:${tag.objectId}:${published.get(tag.name)!.objectId}`)
            .sort();
          const next = { count: differing.length, set: differing.join(",") };
          const moved = await sources.recount(git, "repo-1", "/repo", "origin");
          expect(moved).toEqual(ok(next.count !== previous.count || next.set !== previous.set));
          previous = next;
        }
      })
    );
  });
});

describe("concurrent listings", () => {
  /**
   * Git as the scheduler resolves it: each call settles when the scheduler
   * says, and a call whose signal is aborted by then fails as execGit does.
   */
  function fakeGit(s: fc.Scheduler, signal: AbortSignal | undefined, label: string): GitExec {
    return async (args) => {
      await s.schedule(Promise.resolve(), `${label}: git ${args[0]}`);
      if (signal?.aborted === true) {
        return err({ kind: "git", code: "aborted", message: "Git was stopped before it completed." });
      }
      if (args[0] === "config") return ok({ stdout: "remote.origin.url\n/origin.git\0", stderr: "", exitCode: 0 });
      if (args[0] === "ls-remote") return ok({ stdout: `${IDS[0]}\trefs/tags/v1.0.0\n`, stderr: "", exitCode: 0 });
      return ok({ stdout: "", stderr: "", exitCode: 0 });
    };
  }

  it("an asker that was not stopped gets the listing, and a stop is never recorded as the remote failing", async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }), async (s, stoppable) => {
        resetStore();
        const sources = new TagSources(db);
        const callers = stoppable.map((stop, index) => {
          const controller = stop ? new AbortController() : undefined;
          // A background check yields to a user's operation by aborting.
          if (controller !== undefined) {
            void s.schedule(Promise.resolve(), `stop caller ${index}`).then(() => controller.abort());
          }
          return {
            stop,
            result: sources.refresh(fakeGit(s, controller?.signal, `caller ${index}`), "repo-1", "/repo", "origin")
          };
        });
        // Resolve scheduled work until every caller has answered: a joined
        // listing schedules its own Git calls only after the first settles.
        const results = await s.waitFor(Promise.all(callers.map((caller) => caller.result)));

        callers.forEach((caller, index) => {
          if (!caller.stop) expect(results[index]?.ok).toBe(true);
        });
        const snapshot = sources.store.snapshot("repo-1", "origin");
        // The fake remote never refuses: any recorded error is a stop mis-read.
        expect(snapshot?.error ?? null).toBeNull();
        if (stoppable.includes(false)) expect(snapshot?.checked_at_ms).not.toBeNull();
      })
    );
  });
});
