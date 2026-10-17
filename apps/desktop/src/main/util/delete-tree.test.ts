import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteTree, DeleteTreeError, type DeleteTreeProgress } from "./delete-tree";

/** Make every directory writable again so cleanup cannot fail on a test's leftovers. */
function unlock(dir: string): void {
  if (!existsSync(dir)) return;
  chmodSync(dir, 0o755);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) unlock(join(dir, entry.name));
  }
}

const posixOwner =
  process.platform !== "win32" && process.getuid?.() !== 0;

describe("deleteTree", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pwrgit-delete-tree-"));
  });
  afterEach(() => {
    unlock(root);
    rmSync(root, { recursive: true, force: true });
  });

  const file = (relative: string, body = "x"): void => {
    const at = join(root, relative);
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, body);
  };

  it("removes a nested tree and reports every entry it removed", async () => {
    for (let d = 0; d < 5; d += 1) {
      for (let f = 0; f < 20; f += 1) file(`target/d${d}/sub/f${f}.txt`);
    }
    mkdirSync(join(root, "target", "empty"));
    const seen: DeleteTreeProgress[] = [];

    await deleteTree(join(root, "target"), (p) => seen.push(p));

    expect(existsSync(join(root, "target"))).toBe(false);
    // 100 files + 5 × (d, sub) + empty + the root itself.
    expect(seen.at(-1)?.itemsDeleted).toBe(100 + 10 + 1 + 1);
    const counts = seen.map((p) => p.itemsDeleted);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
  });

  it("resolves for a path that is already gone", async () => {
    await expect(deleteTree(join(root, "never-there"))).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "removes a link without touching what it points at",
    async () => {
      file("outside/keep.txt");
      file("target/a.txt");
      symlinkSync(join(root, "outside"), join(root, "target", "link"));

      await deleteTree(join(root, "target"));

      expect(existsSync(join(root, "target"))).toBe(false);
      expect(existsSync(join(root, "outside", "keep.txt"))).toBe(true);
    }
  );

  // Go's module cache: 0555 directories all the way down. `rm -rf` and
  // `git worktree remove` both stop at the first one with EACCES.
  it.skipIf(!posixOwner)("empties read-only directories", async () => {
    file("target/go/pkg/mod/example.com/m@v1/internal/a.go");
    file("target/go/pkg/mod/example.com/m@v1/b.go");
    const mod = join(root, "target/go/pkg/mod/example.com/m@v1");
    chmodSync(join(mod, "internal"), 0o555);
    chmodSync(mod, 0o555);
    chmodSync(join(mod, ".."), 0o555);

    await deleteTree(join(root, "target"));

    expect(existsSync(join(root, "target"))).toBe(false);
  });

  it("keeps the event loop responsive while it works", async () => {
    for (let d = 0; d < 20; d += 1) {
      for (let f = 0; f < 50; f += 1) file(`target/d${d}/f${f}.txt`);
    }
    let last = performance.now();
    let worstGap = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
    }, 5);
    try {
      await deleteTree(join(root, "target"));
    } finally {
      clearInterval(ticker);
    }
    expect(existsSync(join(root, "target"))).toBe(false);
    expect(worstGap).toBeLessThan(250);
  });

  // An immutable file (macOS `chflags uchg`) cannot be removed by its owner,
  // and chmod does not change that. The error must say which entry stopped
  // the delete, and how far it got, instead of a bare EPERM.
  it.runIf(process.platform === "darwin" && posixOwner)(
    "names the entry that stopped it",
    async () => {
      file("target/a/ok.txt");
      file("target/b/stuck.txt");
      execFileSync("chflags", ["uchg", join(root, "target/b/stuck.txt")]);
      try {
        const failure = await deleteTree(join(root, "target")).then(
          () => null,
          (cause: unknown) => cause
        );
        expect(failure).toBeInstanceOf(DeleteTreeError);
        const error = failure as DeleteTreeError;
        expect(error.relativePath).toBe(join("b", "stuck.txt"));
        expect(error.code).toBe("EPERM");
        expect(existsSync(join(root, "target/b/stuck.txt"))).toBe(true);
      } finally {
        execFileSync("chflags", ["nouchg", join(root, "target/b/stuck.txt")]);
      }
    }
  );

  // A worktree's `.git` link goes last, so a delete that stops partway leaves
  // a folder Git still recognises — one Remove can finish rather than an
  // orphan nobody lists.
  it.runIf(process.platform === "darwin" && posixOwner)(
    "keeps the deferred entries when it stops partway",
    async () => {
      file("target/.git", "gitdir: /elsewhere\n");
      file("target/src/stuck.txt");
      execFileSync("chflags", ["uchg", join(root, "target/src/stuck.txt")]);
      try {
        await expect(
          deleteTree(join(root, "target"), undefined, { deleteLast: [".git"] })
        ).rejects.toBeInstanceOf(DeleteTreeError);
        expect(existsSync(join(root, "target/.git"))).toBe(true);
      } finally {
        execFileSync("chflags", ["nouchg", join(root, "target/src/stuck.txt")]);
      }
    }
  );

  it("still removes the deferred entries once everything else is gone", async () => {
    file("target/.git", "gitdir: /elsewhere\n");
    file("target/src/a.txt");
    await deleteTree(join(root, "target"), undefined, { deleteLast: [".git"] });
    expect(existsSync(join(root, "target"))).toBe(false);
  });

  // Only directories being deleted are ever chmodded. A root whose parent is
  // read-only fails, and the parent keeps its mode.
  it.skipIf(!posixOwner)("never chmods the root's own parent", async () => {
    file("locked-parent/target/a.txt");
    const parent = join(root, "locked-parent");
    chmodSync(parent, 0o555);
    const failure = await deleteTree(join(parent, "target")).then(
      () => null,
      (cause: unknown) => cause
    );
    expect(failure).toBeInstanceOf(DeleteTreeError);
    expect((failure as DeleteTreeError).relativePath).toBe("");
    expect(statSync(parent).mode & 0o777).toBe(0o555);
  });
});
