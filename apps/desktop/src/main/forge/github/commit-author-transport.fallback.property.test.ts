import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CliError } from "../cli-runner";
import type { ForgeRepo } from "../types";
import { GhCliCommitAuthorIdentityTransport } from "./commit-author-transport";

/**
 * An older GitHub Enterprise Server lacks fields github.com has, and GraphQL
 * rejects the whole document for one unknown field. The rule: a server that
 * rejects only optional fields (the signature, the PR fallback) still answers
 * every commit's author, keeps every optional field it does have when its
 * errors name what it lacks, and learns this once per host, not per request.
 *
 * The server here is a model of graphql-ruby's validation: each optional part
 * it lacks yields an error when the query mentions it, worded with
 * `extensions` (github.com's shape), with the message only, or naming nothing.
 * `gh api graphql` prints that body on stdout and exits 1, which the runner
 * reports as a `CliError` carrying the stdout.
 *
 * Before the fallback, any missing field failed every request on that host, so
 * no author there was ever matched.
 */
const HOST = "ghe.example.test";
const OTHER_HOST = "ghe-new.example.test";
const repoAt = (host: string): ForgeRepo => ({ kind: "github", host, path: "octo-org/example" });

type Part = "signature" | "wasSignedByGitHub" | "pulls";
/** What each optional part puts in the query, and how its error names it. */
const PARTS: Record<Part, { marker: string; field: string; type: string }> = {
  signature: { marker: "signature {", field: "signature", type: "Commit" },
  wasSignedByGitHub: { marker: "wasSignedByGitHub", field: "wasSignedByGitHub", type: "GitSignature" },
  pulls: { marker: "associatedPullRequests", field: "associatedPullRequests", type: "Commit" }
};
type Wording = "extensions" | "message" | "nameless";

function schemaError(part: Part, wording: Wording): unknown {
  const { field, type } = PARTS[part];
  if (wording === "extensions") {
    return {
      message: `Field '${field}' doesn't exist on type '${type}'`,
      extensions: { code: "undefinedField", typeName: type, fieldName: field }
    };
  }
  if (wording === "message") return { message: `Field '${field}' doesn't exist on type '${type}'` };
  return { message: "Query has an unsupported selection", extensions: { code: "undefinedField" } };
}

function commitNode(sha: string, query: string): Record<string, unknown> {
  return {
    oid: sha,
    author: { name: "Example Author", email: "author@example.test", user: { login: "example-author", databaseId: 7 } },
    ...(query.includes(PARTS.signature.marker)
      ? { signature: { isValid: true, state: "VALID", wasSignedByGitHub: false, signer: { login: "example-author" } } }
      : {}),
    ...(query.includes(PARTS.pulls.marker) ? { associatedPullRequests: { totalCount: 0, nodes: [] } } : {})
  };
}

function server(missing: ReadonlySet<Part>, wording: Wording, reportsEvery: boolean) {
  const queries: { host: string; query: string }[] = [];
  const run = async (args: string[]): Promise<string> => {
    const host = args[args.indexOf("--hostname") + 1]!;
    const query = args.find((arg) => arg.startsWith("query="))!.slice("query=".length);
    queries.push({ host, query });
    const lacks = host === HOST
      ? [...missing].filter((part) => query.includes(PARTS[part].marker))
      : [];
    if (lacks.length > 0) {
      const errors = (reportsEvery ? lacks : lacks.slice(0, 1)).map((part) => schemaError(part, wording));
      const body = JSON.stringify({ errors });
      throw new CliError(`gh: ${String((errors[0] as { message: string }).message)}`, "command_failed", body, "");
    }
    const variables = new Map(
      args.filter((arg) => /^c\d+=/.test(arg)).map((arg) => arg.split("=") as [string, string])
    );
    const repository = Object.fromEntries(
      [...variables].map(([alias, sha]) => [alias, commitNode(sha, query)])
    );
    return JSON.stringify({ data: { repository } });
  };
  return { run, queries };
}

const shas = fc.uniqueArray(
  fc.bigInt({ min: 0n, max: (1n << 160n) - 1n }).map((n) => n.toString(16).padStart(40, "0")),
  { minLength: 1, maxLength: 50 }
);

describe("GhCliCommitAuthorIdentityTransport schema fallback (property)", () => {
  it("answers every commit on a server missing optional fields, and learns it once per host", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(["signature", "wasSignedByGitHub", "pulls"] as Part[]),
        fc.constantFrom<Wording>("extensions", "message", "nameless"),
        fc.boolean(),
        shas,
        async (missingList, wording, reportsEvery, commits) => {
          const missing = new Set(missingList);
          const fake = server(missing, wording, reportsEvery);
          const transport = new GhCliCommitAuthorIdentityTransport({ run: fake.run });

          const answers = await transport.fetchCommits(repoAt(HOST), commits);
          expect([...answers.keys()].sort()).toEqual([...commits].sort());
          for (const commit of answers.values()) {
            expect(commit.account?.login).toBe("example-author");
          }

          // One request per missing part at most, one when errors name nothing.
          const firstCall = fake.queries.length;
          const lacking = missing.size;
          expect(firstCall).toBeLessThanOrEqual(1 + (wording === "nameless" ? Math.min(lacking, 1) : lacking));

          // Named errors keep what the server has: a server with signatures
          // still reports them.
          const signatures = !missing.has("signature") && !missing.has("wasSignedByGitHub");
          if (wording !== "nameless" && signatures) {
            for (const commit of answers.values()) expect(commit.signature?.valid).toBe(true);
          }
          if (wording !== "nameless" && !missing.has("pulls")) {
            expect(fake.queries.at(-1)!.query).toContain(PARTS.pulls.marker);
          }

          // The host is learned: the next request is one request.
          await transport.fetchCommits(repoAt(HOST), commits);
          expect(fake.queries.length).toBe(firstCall + 1);

          // Another host is not downgraded by this one.
          await transport.fetchCommits(repoAt(OTHER_HOST), commits);
          const other = fake.queries.at(-1)!;
          expect(other.host).toBe(OTHER_HOST);
          expect(other.query).toContain(PARTS.signature.marker);
          expect(other.query).toContain(PARTS.pulls.marker);
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe("GhCliCommitAuthorIdentityTransport schema fallback", () => {
  const body = (errors: unknown[]) => JSON.stringify({ errors });

  it("never drops a field for an error that is not about the schema", async () => {
    const queries: string[] = [];
    let calls = 0;
    const transport = new GhCliCommitAuthorIdentityTransport({
      run: async (args) => {
        calls += 1;
        queries.push(args.find((arg) => arg.startsWith("query="))!);
        if (calls === 1) {
          throw new CliError("gh: API rate limit exceeded", "command_failed", body([
            { type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." }
          ]), "");
        }
        return JSON.stringify({ data: { repository: {} } });
      }
    });

    await expect(transport.fetchCommits(repoAt(HOST), ["a".repeat(40)])).rejects.toThrow(/rate limit/);
    await transport.fetchCommits(repoAt(HOST), ["a".repeat(40)]);
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("wasSignedByGitHub");
    expect(queries[1]).toContain("associatedPullRequests");
  });

  it("never drops a field when schema errors come with any other error", async () => {
    let calls = 0;
    const transport = new GhCliCommitAuthorIdentityTransport({
      run: async () => {
        calls += 1;
        throw new CliError("gh: failed", "command_failed", body([
          { message: "Field 'wasSignedByGitHub' doesn't exist on type 'GitSignature'", extensions: { code: "undefinedField", fieldName: "wasSignedByGitHub", typeName: "GitSignature" } },
          { type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement." }
        ]), "");
      }
    });
    await expect(transport.fetchCommits(repoAt(HOST), ["a".repeat(40)])).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("throws when the base query itself is rejected, after dropping every optional field", async () => {
    const queries: string[] = [];
    const transport = new GhCliCommitAuthorIdentityTransport({
      run: async (args) => {
        queries.push(args.find((arg) => arg.startsWith("query="))!);
        throw new CliError("gh: Field 'databaseId' doesn't exist on type 'User'", "command_failed", body([
          { message: "Field 'databaseId' doesn't exist on type 'User'", extensions: { code: "undefinedField", fieldName: "databaseId", typeName: "User" } }
        ]), "");
      }
    });
    await expect(transport.fetchCommits(repoAt(HOST), ["a".repeat(40)])).rejects.toThrow(CliError);
    expect(queries).toHaveLength(2);
    expect(queries[1]).not.toContain("signature {");
    expect(queries[1]).not.toContain("associatedPullRequests");
  });

  it("reads a schema rejection that arrives with exit 0", async () => {
    const queries: string[] = [];
    const transport = new GhCliCommitAuthorIdentityTransport({
      run: async (args) => {
        const query = args.find((arg) => arg.startsWith("query="))!;
        queries.push(query);
        if (query.includes("wasSignedByGitHub")) {
          return body([{ message: "Field 'wasSignedByGitHub' doesn't exist on type 'GitSignature'" }]);
        }
        return JSON.stringify({ data: { repository: { c0: null } } });
      }
    });
    await expect(transport.fetchCommits(repoAt(HOST), ["a".repeat(40)])).resolves.toEqual(new Map());
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("associatedPullRequests");
  });
});
