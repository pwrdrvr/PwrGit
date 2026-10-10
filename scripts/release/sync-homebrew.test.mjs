import { expect, test } from "vitest";
import { syncHomebrew } from "./sync-homebrew.mjs";

function source({ installed = true, version = "0.27.0" } = {}) {
  const calls = [];
  const api = (endpoint, body, token) => {
    calls.push({ endpoint, body, token });
    if (endpoint.includes("releases/latest")) return { tag_name: "v0.29.0", draft: false, prerelease: false };
    if (endpoint.includes("contents/")) return version ? { content: Buffer.from(`  version "${version}"\n`).toString("base64") } : null;
    if (endpoint.endsWith("/dispatches")) { version = "0.29.0"; return null; }
    if (endpoint.includes("/runs?")) return { workflow_runs: [{ display_title: "PwrGit Homebrew sync 0.29.0", created_at: new Date().toISOString(), html_url: "https://github.com/pwrdrvr/homebrew-tap/actions/runs/123", status: "completed", conclusion: "failure" }] };
    return installed ? { state: "active" } : null;
  };
  return { api, calls };
}
test("already-published casks need no credential or dispatch", async () => {
  const { api, calls } = source({ version: "0.29.0" });
  expect(await syncHomebrew("0.29.0", { api, dispatchToken: "" })).toMatchObject({ state: "published" });
  expect(calls).toHaveLength(2);
});
test("dispatches the tap's main workflow with a write token and verifies publication", async () => {
  const { api, calls } = source();
  expect(await syncHomebrew("0.29.0", { api, dispatchToken: "test-token", pause: async () => {} })).toMatchObject({ state: "published" });
  const writes = calls.filter((call) => call.body);
  expect(writes).toEqual([{ endpoint: "repos/pwrdrvr/homebrew-tap/actions/workflows/bump-pwrgit.yml/dispatches", body: { ref: "main", inputs: { version: "0.29.0" } }, token: "test-token" }]);
  expect(calls.filter((call) => !call.body).every((call) => call.token === undefined)).toBe(true);
});
test("reports setup dependencies and a bounded schedule wait without opening PRs", async () => {
  await expect(syncHomebrew("0.29.0", { ...source(), dispatchToken: "", pause: async () => {}, attempts: 1 })).rejects.toThrow("actions/runs/123");
  await expect(syncHomebrew("0.29.0", { ...source({ installed: false }), dispatchToken: "test-token" })).rejects.toThrow("not installed/active");
});
test("refuses stale targets and reports failed tap runs after a bounded wait", async () => {
  const { api, calls } = source();
  await expect(syncHomebrew("0.28.0", { api, dispatchToken: "test-token" })).rejects.toThrow("no longer promoted");
  expect(calls.some((call) => call.body)).toBe(false);
  const noPublication = (endpoint, ...args) => endpoint.endsWith("/dispatches") ? null : api(endpoint, ...args);
  await expect(syncHomebrew("0.29.0", { api: noPublication, dispatchToken: "test-token", pause: async () => {}, attempts: 2 })).rejects.toThrow("actions/runs/123; status=completed, conclusion=failure");
});

test("does not confuse earlier failed runs with this dispatch and stops waiting at its deadline", async () => {
  const { api } = source();
  const oldRun = (endpoint, ...args) => {
    if (endpoint.endsWith("/dispatches")) return null;
    const response = api(endpoint, ...args);
    if (endpoint.includes("/runs?")) response.workflow_runs[0].created_at = "2026-01-01T00:00:00Z";
    return response;
  };
  await expect(syncHomebrew("0.29.0", { api: oldRun, dispatchToken: "test-token", pause: async () => {}, attempts: 2 })).rejects.toThrow("not on tap main after 1 minutes");
});
