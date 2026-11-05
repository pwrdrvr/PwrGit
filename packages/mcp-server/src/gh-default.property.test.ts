import fc from "fast-check";
import { expect, it } from "vitest";
import { planGhSetDefault, resolveGhDefaultRepository, type GhRemoteInput } from "./gh-default.js";

// The model is gh's rule read straight off its source, written the slow way:
// walk the rank buckets from `upstream` down, each bucket in `git remote -v`
// (byte) order. It shares no code with the implementation's comparator.
function model(remotes: readonly GhRemoteInput[]): { repository: string | null; ambiguous: boolean } {
  const usable = remotes.filter((remote) => remote.github && remote.host !== null && remote.repository !== null);
  const bucket = (name: string): number =>
    ({ upstream: 0, github: 1, origin: 2 } as Record<string, number>)[name.toLowerCase()] ?? 3;
  const order: GhRemoteInput[] = [];
  for (let rank = 0; rank <= 3; rank++) {
    const names = usable.filter((remote) => bucket(remote.name) === rank).map((remote) => remote.name);
    names.sort();
    for (const name of names) order.push(usable.find((remote) => remote.name === name)!);
  }
  const resolved = order.find((remote) => remote.resolved !== null);
  if (resolved !== undefined) {
    return { repository: resolved.resolved === "base" ? resolved.repository : resolved.resolved, ambiguous: false };
  }
  const distinct = new Set(order.map((remote) => `${remote.host}/${remote.repository!.toLowerCase()}`));
  return { repository: order[0]?.repository ?? null, ambiguous: distinct.size > 1 };
}

const NAMES = ["origin", "upstream", "Upstream", "github", "pwrdrvr", "fork", "mirror", "a", "z"];
const REPOS = ["pwrdrvr/PwrDisk", "pwrdrvr/pwrdisk", "tobi/disktree", "me/widget", null];

const remotesArb = fc
  .uniqueArray(fc.constantFrom(...NAMES), { maxLength: 6 })
  .chain((names) =>
    fc.tuple(
      ...names.map((name) =>
        fc.record({
          name: fc.constant(name),
          host: fc.constantFrom("github.com", "ghe.acme.example"),
          repository: fc.constantFrom(...REPOS),
          github: fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
          resolved: fc.option(fc.constantFrom("base", "me/widget"), { freq: 6 })
        })
      )
    )
  )
  .map((remotes) => remotes as GhRemoteInput[]);

it("agrees with gh's rule, read as a model, for every remote set", () => {
  fc.assert(
    fc.property(remotesArb, (remotes) => {
      const state = resolveGhDefaultRepository(remotes);
      const expected = model(remotes);
      expect(state.repository).toBe(expected.repository);
      expect(state.status === "ambiguous").toBe(expected.ambiguous);
      // A risky state always carries a fix; a settled one never nags.
      expect(state.fix !== null).toBe(state.status === "ambiguous" || state.status === "invalid");
    }),
    { numRuns: 500 }
  );
});

it("does not depend on the order the remotes were read in", () => {
  fc.assert(
    fc.property(remotesArb.chain((remotes) => fc.tuple(fc.constant(remotes), fc.shuffledSubarray(remotes, { minLength: remotes.length, maxLength: remotes.length }))), ([remotes, shuffled]) => {
      expect(resolveGhDefaultRepository(shuffled)).toEqual(resolveGhDefaultRepository(remotes));
    })
  );
});

it("never becomes ambiguous by adding a remote that duplicates an existing URL", () => {
  fc.assert(
    fc.property(remotesArb, fc.string({ minLength: 1, maxLength: 6 }).filter((name) => /^[b-y]+$/.test(name)), (remotes, extra) => {
      const existing = remotes.find((remote) => remote.github && remote.repository !== null);
      fc.pre(existing !== undefined && !remotes.some((remote) => remote.name === extra));
      const before = resolveGhDefaultRepository(remotes);
      const after = resolveGhDefaultRepository([...remotes, { ...existing!, name: extra, resolved: null }]);
      expect(after.candidates.length).toBe(before.candidates.length);
      if (before.status === "implicit") expect(after.status).toBe("implicit");
    })
  );
});

it("PwrGit's set-default plan always makes gh resolve to the chosen repository, with one key left", () => {
  fc.assert(
    fc.property(remotesArb, fc.nat(), (remotes, pick) => {
      const usable = remotes.filter((remote) => remote.github && remote.repository !== null);
      fc.pre(usable.length > 0);
      const target = usable[pick % usable.length]!;
      const plan = planGhSetDefault(remotes, { host: target.host!, repository: target.repository! });
      expect(plan).not.toBeNull();
      const after = remotes.map((remote) => ({
        ...remote,
        resolved: remote.name === plan!.set ? "base" : plan!.unset.includes(remote.name) ? null : remote.resolved
      }));
      expect(after.filter((remote) => remote.resolved !== null).map((remote) => remote.name)).toEqual([plan!.set]);
      const state = resolveGhDefaultRepository(after);
      expect(state.status).toBe("set");
      expect(state.repository?.toLowerCase()).toBe(target.repository!.toLowerCase());
      expect(state.host).toBe(target.host);
    }),
    { numRuns: 300 }
  );
});
