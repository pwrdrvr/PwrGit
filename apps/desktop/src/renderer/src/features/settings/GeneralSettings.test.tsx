import {
  GENERAL_DEFAULTS,
  type AppSettingsSnapshot
} from "@pwrgit/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GeneralSettings } from "./GeneralSettings";

const snapshot = { general: GENERAL_DEFAULTS } as AppSettingsSnapshot;

function render(platform: string): string {
  return renderToStaticMarkup(
    <GeneralSettings
      saving={false}
      snapshot={snapshot}
      onThemeChange={() => undefined}
      onDeveloperModeChange={() => undefined}
      onSidebarTextSizeChange={() => undefined}
      onSidebarDensityChange={() => undefined}
      platform={platform}
    />
  );
}

describe("GeneralSettings developer shortcut copy", () => {
  it("preserves the native macOS menu chords", () => {
    expect(render("darwin")).toContain("⌘R, ⇧⌘R, ⌥⌘I");
  });

  it("names the Windows menu chords with Ctrl", () => {
    expect(render("win32")).toContain("Ctrl+R, Ctrl+Shift+R, Ctrl+Shift+I");
  });
});
