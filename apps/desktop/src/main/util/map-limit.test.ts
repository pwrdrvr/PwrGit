import { expect, it, vi } from "vitest";
import { limitConcurrency, mapLimit } from "./map-limit";

function gate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}

it("bounds work and returns input order despite out-of-order completion", async () => {
  const gates = Array.from({ length: 4 }, gate);
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  const result = mapLimit([0, 1, 2, 3], 2, async (id) => {
    started.push(id);
    peak = Math.max(peak, ++active);
    await gates[id]!.ready;
    active -= 1;
    return id;
  });
  await vi.waitFor(() => expect(started).toEqual([0, 1]));
  gates[1]!.release();
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
  gates[2]!.release();
  await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
  gates[3]!.release();
  gates[0]!.release();
  expect(await result).toEqual([0, 1, 2, 3]);
  expect(peak).toBe(2);
});

it("drains workers before propagating a failure to a lock-owning caller", async () => {
  const held = gate();
  const failure = new Error("worker failed");
  let started = 0;
  let settled = false;
  const result = mapLimit([0, 1], 2, async (id) => {
    started += 1;
    if (id === 0) throw failure;
    await held.ready;
  }).then(() => { settled = true; return null; }, (error: unknown) => {
    settled = true;
    return error;
  });
  await vi.waitFor(() => expect(started).toBe(2));
  expect(settled).toBe(false);
  held.release();
  expect(await result).toBe(failure);
});

it("shares a ceiling across callers and continues after rejected work", async () => {
  const held = gate();
  let active = 0;
  let peak = 0;
  let started = 0;
  const run = limitConcurrency(async (id: number) => {
    started += 1;
    peak = Math.max(peak, ++active);
    await held.ready;
    active -= 1;
    if (id === 0) throw new Error("first call failed");
    return id;
  }, 2);
  const result = Promise.allSettled([0, 1, 2, 3, 4].map(run));
  await vi.waitFor(() => expect(started).toBe(2));
  held.release();
  expect(await result).toEqual([
    { status: "rejected", reason: expect.any(Error) },
    ...[1, 2, 3, 4].map((value) => ({ status: "fulfilled", value }))
  ]);
  expect(peak).toBe(2);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await run(5)).toBe(5);
});

it.each([6, 8])("hands released permits to waiting callers before newcomers at limit %i", async (limit) => {
  const gates = Array.from({ length: limit + 2 }, gate);
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  const run = limitConcurrency(async (id: number) => {
    started.push(id);
    peak = Math.max(peak, ++active);
    await gates[id]!.ready;
    active -= 1;
    return id;
  }, limit);
  const initial = Promise.allSettled(Array.from({ length: limit + 1 }, (_, id) => run(id)));
  let newcomer: Promise<PromiseSettledResult<number>[]> | undefined;
  let afterRelease: number[] = [];
  try {
    await vi.waitFor(() => expect(started).toHaveLength(limit));
    gates[0]!.release();
    // Race a new caller against the queued caller resuming after permit release.
    await Promise.resolve();
    await Promise.resolve();
    newcomer = Promise.allSettled([run(limit + 1)]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    afterRelease = [...started];
  } finally {
    for (const held of gates) held.release();
  }
  const results = [...await initial, ...await newcomer!];
  expect({ started: afterRelease, peak, results }).toEqual({
    started: Array.from({ length: limit + 1 }, (_, id) => id),
    peak: limit,
    results: Array.from({ length: limit + 2 }, (_, value) => ({ status: "fulfilled", value }))
  });
});
