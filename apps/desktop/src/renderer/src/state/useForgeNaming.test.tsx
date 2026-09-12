// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { ok, type ForgeHostRow } from "@pwrgit/shared";
import { resetForgeNamingForTests, useForgeNaming } from "./useForgeNaming";

const { dispatch, subscribe } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  subscribe: vi.fn()
}));
vi.mock("../lib/pwrgit", () => ({ dispatch, subscribe }));

/** Channel → the last handler the store registered for it. */
const handlers = new Map<string, (payload: unknown) => void>();

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  resetForgeNamingForTests();
  subscribe.mockImplementation(
    (channel: string, handler: (payload: unknown) => void) => {
      handlers.set(channel, handler);
      return () => handlers.delete(channel);
    }
  );
});

const row = (over: Partial<ForgeHostRow> & { host: string }): ForgeHostRow => ({
  kind: "github",
  kindSource: "auto",
  enabled: true,
  enabledSource: "auto",
  origin: "cli",
  cli: "gh",
  ...over
});

const answer = (hosts: ForgeHostRow[]): void => {
  dispatch.mockResolvedValue(ok({ hosts, overrides: {} }));
};

/** Renders the hook and hands back its latest value. */
async function mount(): Promise<{
  latest: () => ReturnType<typeof useForgeNaming>;
  unmount: () => Promise<void>;
}> {
  let latest!: ReturnType<typeof useForgeNaming>;
  function Probe() {
    latest = useForgeNaming();
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Probe />));
  return {
    latest: () => latest,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    }
  };
}

it("stays quiet while one forge host is on, and speaks once a second is", async () => {
  // The chip's whole job is telling two rows apart. With one host every chip
  // in the sidebar would read the same word.
  answer([row({ host: "github.com" })]);
  const one = await mount();
  expect(one.latest().showChips).toBe(false);
  await one.unmount();

  resetForgeNamingForTests();
  answer([
    row({ host: "github.com" }),
    row({ host: "gitlab.com", kind: "gitlab", cli: "glab" })
  ]);
  const two = await mount();
  expect(two.latest().showChips).toBe(true);
  expect(two.latest().names.get("github.com")).toBe("GitHub");
  expect(two.latest().names.get("gitlab.com")).toBe("GitLab");
  await two.unmount();
});

it("counts hosts that are ON, not hosts that have a row", async () => {
  // A host switched off in Settings spawns nothing and holds no repos worth
  // distinguishing; two rows with one switch on is still one forge.
  answer([
    row({ host: "github.com" }),
    row({ host: "gitlab.com", kind: "gitlab", cli: "glab", enabled: false })
  ]);
  const probe = await mount();
  expect(probe.latest().showChips).toBe(false);
  await probe.unmount();
});

it("prefers the name the user gave a host", async () => {
  answer([
    row({ host: "github.com" }),
    row({
      host: "github.acme.huge-corp.southeast.us.corp",
      kindSource: "config",
      label: "Acme"
    })
  ]);
  const probe = await mount();
  expect(
    probe.latest().names.get("github.acme.huge-corp.southeast.us.corp")
  ).toBe("Acme");
  await probe.unmount();
});

it("re-reads when a host is renamed in another window", async () => {
  answer([
    row({ host: "github.com" }),
    row({ host: "ghe.acme.example", kindSource: "config" })
  ]);
  const probe = await mount();
  expect(probe.latest().names.get("ghe.acme.example")).toBe("acme");

  answer([
    row({ host: "github.com" }),
    row({ host: "ghe.acme.example", kindSource: "config", label: "Wile E." })
  ]);
  await act(async () => {
    handlers.get("settings:changed")?.(undefined);
  });
  expect(probe.latest().names.get("ghe.acme.example")).toBe("Wile E.");
  await probe.unmount();
});

it("re-reads when CLI enumeration lands after the window opened", async () => {
  // Enumeration is two subprocesses. The first window asks before they
  // finish, so without this event it would show no chips until something
  // else re-rendered it.
  answer([row({ host: "github.com" })]);
  const probe = await mount();
  expect(probe.latest().showChips).toBe(false);

  answer([
    row({ host: "github.com" }),
    row({ host: "gitlab.com", kind: "gitlab", cli: "glab" })
  ]);
  await act(async () => {
    handlers.get("forge:statusChanged")?.({ forges: [] });
  });
  expect(probe.latest().showChips).toBe(true);
  await probe.unmount();
});

it("keeps the same snapshot when a re-read changes nothing", async () => {
  // `useSyncExternalStore` re-renders on every new snapshot object, so a
  // rebuilt-but-equal map would repaint the whole sidebar on each settings
  // write.
  answer([
    row({ host: "github.com" }),
    row({ host: "gitlab.com", kind: "gitlab", cli: "glab" })
  ]);
  const probe = await mount();
  const before = probe.latest();
  await act(async () => {
    handlers.get("settings:changed")?.(undefined);
  });
  expect(probe.latest()).toBe(before);
  await probe.unmount();
});

it("never asks the CLIs to re-enumerate", async () => {
  // This runs on every settings write. `{ refresh: true }` would spawn both
  // CLIs each time somebody flipped an unrelated switch.
  answer([row({ host: "github.com" })]);
  const probe = await mount();
  expect(dispatch).toHaveBeenCalledWith("forge:hosts", {});
  await probe.unmount();
});
