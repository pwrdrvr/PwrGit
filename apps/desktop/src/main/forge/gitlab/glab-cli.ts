import {
  createCliClient,
  type CliRunOptions,
  type CliSpec
} from "../cli-runner";

/**
 * GitLab's binding of the shared forge CLI runner — the mirror of
 * `github/gh-cli.ts`, differing only in vocabulary.
 *
 * `glab` has no `auth token` subcommand the way `gh` does; the bare token comes
 * from `config get token --host <host>`, which is why `getGitLabToken` below
 * exists rather than a one-line alias.
 */
export const GLAB_CLI_SPEC: CliSpec = {
  binary: "glab",
  label: "GitLab CLI",
  errorName: "GlabCliError",
  authenticationRequiredMessage:
    "GitLab authentication is required. Run glab auth login and verify your Git/SSH credentials, then try again.",
  nonInteractiveEnv: {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    // Every invocation would otherwise consider a release check on the network.
    GLAB_CHECK_UPDATE: "0",
    GLAB_SEND_SURVEY: "0"
  },
  sensitiveEnvNames: [
    "GITLAB_TOKEN",
    "GITLAB_ACCESS_TOKEN",
    "GLAB_TOKEN",
    "OAUTH_TOKEN",
    "CI_JOB_TOKEN"
  ],
  // GitLab's routable token prefixes. A keyring OAuth token is bare hex with no
  // prefix, so it cannot be pattern-matched without redacting ordinary SHAs —
  // it is protected by never becoming diagnostic data, exactly as `gh`'s is.
  tokenPrefixes: [
    "glpat-",
    "gloas-",
    "glrt-",
    "gldt-",
    "glft-",
    "glimt-",
    "glptt-",
    "glsoat-",
    "glcbt-"
  ],
  redactionPatterns: [
    {
      pattern:
        /\b((?:GITLAB|GLAB)(?:_ACCESS)?_TOKEN|OAUTH_TOKEN|CI_JOB_TOKEN)(\s*[=:]\s*)\S+/gi,
      replacement: "$1$2[REDACTED]"
    },
    {
      pattern:
        /\b((?:authorization|private-token|job-token)\s*:\s*(?:bearer\s+|token\s+)?)\S+/gi,
      replacement: "$1[REDACTED]"
    },
    {
      pattern:
        /\bgl(?:pat|oas|rt|dt|ft|imt|ptt|soat|cbt)-[A-Za-z0-9_-]{8,}\b/g,
      replacement: "[REDACTED]"
    },
    {
      pattern: /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
      replacement: "$1[REDACTED]@"
    }
  ],
  authenticationHints: [/glab auth login/i, /401 unauthorized/i]
};

const glab = createCliClient(GLAB_CLI_SPEC);

export type GlabRunOptions = CliRunOptions;

export function glabEnvironment(): NodeJS.ProcessEnv {
  return glab.environment();
}

export function sanitizeGlabDiagnostic(
  diagnostic: string,
  environment: NodeJS.ProcessEnv = glab.environment()
): string {
  return glab.sanitize(diagnostic, environment);
}

export function isGlabAuthenticationError(cause: unknown): boolean {
  return glab.isAuthenticationError(cause);
}

export function isGlabNotFoundError(cause: unknown): boolean {
  return glab.isNotFoundError(cause);
}

export function glabErrorMessage(cause: unknown): string {
  return glab.errorMessage(cause);
}

/** Run the configured GitLab CLI without exposing its credential storage. */
export async function runGlab(
  args: string[],
  options: GlabRunOptions = {}
): Promise<string> {
  return glab.run(args, options);
}

const TOKEN_TTL_MS = 5 * 60_000;
const tokenCache = new Map<string, { token: string; at: number }>();

/** Only reset by tests; the cache is otherwise per-host and time-bounded. */
export function clearGitLabTokenCache(): void {
  tokenCache.clear();
}

/**
 * `GITLAB_TOKEN` if set, else the token `glab` already holds for this host.
 *
 * Cached per host because a self-managed instance and gitlab.com are different
 * credentials. Returns null rather than throwing, so an unauthenticated user
 * simply gets no PR status instead of an error surface.
 */
export async function getGitLabToken(host: string): Promise<string | null> {
  const key = host.trim().toLowerCase();
  const cached = tokenCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < TOKEN_TTL_MS) {
    return cached.token;
  }
  const fromEnv = process.env.GITLAB_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    tokenCache.set(key, { token: fromEnv, at: Date.now() });
    return fromEnv;
  }
  try {
    const token = (await runGlab(["config", "get", "token", "--host", key])).trim();
    // `config get` prints an empty line rather than failing for an unset key.
    if (token !== "") {
      tokenCache.set(key, { token, at: Date.now() });
      return token;
    }
  } catch {
    // glab missing or not logged in for this host.
  }
  return null;
}
