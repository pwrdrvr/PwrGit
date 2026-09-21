// @vitest-environment jsdom
//
// The leading glyph is the only thing on a palette row that says what KIND of
// result it is — `.overlay-result__meta` names the repo for a worktree and a
// worktree count for a repo, never the kind. These assert that the kind
// survives both ways out of the row: as text in the option's accessible name,
// and as a tooltip for the pointer.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ok, type RepoSearchHit } from "@pwrgit/shared";
import { RepoSwitcherOverlay } from "./RepoSwitcherOverlay";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;
const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  // The footer's scope toggle reads the setting on mount; these suites are
  // about rows, so answer it here instead of in every dispatch mock.
  dispatch: (command: string, req: unknown) =>
    command === "settings:read"
      ? Promise.resolve({ ok: true, value: { general: { searchAllProfiles: false } } })
      : dispatch(command, req),
  subscribe: () => () => {},
  windowProfileId: () => "default"
}));

const base = {
  repoId: "repo", repoName: "Demo", path: "/repo",
  profileId: "profile", profileName: "Test", pinned: false, worktreeCount: 0
};
const hits: RepoSearchHit[] = [
  { ...base, kind: "worktree", name: "feature/requested", worktreeId: "wt" },
  { ...base, kind: "local_branch", name: "spike/no-checkout" },
  { ...base, kind: "remote_branch", name: "release/1.4", remoteName: "origin" },
  { ...base, kind: "repo", name: "Demo", worktreeCount: 6 }
];

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });
  dispatch.mockReset();
  dispatch.mockImplementation(async (command: string) =>
    command === "repo:search"
      ? ok(hits)
      : ok({ lastActivityAt: null, dirty: null, ahead: null, behind: null })
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<RepoSwitcherOverlay platform="darwin" commits={[]} commitContext={null}
      onClose={() => {}} onPick={() => {}} onPickCommit={() => {}}
      onPickFile={() => {}} profileCount={1} />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const rows = (): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(".overlay-result"));

it("names each kind in the row's own text, in reading order", () => {
  expect(rows().map((row) => row.textContent)).toEqual([
    expect.stringMatching(/^Worktree\s*feature\/requested/),
    expect.stringMatching(/^Local branch\s*spike\/no-checkout/),
    expect.stringMatching(/^Remote branch\s*release\/1\.4/),
    expect.stringMatching(/^Repo\s*Demo/)
  ]);
});

it("hides the glyph itself from the accessibility tree", () => {
  // Otherwise the kind is announced twice — once as the label, once as an
  // unnamed graphic.
  const glyphs = rows().map((row) =>
    row.querySelector(".overlay-result__kind > svg")
  );
  expect(glyphs).toHaveLength(4);
  for (const glyph of glyphs) {
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
  }
});

it("opens a tooltip naming the kind when the pointer is on the glyph", async () => {
  const glyph = rows()[1]!.querySelector(".overlay-result__kind")!;
  await act(async () => {
    glyph.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  });
  expect(document.body.textContent).toContain("Local branch");
  // The card, not just the row it came from.
  expect(
    document.querySelector(".tooltip, [role='tooltip']")?.textContent
  ).toBe("Local branch");
});
