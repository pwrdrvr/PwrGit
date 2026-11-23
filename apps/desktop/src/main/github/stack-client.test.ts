import { expect, test, vi } from "vitest";
import { fetchGitHubStacks } from "./stack-client";

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
    const stacks = await fetchGitHubStacks("fixture", "example", "orbit");
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(stacks?.map(({ number, closed }) => [number, closed])).toEqual([
      [1, "merged"], [2, "merged"], [3, "merged"], [4, "merged"], [5, "merged"], [6, "merged"], [7, undefined],
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
});
