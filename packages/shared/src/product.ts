/** Canonical first-party destinations surfaced by Help and Settings → About. */
export const PWRGIT_LINKS = {
  website: "https://pwrgit.com",
  documentation: "https://docs.pwrgit.com",
  source: "https://github.com/pwrdrvr/PwrGit",
  releases: "https://github.com/pwrdrvr/PwrGit/releases",
  issues: "https://github.com/pwrdrvr/PwrGit/issues/new/choose",
  security: "https://github.com/pwrdrvr/PwrGit/security/policy"
} as const;

export type PwrGitLinkName = keyof typeof PWRGIT_LINKS;
