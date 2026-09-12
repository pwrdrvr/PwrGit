// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { ok, type RepoIdentityRefreshOutcome } from "@pwrgit/shared";
import { RepoIdentityGlyphs } from "./RepoIdentityMarks";

const { dispatch, showErrorToast, showInfoToast } = vi.hoisted(() => ({
  dispatch: vi.fn(), showErrorToast: vi.fn(), showInfoToast: vi.fn()
}));
vi.mock("../../lib/pwrgit", () => ({ dispatch }));
vi.mock("../../lib/toast", () => ({ showErrorToast, showInfoToast }));

beforeEach(() => vi.clearAllMocks());

it("retries only this repo, blocks duplicate clicks, and explains an unresolved visibility", async () => {
  let resolve!: (value: ReturnType<typeof ok<{ changed: number; outcomes: RepoIdentityRefreshOutcome[] }>>) => void;
  dispatch.mockReturnValue(new Promise((done) => { resolve = done; }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const toggleRow = vi.fn();
  try {
    await act(async () => root.render(
      <div onClick={toggleRow}>
        <RepoIdentityGlyphs repoId="repo-1" profileId="profile-1" identity={{
          host: "github", hostname: "github.com", owner: "example",
          name: "demo", nameWithOwner: "example/demo", visibility: "unknown"
        }} />
      </div>
    ));
    const button = container.querySelector("button")!;
    await act(async () => { button.click(); button.click(); });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith("repo:refreshIdentities", {
      profileId: "profile-1", repoId: "repo-1", force: true
    });
    expect(toggleRow).not.toHaveBeenCalled();
    expect(button.disabled).toBe(true);
    await act(async () => resolve(ok({ changed: 0, outcomes: [{ repoId: "repo-1", status: "unknown" }] })));
    expect(button.disabled).toBe(false);
    expect(showErrorToast).toHaveBeenCalledWith({
      title: "Repository visibility",
      message: "Visibility is still unknown. Check Settings → Forges or Logs."
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([
  { previous: "public", status: "unknown", changed: 1 },
  { previous: "private", status: "signed_out", changed: 0 },
  { previous: "unknown", status: "unknown", changed: 1 },
  { previous: "public", status: "resolved", changed: 0 }
] as const)("reports $status from the lookup, not $changed changes to $previous", async ({ previous, status, changed }) => {
  vi.clearAllMocks();
  dispatch.mockResolvedValue(ok({ changed, outcomes: [{ repoId: "repo-1", status }] }));
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <RepoIdentityGlyphs repoId="repo-1" profileId="profile-1" identity={{
        host: "github", hostname: "github.com", owner: "example",
        name: "demo", nameWithOwner: "example/demo", visibility: previous
      }} />
    ));
    await act(async () => container.querySelector("button")!.click());
    if (status === "resolved") {
      expect(showInfoToast).toHaveBeenCalledTimes(1);
      expect(showErrorToast).not.toHaveBeenCalled();
    } else {
      expect(showErrorToast).toHaveBeenCalledTimes(1);
      expect(showInfoToast).not.toHaveBeenCalled();
    }
  } finally {
    await act(async () => root.unmount());
  }
});

it("names the switch, and does not raise an error, for a disabled host", async () => {
  // The one non-resolved outcome that is a choice rather than a failure.
  // Reporting it like the rest said "Visibility is still unknown" beside a
  // lock glyph rendering a known `private`, and pointed at an empty log.
  vi.clearAllMocks();
  dispatch.mockResolvedValue(
    ok({ changed: 0, outcomes: [{ repoId: "repo-1", status: "host_disabled" }] })
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <RepoIdentityGlyphs repoId="repo-1" profileId="profile-1" identity={{
        host: "github", hostname: "github.com", owner: "example",
        name: "demo", nameWithOwner: "example/demo", visibility: "private"
      }} />
    ));
    await act(async () => container.querySelector("button")!.click());
    expect(showErrorToast).not.toHaveBeenCalled();
    expect(showInfoToast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showInfoToast).mock.calls[0]?.[0]?.message).toContain(
      "github.com is switched off in Settings → Forges"
    );
  } finally {
    await act(async () => root.unmount());
  }
});
