import { describe, expect, it } from "vitest";
import { GitHubContributionProvider } from "./contribution-provider";
import { GhCliError, type runGh } from "../../github/gh-cli";

const identity = { id: "U1", login: "demo-user", host: "ghe.example.test" };
const signal = new AbortController().signal;
const orgs = [{ id: "42", login: "blocked-org" }];
const pull = (id: string) => ({
  id, number: 1, author: { id: "U1" }, mergedBy: null, mergedAt: null,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-02-01T00:00:00Z",
  closedAt: "2026-02-01T00:00:00Z", state: "CLOSED",
  repository: {
    id: "R1", nameWithOwner: "open-org/widget", visibility: "PUBLIC",
    isArchived: false, isFork: false,
    owner: { id: "O1", login: "open-org", __typename: "Organization" }
  }
});
function envelope(nodes: unknown[], more = false, errors: unknown[] = [sso(1)]) {
  return JSON.stringify({
    data: {
      viewer: { ...identity, pullRequests: {
        nodes, totalCount: nodes.length,
        pageInfo: { hasNextPage: more, endCursor: more ? "NEXT" : null }
      } },
      rateLimit: { remaining: 4000, resetAt: "2026-10-28T00:00:00Z" }
    }, errors
  });
}
const sso = (index: number) => ({
  type: "FORBIDDEN", path: ["viewer", "pullRequests", "nodes", index],
  extensions: { saml_failure: true },
  message: "Resource protected by organization SAML enforcement. private payload"
});
function transport(raw: string, rejects = true, lookupId = 42) {
  const calls: string[][] = [];
  const run: typeof runGh = async (args) => {
    calls.push(args);
    expect(args).toContain(identity.host);
    if (args.includes("graphql")) {
      if (rejects) throw new GhCliError("private stderr", "command_failed", raw, "private stderr");
      return raw;
    }
    if (args.includes("user/repos?per_page=1"))
      return "HTTP/2.0 200 OK\r\nX-GitHub-SSO: partial-results; organizations=42\r\n\r\n";
    if (args.includes("organizations?since=41&per_page=1"))
      return JSON.stringify([{ id: lookupId, login: "blocked-org" }]);
    throw new Error("Unexpected API call");
  };
  return { provider: new GitHubContributionProvider(identity.host, run), calls };
}
describe("SSO-isolated authored pagination", () => {
  it.each([true, false])("keeps accessible nodes, names the blocked org, and advances pagination (CLI refusal=%s)", async (rejects) => {
    const { provider, calls } = transport(envelope([pull("P1"), null, pull("P3")]), rejects);
    const result = await provider.authored(identity, "PAGE_3", signal);
    expect(result.nodes.map((row) => row.id)).toEqual(["P1", "P3"]);
    expect(result).toMatchObject({ skipped: 1, blockedOrganizations: orgs, more: false, totalCount: 3 });
    expect(JSON.stringify(result)).not.toContain("private payload");
    await provider.authored(identity, "PAGE_4", signal);
    expect(calls.filter((args) => args.includes("user/repos?per_page=1"))).toHaveLength(1);
  });
  it("advances a wholly SSO-blocked page with a valid cursor", async () => {
    const { provider } = transport(envelope([null], true, [sso(0)]));
    await expect(provider.authored(identity, null, signal)).resolves.toMatchObject({
      nodes: [], skipped: 1, cursor: "NEXT", more: true
    });
  });
  it("does not assign the next public organization when the exact ID is unavailable", async () => {
    const { provider } = transport(envelope([null], false, [sso(0)]), true, 43);
    await expect(provider.authored(identity, null, signal)).resolves.toMatchObject({
      blockedOrganizations: [{ id: "42", login: null }]
    });
  });
  it.each([
    [{ ...sso(1), type: "INTERNAL" }],
    [{ ...sso(1), path: ["viewer", "id"] }],
    [sso(9)],
    [sso(1), { type: "FORBIDDEN", message: "ordinary permission denial" }]
  ])("rejects errors that cannot be isolated to SSO-blocked nodes: %j", async (errors) => {
    const { provider } = transport(envelope([pull("P1"), null], false, errors));
    await expect(provider.authored(identity, null, signal)).rejects.toThrow();
  });
  it("still rejects account changes and low rate budgets on partially readable pages", async () => {
    for (const change of ["account", "rate"]) {
      const raw = JSON.parse(envelope([pull("P1"), null]));
      if (change === "account") raw.data.viewer.id = "U2";
      else raw.data.rateLimit.remaining = 199;
      const { provider } = transport(JSON.stringify(raw));
      await expect(provider.authored(identity, null, signal)).rejects.toThrow(
        change === "account" ? /account changed/ : /rate budget/
      );
    }
  });
});
