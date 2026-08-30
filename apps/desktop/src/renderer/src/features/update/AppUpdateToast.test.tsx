// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type AppUpdateStatus, type EventChannel } from "@pwrgit/shared";

const dispatchMock = vi.hoisted(() => vi.fn());
const subscribeMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/pwrgit", () => ({
  dispatch: dispatchMock,
  subscribe: subscribeMock
}));

import { AppUpdateToast } from "./AppUpdateToast";
import { dismissToast, subscribeToasts, type Toast } from "../../lib/toast";

type Handler = (payload: unknown) => void;

let handlers: Map<EventChannel, Handler[]>;
let container: HTMLDivElement;
let root: Root;
let toasts: Toast[];
let unsubscribeToasts: () => void;

function emit(channel: EventChannel, payload: unknown): Promise<void> {
  return act(async () => {
    for (const handler of handlers.get(channel) ?? []) handler(payload);
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label
  );
}

async function mount(initial: AppUpdateStatus): Promise<void> {
  dispatchMock.mockImplementation((name: string) =>
    Promise.resolve(
      name === "app:readUpdateStatus" ? ok(initial) : ok({ status: "restarting" })
    )
  );
  await act(async () => {
    root.render(<AppUpdateToast />);
  });
}

beforeEach(() => {
  handlers = new Map();
  subscribeMock.mockImplementation((channel: EventChannel, handler: Handler) => {
    handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
    return () => {
      handlers.set(
        channel,
        (handlers.get(channel) ?? []).filter((entry) => entry !== handler)
      );
    };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // The toast store is module state shared by every test in this file, and
  // subscribing hands over whatever it already holds — clear that first.
  toasts = [];
  unsubscribeToasts = subscribeToasts((next) => {
    toasts = next;
  });
  for (const toast of [...toasts]) dismissToast(toast.id);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  unsubscribeToasts();
  vi.clearAllMocks();
});

describe("AppUpdateToast", () => {
  it("stays out of the way until an update is downloaded", async () => {
    await mount({ status: "idle" });
    expect(container.textContent).toBe("");

    await emit("app:updateStatus", { status: "downloading", version: "0.9.0" });
    expect(container.textContent).toBe("");

    await emit("app:updateStatus", { status: "downloaded", version: "0.9.0" });
    expect(container.textContent).toContain("Update ready");
    expect(container.textContent).toContain("Restart to update to v0.9.0.");
  });

  it("shows a downloaded update that landed before the window mounted", async () => {
    await mount({ status: "downloaded", version: "0.9.0" });
    expect(container.textContent).toContain("Restart to update to v0.9.0.");
  });

  it("restarts through the install command and reports its refusal", async () => {
    await mount({ status: "downloaded", version: "0.9.0" });
    dispatchMock.mockResolvedValue(
      ok({ status: "error", message: "Dev preview (v420.0.0): no." })
    );

    await act(async () => button("Restart")?.click());

    expect(dispatchMock).toHaveBeenLastCalledWith(
      "app:installUpdate",
      undefined
    );
    expect(container.textContent).toContain("Dev preview (v420.0.0): no.");
    expect(button("Restart")?.disabled).toBe(false);
  });

  it("keeps a dismissal until a newer version is offered", async () => {
    await mount({ status: "downloaded", version: "0.9.0" });

    await act(async () => button("Dismiss")?.click());
    expect(container.textContent).toBe("");

    await emit("app:updateStatus", { status: "downloaded", version: "0.9.0" });
    expect(container.textContent).toBe("");

    await emit("app:updateStatus", { status: "downloaded", version: "1.0.0" });
    expect(container.textContent).toContain("Restart to update to v1.0.0.");
  });

  it("brings a dismissed update back when the user asks the menu again", async () => {
    await mount({ status: "downloaded", version: "0.9.0" });
    await act(async () => button("Dismiss")?.click());
    expect(container.textContent).toBe("");

    await emit("app:updateCheckResult", {
      status: "downloaded",
      version: "0.9.0"
    });

    expect(container.textContent).toContain("Restart to update to v0.9.0.");
    expect(toasts).toHaveLength(0);
  });

  it("replaces its own checking notice with the menu check outcome", async () => {
    await mount({ status: "idle" });

    await emit("app:updateCheckResult", { status: "checking" });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe("Checking for updates");

    await emit("app:updateCheckResult", {
      status: "no-update",
      version: "0.8.0"
    });

    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title).toBe("PwrGit is up to date");
    expect(toasts[0]?.message).toBe("You’re running v0.8.0.");
    // Nothing is broken, so the toast doesn't offer Logs / Copy.
    expect(toasts[0]?.showLogsAction).toBe(false);
  });

  it("reports a failed menu check as an error toast", async () => {
    await mount({ status: "idle" });

    await emit("app:updateCheckResult", {
      status: "error",
      message: "GitHub releases request failed with 404"
    });

    expect(toasts[0]?.title).toBe("Update check failed");
    expect(toasts[0]?.showLogsAction).toBe(true);
  });
});
