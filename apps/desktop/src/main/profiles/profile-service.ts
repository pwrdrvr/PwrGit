import type {
  CreateProfileRequest,
  DeleteProfileRequest,
  Profile,
  ProfileDeletion,
  ProfileId,
  ProfileList,
  Result,
  UpdateProfileRequest
} from "@pwrgit/shared";
import { err, ok } from "@pwrgit/shared";
import type { DB } from "../persistence/db";

type ProfileRow = {
  id: string;
  name: string;
  email: string;
  author_name: string | null;
  mono: string;
  kind: string | null;
  org: string | null;
  theme: "dark" | "light" | null;
  roots: string;
  last_used_at: string | null;
  sort_order: number;
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveMono(name: string): string {
  const first = name.trim().replace(/[^a-zA-Z0-9]/g, "").charAt(0);
  return (first || "?").toUpperCase();
}

function rowToProfile(r: ProfileRow): Profile {
  const p: Profile = {
    id: r.id,
    name: r.name,
    email: r.email,
    mono: r.mono,
    roots: JSON.parse(r.roots) as string[]
  };
  if (r.author_name !== null) p.authorName = r.author_name;
  if (r.kind !== null) p.kind = r.kind;
  if (r.org !== null) p.org = r.org;
  if (r.theme !== null) p.theme = r.theme;
  if (r.last_used_at !== null) p.lastUsedAt = r.last_used_at;
  return p;
}

const ACTIVE_KEY = "active_profile_id";

/** Reserved namespace for selection/presentation state owned by one profile.
 *  Keeping it here lets deletion clean future keys without learning each key. */
const profileMetaPrefix = (id: ProfileId): string => `profile:${id}:`;

/**
 * Profiles are an in-app concern (PwrGit is single-instance). Switching just
 * updates the active-profile pointer and last-used timestamp; no new process
 * is spawned. Electron-free by construction — tests drive it against an
 * in-memory database.
 */
export class ProfileService {
  constructor(private readonly db: DB) {}

  list(): Profile[] {
    const rows = this.db
      .prepare("SELECT * FROM profiles ORDER BY sort_order, created_at")
      .all() as ProfileRow[];
    return rows.map(rowToProfile);
  }

  get(id: ProfileId): Profile | null {
    const row = this.db
      .prepare("SELECT * FROM profiles WHERE id = ?")
      .get(id) as ProfileRow | undefined;
    return row === undefined ? null : rowToProfile(row);
  }

  getActiveId(): ProfileId | null {
    const row = this.db
      .prepare("SELECT value FROM app_meta WHERE key = ?")
      .get(ACTIVE_KEY) as { value: string } | undefined;
    return row?.value ?? null;
  }

  snapshot(): ProfileList {
    return { activeProfileId: this.getActiveId(), profiles: this.list() };
  }

  create(input: CreateProfileRequest): Profile {
    const id = this.uniqueId(input.name);
    const mono = input.mono?.trim() ? input.mono.trim() : deriveMono(input.name);
    const nextOrder = (
      this.db
        .prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM profiles")
        .get() as { n: number }
    ).n;

    this.db
      .prepare(
        `INSERT INTO profiles (id, name, email, author_name, mono, kind, org, theme, roots, sort_order)
         VALUES (@id, @name, @email, @author_name, @mono, @kind, @org, @theme, @roots, @sort_order)`
      )
      .run({
        id,
        name: input.name,
        email: input.email,
        author_name: input.authorName ?? null,
        mono,
        kind: input.kind ?? null,
        org: input.org?.trim() ? input.org.trim() : null,
        theme: input.theme ?? null,
        roots: JSON.stringify(input.roots ?? []),
        sort_order: nextOrder
      });

    if (this.getActiveId() === null) this.setActiveId(id);
    const created = this.get(id);
    if (created === null) throw new Error("profile insert did not persist");
    return created;
  }

  /** Switch the active profile; records last-used. Assumes the id exists. */
  switch(id: ProfileId): ProfileList {
    this.db
      .prepare("UPDATE profiles SET last_used_at = datetime('now') WHERE id = ?")
      .run(id);
    this.setActiveId(id);
    return this.snapshot();
  }

  /** Patch a profile's editable fields (only provided keys change). */
  update(patch: UpdateProfileRequest): Profile | null {
    const profile = this.get(patch.profileId);
    if (profile === null) return null;
    const sets: string[] = [];
    const args: Record<string, string | null> = { id: patch.profileId };
    if (patch.name !== undefined) {
      sets.push("name = @name");
      args.name = patch.name;
    }
    if (patch.email !== undefined) {
      sets.push("email = @email");
      args.email = patch.email;
    }
    if (patch.authorName !== undefined) {
      sets.push("author_name = @author_name");
      args.author_name = patch.authorName.trim() ? patch.authorName.trim() : null;
    }
    if (patch.org !== undefined) {
      sets.push("org = @org");
      args.org = patch.org.trim() ? patch.org.trim() : null;
    }
    if (patch.theme !== undefined) {
      sets.push("theme = @theme");
      args.theme = patch.theme;
    }
    if (sets.length > 0) {
      this.db
        .prepare(`UPDATE profiles SET ${sets.join(", ")} WHERE id = @id`)
        .run(args);
    }
    return this.get(patch.profileId);
  }

  /**
   * Permanently remove a profile from PwrGit's database. This operation never
   * touches any repository/worktree path stored in the index.
   *
   * The exact current name is a confirmation + stale-dialog guard, and the
   * final profile is protected so callers always receive a concrete next
   * active profile. Database-owned rows cascade through repos/worktrees; the
   * legacy branch_pr table is cleaned explicitly because it predates FKs.
   */
  delete(input: DeleteProfileRequest): Result<ProfileDeletion> {
    const existing = this.get(input.profileId);
    if (existing === null) {
      return err({
        kind: "profile",
        code: "not_found",
        message: `No profile "${input.profileId}"`
      });
    }
    if (input.expectedName !== existing.name) {
      return err({
        kind: "validation",
        code: "confirmation_mismatch",
        message: `Type "${existing.name}" exactly to confirm deletion`
      });
    }

    const ordered = this.list();
    if (ordered.length <= 1) {
      return err({
        kind: "profile",
        code: "last_profile",
        message: "PwrGit must keep at least one profile"
      });
    }

    const deletingIndex = ordered.findIndex((p) => p.id === input.profileId);
    const remaining = ordered.filter((p) => p.id !== input.profileId);
    const currentActiveId = this.getActiveId();
    const activeSurvives = remaining.some((p) => p.id === currentActiveId);
    const replacement =
      remaining[Math.min(Math.max(deletingIndex, 0), remaining.length - 1)];
    const nextActiveId = activeSurvives ? currentActiveId : replacement?.id;
    if (nextActiveId === null || nextActiveId === undefined) {
      return err({
        kind: "profile",
        code: "replacement_missing",
        message: "Could not choose a surviving profile"
      });
    }

    this.db.transaction(() => {
      // branch_pr intentionally predates the repository FK used by its newer
      // sibling commit_pr. Clear it while the repo rows still identify owner.
      this.db
        .prepare(
          `DELETE FROM branch_pr
           WHERE repo_id IN (SELECT id FROM repos WHERE profile_id = ?)`
        )
        .run(input.profileId);

      // ON DELETE CASCADE removes repos, worktrees, derived branch/search
      // indexes, clone destinations, scan state, and repo-owned caches.
      this.db.prepare("DELETE FROM profiles WHERE id = ?").run(input.profileId);

      // Selection state uses one reserved namespace so new profile-scoped keys
      // are deletion-safe without adding bespoke cleanup for every feature.
      const prefix = profileMetaPrefix(input.profileId);
      this.db
        .prepare(
          `DELETE FROM app_meta
           WHERE substr(key, 1, ?) = ?`
        )
        .run(prefix.length, prefix);
      this.setActiveId(nextActiveId);
    })();

    return ok({
      deletedProfileId: input.profileId,
      activeProfileId: nextActiveId,
      profiles: this.list()
    });
  }

  /**
   * Replace a profile's scan roots wholesale (trimmed + de-duped, order kept).
   * Repos under removed roots are pruned on the next rescan.
   */
  setRoots(id: ProfileId, roots: string[]): Profile | null {
    const profile = this.get(id);
    if (profile === null) return null;
    const cleaned: string[] = [];
    for (const r of roots) {
      const t = r.trim();
      if (t !== "" && !cleaned.includes(t)) cleaned.push(t);
    }
    this.db
      .prepare("UPDATE profiles SET roots = ? WHERE id = ?")
      .run(JSON.stringify(cleaned), id);
    return this.get(id);
  }

  /** Ensure at least one profile exists; seeds a default on first run. */
  ensureSeed(seed: CreateProfileRequest): void {
    const count = (
      this.db.prepare("SELECT COUNT(*) AS n FROM profiles").get() as {
        n: number;
      }
    ).n;
    if (count > 0) {
      const current = this.getActiveId();
      if (current === null || this.get(current) === null) {
        const first = this.list()[0];
        if (first !== undefined) this.setActiveId(first.id);
      }
      return;
    }
    this.create(seed);
  }

  private setActiveId(id: ProfileId): void {
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(ACTIVE_KEY, id);
  }

  private uniqueId(name: string): string {
    const base = slugify(name) || "profile";
    let candidate = base;
    let n = 2;
    while (this.get(candidate) !== null) {
      candidate = `${base}-${n}`;
      n += 1;
    }
    return candidate;
  }
}
