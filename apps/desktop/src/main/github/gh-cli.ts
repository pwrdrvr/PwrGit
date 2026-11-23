import { forgeProduct } from "@pwrgit/shared";
import {
  CliError,
  createCliClient,
  type CliRunOptions,
  type CliSpec
} from "../forge/cli-runner";
import { GitHubCredentials } from "./gh-account";

/**
 * GitHub's binding of the shared forge CLI runner.
 *
 * The hardening lives in `../forge/cli-runner`; this file is only the
 * GitHub-specific vocabulary — its binary, its token shapes, and the env vars
 * that must never leak into a diagnostic. `glab-cli.ts` is the same file with
 * GitLab's vocabulary, so the two cannot drift apart in behavior.
 */
/** Binary and product name come from `FORGE_PRODUCTS`, not from literals here:
 *  the dialogs word "${label} CLI" and "${cli} repo clone …" from the registry,
 *  and a second copy would let one product be "GitHub CLI" in an error toast
 *  and something else everywhere else. */
const GITHUB = forgeProduct("github");

export const GH_CLI_SPEC: CliSpec = {
  binary: GITHUB.cli,
  label: `${GITHUB.label} CLI`,
  errorName: "GhCliError",
  authenticationRequiredMessage: `${GITHUB.label} authentication is required. Run ${GITHUB.cli} auth login and verify your Git/SSH credentials, then try again.`,
  nonInteractiveEnv: {
    GH_PROMPT_DISABLED: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never"
  },
  sensitiveEnvNames: [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN"
  ],
  tokenPrefixes: ["github_pat_", "gho_", "ghp_", "ghu_", "ghs_", "ghr_"],
  redactionPatterns: [
    {
      pattern: /\b((?:GH|GITHUB)(?:_ENTERPRISE)?_TOKEN\s*[=:]\s*)\S+/gi,
      replacement: "$1[REDACTED]"
    },
    {
      pattern: /\b(authorization\s*:\s*(?:bearer|token)\s+)\S+/gi,
      replacement: "$1[REDACTED]"
    },
    {
      pattern: /\b(?:gh[opusr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g,
      replacement: "[REDACTED]"
    },
    {
      pattern: /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
      replacement: "$1[REDACTED]@"
    }
  ],
  authenticationHints: [/gh auth login/i]
};

const gh = createCliClient(GH_CLI_SPEC);

/**
 * The one credential store for every `gh` spawn in the app: which account
 * each host reads as, and its token. See `gh-account.ts`. Built over the
 * plain runner, so its own `gh auth token` calls are never given an injected
 * token to print back.
 */
export const githubCredentials = new GitHubCredentials({
  run: (args, options) => gh.run(args, options)
});

export type GhRunOptions = CliRunOptions;
export type GhCliErrorCode = CliError["code"];
export { CliError as GhCliError };

export function ghEnvironment(): NodeJS.ProcessEnv {
  return gh.environment();
}

/** Keep CLI diagnostics useful without allowing credentials into UI errors. */
export function sanitizeGhDiagnostic(
  diagnostic: string,
  environment: NodeJS.ProcessEnv = gh.environment()
): string {
  return gh.sanitize(diagnostic, environment);
}

export function isGhAuthenticationError(cause: unknown): boolean {
  return gh.isAuthenticationError(cause);
}

export function isGhNotFoundError(cause: unknown): boolean {
  return gh.isNotFoundError(cause);
}

export function ghErrorMessage(cause: unknown): string {
  return gh.errorMessage(cause);
}

/**
 * Run the configured GitHub CLI without exposing its credential storage.
 *
 * As the target host's pinned account, when it has one: the command's
 * environment carries that account's token (`githubCredentials.run`). A
 * pinned account that no longer resolves fails the command as an
 * authentication error rather than running it as gh's active account.
 */
export async function runGh(
  args: string[],
  options: GhRunOptions = {}
): Promise<string> {
  return githubCredentials.run(args, options);
}
