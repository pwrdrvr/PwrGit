// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ok } from "@pwrgit/shared";
import { RepoIdentityGlyphs } from "./RepoIdentityMarks";

const { dispatch, showErrorToast } = vi.hoisted(() => ({
  dispatch: vi.fn(), showErrorToast: vi.fn()
}));
vi.mock("../../lib/pwrgit", () => ({ dispatch }));
vi.mock("../../lib/toast", () => ({ showErrorToast, showInfoToast: vi.fn() }));

it("retries only this repo, blocks duplicate clicks, and explains an unresolved visibility", async () => {
  let resolve!: (value: ReturnType<typeof ok<{ changed: number }>>) => void;
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
    await act(async () => resolve(ok({ changed: 0 })));
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
