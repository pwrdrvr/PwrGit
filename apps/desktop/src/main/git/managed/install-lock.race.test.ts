// The install lock across PwrGit processes sharing one data directory.
// Rule: of processes taking the lock at once, exactly one holds it. A lock
// file being created is never read as a dead holder's and taken over.
//
// File creation is slowed here, so the moment between "the lock file exists"
// and "it names its holder" is long enough for other processes to look at it.
// A lock that can be seen before its pid is written fails this test.
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));
  return {
    ...real,
    // An exclusive create returns before anything is written to the file.
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      await pause();
      return handle;
    }
  };
});

const { ManagedGitService } = await import("./managed-git-service");

let root: string;
beforeEach(() => {
  root = join(realpathSync(mkdtempSync(join(tmpdir(), "pwrgit-install-lock-"))), "git-runtimes");
});
afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

type Lockable = { lock(): Promise<() => Promise<void>> };

test("of several PwrGits taking the install lock at once, exactly one gets it", async () => {
  const pids = [101, 102, 103, 104];
  for (let round = 0; round < 5; round += 1) {
    const services = pids.map(
      (pid) =>
        new ManagedGitService({
          root,
          platform: "linux",
          arch: "x64",
          bundled: { version: "2.56.0-dev-pwrgit.4", consumerSha256: "0".repeat(64) },
          selection: () => ({}),
          installedOverride: () => false,
          pid,
          isProcessAlive: (other) => pids.includes(other)
        }) as unknown as Lockable
    );
    const taken = await Promise.allSettled(services.map((service) => service.lock()));
    const held = taken.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === "fulfilled");
    expect(held, `round ${round}`).toHaveLength(1);
    await held[0]!.value();
    expect(readdirSync(root).filter((name) => name.startsWith(".install.lock"))).toEqual([]);
  }
});
