import type {
  FolderIdentityReport,
  FolderProfileIdentity,
  FolderRepoIdentity,
  OutsideGitIdentity,
  RootOverlap
} from "@pwrgit/shared";
import { pathLeaf } from "../../lib/platform";

// What the profile popup's "Git outside PwrGit" row and Settings › Profiles ›
// By folder say about one profile's repositories. design/Git Identity by
// Folder, turns 2 and 3.

export type FolderTone = "ok" | "warn" | "neutral";

export type FolderRowView = { tone: FolderTone; text: string };

function repos(count: number): string {
  return `${count} repo${count === 1 ? "" : "s"}`;
}

/** "All 3 repos commit" / "Its 1 repo commits". */
function allCommit(count: number): string {
  return count === 1 ? "Its 1 repo commits" : `All ${count} repos commit`;
}

/** The repo commits with the profile's email; only the author name differs. */
function emailMatches(repo: FolderRepoIdentity, profile: FolderProfileIdentity): boolean {
  return repo.email !== null && repo.email.toLowerCase() === profile.email.trim().toLowerCase();
}

/** The one email every repo in `list` uses, or null when they disagree. */
function sharedEmail(list: readonly FolderRepoIdentity[]): string | null {
  const first = list[0]?.email ?? null;
  if (first === null) return null;
  return list.every((repo) => repo.email?.toLowerCase() === first.toLowerCase()) ? first : null;
}

export function overlapText(overlap: RootOverlap): string {
  const root = pathLeaf(overlap.root);
  switch (overlap.relation) {
    case "same":
      return `${root} is also a folder of “${overlap.profileName}”`;
    case "inside":
      return `${root} is inside “${overlap.profileName}”’s ${pathLeaf(overlap.otherRoot)}`;
    case "contains":
      return `${root} holds “${overlap.profileName}”’s ${pathLeaf(overlap.otherRoot)}`;
  }
}

function machineRow(machine: OutsideGitIdentity): FolderRowView {
  if (machine.kind === "configured") {
    return { tone: "neutral", text: `${machine.author.email} · Git’s global identity` };
  }
  if (machine.kind === "guessed") {
    return { tone: "warn", text: `Git is guessing ${machine.author.email}` };
  }
  return { tone: "warn", text: "No identity — commits fail or use a guessed address" };
}

/**
 * The popup row for one profile. Priority: a shared folder (the repo list
 * itself can't be trusted), no identity, repos that differ, in step.
 */
export function folderRowView(
  profile: FolderProfileIdentity,
  machine: OutsideGitIdentity
): FolderRowView {
  const overlap = profile.overlaps[0];
  if (overlap !== undefined) return { tone: "warn", text: overlapText(overlap) };
  if (profile.email.trim() === "") {
    return machine.kind === "configured"
      ? { tone: "neutral", text: `Follows Git’s own identity · ${machine.author.email}` }
      : machineRow(machine);
  }
  const list = profile.repos;
  if (list.length === 0) return machineRow(machine);
  if (list.every((repo) => repo.source === "none")) {
    return { tone: "warn", text: "No identity here — commits fail or use a guessed address" };
  }
  const differ = list.filter((repo) => !repo.matches);
  if (differ.length === 0) {
    return {
      tone: "ok",
      text: list.length === 1 ? `${profile.email} in its 1 repo` : `${profile.email} in all ${repos(list.length)}`
    };
  }
  // A profile that sets an author name differs on the name alone too; saying
  // "commits as <its own email>" would read as a contradiction.
  if (differ.every((repo) => emailMatches(repo, profile))) {
    return {
      tone: "warn",
      text:
        differ.length === list.length
          ? `Another author name in ${list.length === 1 ? "its 1 repo" : `all ${repos(list.length)}`}`
          : `${differ.length} of ${repos(list.length)} use${differ.length === 1 ? "s" : ""} another author name`
    };
  }
  if (differ.length === list.length) {
    const email = sharedEmail(list);
    return {
      tone: "warn",
      text:
        email !== null
          ? `Commits as ${email} in ${list.length === 1 ? "its 1 repo" : `all ${repos(list.length)}`}`
          : `${repos(list.length)} commit as other emails`
    };
  }
  return {
    tone: "warn",
    text: `${differ.length} of ${repos(list.length)} commit${differ.length === 1 ? "s" : ""} as another email`
  };
}

/** How many things on the card want a decision: shared folders and repos
 *  that disagree with their profile. A profile with no email has nothing to
 *  disagree with. */
function attention(report: FolderIdentityReport): { differ: number; overlaps: number } {
  let differ = 0;
  let overlaps = 0;
  for (const profile of report.profiles) {
    if (profile.overlaps.length > 0) overlaps += 1;
    if (profile.email.trim() === "") continue;
    differ += profile.repos.filter((repo) => !repo.matches).length;
  }
  return { differ, overlaps };
}

export function folderCardChip(report: FolderIdentityReport | null): {
  label: string;
  kind: "default" | "ok" | "warn";
} {
  if (report === null) return { label: "Checking", kind: "default" };
  const { differ, overlaps } = attention(report);
  const count = differ + overlaps;
  if (count === 0) return report.enabled ? { label: "In step", kind: "ok" } : { label: "Off", kind: "default" };
  if (report.enabled || overlaps > 0) return { label: `${count} need${count === 1 ? "s" : ""} attention`, kind: "warn" };
  return { label: `${repos(differ)} differ${differ === 1 ? "s" : ""}`, kind: "warn" };
}

/** The nav row's warn dot follows the chip. */
export function folderNeedsAttention(report: FolderIdentityReport | null): boolean {
  return folderCardChip(report).kind === "warn";
}

/** Where a repo's email came from, in a few words. */
export function sourceLabel(repo: FolderRepoIdentity): string {
  switch (repo.source) {
    case "pwrgit":
      return "from PwrGit’s include";
    case "pwrgit-other":
      return "from another profile’s include";
    case "local":
      return "set in this repo’s .git/config";
    case "global":
      return `from ${repo.origin ?? "the global config"}`;
    case "include":
      return `from ${repo.origin ?? "an include"}`;
    case "system":
      return "from the system config";
    case "none":
      return "Git would guess or refuse";
  }
}

/** The tally line under a profile in Settings. */
export function folderTally(profile: FolderProfileIdentity): FolderRowView {
  if (profile.email.trim() === "") {
    return { tone: "neutral", text: "No commit email · follows Git’s own identity, gets no include" };
  }
  if (profile.roots.length === 0) return { tone: "neutral", text: "No repo folders · gets no include" };
  const list = profile.repos;
  if (list.length === 0) return { tone: "neutral", text: "No repositories indexed under these folders yet" };
  const differ = list.filter((repo) => !repo.matches);
  const from = (sample: FolderRepoIdentity | undefined): string =>
    sample !== undefined && sample.source !== "pwrgit" && list.every((repo) => repo.source === sample.source && repo.origin === sample.origin)
      ? ` · ${sourceLabel(sample)}`
      : "";
  if (differ.length === 0) {
    return { tone: "ok", text: `${allCommit(list.length)} as ${profile.email}${from(list[0])}` };
  }
  if (differ.length === list.length && differ.every((repo) => emailMatches(repo, profile))) {
    return { tone: "warn", text: `${allCommit(list.length)} as ${profile.email} with another author name${from(list[0])}` };
  }
  if (differ.length === list.length) {
    const email = sharedEmail(list);
    if (email === null && list.every((repo) => repo.source === "none")) {
      return { tone: "warn", text: `No email configured for ${list.length === 1 ? "its repo" : `these ${repos(list.length)}`}` };
    }
    // A repo that pins its own email stays wrong after the switch, so say so
    // even when its email happens to be the one every other repo uses.
    const pinned = list.filter((repo) => repo.source === "local").length;
    const own = pinned > 0 && pinned < list.length ? ` · ${pinned === 1 ? "1 sets its own email" : `${pinned} set their own email`}` : "";
    return {
      tone: "warn",
      text:
        email !== null
          ? `${allCommit(list.length)} as ${email}${from(list[0])}${own}`
          : `${repos(list.length)} commit as other emails${own}`
    };
  }
  const local = differ.filter((repo) => repo.source === "local").length;
  return {
    tone: "warn",
    text: `${list.length - differ.length} of ${repos(list.length)} match · ${
      local === differ.length
        ? local === 1
          ? "1 sets its own email"
          : `${local} set their own email`
        : `${differ.length} differ${differ.length === 1 ? "s" : ""}`
    }`
  };
}

/**
 * The repos worth listing one by one. With the switch on, every one that
 * disagrees. With it off, only those that would still disagree after
 * turning it on — a repo that merely follows the global identity is the
 * switch's job, and the tally already says so.
 */
export function differingRepos(profile: FolderProfileIdentity, enabled: boolean): FolderRepoIdentity[] {
  if (profile.email.trim() === "") return [];
  return profile.repos.filter(
    (repo) => !repo.matches && (enabled || repo.source === "local" || repo.source === "pwrgit-other")
  );
}
