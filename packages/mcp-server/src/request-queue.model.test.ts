import fc from "fast-check";
import { expect, test } from "vitest";
import { McpRequestQueue } from "./request-queue.js";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test("generated admissions, cancellations and completions agree with a bounded FIFO work model", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    operation: fc.constantFrom("submit", "submit", "cancel", "finish", "throw"),
    index: fc.nat(80)
  }), { maxLength: 80 }), async (history) => {
    const queue = new McpRequestQueue();
    const controllers: AbortController[] = [];
    const releases = new Map<number, (fail?: boolean) => void>();
    const actual: number[] = [];
    const live = new Set<number>();
    const model = { active: new Set<number>(), pending: [] as number[], started: [] as number[] };
    const results: Promise<unknown>[] = [];
    try {
      for (const { operation, index } of history) {
        if (operation === "submit") {
          const id = controllers.length;
          const controller = new AbortController();
          controllers.push(controller);
          if (model.active.size < 8) { model.active.add(id); model.started.push(id); }
          else model.pending.push(id);
          results.push(queue.run(async () => {
            actual.push(id);
            live.add(id);
            try {
              await new Promise<void>((resolve, reject) => {
                releases.set(id, fail => fail ? reject(new Error("handler failed")) : resolve());
              });
            } finally { live.delete(id); }
          }, controller.signal, { id }).catch(error => error as unknown));
        } else if (operation === "cancel" && controllers.length > 0) {
          const id = index % controllers.length;
          controllers[id].abort();
          model.pending = model.pending.filter(pending => pending !== id);
          // Active work can ignore abort: cancellation alone never frees a slot.
        } else if ((operation === "finish" || operation === "throw") && model.active.size > 0) {
          const id = [...model.active][index % model.active.size];
          releases.get(id)!(operation === "throw");
          releases.delete(id);
          model.active.delete(id);
          if (model.pending.length > 0) {
            const next = model.pending.shift()!;
            model.active.add(next);
            model.started.push(next);
          }
        }
        await flush();
        expect(actual).toEqual(model.started);
        expect([...live].sort((a, b) => a - b)).toEqual([...model.active].sort((a, b) => a - b));
        expect(live.size).toBeLessThanOrEqual(8);
      }
    } finally {
      controllers.forEach(controller => controller.abort());
      releases.forEach(release => release());
      await Promise.all(results);
    }
  }));
});

test("a session admits at most 128 waiting requests and rejects excess work without running it", async () => {
  const queue = new McpRequestQueue();
  const controller = new AbortController();
  let release = (): void => undefined;
  const hold = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  const work = (): Promise<void> => { started++; return hold; };
  const admitted = Array.from({ length: 136 }, (_, id) => queue.run(work, controller.signal, { id }));
  try {
    await expect(queue.run(work, controller.signal, {})).rejects.toThrow("queue is full");
    expect(started).toBe(8);
    release();
    await Promise.all(admitted);
    expect(started).toBe(136);
  } finally { release(); await Promise.all(admitted); }
});

test("queued payload bytes are bounded independently of request count, and cancellation returns their budget", async () => {
  const queue = new McpRequestQueue();
  const controller = new AbortController();
  const queuedController = new AbortController();
  let release = (): void => undefined;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const active = Array.from({ length: 8 }, () => queue.run(() => hold, controller.signal, {}));
  const payload = "x".repeat(1024 * 1024 - 2); // JSON's quotes make exactly 1 MiB.
  let started = 0;
  const work = (): void => { started++; };
  const queued = Array.from({ length: 4 }, () =>
    queue.run(work, queuedController.signal, payload).catch(error => error as unknown));
  try {
    await expect(queue.run(work, controller.signal, {})).rejects.toThrow("queue is full");
    queuedController.abort();
    const replacement = queue.run(work, controller.signal, payload);
    release();
    await Promise.all([...active, ...queued, replacement]);
    expect(started).toBe(1);
  } finally { release(); await Promise.all([...active, ...queued]); }
});
