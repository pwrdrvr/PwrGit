import type {
  ContributionIdentity,
  ContributionRepo,
  ContributionRecord,
  ContributionEvent,
  ContributionBlockedOrganization
} from "@pwrgit/shared";
import { runGh, GhCliError } from "../../github/gh-cli";
import { forgeRetryDelayMs } from "../retry";
import { delay } from "../../util/timing";

type Page<T> = {
  nodes: T[];
  cursor: string | null;
  more: boolean;
  totalCount?: number;
  skipped?: number;
  blockedOrganizations?: ContributionBlockedOrganization[];
};
export interface ContributionProvider {
  verify(signal: AbortSignal): Promise<ContributionIdentity>;
  repositories(
    identity: ContributionIdentity,
    cursor: string | null,
    signal: AbortSignal
  ): Promise<Page<ContributionRepo>>;
  organizations(
    identity: ContributionIdentity,
    cursor: string | null,
    signal: AbortSignal
  ): Promise<Page<string>>;
  pulls(
    identity: ContributionIdentity,
    repo: ContributionRepo,
    cursor: string | null,
    signal: AbortSignal
  ): Promise<Page<ContributionRecord> & { oldestUpdatedAt: string | null }>;
  authored(
    identity: ContributionIdentity,
    cursor: string | null,
    signal: AbortSignal
  ): Promise<Page<ContributionRecord>>;
  timelines(
    identity: ContributionIdentity,
    records: ContributionRecord[],
    signal: AbortSignal
  ): Promise<
    {
      id: string;
      events: ContributionEvent[];
      cursor: string | null;
      more: boolean;
      filteredCount: number;
    }[]
  >;
}
const VIEWER = "viewer { id login } rateLimit { remaining resetAt }";
const REPO_FIELDS =
  "id nameWithOwner visibility isArchived isFork owner { id login __typename }";
const PULL_FIELDS = `id number createdAt closedAt state mergedAt updatedAt
  mergedBy { ... on Node { id } login }
  author { ... on Node { id } login }`;
export const CONTRIBUTION_AUTHORED_QUERY = `query($cursor:String) {
  viewer { id login pullRequests(first:100, after:$cursor,
    states:[OPEN,CLOSED,MERGED],
    orderBy:{field:CREATED_AT,direction:DESC}) {
      totalCount
      nodes { ${PULL_FIELDS} repository { ${REPO_FIELDS} } }
      pageInfo { hasNextPage endCursor }
  } } rateLimit { remaining resetAt }
}`;
// Both filters are explicit: ownerAffiliations otherwise defaults to OWNER.
export const CONTRIBUTION_REPOS_QUERY = `query($cursor:String) {
  viewer { id login repositories(first:100, after:$cursor,
    affiliations:[OWNER,ORGANIZATION_MEMBER,COLLABORATOR],
    ownerAffiliations:[OWNER,ORGANIZATION_MEMBER,COLLABORATOR],
    orderBy:{field:NAME,direction:ASC}) {
      totalCount nodes { ${REPO_FIELDS} }
      pageInfo { hasNextPage endCursor }
  } } rateLimit { remaining resetAt }
}`;
export const CONTRIBUTION_PULLS_QUERY = `query($id:ID!,$cursor:String) {
  ${VIEWER} node(id:$id) { ... on Repository { id pullRequests(first:100,after:$cursor,
    states:MERGED,orderBy:{field:UPDATED_AT,direction:DESC}) {
      nodes { ${PULL_FIELDS} }
      pageInfo { hasNextPage endCursor }
  } } }
}`;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("GitHub returned incomplete analytics metadata.");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value)
    throw new Error("GitHub returned incomplete analytics metadata.");
  return value;
}
function timestamp(value: unknown): string {
  const text = string(value);
  if (!Number.isFinite(Date.parse(text)))
    throw new Error("GitHub returned an invalid analytics timestamp.");
  return text;
}
function actorId(value: unknown): string | null {
  if (value === null) return null;
  const actor = object(value);
  // Actor can be a bot or a deleted account; do not infer identity from author.
  return typeof actor.id === "string" ? actor.id : null;
}
function repository(value: unknown): ContributionRepo {
  const repo = object(value),
    owner = object(repo.owner);
  if (owner.__typename !== "Organization" && owner.__typename !== "User")
    throw new Error("GitHub returned an unknown repository namespace.");
  if (typeof repo.isArchived !== "boolean" || typeof repo.isFork !== "boolean")
    throw new Error("GitHub returned incomplete repository metadata.");
  return {
    id: string(repo.id),
    path: string(repo.nameWithOwner),
    owner: string(owner.login),
    ownerId: string(owner.id),
    ownerKind: owner.__typename === "Organization" ? "organization" : "user",
    archived: repo.isArchived,
    fork: repo.isFork,
    visibility: string(repo.visibility)
  };
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("GitHub did not report analytics page coverage.");
  return value;
}
function pullRecord(
  value: unknown,
  repo: ContributionRepo,
  identity: ContributionIdentity
): ContributionRecord {
  const pull = object(value),
    updatedAt = timestamp(pull.updatedAt),
    createdAt = timestamp(pull.createdAt);
  if (
    typeof pull.number !== "number" ||
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1
  )
    throw new Error("GitHub returned an invalid pull request number.");
  if (
    pull.state !== "OPEN" &&
    pull.state !== "CLOSED" &&
    pull.state !== "MERGED"
  )
    throw new Error("GitHub returned an unknown PR state.");
  const author = actorId(pull.author);
  const record: ContributionRecord = {
    id: string(pull.id),
    repo,
    number: pull.number,
    mergedAt: pull.mergedAt === null ? null : timestamp(pull.mergedAt),
    mergedBy: actorId(pull.mergedBy),
    author
  };
  if (author === identity.id)
    record.lifecycle = {
      createdAt,
      updatedAt,
      closedAt: pull.closedAt === null ? null : timestamp(pull.closedAt),
      state: pull.state,
      events: [],
      complete: false,
      cursor: null
    };
  return record;
}
function page<T>(
  value: unknown,
  parse: (value: unknown) => T,
  skipped: number[] = []
): Page<T> {
  const connection = object(value),
    info = object(connection.pageInfo);
  if (!Array.isArray(connection.nodes) || typeof info.hasNextPage !== "boolean")
    throw new Error("GitHub returned an incomplete analytics page.");
  const cursor = info.endCursor === null ? null : string(info.endCursor);
  if (info.hasNextPage && (!cursor || !connection.nodes.length))
    throw new Error("GitHub returned a stalled analytics page.");
  return {
    nodes: connection.nodes.flatMap((node, index) =>
      skipped.includes(index) ? [] : [parse(node)]
    ),
    cursor,
    more: info.hasNextPage
  };
}
export class ContributionRateLimitError extends Error {
  constructor(readonly retryAt: string) {
    super("GitHub rate budget is low. Resume after the displayed reset time.");
  }
}
export class ContributionSsoError extends Error {
  constructor(readonly organizations: ContributionBlockedOrganization[] = []) {
    super(
      "GitHub requires SAML SSO authorization for an organization in this collection. Sign in through the organization's SSO and reauthorize GitHub CLI, then resume collection."
    );
  }
}
function isSsoRefusal(error: Record<string, unknown>): boolean {
  return (
    error.type === "FORBIDDEN" &&
    ((typeof error.extensions === "object" &&
      error.extensions !== null &&
      (error.extensions as Record<string, unknown>).saml_failure === true) ||
      (typeof error.message === "string" &&
        /\bSAML\b|\bSSO\b|single.sign.on/i.test(error.message)))
  );
}
type QueryResult = {
  data: Record<string, unknown>;
  skipped: number[];
  blockedOrganizations: ContributionBlockedOrganization[];
};
/** Classify structured failures without exposing GitHub's private error messages. */
function graphqlFailure(response: Record<string, unknown>): Error | null {
  if (response.errors === undefined) return null;
  const errors: Record<string, unknown>[] = Array.isArray(response.errors)
    ? response.errors.filter(
        (error): error is Record<string, unknown> =>
          error !== null && typeof error === "object" && !Array.isArray(error)
      )
    : [];
  if (
    errors.length &&
    Array.isArray(response.errors) &&
    errors.length === response.errors.length &&
    errors.every(isSsoRefusal)
  )
    return new ContributionSsoError();
  if (errors.some((error) => error.type === "FORBIDDEN"))
    return new Error(
      "GitHub denied access to analytics metadata. Check organization access policies and repository permissions for GitHub CLI, then resume collection."
    );
  return new Error(
    "GitHub refused analytics metadata; partial data was retained. Check access and rate limits."
  );
}
/** Same audited CLI/auth/host transport as other GitHub reads; never extracts a token. */
export class GitHubContributionProvider implements ContributionProvider {
  private ssoOrganizations = new Map<
    string,
    ContributionBlockedOrganization[]
  >();
  private async identifySsoOrganizations(
    identity: ContributionIdentity,
    signal: AbortSignal
  ): Promise<ContributionBlockedOrganization[]> {
    const cached = this.ssoOrganizations.get(identity.id);
    if (cached) return cached;
    const organizations: ContributionBlockedOrganization[] = [];
    try {
      const headers = await this.run(
        [
          "api",
          "--hostname",
          this.host,
          "--include",
          "user/repos?per_page=1",
          "--jq",
          "empty"
        ],
        { signal, timeoutMs: 45_000 }
      );
      const match =
        /^x-github-sso:\s*partial-results;\s*organizations=([\d, ]+)\s*$/im.exec(
          headers
        );
      const ids = [
        ...new Set(match?.[1].split(",").map((id) => Number(id.trim())) ?? [])
      ]
        .filter((id) => Number.isSafeInteger(id) && id > 0)
        .slice(0, 100);
      for (const id of ids) {
        let login: string | null = null;
        try {
          // Public directory lookup avoids requiring SSO/admin:org for the
          // identity itself. Never substitute the next org if this ID is gone.
          const raw = await this.run(
            [
              "api",
              "--hostname",
              this.host,
              `organizations?since=${id - 1}&per_page=1`,
              "--jq",
              "map({id,login})"
            ],
            { signal, timeoutMs: 45_000 }
          );
          const result: unknown = JSON.parse(raw);
          if (Array.isArray(result) && result.length === 1) {
            const org = object(result[0]);
            if (
              org.id === id &&
              typeof org.login === "string" &&
              /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(org.login)
            )
              login = org.login;
          }
        } catch {
          signal.throwIfAborted();
        }
        organizations.push({ id: String(id), login });
      }
    } catch {
      signal.throwIfAborted();
    }
    if (!organizations.length) organizations.push({ id: null, login: null });
    this.ssoOrganizations.set(identity.id, organizations);
    return organizations;
  }
  constructor(
    readonly host: string,
    private readonly run: typeof runGh = runGh
  ) {}
  private async query(
    query: string,
    variables: Record<string, string | null>,
    signal: AbortSignal,
    identity?: ContributionIdentity,
    recoverConnection?: "pullRequests"
  ): Promise<QueryResult> {
    const args = [
      "api",
      "graphql",
      "--hostname",
      this.host,
      "-f",
      `query=${query}`
    ];
    for (const [key, value] of Object.entries(variables))
      if (value !== null) args.push("-f", `${key}=${value}`);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let raw: string;
      try {
        raw = await this.run(args, { signal, timeoutMs: 45_000 });
      } catch (cause) {
        if (signal.aborted) throw new Error("Collection canceled.");
        const transient =
          cause instanceof GhCliError &&
          (cause.code === "timed_out" || /HTTP 5\d\d/i.test(cause.message));
        const wait =
          transient && attempt < 2
            ? forgeRetryDelayMs({
                kind: "github",
                status: undefined,
                header: () => null,
                attempt: attempt + 1
              })
            : null;
        if (wait !== null) {
          await delay(wait, { signal });
          continue;
        }
        // gh exits nonzero on GraphQL errors even for an HTTP 200. Only
        // structured GraphQL failures may reach the shared response parser.
        if (cause instanceof GhCliError && cause.code === "command_failed") {
          try {
            const response = object(JSON.parse(cause.stdout));
            if (response.errors !== undefined) {
              raw = cause.stdout;
            } else throw new Error();
          } catch {
            throw new Error(
              "GitHub analytics read failed. Check CLI sign-in, SSO authorization, repository access and rate limits, then resume."
            );
          }
        } else {
          // Do not log private API payloads or stderr. Auth/SSO/access/rate failure is never zero.
          throw new Error(
            "GitHub analytics read failed. Check CLI sign-in, SSO authorization, repository access and rate limits, then resume."
          );
        }
      }
      let response: Record<string, unknown>;
      try {
        response = object(JSON.parse(raw));
      } catch {
        throw new Error("GitHub returned invalid analytics metadata.");
      }
      const failure = graphqlFailure(response);
      if (failure && !(failure instanceof ContributionSsoError)) throw failure;
      let data: Record<string, unknown>, viewer: Record<string, unknown>;
      let id: string, login: string;
      try {
        data = object(response.data);
        viewer = object(data.viewer);
        id = string(viewer.id);
        login = string(viewer.login);
      } catch (cause) {
        // Without the identity envelope an SSO page is not recoverable.
        throw failure ?? cause;
      }
      if (
        identity &&
        (id !== identity.id ||
          login.toLowerCase() !== identity.login.toLowerCase())
      )
        throw new Error(
          "The active GitHub account changed. Reconnect analytics before continuing."
        );
      const rate = object(data.rateLimit);
      if (typeof rate.remaining !== "number")
        throw new Error("GitHub did not report its analytics rate budget.");
      if (rate.remaining < 200)
        throw new ContributionRateLimitError(timestamp(rate.resetAt));
      let skipped: number[] = [];
      let blockedOrganizations: ContributionBlockedOrganization[] = [];
      if (failure instanceof ContributionSsoError) {
        blockedOrganizations = identity
          ? await this.identifySsoOrganizations(identity, signal)
          : [];
        if (!recoverConnection || !identity)
          throw new ContributionSsoError(blockedOrganizations);
        const refusal = new ContributionSsoError(blockedOrganizations);
        const connection = viewer[recoverConnection];
        if (
          !connection ||
          typeof connection !== "object" ||
          Array.isArray(connection)
        )
          throw refusal;
        const nodes = (connection as Record<string, unknown>).nodes;
        const errors = response.errors as Record<string, unknown>[];
        const indices = errors.map((error) => {
          const path = error.path;
          if (
            !Array.isArray(path) ||
            path[0] !== "viewer" ||
            path[1] !== recoverConnection ||
            path[2] !== "nodes" ||
            !Number.isSafeInteger(path[3]) ||
            path[3] < 0 ||
            !Array.isArray(nodes) ||
            path[3] >= nodes.length
          )
            throw refusal;
          return path[3] as number;
        });
        skipped = [...new Set(indices)];
      }
      return { data, skipped, blockedOrganizations };
    }
  }
  async verify(signal: AbortSignal): Promise<ContributionIdentity> {
    const { data } = await this.query(`query { ${VIEWER} }`, {}, signal),
      viewer = object(data.viewer);
    return {
      id: string(viewer.id),
      login: string(viewer.login),
      host: this.host
    };
  }
  async repositories(
    identity: ContributionIdentity,
    cursor: string | null,
    signal: AbortSignal
  ): Promise<Page<ContributionRepo>> {
    const { data } = await this.query(
      CONTRIBUTION_REPOS_QUERY,
      { cursor },
      signal,
      identity
    );
    const connection = object(object(data.viewer).repositories);
    if (
      typeof connection.totalCount !== "number" ||
      !Number.isSafeInteger(connection.totalCount) ||
      connection.totalCount < 0
    )
      throw new Error("GitHub did not report repository inventory coverage.");
    return {
      ...page(connection, repository),
      totalCount: connection.totalCount
    };
  }
  async organizations(
    identity: ContributionIdentity,
    cursor: string | null,
    signal: AbortSignal
  ): Promise<Page<string>> {
    const { data } = await this.query(
      `query($cursor:String) {
        viewer { id login organizations(first:100, after:$cursor) {
          nodes { login }
          pageInfo { hasNextPage endCursor }
        } } rateLimit { remaining resetAt }
      }`,
      { cursor },
      signal,
      identity
    );
    return page(object(data.viewer).organizations, (value) =>
      string(object(value).login)
    );
  }
  async pulls(
    identity: ContributionIdentity,
    repo: ContributionRepo,
    cursor: string | null,
    signal: AbortSignal
  ) {
    const { data } = await this.query(
      CONTRIBUTION_PULLS_QUERY,
      { id: repo.id, cursor },
      signal,
      identity
    );
    const node = object(data.node);
    if (node.id !== repo.id)
      throw new Error("GitHub repository identity changed or access was lost.");
    const updates: string[] = [];
    const result = page(node.pullRequests, (value) => {
      const pull = object(value);
      updates.push(timestamp(pull.updatedAt));
      return pullRecord(pull, repo, identity);
    });
    return {
      ...result,
      oldestUpdatedAt: updates.length
        ? updates.reduce((a, b) => (Date.parse(a) < Date.parse(b) ? a : b))
        : null
    };
  }
  async authored(
    identity: ContributionIdentity,
    cursor: string | null,
    signal: AbortSignal
  ): Promise<Page<ContributionRecord>> {
    const { data, skipped, blockedOrganizations } = await this.query(
      CONTRIBUTION_AUTHORED_QUERY,
      { cursor },
      signal,
      identity,
      "pullRequests"
    );
    const connection = object(object(data.viewer).pullRequests);
    const result = page(
      connection,
      (value) => {
        const pull = object(value),
          record = pullRecord(pull, repository(pull.repository), identity);
        if (record.author !== identity.id)
          throw new Error(
            "GitHub's authored inventory returned a PR by another actor. Author coverage is unverified."
          );
        return record;
      },
      skipped
    );
    return {
      ...result,
      totalCount: count(connection.totalCount),
      ...(skipped.length
        ? { skipped: skipped.length, blockedOrganizations }
        : {})
    };
  }
  async timelines(
    identity: ContributionIdentity,
    records: ContributionRecord[],
    signal: AbortSignal
  ) {
    if (records.length > 25)
      throw new Error("Lifecycle request exceeds its 25-PR batch limit.");
    // filteredCount is scoped to the cursor range. Pin the first page count;
    // totalCount is not a count of either filtered or all timeline nodes.
    const fields = records
      .map((record, index) => {
        const id = JSON.stringify(record.id);
        const after = JSON.stringify(record.lifecycle?.cursor ?? null);
        return `p${index}:node(id:${id}) { ... on PullRequest { id
          timelineItems(first:100, after:${after},
            itemTypes:[CLOSED_EVENT,REOPENED_EVENT,MERGED_EVENT]) {
              filteredCount
              nodes { __typename ... on Node { id }
                ... on ClosedEvent { createdAt }
                ... on ReopenedEvent { createdAt }
                ... on MergedEvent { createdAt } }
              pageInfo { hasNextPage endCursor }
        } } }`;
      })
      .join("\n");
    const { data } = await this.query(
      `query { ${VIEWER} ${fields} }`,
      {},
      signal,
      identity
    );
    return records.map((record, index) => {
      const node = object(data[`p${index}`]);
      if (node.id !== record.id)
        throw new Error("PR lifecycle identity could not be resolved.");
      const connection = object(node.timelineItems);
      const result = page(connection, (value) => {
        const event = object(value);
        const kinds: Record<string, ContributionEvent["kind"]> = {
          ClosedEvent: "closed",
          ReopenedEvent: "reopened",
          MergedEvent: "merged"
        };
        const kind =
          typeof event.__typename === "string"
            ? kinds[event.__typename]
            : undefined;
        const id = string(event.id);
        if (!kind)
          throw new Error(
            "GitHub returned an unexpected filtered lifecycle event."
          );
        return { id, kind, at: timestamp(event.createdAt) };
      });
      return {
        id: record.id,
        events: result.nodes,
        cursor: result.cursor,
        more: result.more,
        filteredCount: count(connection.filteredCount)
      };
    });
  }
}
