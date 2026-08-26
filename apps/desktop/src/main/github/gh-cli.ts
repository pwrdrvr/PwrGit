import {
  CliError,
  createCliClient,
  type CliRunOptions,
  type CliSpec
} from "../forge/cli-runner";

/**
 * GitHub's binding of the shared forge CLI runner.
 *
 * The hardening lives in `../forge/cli-runner`; this file is only the
 * GitHub-specific vocabulary — its binary, its token shapes, and the env vars
 * that must never leak into a diagnostic. `glab-cli.ts` is the same file with
 * GitLab's vocabulary, so the two cannot drift apart in behavior.
 */
export const GH_CLI_SPEC: CliSpec = {
  binary: "gh",
  label: "GitHub CLI",
  errorName: "GhCliError",
  authenticationRequiredMessage:
    "GitHub authentication is required. Run gh auth login and verify your Git/SSH credentials, then try again.",
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

/** Run the configured GitHub CLI without exposing its credential storage. */
export async function runGh(
  args: string[],
  options: GhRunOptions = {}
): Promise<string> {
  return gh.run(args, options);
}
