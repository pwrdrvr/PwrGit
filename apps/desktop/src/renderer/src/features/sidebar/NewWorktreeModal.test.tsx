// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Repo } from "@pwrgit/shared";
import { NewWorktreeModal } from "./NewWorktreeModal";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const repo: Repo = {
  id: "repo-1",
  name: "orbit",
  path: "/repos/orbit",
  profileId: "profile-1",
  pinned: false,
  worktrees: []
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("NewWorktreeModal", () => {
  it("names the PR it was opened from and still starts in the branch field", async () => {
    await act(async () => {
      root.render(
        <NewWorktreeModal
          repo={repo}
          initialBranch="fix/audit-export"
          startPoint="refs/remotes/origin/fix/audit-export"
          changeRequest={{
            number: 381,
            url: "https://example.test/acme/orbit/pull/381",
            title: "Export the audit log as CSV",
            state: "open",
            isDraft: false,
            forge: "github"
          }}
          onCreate={async () => null}
          onClose={() => undefined}
        />
      );
    });
    expect(container.querySelector(".modal__subject")?.textContent).toContain(
      "Export the audit log as CSV"
    );
    // The chip comes first in tab order; focusing it would open its status
    // card over the dialog's title.
    expect(document.activeElement).toBe(container.querySelector(".modal__input"));
  });
});
