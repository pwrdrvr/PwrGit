import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemGit } from "../test-support/system-git";
import { StackEngine, type CatalogStore, type GhStackCatalog, type GitRunner } from ".";

export const repository = "github.com:example/orbit-deploy";
export const gitEnvironment = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_COUNT: undefined,
  GIT_CONFIG_PARAMETERS: undefined,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
};

export const runner: GitRunner = {
  async run(cwd, args, opts) {
    const execute = createSystemGit({ env: gitEnvironment });
    const result = await execute(args, cwd, opts?.stdin === undefined ? undefined : { input: opts.stdin });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  },
};

export async function git(cwd: string, ...args: string[]) {
  const result = await runner.run(cwd, args);
  if (result.exitCode !== 0) throw new Error(`${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

export async function commit(cwd: string, file: string, contents: string, amend = false) {
  await writeFile(join(cwd, file), contents);
  await git(cwd, "add", "--", file);
  await git(cwd, "commit", "-qm", file, ...(amend ? ["--amend"] : []));
  return git(cwd, "rev-parse", "HEAD");
}

export function memoryStore(initial: GhStackCatalog): CatalogStore {
  let catalog = initial;
  let generation = 0;
  return {
    withOperationLock: async (_dir, fn) => fn(),
    read: async () => ({ catalog: structuredClone(catalog), sha256: String(generation) }),
    writeIfUnchanged: async (_dir, next, hash) => {
      if (hash !== String(generation)) throw new Error("stale catalog");
      catalog = structuredClone(next);
      generation += 1;
    },
  };
}

export async function withRepo<T>(fn: (cwd: string, base: string) => Promise<T>) {
  const cwd = await mkdtemp(join(tmpdir(), "pwrgit-stack-"));
  try {
    await git(cwd, "init", "-q", "-b", "main");
    for (const [key, value] of [
      ["user.name", "Fixture"], ["user.email", "fixture@example.invalid"],
      ["commit.gpgSign", "false"], ["core.autocrlf", "false"], ["core.hooksPath", devNull],
    ]) await git(cwd, "config", key, value);
    const base = await commit(cwd, "base.txt", "base\n");
    return await fn(cwd, base);
  } finally {
    await rm(cwd, { force: true, recursive: true, maxRetries: 5 });
  }
}

export async function withStack<T>(fn: (context: {
  cwd: string; commonDir: string; initial: GhStackCatalog; store: CatalogStore; engine: StackEngine;
  base: string; bottom: string; top: string;
}) => Promise<T>): Promise<T> {
  return withRepo(async (cwd, base) => {
    await git(cwd, "switch", "-qc", "bottom");
    const bottom = await commit(cwd, "bottom.txt", "bottom\n");
    await git(cwd, "switch", "-qc", "top");
    const top = await commit(cwd, "top.txt", "top\n");
    await git(cwd, "switch", "-q", "main");
    const initial: GhStackCatalog = {
      schemaVersion: 1, repository, stacks: [{
        trunk: { branch: "main", head: base },
        branches: [{ branch: "bottom", head: bottom, base }, { branch: "top", head: top, base: bottom }],
      }],
    };
    const commonDir = join(cwd, ".git");
    const store = memoryStore(initial);
    const engine = new StackEngine(runner, store, cwd, commonDir);
    return await fn({ cwd, commonDir, engine, initial, store, base, bottom, top });
  });
}
