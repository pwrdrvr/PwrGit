import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  REPO_SEARCH_DEPTH,
  REPO_SEARCH_MAX_FOLDERS,
  REPO_SEARCH_MAX_MS,
  type FoundRepository,
  type ProposedFolder,
  type ProposedFolderNote,
  type RepoSearchResult,
  type RepoSearchStop
} from "@pwrgit/shared";
import { mapLimit } from "../util/map-limit";
import { isScanSkippedDir } from "./repo-indexer";

/**
 * Find my repositories: a names-only walk of the home folder that proposes the
 * folders holding repositories. Design: `design/New User Journey - UX
 * Review.dc.html`, cards 2a, 2d and 2e.
 *
 * Filesystem only, no Git process. It lists folders and checks for `.git`; the
 * only files it reads are Git's own pointers that say which repository a
 * checkout belongs to (a `.git` file's `gitdir:` line, the `commondir` beside
 * it, and a repository's `config` when that is the only way to tell bare from
 * not). Rules:
 *
 * - Three levels below home (`REPO_SEARCH_DEPTH`), with the scan's own
 *   never-opened rule (`isScanSkippedDir`: dot folders, `node_modules`,
 *   `Library`, build output).
 * - **It stops at the first `.git` on the way down.** Nothing inside a
 *   repository is opened, so submodules, nested clones and worktrees kept
 *   inside a repository (`repo/.claude/worktrees/x`) are never reached,
 *   counted or proposed. A bare repository (`HEAD`, `objects`, `refs`) stops
 *   it the same way.
 * - The home folder's own `.git` does not stop it, and home is never proposed.
 * - A `.git` file is a linked worktree or a submodule: its pointer names the
 *   repository, and the checkout is folded into it. The counts are
 *   repositories, keyed by Git's common directory, as the scan indexes them.
 */

/** Folders the OS asks about before an app may open them. macOS only: TCC's
 *  `SystemPolicyDocumentsFolder`, `…DesktopFolder`, `…DownloadsFolder`. */
const PERSONAL_FOLDERS = ["Desktop", "Documents", "Downloads"] as const;

/**
 * Home-level folders the first pass never opens because they do not hold
 * code and some open a privacy prompt of their own (the Photos and Music
 * libraries sit in Pictures and Music on macOS; Windows keeps per-app data in
 * AppData and legacy junctions that refuse listing). "Choose folders myself…"
 * still reaches any of them.
 */
const NOT_CODE_AT_HOME: Partial<Record<NodeJS.Platform, ReadonlySet<string>>> = {
  darwin: new Set(["Applications", "Movies", "Music", "Pictures", "Public"]),
  win32: new Set([
    "AppData",
    "Application Data",
    "Contacts",
    "Cookies",
    "Favorites",
    "Links",
    "Local Settings",
    "Music",
    "My Documents",
    "NetHood",
    "Pictures",
    "PrintHood",
    "Recent",
    "Saved Games",
    "Searches",
    "SendTo",
    "Start Menu",
    "Templates",
    "Videos",
    "3D Objects"
  ]),
  linux: new Set(["Music", "Pictures", "Public", "Templates", "Videos", "snap"])
};

/** Cloud-synced folders at the top of home. Opening one may fetch folder
 *  listings from the network; nobody has measured what that costs, so the
 *  search leaves them out. (macOS's File Provider folders live in
 *  `~/Library/CloudStorage`, which the skip rule already never opens, and the
 *  `~/Dropbox`-style links to them are symlinks, which no walk follows.)
 *
 *  The clients' own spellings only: case-sensitive, and a suffix only after a
 *  space ("OneDrive - Acme", "Dropbox (Personal)"), so a code folder named
 *  `box-tools` or `mega-monorepo` is still searched. */
const CLOUD_FOLDER = /^(Dropbox|OneDrive|Google Drive|iCloud ?Drive|Box|Box Sync|pCloud Drive|MEGA)( |$)/;

const READ_CONCURRENCY = 4;
const YIELD_EVERY = 32;
const PROGRESS_EVERY_MS = 100;

export type HomeSearchOptions = {
  home: string;
  platform: NodeJS.Platform;
  /** Open Documents, Desktop and Downloads too (macOS asks first). */
  includeProtected: boolean;
  /** The user pressed Stop: finish now and answer with what was found. */
  stop?: AbortSignal;
  /** The search was superseded or its window closed: throw, answer nothing. */
  signal?: AbortSignal;
  maxFolders?: number;
  maxMs?: number;
  now?: () => number;
  yieldEvery?: number;
  yieldToEventLoop?: () => Promise<void>;
  onProgress?: (progress: { foldersOpened: number; repositoriesFound: number }) => void;
  /** Folders of profiles, to mark proposals already added or refused. */
  roots?: {
    own: readonly string[];
    others: readonly { name: string; roots: readonly string[] }[];
  };
};

/** One checkout the walk found: a folder with a `.git` entry. */
type FoundCheckout = { path: string; gitEntry: Dirent };

type ResolvedCheckout = {
  path: string;
  key: string;
  name: string;
  linked: boolean;
  indexable: boolean;
  /** Its repository is the one in the home folder itself. */
  homePart: boolean;
};

const defaultYield = (): Promise<void> =>
  new Promise((resolveYield) => setImmediate(resolveYield));

export async function searchHomeForRepositories(
  options: HomeSearchOptions
): Promise<RepoSearchResult> {
  const {
    home,
    platform,
    includeProtected,
    stop,
    signal,
    now = Date.now,
    yieldToEventLoop = defaultYield
  } = options;
  const maxFolders = options.maxFolders ?? REPO_SEARCH_MAX_FOLDERS;
  const maxMs = options.maxMs ?? REPO_SEARCH_MAX_MS;
  const yieldEvery = Math.max(1, options.yieldEvery ?? YIELD_EVERY);
  const askFirst = platform === "darwin";
  const notCode = NOT_CODE_AT_HOME[platform] ?? new Set<string>();
  const started = now();

  const found: FoundCheckout[] = [];
  const protectedSkipped: string[] = [];
  const refused: string[] = [];
  const cloudSkipped: string[] = [];
  let homeIsRepository = false;
  let foldersOpened = 0;
  let repositoriesSoFar = 0;
  let stoppedEarly: RepoSearchStop | null = null;
  let lastProgress = -Infinity;
  let lastYield = 0;

  const report = (force: boolean): void => {
    if (options.onProgress === undefined) return;
    const t = now();
    if (!force && t - lastProgress < PROGRESS_EVERY_MS) return;
    lastProgress = t;
    options.onProgress({ foldersOpened, repositoriesFound: repositoriesSoFar });
  };

  const homeEntries = await readdir(home, { withFileTypes: true });
  foldersOpened = 1;
  signal?.throwIfAborted();

  const queue: { dir: string; depth: number }[] = [];
  for (const entry of homeEntries) {
    if (entry.name === ".git") {
      // Dotfiles kept in a repository at ~ are common. Its `.git` does not
      // stop the search, and home is never proposed.
      homeIsRepository = true;
      continue;
    }
    if (!entry.isDirectory() || isScanSkippedDir(entry.name)) continue;
    if (notCode.has(entry.name)) continue;
    const dir = join(home, entry.name);
    if (CLOUD_FOLDER.test(entry.name)) {
      cloudSkipped.push(dir);
      continue;
    }
    if (askFirst && isPersonalFolder(entry.name) && !includeProtected) {
      protectedSkipped.push(dir);
      continue;
    }
    queue.push({ dir, depth: 1 });
  }

  // Breadth first: if a budget runs out, the shallow levels — where nearly
  // every repository the board measured lives — are the part already done.
  let head = 0;
  while (head < queue.length) {
    signal?.throwIfAborted();
    if (stop?.aborted === true) {
      stoppedEarly = "stopped";
      break;
    }
    if (foldersOpened >= maxFolders) {
      stoppedEarly = "folders";
      break;
    }
    if (now() - started >= maxMs) {
      stoppedEarly = "time";
      break;
    }
    const batch = queue.slice(
      head,
      head + Math.min(READ_CONCURRENCY, maxFolders - foldersOpened)
    );
    head += batch.length;
    const reads = await mapLimit(batch, READ_CONCURRENCY, async (current) => {
      try {
        return { current, entries: await readdir(current.dir, { withFileTypes: true }), code: null };
      } catch (cause) {
        return { current, entries: null, code: (cause as NodeJS.ErrnoException).code ?? null };
      }
    });
    for (const { current, entries, code } of reads) {
      if (entries === null) {
        // Only a folder macOS guards is worth telling the user about (the
        // renderer's note points at Privacy & Security); the rest (a Windows
        // junction, a folder deleted mid-walk) are not theirs to fix.
        if (
          askFirst &&
          current.depth === 1 &&
          (code === "EPERM" || code === "EACCES") &&
          isPersonalFolder(basename(current.dir))
        ) {
          refused.push(current.dir);
        }
        continue;
      }
      foldersOpened += 1;
      const git = entries.find((entry) => entry.name === ".git");
      if (git !== undefined) {
        found.push({ path: current.dir, gitEntry: git });
        if (git.isDirectory()) repositoriesSoFar += 1;
        continue;
      }
      if (isBareRepositoryListing(entries)) continue;
      if (current.depth >= REPO_SEARCH_DEPTH) continue;
      for (const entry of entries) {
        if (!entry.isDirectory() || isScanSkippedDir(entry.name)) continue;
        queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
      }
    }
    // Per batch, not per folder: most folders opened are leaves (the deepest
    // level, a checkout, a bare repository), and a per-folder check placed
    // after their `continue` froze the running count for most of the walk.
    report(false);
    if (foldersOpened - lastYield >= yieldEvery) {
      lastYield = foldersOpened;
      await yieldToEventLoop();
    }
  }
  signal?.throwIfAborted();
  report(true);

  const homeGitDir = homeIsRepository
    ? await realpath(join(home, ".git")).catch(() => null)
    : null;
  // Each checkout costs a few small reads; run them side by side, as the walk
  // reads folders, rather than one after another once the walk has ended.
  const resolved = (
    await mapLimit(found, READ_CONCURRENCY, (checkout) => resolveCheckout(checkout, homeGitDir))
  ).filter((r): r is ResolvedCheckout => r !== null);
  signal?.throwIfAborted();

  return {
    home,
    folders: proposeFolders(home, resolved, options.roots, platform),
    foldersOpened,
    stoppedEarly,
    includedProtected: includeProtected,
    protectedSkipped,
    refused,
    cloudSkipped,
    protectedAskFirst: askFirst,
    homeIsRepository
  };
}

function isPersonalFolder(name: string): boolean {
  return (PERSONAL_FOLDERS as readonly string[]).includes(name);
}

/** A bare repository's own folder: Git's `HEAD`, `objects` and `refs` side
 *  by side. The walk does not go inside one, as it does not go inside `.git`. */
function isBareRepositoryListing(entries: readonly Dirent[]): boolean {
  let head = false;
  let objects = false;
  let refs = false;
  for (const entry of entries) {
    if (entry.name === "HEAD" && entry.isFile()) head = true;
    else if (entry.name === "objects" && entry.isDirectory()) objects = true;
    else if (entry.name === "refs" && entry.isDirectory()) refs = true;
  }
  return head && objects && refs;
}

/**
 * Which repository a checkout belongs to, from Git's own pointers. Null when
 * the pointer leads nowhere: a linked worktree whose repository is gone is
 * left out of the list, as the scan leaves it out of the sidebar.
 */
async function resolveCheckout(
  checkout: FoundCheckout,
  homeGitDir: string | null
): Promise<ResolvedCheckout | null> {
  const dotGit = join(checkout.path, ".git");
  const isDir = checkout.gitEntry.isDirectory() ||
    (checkout.gitEntry.isSymbolicLink() &&
      (await stat(dotGit).then((s) => s.isDirectory(), () => false)));
  let common: string;
  let linked = false;
  if (isDir) {
    common = dotGit;
  } else {
    const pointer = await readFile(dotGit, "utf8").catch(() => null);
    const match = pointer === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
    if (match === null) return null;
    const gitDir = isAbsolute(match[1]!) ? match[1]! : resolve(checkout.path, match[1]!);
    const commonDir = await readFile(join(gitDir, "commondir"), "utf8").catch(() => null);
    linked = commonDir !== null;
    common = commonDir === null ? gitDir : resolve(gitDir, commonDir.trim());
  }
  // A pointer into a repository that is gone leads nowhere.
  const key = await realpath(common).catch(() => null);
  if (key === null) return null;

  const named = basename(key);
  const ownsWorkTree = named === ".git";
  const indexable = ownsWorkTree || !(await isBareConfig(key));
  const name = ownsWorkTree || named === ".bare"
    ? basename(dirname(key))
    : named.replace(/\.git$/, "");
  const homePart =
    homeGitDir !== null && (key === homeGitDir || key.startsWith(homeGitDir + sep));
  return { path: checkout.path, key, name, linked, indexable, homePart };
}

/** `core.bare = true` in a repository's config. Read only for a common
 *  directory not named `.git`: a bare repository, a submodule's
 *  `modules/<name>`, or a `--separate-git-dir`. */
async function isBareConfig(gitDir: string): Promise<boolean> {
  const config = await readFile(join(gitDir, "config"), "utf8").catch(() => "");
  let inCore = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inCore = /^\[core\]$/i.test(line);
      continue;
    }
    if (inCore && /^bare\s*=\s*true$/i.test(line)) return true;
  }
  return false;
}

/**
 * The folder a checkout is proposed under (card 2d): the level-1 folder under
 * home, so `~/github/acme/atlas` proposes `~/github`, which the profile scan
 * then walks five levels into. Under Documents, Desktop or Downloads it is the
 * level-2 folder: never the whole of Documents.
 */
function proposedFolderFor(home: string, checkout: string): string | null {
  const rel = relative(home, checkout);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const parts = rel.split(sep);
  if (isPersonalFolder(parts[0]!) && parts.length >= 2) {
    return join(home, parts[0]!, parts[1]!);
  }
  return join(home, parts[0]!);
}

function displayPath(home: string, path: string): string {
  const rel = relative(home, path);
  return rel === "" ? "~" : `~${sep}${rel}`;
}

function isInside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

function proposeFolders(
  home: string,
  checkouts: readonly ResolvedCheckout[],
  roots: HomeSearchOptions["roots"],
  platform: NodeJS.Platform
): ProposedFolder[] {
  // Where each repository's own checkout was found, if anywhere: the folder
  // holding its `.git` directory (or, for a submodule, its work tree).
  const primaryOf = new Map<string, string>();
  for (const c of checkouts) {
    if (!c.linked) primaryOf.set(c.key, c.path);
  }

  const byFolder = new Map<string, ResolvedCheckout[]>();
  for (const c of checkouts) {
    const folder = proposedFolderFor(home, c.path);
    if (folder === null) continue;
    const list = byFolder.get(folder) ?? [];
    list.push(c);
    byFolder.set(folder, list);
  }

  const fold = platform === "darwin" || platform === "win32";
  const cmp = (p: string): string => (fold ? p.toLowerCase() : p);
  const proposals: ProposedFolder[] = [];
  for (const [folder, list] of byFolder) {
    const repos = new Map<string, FoundRepository>();
    for (const c of list) {
      const repo = repos.get(c.key) ?? {
        key: c.key,
        name: c.name,
        checkouts: [],
        primaryFound: primaryOf.has(c.key),
        indexable: c.indexable
      };
      repo.checkouts.push(c.path);
      repos.set(c.key, repo);
    }
    const repositories = [...repos.values()].sort((a, b) => a.name.localeCompare(b.name));
    const homeKeys = new Set(list.filter((c) => c.homePart).map((c) => c.key));
    const owned = repositories.filter((r) => {
      if (!r.indexable || homeKeys.has(r.key)) return false;
      const primary = primaryOf.get(r.key);
      return primary === undefined || isInside(primary, folder);
    });
    const owners = new Set<string>();
    for (const c of list) {
      const rel = relative(folder, c.path).split(sep);
      if (rel.length >= 2) owners.add(rel[0]!);
    }

    let note: ProposedFolderNote | null = null;
    let selectable = true;
    const own = roots?.own.find((r) => isInside(cmp(folder), cmp(r)));
    const other = roots?.others
      .flatMap((p) => p.roots.map((r) => ({ name: p.name, root: r })))
      .find((o) => isInside(cmp(folder), cmp(o.root)) || isInside(cmp(o.root), cmp(folder)));
    if (own !== undefined) {
      note = { kind: "added" };
      selectable = false;
    } else if (other !== undefined) {
      note = { kind: "other-profile", profileName: other.name, otherRoot: other.root };
      selectable = false;
    } else if (repositories.every((r) => !r.indexable)) {
      note = { kind: "bare" };
      selectable = false;
    } else if (owned.length === 0 && repositories.every((r) => homeKeys.has(r.key) || !r.indexable)) {
      note = { kind: "home-repository" };
    } else if (owned.length === 0) {
      const elsewhere = new Set<string>();
      for (const r of repositories) {
        const primary = primaryOf.get(r.key);
        const at = primary === undefined ? null : proposedFolderFor(home, primary);
        if (at !== null) elsewhere.add(at);
      }
      note = { kind: "worktrees-of", repositoryFolders: [...elsewhere].sort() };
    }

    proposals.push({
      path: folder,
      display: displayPath(home, folder),
      isRepository: list.some((c) => c.path === folder),
      repositories,
      worktreeCount: list.filter((c) => c.linked).length,
      ownerFolders: list.some((c) => c.path === folder) ? 0 : owners.size,
      checked: selectable && owned.length > 0,
      selectable,
      note
    });
  }

  const rank = (f: ProposedFolder): number =>
    f.checked ? (f.isRepository ? 1 : 0) : f.selectable ? 2 : 3;
  return proposals.sort(
    (a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path)
  );
}
