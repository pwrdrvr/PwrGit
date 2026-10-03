import { expect, test } from "vitest";
import { ghRequest, makeApi, searchAll } from "./distribution-api.mjs";

const complete = (items = []) => ({ total_count: items.length, incomplete_results: false, items });

test("only an explicitly allowed 404 means a missing path", async () => {
  const api = makeApi({ request: async () => ({ status: 404, headers: {}, body: {} }) });
  expect(await api("source", { allow404: true })).toBeNull();
  await expect(api("source")).rejects.toThrow("HTTP 404");
  await expect(makeApi({ request: async () => ({ status: 403, headers: {}, body: { message: "Forbidden" } }) })("source", { allow404: true })).rejects.toThrow("no absence conclusion");
});

test.each([
  [429, { "retry-after": "75" }, 75_000],
  [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1090" }, 90_000],
  [403, { "retry-after": "1" }, 60_000],
  [503, {}, 1_000],
])("bounds retries and honors headers: status %s", async (status, headers, expected) => {
  let calls = 0;
  const delays = [];
  const api = makeApi({ now: () => 1_000_000, sleep: async (ms) => delays.push(ms), request: async () => ++calls === 1 ?
    { status, headers, body: {} } : { status: 200, headers: {}, body: complete() } });
  expect(await api("source")).toEqual(complete());
  expect(delays).toEqual([expected]);
  expect(calls).toBe(2);
});

test("exhausted rate limits retain an actionable blocker, never absence", async () => {
  const delays = [];
  let calls = 0;
  const api = makeApi({ sleep: async (ms) => delays.push(ms), request: async () => {
    calls++;
    return { status: 429, headers: {}, body: { message: "sensitive upstream response" } };
  } });
  await expect(api("search/code?q=secret", { search: true, allow404: true })).rejects.toThrow("Audit blocked: throttled at search/code; no absence conclusion");
  expect(calls).toBe(3);
  expect(delays).toEqual([60_000, 120_000]);
});

test("does not retry before Retry-After/reset or beyond the wait budget", async () => {
  const api = makeApi({ now: () => 0, sleep: async () => { throw new Error("must not sleep"); }, request: async () => ({
    status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3600" }, body: {},
  }) });
  await expect(api("source")).rejects.toThrow("budget");
  const delays = [];
  const cumulative = makeApi({ sleep: async (ms) => delays.push(ms), request: async () => ({ status: 429, headers: { "retry-after": "100" }, body: {} }) });
  await expect(cumulative("source")).rejects.toThrow("budget");
  expect(delays).toEqual([100_000]);
});

test.each([true, undefined])("requires incomplete_results=false and retries incomplete search (%s)", async (incomplete_results) => {
  let calls = 0;
  const api = makeApi({ sleep: async () => {}, request: async () => ({ status: 200, headers: {}, body: ++calls === 1 ?
    { ...complete(), incomplete_results } : complete() }) });
  expect(await api("search/code", { search: true })).toEqual(complete());
  expect(calls).toBe(2);
});

test("fully paginates submission history as well as code search", async () => {
  const pages = [];
  const items = Array.from({ length: 101 }, (_, i) => ({ id: i, html_url: `https://github.com/example/pull/${i}` }));
  expect(await searchAll(async (path) => {
    const page = Number(new URLSearchParams(path.split("?")[1]).get("page"));
    pages.push(page);
    return { total_count: 101, incomplete_results: false, items: items.slice((page - 1) * 100, page * 100) };
  }, "issues", "pwrgit is:pr")).toEqual(items);
  expect(pages).toEqual([1, 2]);
});

test.each([
  { total_count: 1001, incomplete_results: false, items: [] },
  { total_count: 0, incomplete_results: true, items: [] },
  { total_count: 0, items: [] },
  { total_count: 2, incomplete_results: false, items: [{ id: 1 }, { id: 1 }] },
  { total_count: 1, incomplete_results: false, items: [] },
  { total_count: 1, incomplete_results: false, items: null },
])("rejects truncated/incomplete/malformed searches %#", async (response) => {
  await expect(searchAll(async () => response, "issues", "query")).rejects.toThrow(/Audit blocked/);
});

test("rejects changing search counts between pages", async () => {
  let page = 0;
  await expect(searchAll(async () => (++page === 1 ? { total_count: 101, incomplete_results: false, items: Array.from({ length: 100 }, (_, id) => ({ id })) } :
    { total_count: 102, incomplete_results: false, items: [{ id: 101 }] }), "code", "query")).rejects.toThrow("changed during pagination");
});

test("parses gh HTTP headers on failures without exposing raw errors or debug output", async () => {
  const response = await ghRequest("search/code", { execute: async (command, args, options) => {
    expect(command).toBe("gh");
    expect(args).toEqual(["api", "--include", "search/code"]);
    expect(options.env.GH_DEBUG).toBe("");
    throw { stdout: 'HTTP/2.0 429 Too Many Requests\r\nRetry-After: 75\r\nX-RateLimit-Remaining: 0\r\n\r\n{"message":"limited"}', stderr: "private subprocess context" };
  } });
  expect(response).toEqual({ status: 429, headers: { "retry-after": "75", "x-ratelimit-remaining": "0" }, body: { message: "limited" } });
  expect(await ghRequest("source", { execute: async () => { throw new Error("private transport context"); } })).toEqual({ status: 0, headers: {}, body: null });
});
