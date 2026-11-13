import { describe, expect, it, vi } from "vitest";
import type { Profile } from "@pwrgit/shared";
import {
  createRootDiscovery,
  ROOT_DISCOVERY_FOCUS_GAP_MS,
  ROOT_DISCOVERY_RETRY_MS
} from "./root-discovery";

const profile = (id: string, roots: string[] = [`/roots/${id}`]): Profile =>
  ({ id, name: id, roots }) as unknown as Profile;

function harness(newDirs: Record<string, string[]>) {
  let clock = 0;
  const unscannedRepoDirs = vi.fn(async (p: Profile) => {
    const dirs = newDirs[p.id];
    if (dirs === undefined) throw new Error("unreadable");
    return dirs;
  });
  const shouldRescanProfile = vi.fn((_id: string) => false);
  const rescan = vi.fn((_p: Profile, _o: { force: boolean }) => true);
  const profiles = [profile("a"), profile("b"), profile("empty", [])];
  const discovery = createRootDiscovery({
    profiles: () => profiles,
    indexer: { shouldRescanProfile, unscannedRepoDirs },
    rescan,
    now: () => clock
  });
  return {
    discovery,
    rescan,
    shouldRescanProfile,
    unscannedRepoDirs,
    advance: (ms: number) => {
      clock += ms;
    }
  };
}

describe("root discovery", () => {
  it("forces a scan for new folders, and leaves a quiet profile alone", async () => {
    const h = harness({ a: ["/roots/a/rgit"], b: [] });
    await h.discovery.check();
    expect(h.rescan).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "a" }),
      { force: true }
    );
    // A profile with no folder is never walked.
    expect(h.unscannedRepoDirs).toHaveBeenCalledTimes(2);
  });

  it("runs the daily scan when it is due, without walking first", async () => {
    const h = harness({ a: [], b: [] });
    h.shouldRescanProfile.mockImplementation((id) => id === "b");
    await h.discovery.check();
    expect(h.rescan).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "b" }),
      { force: false }
    );
    expect(h.unscannedRepoDirs).toHaveBeenCalledTimes(1);
  });

  it("does not rescan every tick for folders a failing scan never records", async () => {
    const h = harness({ a: ["/roots/a/broken"], b: [] });
    await h.discovery.check();
    h.advance(2 * 60_000);
    await h.discovery.check();
    expect(h.rescan).toHaveBeenCalledTimes(1);
    h.advance(ROOT_DISCOVERY_RETRY_MS);
    await h.discovery.check();
    expect(h.rescan).toHaveBeenCalledTimes(2);
  });

  it("asks at once for a different set of new folders", async () => {
    const dirs = { a: ["/roots/a/one"], b: [] as string[] };
    const h = harness(dirs);
    await h.discovery.check();
    dirs.a = ["/roots/a/one", "/roots/a/two"];
    await h.discovery.check();
    expect(h.rescan).toHaveBeenCalledTimes(2);
  });

  it("asks again when the profile was already scanning", async () => {
    // That scan may have walked before the folder arrived.
    const h = harness({ a: ["/roots/a/rgit"], b: [] });
    h.rescan.mockReturnValueOnce(false);
    await h.discovery.check();
    await h.discovery.check();
    expect(h.rescan).toHaveBeenCalledTimes(2);
  });

  it("looks at the next profile when one cannot be walked", async () => {
    const h = harness({ b: ["/roots/b/new"] });
    await h.discovery.check();
    expect(h.rescan).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: "b" }),
      { force: true }
    );
  });

  it("holds focus checks to the gap, and never runs two looks at once", async () => {
    const h = harness({ a: [], b: [] });
    await h.discovery.check({ minGapMs: ROOT_DISCOVERY_FOCUS_GAP_MS });
    await h.discovery.check({ minGapMs: ROOT_DISCOVERY_FOCUS_GAP_MS });
    expect(h.unscannedRepoDirs).toHaveBeenCalledTimes(2);
    h.advance(ROOT_DISCOVERY_FOCUS_GAP_MS);
    await Promise.all([
      h.discovery.check({ minGapMs: ROOT_DISCOVERY_FOCUS_GAP_MS }),
      h.discovery.check()
    ]);
    expect(h.unscannedRepoDirs).toHaveBeenCalledTimes(4);
  });
});
