import { canonicalForgeHostname, forgeProduct } from "@pwrgit/shared";

/**
 * The environment-token rule, alone in a module with no Node imports: Settings
 * rows (`ForgeHosts`) ask it too, and the forge-settings harness bundles
 * `ForgeHosts` for a browser. The credential store is `gh-account.ts`.
 */

export const GITHUB_DOT_COM = forgeProduct("github").saasHost;

function canonical(host: string | undefined): string {
  return host === undefined ? "" : (canonicalForgeHostname(host) ?? "");
}

/**
 * The environment token a host reads with, when one applies.
 *
 * `GITHUB_TOKEN` (and `GH_TOKEN`, which `gh` ranks above it) apply to
 * **github.com only** — a github.com PAT must never reach a self-managed
 * server. `""` is `gh`'s own default host, which `GITHUB_TOKEN` has always
 * applied to (see `getGitHubToken`). A GHE.com tenancy (`*.ghe.com`) takes
 * `GH_TOKEN` as `gh` does, never an Enterprise Server token. An Enterprise
 * token applies only to the host `GH_HOST` names: `gh` would hand it to ANY
 * Enterprise host, and a remote URL is not a reason to send a credential
 * somewhere.
 *
 * Read from the user's environment, never from a spawn's overrides: a
 * provider sets `GH_HOST` to TARGET a host, and that must not promote the
 * user's Enterprise token to it.
 */
export function githubEnvToken(
  host: string | undefined,
  env: NodeJS.ProcessEnv
): { name: string; value: string } | null {
  const key = host === undefined ? "" : host.trim().toLowerCase();
  const names =
    key === ""
      ? ["GITHUB_TOKEN"]
      : key === GITHUB_DOT_COM
        ? ["GH_TOKEN", "GITHUB_TOKEN"]
        : // A GHE.com tenancy takes `GH_TOKEN`, as github.com does, and never
          // an Enterprise Server token. `GITHUB_TOKEN` stays github.com's.
          key.endsWith(".ghe.com")
          ? ["GH_TOKEN"]
          : canonical(env["GH_HOST"]) === canonical(key) && canonical(key) !== ""
            ? ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
            : [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { name, value };
  }
  return null;
}
