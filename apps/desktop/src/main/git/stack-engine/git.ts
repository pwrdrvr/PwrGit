import type { GitRunner, RefMove, WorktreeFollow } from "./types";

export const branchRef = (branch: string) => `refs/heads/${branch}`;
export const isOid = (value: string) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);

export class StackGit {
  constructor(readonly runner: GitRunner, readonly cwd: string) {}

  run(args: string[], stdin?: string, cwd = this.cwd) {
    return this.runner.run(cwd, args, stdin === undefined ? undefined : { stdin });
  }

  async output(args: string[], stdin?: string, cwd?: string): Promise<string> {
    const result = await this.run(args, stdin, cwd);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} exited ${result.exitCode}`);
    return result.stdout;
  }

  async tip(branch: string): Promise<string | null> {
    const ref = branchRef(branch);
    await this.output(["check-ref-format", ref]);
    const result = await this.run(["show-ref", "--verify", "--hash", ref]);
    if (result.exitCode === 128 && !result.stdout) {
      const exists = await this.run(["show-ref", "--exists", ref]);
      if (exists.exitCode === 2) return null;
    }
    const oid = result.stdout.trim();
    if (result.exitCode !== 0 || !isOid(oid)) throw new Error(result.stderr.trim() || `Cannot read ${ref}`);
    return oid;
  }

  async ancestor(base: string, tip: string): Promise<boolean> {
    const result = await this.run(["merge-base", "--is-ancestor", base, tip]);
    if (result.exitCode > 1 || result.exitCode < 0) throw new Error(result.stderr.trim() || "Cannot verify ancestry");
    return result.exitCode === 0;
  }

  async transaction(moves: RefMove[], expected: Record<string, string | null>, creates: string[] = []) {
    for (const branch of new Set([...Object.keys(expected), ...moves.map(move => move.branch)])) {
      await this.output(["check-ref-format", branchRef(branch)]);
    }
    const oids = [...Object.values(expected), ...moves.flatMap(({ old, next }) => [old, next])];
    if (oids.some(oid => oid !== null && (typeof oid !== "string" || !isOid(oid)))) {
      throw new Error("Invalid stack transaction object ID");
    }
    const updates = new Set(moves.map(move => move.branch));
    const commands = [
      ...creates,
      ...Object.entries(expected).flatMap(([branch, oid]) => updates.has(branch) ? [] : [`verify ${branchRef(branch)} ${oid ?? ""}`.trimEnd()]),
      ...moves.map(({ branch, old, next }) => {
        const ref = branchRef(branch);
        if (next === null) return `delete ${ref} ${old}`;
        return old === null ? `create ${ref} ${next}` : `update ${ref} ${next} ${old}`;
      }),
    ];
    if (commands.length) await this.output(["update-ref", "--stdin"], ["start", ...commands, "prepare", "commit", ""].join("\n"));
  }

  async worktrees(moves: RefMove[]): Promise<WorktreeFollow[]> {
    const byBranch = new Map(moves.map(move => [branchRef(move.branch), move]));
    const records = (await this.output(["worktree", "list", "--porcelain", "-z"])).split("\0\0");
    return records.flatMap(record => {
      const fields = record.split("\0");
      const path = fields[0]?.slice("worktree ".length);
      const ref = fields.find(field => field.startsWith("branch "))?.slice(7);
      const move = ref && byBranch.get(ref);
      if (!path || !move || move.old === null) return [];
      if (move.next === null) throw new Error(`Switch away from ${move.branch} in ${path} before undoing its creation`);
      return [{ branch: move.branch, path, old: move.old, next: move.next }];
    });
  }

  async dirtyOverlap(follows: WorktreeFollow[]): Promise<{ path: string; files: string[] }[]> {
    const blocked = [];
    for (const follow of follows) {
      const { path, old, next } = follow;
      const porcelain = await this.output(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"], undefined, path);
      const dirty = porcelain.split("\0").filter(Boolean).map(entry => entry.slice(3));
      const diff = await this.output(["diff-tree", "-r", "--name-only", "--no-renames", "-z", old, next]);
      const changed = new Set(diff.split("\0").filter(Boolean));
      const files = dirty.filter(file => changed.has(file) ||
        [...changed].some(name => name.startsWith(file + "/") || file.startsWith(name + "/")));
      if (files.length) blocked.push({ path, files });
      else await this.output(["read-tree", "--dry-run", "-m", "-u", old, next], undefined, path);
    }
    return blocked;
  }

  async follow(worktree: WorktreeFollow): Promise<void> {
    const { branch, path, old, next } = worktree;
    const head = await this.output(["symbolic-ref", "-q", "HEAD"], undefined, path);
    if (head.trim() !== branchRef(branch) || await this.tip(branch) !== next) {
      throw new Error(`Worktree changed while applying the stack: ${path}`);
    }
    await this.output(["read-tree", "-m", "-u", old, next], undefined, path);
  }
}
