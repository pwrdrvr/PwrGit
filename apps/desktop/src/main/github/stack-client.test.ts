import { expect, test, vi } from "vitest";
import { fetchGitHubStacks } from "./stack-client";

test("a full terminal page must rediscover pagination even when its ETag is unchanged", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }), async terminal => {
    let last = terminal;
    const fetch = vi.fn(async (url: string, options: RequestInit) => {
      const page = Number(new URL(url).searchParams.get("page"));
      const etag = `"page-${page}"`;
      if (new Headers(options.headers).get("If-None-Match") === etag) return new Response(null, { status: 304 });
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      return Response.json(Array.from({ length: 100 }, (_, index) => {
        const number = 100 * (page - 1) + index + 1;
        return { number, open: false, base: { ref: "main" }, pull_requests: [
          { number, state: "closed", head: { ref: `branch-${number}` } },
        ] };
      }), { headers: { ETag: etag, ...(page < last ? { Link: `<${next}>; rel="next"` } : {}) } });
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const initial = await fetchGitHubStacks("fixture", "example", "orbit");
      last++;
      fetch.mockClear();
      const refreshed = await fetchGitHubStacks("fixture", "example", "orbit", initial);
      expect(refreshed.stacks).toHaveLength(last * 100);
      expect(fetch.mock.calls.map(([, options]) => new Headers(options.headers).has("If-None-Match")))
        .toEqual([...Array(terminal - 1).fill(true), false, false]);
    } finally {
      vi.unstubAllGlobals();
    }
  }), { numRuns: 8, examples: [[1]] });
});

test("walks beyond five pages to find both old closed stacks and open stacks", async () => {
  const fetch = vi.fn(async (url: string) => {
    const page = Number(new URL(url).searchParams.get("page"));
    const open = page === 7;
    return Response.json([{
      number: page, open, base: { ref: "main" },
      pull_requests: [{
        number: page + 100, state: open ? "open" : "closed", head: { ref: `branch-${page}` },
        merged_at: open ? null : "2026-11-12T10:00:00Z",
      }],
    }], page < 7 ? { headers: {
      Link: `<https://api.github.com/repos/example/orbit/stacks?per_page=100&page=${page + 1}>; rel="next"`,
    } } : undefined);
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const { stacks } = await fetchGitHubStacks("fixture", "example", "orbit");
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(stacks.map(({ number, closed }) => [number, closed])).toEqual([
      [1, "merged"], [2, "merged"], [3, "merged"], [4, "merged"], [5, "merged"], [6, "merged"], [7, undefined],
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test.each([
  ["https://example.invalid/repos/example/orbit/stacks?page=2", "outside its API"],
  ["https://api.github.com/repos/example/orbit/stacks?per_page=100&page=1", "repeated a page"],
])("stops on an invalid next link %s", async (next, message) => {
  const fetch = vi.fn(async () => Response.json([], { headers: { Link: `<${next}>; rel="next"` } }));
  vi.stubGlobal("fetch", fetch);
  try {
    await expect(fetchGitHubStacks("fixture", "example", "orbit")).rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
import fc from "fast-check";
