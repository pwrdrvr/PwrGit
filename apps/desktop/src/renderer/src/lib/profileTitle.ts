import type { Profile } from "@pwrgit/shared";

/**
 * Window title for a profile-bound window. When two profiles share a name
 * (e.g. both seeded from the same git identity), the email disambiguates —
 * otherwise the macOS Window menu lists identical twins and you can't tell
 * which window is which.
 */
export function profileWindowTitle(
  profiles: Profile[],
  active: Profile | null
): string {
  if (active === null) return "PwrGit";
  const nameShared = profiles.some(
    (p) => p.id !== active.id && p.name === active.name
  );
  return nameShared && active.email !== ""
    ? `PwrGit — ${active.name} (${active.email})`
    : `PwrGit — ${active.name}`;
}
