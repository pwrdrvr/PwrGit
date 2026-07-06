import type {
  CreateProfileRequest,
  Profile,
  ProfileId,
  ProfileList
} from "@pwrgit/shared";
import type { DB } from "../persistence/db";

type ProfileRow = {
  id: string;
  name: string;
  email: string;
  author_name: string | null;
  mono: string;
  kind: string | null;
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
  if (r.last_used_at !== null) p.lastUsedAt = r.last_used_at;
  return p;
}

const ACTIVE_KEY = "active_profile_id";

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
        `INSERT INTO profiles (id, name, email, author_name, mono, kind, roots, sort_order)
         VALUES (@id, @name, @email, @author_name, @mono, @kind, @roots, @sort_order)`
      )
      .run({
        id,
        name: input.name,
        email: input.email,
        author_name: input.authorName ?? null,
        mono,
        kind: input.kind ?? null,
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

  /** Ensure at least one profile exists; seeds a default on first run. */
  ensureSeed(seed: CreateProfileRequest): void {
    const count = (
      this.db.prepare("SELECT COUNT(*) AS n FROM profiles").get() as {
        n: number;
      }
    ).n;
    if (count > 0) return;
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
