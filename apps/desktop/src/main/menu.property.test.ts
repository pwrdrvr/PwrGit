import Database from "better-sqlite3";
import fc from "fast-check";
import type { MenuItemConstructorOptions } from "electron";
import { expect, test, vi } from "vitest";

vi.mock("electron", () => ({ Menu: {} }));

const { buildAppMenuTemplate } = await import("./menu");

const labels = [
  "Settings…",
  "About PwrGit",
  "Check for Updates…",
  "Personal",
  "New Profile…",
  "Manage Profiles…",
  "Changelog",
  "Replay Onboarding…",
  "Copy Diagnostics Info",
  "Logs",
  "View License",
  "Third-Party Notices",
  "PwrGit Documentation"
] as const;
type Label = (typeof labels)[number];
type Click = { label: Label; interrupt: boolean };

// Model: menu gestures enter a FIFO queue. Each action runs exactly once,
// after the interrupted statement has returned, whether the gesture arrived
// normally or through inspector evaluation in the middle of a SQLite call.
async function checkDispatch(
  clicks: Click[],
  platform: NodeJS.Platform
): Promise<void> {
  const db = new Database(":memory:");
  const actual: string[] = [];
  const errors: unknown[] = [];
  const action = (label: Label) => () => {
    try {
      expect(db.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
      actual.push(label);
    } catch (error) {
      errors.push(error);
    }
  };
  const template = buildAppMenuTemplate({
    profiles: [{
      id: "personal",
      name: "Personal",
      email: "me@example.com",
      mono: "P",
      roots: [],
      onboardingCompleted: true,
      showInMenu: true
    }],
    currentProfileId: "personal",
    openProfileIds: ["personal"],
    developerMode: false,
    onOpenSettings: action("Settings…"),
    onAbout: action("About PwrGit"),
    onCheckForUpdates: action("Check for Updates…"),
    onOpenProfile: action("Personal"),
    onNewProfile: action("New Profile…"),
    onManageProfiles: action("Manage Profiles…"),
    onOpenChangelog: action("Changelog"),
    onReplayOnboarding: action("Replay Onboarding…"),
    onCopyDiagnostics: action("Copy Diagnostics Info"),
    onOpenLogs: action("Logs"),
    onOpenLicense: action("View License"),
    onOpenThirdPartyNotices: action("Third-Party Notices"),
    onOpenExternalLink: action("PwrGit Documentation")
  }, platform);
  const items = template.flatMap(menu =>
    (menu.submenu as MenuItemConstructorOptions[] | undefined) ?? []
  );
  const click = (label: Label) => {
    const item = items.find(item => item.label === label);
    expect(item?.click).toBeTypeOf("function");
    if (item?.click === undefined) throw new Error(`Missing menu action: ${label}`);
    (item.click as () => void)();
  };
  // A real SQLite callback supplies the same busy-connection boundary as
  // inspector evaluation, deterministically, without debugger timing/load.
  db.function("interrupt", (index: number) => {
    click(clicks[index]!.label);
    return index;
  });
  try {
    clicks.forEach(({ label, interrupt }, index) => {
      if (interrupt) {
        expect(db.prepare("SELECT interrupt(?) AS value").get(index)).toEqual({
          value: index
        });
      } else {
        click(label);
      }
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(errors).toEqual([]);
    expect(actual).toEqual(clicks.map(click => click.label));
  } finally {
    db.close();
  }
}

test("menu actions follow the dispatch model across SQLite interruptions", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(
      fc.record({ label: fc.constantFrom(...labels), interrupt: fc.boolean() }),
      { minLength: 1, maxLength: 30 }
    ),
    fc.constantFrom("darwin", "linux", "win32"),
    checkDispatch
  ));
});

test("Settings clicked inside a query waits until the query returns", async () => {
  await checkDispatch([{ label: "Settings…", interrupt: true }], "darwin");
});
