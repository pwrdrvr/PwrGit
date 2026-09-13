import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { directorySize, pathSize } from "./dir-size";

describe("directorySize", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-dir-size-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const file = (relative: string, size: number): void => {
    const at = join(root, relative);
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, "x".repeat(size));
  };

  it("sums nested files and counts every entry it visits", async () => {
    file("a.txt", 100);
    file("deep/b.txt", 250);
    file("deep/deeper/c.txt", 1);
    const result = await directorySize(root);
    expect(result.bytes).toBe(351);
    // 2 directories + 3 files.
    expect(result.entries).toBe(5);
    expect(result.partial).toBe(false);
    expect(result.inaccessible).toBe(0);
  });

  it("does not follow a symlink out of the tree", async () => {
    // A pnpm store lives outside the checkout; counting through the link would
    // attribute another directory's bytes to this worktree — or loop.
    const outside = mkdtempSync(join(tmpdir(), "pwrgit-dir-size-outside-"));
    try {
      writeFileSync(join(outside, "big.bin"), "x".repeat(5000));
      file("small.txt", 10);
      symlinkSync(outside, join(root, "linked"), "dir");
      const result = await directorySize(root);
      expect(result.bytes).toBe(10);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("stops at the entry ceiling and says the answer is a floor", async () => {
    for (let at = 0; at < 40; at += 1) file(`many/f${at}.txt`, 10);
    const capped = await directorySize(root, { entryCap: 5 });
    expect(capped.partial).toBe(true);
    expect(capped.bytes).toBeLessThan(400);
    const whole = await directorySize(root);
    expect(whole.partial).toBe(false);
    expect(whole.bytes).toBe(400);
  });

  it("stops on an aborted signal, reporting what it had", async () => {
    for (let at = 0; at < 20; at += 1) file(`many/f${at}.txt`, 10);
    const controller = new AbortController();
    controller.abort();
    const result = await directorySize(root, { signal: controller.signal });
    expect(result.partial).toBe(true);
    expect(result.bytes).toBe(0);
  });

  it("treats a missing root as empty rather than an error", async () => {
    const result = await directorySize(join(root, "never-existed"));
    expect(result.bytes).toBe(0);
    expect(result.inaccessible).toBe(1);
  });
});

describe("pathSize", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-path-size-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("sizes a file or a directory without the caller knowing which", async () => {
    writeFileSync(join(root, "one.txt"), "x".repeat(64));
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "dir", "two.txt"), "x".repeat(32));
    expect((await pathSize(join(root, "one.txt"))).bytes).toBe(64);
    expect((await pathSize(join(root, "dir"))).bytes).toBe(32);
  });

  it("counts a symlink as nothing", async () => {
    writeFileSync(join(root, "target.txt"), "x".repeat(99));
    symlinkSync(join(root, "target.txt"), join(root, "link.txt"));
    expect((await pathSize(join(root, "link.txt"))).bytes).toBe(0);
  });

  it("reports a vanished path as inaccessible, not as a failure", async () => {
    const result = await pathSize(join(root, "gone"));
    expect(result.bytes).toBe(0);
    expect(result.inaccessible).toBe(1);
  });
});
