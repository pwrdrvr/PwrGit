import { afterEach, expect, it, vi } from "vitest";
import { gerritGet } from "./client";
const repo = { kind: "gerrit" as const, host: "chromium.googlesource.com", path: "v8/v8" };
afterEach(() => vi.unstubAllGlobals());
it("uses the review host, strips XSSI, and never sends authentication or follows redirects", async () => {
  const fetcher = vi.fn(async () => new Response(")]}'\n[]", { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  expect(await gerritGet(repo, "changes/?q=test")).toEqual([]);
  expect(fetcher).toHaveBeenCalledWith("https://chromium-review.googlesource.com/changes/?q=test", expect.objectContaining({ credentials: "omit", redirect: "error", headers: { Accept: "application/json" } }));
});
it.each(["<html>sign in</html>", ")]}'\nnot json", "[]"])("refuses invalid success payload %s", async (body) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
  await expect(gerritGet(repo, "changes/")).rejects.toThrow();
});
it("does not leak an error body or retry a denied public read", async () => {
  const fetcher = vi.fn(async () => new Response("private error details", { status: 403 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(gerritGet(repo, "changes/")).rejects.toThrow("HTTP 403");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("bounds response bytes", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(8 * 1024 * 1024 + 1))));
  await expect(gerritGet(repo, "changes/")).rejects.toThrow("size limit");
});
