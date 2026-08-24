import { describe, expect, it } from "vitest";
import { createAsyncFill } from "./asyncFill";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe("createAsyncFill", () => {
  it("runs a request after the debounce window", async () => {
    const fill = createAsyncFill<string>({ debounceMs: 10 });
    let ran = 0;
    fill.request("a", async () => {
      ran += 1;
    });
    expect(ran).toBe(0); // still debouncing
    await sleep(40);
    expect(ran).toBe(1);
  });

  it("a key canceled during debounce never generates work", async () => {
    const fill = createAsyncFill<string>({ debounceMs: 15 });
    let ran = 0;
    fill.request("flash", async () => {
      ran += 1;
    });
    fill.cancel("flash"); // scrolled past — flashed on screen for a second
    await sleep(50);
    expect(ran).toBe(0);
  });

  it("a key canceled while queued is tossed at pull time", async () => {
    // Hold the first task behind an explicit gate. A timer-based "slow" task
    // can finish before this test resumes on a loaded Windows runner, letting
    // the victim run before cancel() and turning the assertion into a race.
    const fill = createAsyncFill<string>({ concurrency: 1, debounceMs: 1 });
    let markSlowStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      markSlowStarted = resolve;
    });
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let markQueueDrained!: () => void;
    const queueDrained = new Promise<void>((resolve) => {
      markQueueDrained = resolve;
    });
    let secondRan = false;
    fill.request("slow", async () => {
      markSlowStarted();
      await slowGate;
    });
    await slowStarted;
    fill.request("victim", async () => {
      secondRan = true;
    });
    await sleep(10); // victim debounced + enqueued behind slow
    fill.cancel("victim");
    fill.request("after-victim", async () => {
      markQueueDrained();
    });
    await sleep(10); // sentinel debounced + enqueued behind victim
    releaseSlow();
    await queueDrained; // victim was pulled (and tossed) before the sentinel
    expect(secondRan).toBe(false);
  });

  it("re-requesting a canceled-but-queued key revives it", async () => {
    const fill = createAsyncFill<string>({ concurrency: 1, debounceMs: 1 });
    let ran = 0;
    fill.request("slow", () => sleep(60));
    await sleep(20);
    fill.request("comeback", async () => {
      ran += 1;
    });
    await sleep(10);
    fill.cancel("comeback");
    fill.request("comeback", async () => {
      ran += 1;
    }); // scrolled away and back
    await sleep(120);
    expect(ran).toBe(1);
  });

  it("cancelAll clears every pending fill", async () => {
    const fill = createAsyncFill<string>({ debounceMs: 15 });
    let ran = 0;
    for (const k of ["a", "b", "c"]) {
      fill.request(k, async () => {
        ran += 1;
      });
    }
    fill.cancelAll();
    await sleep(60);
    expect(ran).toBe(0);
  });
});
