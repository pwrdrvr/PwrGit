// What the commit footer, its details popover and the launch notice say about
// commit identity, as pure functions of main's answers. Kept apart from the
// components so the wording of every state is tested without a DOM.

import {
  formatGitPerson,
  noreplyForge,
  samePerson,
  type CommitIdentityInspection,
  type CommitSigning,
  type IdentityConfigEntry,
  type OutsideGitIdentity,
  type RecordedCommitIdentity
} from "@pwrgit/shared";

/**
 * The footer line under Commit / Amend.
 *
 * `quiet` means Git will record exactly what it shows. `blocked` is the one
 * state that disables Commit, because Git itself would refuse.
 */
export type FooterView =
  | { kind: "quiet"; line: string }
  | { kind: "split"; author: string; committer: string }
  | { kind: "blocked"; message: string; action: string };

/** The footer before an inspection has answered: the profile's stored email,
 *  which is what it always showed. */
export function provisionalFooter(email: string): FooterView {
  return { kind: "quiet", line: `as ${email !== "" ? email : "—"}` };
}

export function footerView(inspection: CommitIdentityInspection): FooterView {
  const { pwrgit, profile } = inspection;
  if (!pwrgit.ok) {
    if (pwrgit.problem === "no_name") {
      return {
        kind: "blocked",
        message: "Git has no name to record for this commit.",
        action: `Add an author name to ${profile.name}…`
      };
    }
    if (pwrgit.problem === "no_email") {
      return {
        kind: "blocked",
        message: "Git has no email to record for this commit.",
        action: `Add a commit email to ${profile.name}…`
      };
    }
    return {
      kind: "blocked",
      message: `Git can’t resolve who this commit is by: ${pwrgit.message}`,
      action: "Open Profiles settings…"
    };
  }
  if (!samePerson(pwrgit.author, pwrgit.committer)) {
    return {
      kind: "split",
      author: formatGitPerson(pwrgit.author),
      committer: formatGitPerson(pwrgit.committer)
    };
  }
  return { kind: "quiet", line: `as ${formatGitPerson(pwrgit.author)}` };
}

/**
 * What Amend will record, shown while Amend is hovered or focused. Amend keeps
 * HEAD's author (PwrGit never passes `--reset-author`), so the line names that
 * person, and the committer only when it is someone else.
 */
export function amendPreview(
  inspection: CommitIdentityInspection
): { author: string; committer: string | null } | null {
  const head = inspection.recent[0];
  if (head === undefined || !inspection.pwrgit.ok) return null;
  const committer = inspection.pwrgit.committer;
  return {
    author: formatGitPerson(head.author),
    committer: samePerson(head.author, committer) ? null : formatGitPerson(committer)
  };
}

/** Where PwrGit's recorded name and email come from, for the popover. */
export function pwrgitSourceLine(inspection: CommitIdentityInspection): string {
  const { pwrgit, profile, config } = inspection;
  if (!pwrgit.ok) return "";
  const profileLabel = `your ${profile.name} profile`;
  if (pwrgit.nameSource === "profile" && pwrgit.emailSource === "profile") {
    return `From ${profileLabel}`;
  }
  const parts: string[] = [];
  if (pwrgit.nameSource === "git") {
    parts.push(`name from Git’s user.name${originSuffix(lastEntry(config, "user.name"))}`);
  }
  if (pwrgit.emailSource === "git") {
    parts.push(`email from Git’s user.email${originSuffix(lastEntry(config, "user.email"))}`);
  }
  const fromProfile =
    pwrgit.nameSource === "profile" ? "name" : pwrgit.emailSource === "profile" ? "email" : null;
  return `${capitalize(parts.join(", "))}${fromProfile === null ? "" : `; ${fromProfile} from ${profileLabel}`}`;
}

export function signingLine(signing: CommitSigning): string {
  if (!signing.enabled) return "Not signed (commit.gpgsign is off)";
  return `Signed with ${signingKeyLabel(signing)}`;
}

function signingKeyLabel(signing: Extract<CommitSigning, { enabled: true }>): string {
  const format = signing.format === "ssh" ? "SSH" : signing.format === "x509" ? "X.509" : "GPG";
  return signing.key === null ? `Git’s default ${format} key` : `${format} key ${signing.key}`;
}

/** Git outside PwrGit, as the popover and Settings describe it. */
export type OutsideView = {
  status: "configured" | "guessed" | "missing";
  rows: Array<{ label: string; value: string }>;
  /** What that means for a Terminal or agent commit; null when nothing is
   *  wrong. */
  consequence: string | null;
};

export function outsideView(outside: OutsideGitIdentity, where: "checkout" | "machine"): OutsideView {
  const here = where === "checkout" ? " here" : " on this computer";
  if (outside.kind === "configured") {
    const rows = [
      { label: "Name", value: outside.author.name },
      { label: "Email", value: outside.author.email }
    ];
    if (!samePerson(outside.author, outside.committer)) {
      rows.push({ label: "Committer", value: formatGitPerson(outside.committer) });
    }
    return { status: "configured", rows, consequence: null };
  }
  if (outside.kind === "guessed") {
    return {
      status: "guessed",
      rows: [
        { label: "Name", value: outside.author.name },
        { label: "Email", value: `${outside.author.email} (guessed)` }
      ],
      consequence: `Terminal and agent commits${here} record ${outside.author.email}, an address Git built from this computer’s name that no forge can link to you.`
    };
  }
  return {
    status: "missing",
    rows: [
      { label: "Name", value: "Not configured" },
      { label: "Email", value: "Not configured" }
    ],
    consequence: `Terminal and agent commits${here} fail with “Author identity unknown”, unless the command supplies its own identity.`
  };
}

/** The tags a recent commit carries in the popover. A noreply address is a
 *  valid, private choice: it is labelled, never flagged. */
export function commitTags(
  commit: RecordedCommitIdentity,
  profileEmail: string
): string[] {
  const tags: string[] = [];
  const forge = noreplyForge(commit.author.email);
  if (forge !== null) tags.push(`${forge} noreply`);
  if (profileEmail !== "" && commit.author.email.toLowerCase() !== profileEmail.toLowerCase()) {
    tags.push("differs from profile");
  }
  if (!samePerson(commit.author, commit.committer)) {
    tags.push(`committed by ${commit.committer.email}`);
  }
  if (commit.coAuthors.length > 0) {
    tags.push(`+${commit.coAuthors.length} co-author${commit.coAuthors.length === 1 ? "" : "s"}`);
  }
  if (commit.signed) tags.push("Signed");
  return tags;
}

export function scopeLabel(entry: IdentityConfigEntry): string {
  return entry.scope === "unknown" ? "—" : entry.scope;
}

/** The plain-text report behind "Copy diagnostics": pasted into an issue, it
 *  has to say everything the popover shows, including where each value came
 *  from. */
export function identityDiagnostics(inspection: CommitIdentityInspection): string {
  const lines: string[] = ["PwrGit commit identity"];
  const { pwrgit } = inspection;
  lines.push(
    pwrgit.ok
      ? `PwrGit records: author ${formatGitPerson(pwrgit.author)}; committer ${formatGitPerson(pwrgit.committer)} (name: ${pwrgit.nameSource}, email: ${pwrgit.emailSource})`
      : `PwrGit records: blocked (${pwrgit.problem}): ${pwrgit.message}`
  );
  const outside = inspection.outside;
  lines.push(
    outside.kind === "configured"
      ? `Git outside PwrGit: ${formatGitPerson(outside.author)}`
      : outside.kind === "guessed"
        ? `Git outside PwrGit: guessed ${formatGitPerson(outside.author)}`
        : `Git outside PwrGit: not configured (${outside.message})`
  );
  lines.push(`Signing: ${signingLine(inspection.signing)}`);
  for (const entry of inspection.config) {
    lines.push(`config ${entry.key}=${entry.value} [${entry.scope}] ${entry.origin}`);
  }
  for (const env of inspection.env) lines.push(`env ${env.variable}=${env.value}`);
  for (const commit of inspection.recent) {
    const tags = commitTags(commit, inspection.profile.email);
    lines.push(
      `${commit.hash.slice(0, 7)} ${formatGitPerson(commit.author)}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`
    );
  }
  return lines.join("\n");
}

function lastEntry(config: readonly IdentityConfigEntry[], key: string): IdentityConfigEntry | undefined {
  for (let i = config.length - 1; i >= 0; i -= 1) {
    if (config[i]?.key === key) return config[i];
  }
  return undefined;
}

function originSuffix(entry: IdentityConfigEntry | undefined): string {
  return entry === undefined || entry.origin === "" ? "" : ` in ${entry.origin}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What the rebase assistant's Apply will write, said before it runs: every
 *  rewritten commit keeps its author and gets the profile as committer. */
export function rebaseIdentityLine(inspection: CommitIdentityInspection): string {
  const { pwrgit, signing } = inspection;
  if (!pwrgit.ok) return `Apply can’t run until Git can resolve a committer: ${pwrgit.message}`;
  const committer = formatGitPerson(pwrgit.committer);
  if (!signing.enabled) return `Apply keeps each commit’s author and records ${committer} as committer, unsigned.`;
  return `Apply keeps each commit’s author and records ${committer} as committer, signed with ${signingKeyLabel(signing)}.`;
}
