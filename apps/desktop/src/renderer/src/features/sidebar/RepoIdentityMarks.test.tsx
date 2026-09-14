// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { ok, type RepoIdentityRefreshOutcome } from "@pwrgit/shared";
import {
  identityDescription,
  RepoIdentityChips,
  RepoIdentityGlyphs
} from "./RepoIdentityMarks";

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

it("names the host main gated on, not the one in the stored row", async () => {
  // The row records the last host that ANSWERED. After `origin` moves, that is
  // not the host the gate refused — and naming the stored one sends the user to
  // a switch that is already on, with nothing to change.
  vi.clearAllMocks();
  dispatch.mockResolvedValue(
    ok({
      changed: 0,
      outcomes: [
        {
          repoId: "repo-1",
          status: "host_disabled",
          hostname: "gitlab.corp.example"
        }
      ]
    })
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
    expect(vi.mocked(showInfoToast).mock.calls[0]?.[0]?.message).toContain(
      "gitlab.corp.example is switched off"
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it("describes the other forges a repo has remotes on, which the chip only counts", () => {
  // The forge chip is aria-hidden and its `+n` is a number, so this sentence
  // is the only place a screen reader learns there is a second forge at all.
  const base = {
    host: "gitlab" as const,
    hostname: "gitlab.com",
    owner: "pwrdrvr",
    name: "PwrGit",
    nameWithOwner: "pwrdrvr/PwrGit",
    visibility: "public" as const
  };
  expect(identityDescription(base)).toBe("public, on gitlab.com");
  expect(
    identityDescription({
      ...base,
      remoteHostnames: ["github.com", "gitlab.com"]
    })
  ).toBe("public, on gitlab.com, also has remotes on github.com");
  // Origin's own host is already named; repeating it adds nothing.
  expect(
    identityDescription({ ...base, remoteHostnames: ["gitlab.com"] })
  ).toBe("public, on gitlab.com");
});

it("marks a repo you cannot push to, and stays silent about the other two states", async () => {
  // Three states, one glyph. `true` is the ordinary case — a mark on every row
  // you CAN push to costs a column to say nothing — and absent is "not known",
  // where a mark would claim a refusal nobody made.
  const identity = {
    host: "github" as const,
    hostname: "github.com",
    owner: "desktop",
    name: "dugite",
    nameWithOwner: "desktop/dugite",
    visibility: "public" as const
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  const forks: number[] = [];
  const marks = (viewerCanPush?: boolean, onFork?: () => void) => (
    <RepoIdentityGlyphs
      repoId="repo-1"
      profileId="profile-1"
      identity={{
        ...identity,
        ...(viewerCanPush === undefined ? {} : { viewerCanPush })
      }}
      {...(onFork === undefined ? {} : { onFork })}
    />
  );
  try {
    await act(async () => root.render(marks()));
    expect(container.querySelector(".repo-mark--nopush")).toBeNull();
    await act(async () => root.render(marks(true)));
    expect(container.querySelector(".repo-mark--nopush")).toBeNull();

    // No `title`: these 12px marks speak through `useViewportTooltip`, like
    // the refresh button further down the same row. The sentence a screen
    // reader gets is `identityDescription`, on the row's aria-describedby.
    await act(async () => root.render(marks(false)));
    const passive = container.querySelector(".repo-mark--nopush");
    expect(passive?.getAttribute("title")).toBeNull();
    // Passive with nowhere to send the user — a button that goes nowhere is
    // worse than a statement.
    expect(passive?.tagName.toLowerCase()).toBe("span");

    // With a destination it becomes the verb.
    await act(async () =>
      root.render(marks(false, () => forks.push(1)))
    );
    const actionable = container.querySelector<HTMLButtonElement>(
      ".repo-mark--nopush"
    );
    expect(actionable?.tagName.toLowerCase()).toBe("button");
    expect(actionable?.getAttribute("aria-label")).toBe(
      "You can't push to desktop/dugite. Fork it to contribute. Fork it now."
    );
    await act(async () => {
      actionable?.click();
    });
    expect(forks).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
  }
});

it("says read-only in the identity sentence too", () => {
  const base = {
    host: "github" as const,
    hostname: "github.com",
    owner: "desktop",
    name: "dugite",
    nameWithOwner: "desktop/dugite",
    visibility: "public" as const
  };
  expect(identityDescription({ ...base, viewerCanPush: false })).toBe(
    "public, on github.com, read-only, you cannot push"
  );
  expect(identityDescription({ ...base, viewerCanPush: true })).toBe(
    "public, on github.com"
  );
});

it("chips read-only in the dialogs, where there is room to spell it out", async () => {
  const repository = {
    name: "dugite",
    owner: "desktop",
    nameWithOwner: "desktop/dugite",
    visibility: "public" as const,
    host: "github" as const,
    hostname: "github.com",
    sshUrl: "git@github.com:desktop/dugite.git",
    httpsUrl: "https://github.com/desktop/dugite.git",
    localPaths: []
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(<RepoIdentityChips repository={repository} />)
    );
    expect(container.querySelector(".clone-chip--nopush")).toBeNull();
    await act(async () =>
      root.render(
        <RepoIdentityChips repository={{ ...repository, viewerCanPush: false }} />
      )
    );
    expect(container.querySelector(".clone-chip--nopush")?.textContent).toBe(
      "read-only"
    );
  } finally {
    await act(async () => root.unmount());
  }
});
