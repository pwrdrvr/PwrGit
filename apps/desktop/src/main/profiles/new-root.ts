import { mkdir, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import {
  SUGGESTED_ROOTS,
  comparableRoot,
  err,
  foldsPathCase,
  isSuggestedRootName,
  ok,
  rootOverlapMessage,
  type NewRootChoice,
  type ProfileId,
  type Result,
  type SuggestedRoot
} from "@pwrgit/shared";
import type { ProfileService } from "./profile-service";

/** How many picker answers are remembered. A person picks a handful of
 *  folders a session; the cap only stops the set growing without bound. */
const PICKED_MEMORY = 64;

/** What `attach` did, so a failed clone can take it back. */
export type AttachedRoot = {
  path: string;
  created: boolean;
  added: boolean;
  /** Remove the folder from the profile if `attach` added it, and delete it
   *  if `attach` created it and it is still empty. */
  undo: () => Promise<void>;
};

/**
 * Repository folders that may not exist yet: the wizard's "I do not have any"
 * (card 3b) and Clone or Fork on a profile with no folder (card 5a).
 *
 * Main creates or registers a folder only by one of two names, never because
 * a renderer sent a path: one of `SUGGESTED_ROOTS` directly under home, or a
 * path the system folder picker returned to this app this session
 * (`rememberPicked`, called by `dialog:pickDirectories`). Anything else is
 * refused.
 */
export class NewRootService {
  private readonly picked: string[] = [];

  constructor(
    private readonly profiles: Pick<ProfileService, "get" | "setRoots" | "addedRootOverlaps">,
    private readonly home: () => string = homedir,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  rememberPicked(paths: readonly string[]): void {
    for (const path of paths) {
      const key = this.key(path);
      const at = this.picked.indexOf(key);
      if (at >= 0) this.picked.splice(at, 1);
      this.picked.push(key);
    }
    while (this.picked.length > PICKED_MEMORY) this.picked.shift();
  }

  async suggested(): Promise<SuggestedRoot[]> {
    const home = this.home();
    return Promise.all(
      SUGGESTED_ROOTS.map(async (name) => {
        const path = join(home, name);
        const exists = await stat(path).then((s) => s.isDirectory(), () => false);
        return { name, path, display: `~${sep}${name}`, exists };
      })
    );
  }

  /** The absolute path a choice names, or why it is refused. */
  resolve(choice: NewRootChoice): Result<{ path: string; mayCreate: boolean }> {
    if (choice.kind === "suggested") {
      if (!isSuggestedRootName(choice.name)) {
        return err({ kind: "validation", code: "root_not_allowed", message: `“${String(choice.name)}” is not a suggested folder.` });
      }
      return ok({ path: join(this.home(), choice.name), mayCreate: true });
    }
    if (typeof choice.path !== "string" || !this.picked.includes(this.key(choice.path))) {
      return err({
        kind: "validation",
        code: "root_not_allowed",
        message: "Choose the folder with Choose another folder… first."
      });
    }
    return ok({ path: choice.path, mayCreate: false });
  }

  /**
   * Make the folder exist (a suggested one only) and add it to the profile,
   * without a scan. Refused, with nothing changed, if another profile owns an
   * overlapping folder or the name is taken by a file.
   */
  async attach(profileId: ProfileId, choice: NewRootChoice): Promise<Result<AttachedRoot>> {
    const resolved = this.resolve(choice);
    if (!resolved.ok) return resolved;
    const { path, mayCreate } = resolved.value;
    const profile = this.profiles.get(profileId);
    if (profile === null) {
      return err({ kind: "profile", code: "not_found", message: `No profile "${profileId}"` });
    }
    const overlap = this.profiles.addedRootOverlaps(profileId, [path])[0];
    if (overlap !== undefined) {
      return err({ kind: "validation", code: "root_overlap", message: rootOverlapMessage(overlap) });
    }

    const existing = await stat(path).catch(() => null);
    if (existing !== null && !existing.isDirectory()) {
      return err({ kind: "validation", code: "root_not_directory", message: `${path} exists and is not a folder.` });
    }
    if (existing === null && !mayCreate) {
      return err({ kind: "validation", code: "destination_missing", message: `Folder does not exist: ${path}` });
    }
    let created = false;
    if (existing === null) {
      try {
        // Not recursive: the home folder exists, and a suggested folder is
        // one level under it.
        await mkdir(path);
        created = true;
      } catch (cause) {
        return err({
          kind: "profile",
          code: "create_failed",
          message: `Couldn’t create ${path}: ${cause instanceof Error ? cause.message : String(cause)}`
        });
      }
    }

    const before = profile.roots;
    const already = before.some((r) => this.key(r) === this.key(path));
    if (!already) this.profiles.setRoots(profileId, [...before, path]);

    return ok({
      path,
      created,
      added: !already,
      undo: async () => {
        if (!already) {
          const now = this.profiles.get(profileId);
          if (now !== null) {
            this.profiles.setRoots(
              profileId,
              now.roots.filter((r) => this.key(r) !== this.key(path))
            );
          }
        }
        // `rmdir` removes only an empty folder: anything put in it since
        // (a partial clone the clone itself failed to clean) stays.
        if (created) await rmdir(path).catch(() => undefined);
      }
    });
  }

  private key(path: string): string {
    return comparableRoot(path, foldsPathCase(this.platform));
  }
}

/**
 * Run a clone or fork into a folder that may not exist yet (card 5a). With no
 * `choice` it runs into `parentPath` unchanged. With one, the folder is
 * created and added only now, as the operation starts, and taken back out if
 * the operation fails or is cancelled, so nothing is left behind.
 */
export async function runInNewRoot<T>(
  newRoots: NewRootService | undefined,
  profileId: ProfileId,
  choice: NewRootChoice | undefined,
  parentPath: string,
  run: (parentPath: string) => Promise<Result<T>>,
  hooks: {
    /** The profile's folders changed (added, or taken back out). */
    rootsChanged: () => void;
    /** The operation succeeded into a folder that already existed, which may
     *  hold other repositories: scan it. */
    scanExisting: () => void;
  }
): Promise<Result<T>> {
  if (choice === undefined) return run(parentPath);
  if (newRoots === undefined) {
    return err({ kind: "validation", code: "root_not_allowed", message: "This build cannot create repository folders." });
  }
  const attached = await newRoots.attach(profileId, choice);
  if (!attached.ok) return attached;
  if (attached.value.added) hooks.rootsChanged();
  let result: Result<T>;
  try {
    result = await run(attached.value.path);
  } catch (cause) {
    await attached.value.undo();
    if (attached.value.added) hooks.rootsChanged();
    throw cause;
  }
  if (!result.ok) {
    await attached.value.undo();
    if (attached.value.added) hooks.rootsChanged();
  } else if (!attached.value.created && attached.value.added) {
    hooks.scanExisting();
  }
  return result;
}
