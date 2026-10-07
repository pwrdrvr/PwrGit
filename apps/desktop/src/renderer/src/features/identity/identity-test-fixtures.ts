// Contrived identities for the identity suites. No real person or address.

import type { CommitIdentityInspection, RecordedCommitIdentity } from "@pwrgit/shared";

export const ROWAN = { name: "Rowan Vale", email: "rowan@vale.example" };
export const KIT = { name: "Kit Moreau", email: "kit@moreau.example" };

export function recorded(overrides: Partial<RecordedCommitIdentity> = {}): RecordedCommitIdentity {
  return {
    hash: "9c01e4a5b6c7d8e9f00112233445566778899aab",
    author: ROWAN,
    committer: ROWAN,
    coAuthors: [],
    signed: false,
    ...overrides
  };
}

export function inspection(overrides: Partial<CommitIdentityInspection> = {}): CommitIdentityInspection {
  return {
    worktreeId: "wt-1",
    profile: { name: "Personal", email: ROWAN.email, authorName: ROWAN.name },
    pwrgit: {
      ok: true,
      author: ROWAN,
      committer: ROWAN,
      nameSource: "profile",
      emailSource: "profile"
    },
    outside: { kind: "missing", message: "no email was given and auto-detection is disabled" },
    config: [],
    env: [],
    recent: [recorded()],
    signing: { enabled: false },
    ...overrides
  };
}
