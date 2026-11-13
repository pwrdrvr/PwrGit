/**
 * Ask a forge's GraphQL for optional fields, and keep working on a server too
 * old to have them.
 *
 * GraphQL validates the whole document before it runs, so one field an older
 * self-managed server lacks (GitHub Enterprise, GitLab) fails every commit in
 * the request, not just the field. A query here is a base plus optional
 * features. When the server rejects the schema, the features whose fields or
 * types it named are dropped for that host, and the request is sent again;
 * when it names nothing we recognize, every optional feature goes at once.
 * The base query is never dropped: its rejection is thrown like any failure.
 *
 * Only a rejection made entirely of schema errors downgrades. A rate limit, a
 * refusal or a network failure is not evidence about the schema and is thrown
 * unchanged, so a transient error can never cost a host a feature.
 *
 * What was dropped is remembered in memory per host for this run; the first
 * request to an old host after launch spends one extra request per missing
 * feature at most.
 */

/** What a server's error says it lacks; empty when it named nothing. */
export type SchemaRejection = { fields: string[]; types: string[] };

/** The fields and types that would fail on a server without this feature. */
export type OptionalFeature = { fields: readonly string[]; types?: readonly string[] };

/** graphql-ruby's codes (GitHub, GitLab) for a document the schema refuses. */
const SCHEMA_CODES = new Set([
  "undefinedField",
  "undefinedType",
  "argumentNotAccepted",
  "fieldDoesNotExist"
]);
const FIELD_MESSAGE = /Field '([^']+)' doesn't (?:exist on|accept argument)[^']*'([^']+)'/;
const GRAPHQL_JS_FIELD_MESSAGE = /Cannot query field "([^"]+)" on type "([^"]+)"/;
const TYPE_MESSAGE = /No such type '?([A-Za-z_][A-Za-z0-9_]*)/;

export class GraphqlSchemaRejectedError extends Error {
  constructor(readonly rejection: SchemaRejection) {
    super("The server's GraphQL schema rejected the query");
    this.name = "GraphqlSchemaRejectedError";
  }
}

/**
 * The schema rejection a GraphQL response body carries, or undefined when it
 * carries none, or carries any error that is not about the schema.
 */
export function schemaRejectionIn(body: unknown): SchemaRejection | undefined {
  const errors = (body as { errors?: unknown } | null | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const rejection: SchemaRejection = { fields: [], types: [] };
  for (const error of errors) {
    const entry = error as {
      message?: unknown;
      extensions?: { code?: unknown; fieldName?: unknown; typeName?: unknown; name?: unknown };
    } | null;
    const message = typeof entry?.message === "string" ? entry.message : "";
    const code = typeof entry?.extensions?.code === "string" ? entry.extensions.code : undefined;
    const field = FIELD_MESSAGE.exec(message) ?? GRAPHQL_JS_FIELD_MESSAGE.exec(message);
    const type = TYPE_MESSAGE.exec(message);
    if ((code === undefined || !SCHEMA_CODES.has(code)) && field === null && type === null) {
      return undefined;
    }
    const fieldName = readName(entry?.extensions?.fieldName) ?? field?.[1];
    const typeName = readName(entry?.extensions?.typeName) ?? field?.[2] ?? type?.[1];
    if (fieldName !== undefined) rejection.fields.push(fieldName);
    if (typeName !== undefined) rejection.types.push(typeName);
  }
  return rejection;
}

/**
 * The schema rejection behind a failed request: a `GraphqlSchemaRejectedError`,
 * or a CLI failure whose captured stdout is a GraphQL body of schema errors
 * (`gh api graphql` prints the body and exits 1 on any error).
 */
export function schemaRejectionOf(cause: unknown): SchemaRejection | undefined {
  if (cause instanceof GraphqlSchemaRejectedError) return cause.rejection;
  const stdout = (cause as { stdout?: unknown } | null | undefined)?.stdout;
  if (typeof stdout !== "string" || stdout.trim() === "") return undefined;
  try {
    return schemaRejectionIn(JSON.parse(stdout));
  } catch {
    return undefined;
  }
}

/** Per-host memory of which optional features a server's schema lacks. */
export class GraphqlFeatureFallback<F extends string> {
  private readonly missing = new Map<string, Set<F>>();

  constructor(private readonly features: Readonly<Record<F, OptionalFeature>>) {}

  /** The optional features to ask this host for. */
  enabled(host: string): ReadonlySet<F> {
    const missing = this.missing.get(host.toLowerCase());
    return new Set(
      (Object.keys(this.features) as F[]).filter((feature) => missing?.has(feature) !== true)
    );
  }

  /**
   * Run `attempt` with this host's features, dropping what a schema rejection
   * names and trying again, until it succeeds or there is nothing left to drop.
   */
  async run<T>(host: string, attempt: (enabled: ReadonlySet<F>) => Promise<T>): Promise<T> {
    for (;;) {
      const enabled = this.enabled(host);
      try {
        return await attempt(enabled);
      } catch (error) {
        const rejection = schemaRejectionOf(error);
        if (rejection === undefined || enabled.size === 0) throw error;
        const named = [...enabled].filter((feature) => this.names(feature, rejection));
        this.drop(host, named.length > 0 ? named : [...enabled]);
      }
    }
  }

  private names(feature: F, rejection: SchemaRejection): boolean {
    const { fields, types = [] } = this.features[feature];
    return rejection.fields.some((field) => fields.includes(field)) ||
      rejection.types.some((type) => types.includes(type));
  }

  private drop(host: string, features: readonly F[]): void {
    const key = host.toLowerCase();
    const missing = this.missing.get(key) ?? new Set<F>();
    for (const feature of features) missing.add(feature);
    this.missing.set(key, missing);
  }
}

function readName(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
