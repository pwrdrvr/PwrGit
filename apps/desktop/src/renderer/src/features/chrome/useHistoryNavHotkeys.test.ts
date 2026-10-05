// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { matchHistoryNavChord } from "./useHistoryNavHotkeys";

const key = (
  partial: Partial<Parameters<typeof matchHistoryNavChord>[0]>
): Parameters<typeof matchHistoryNavChord>[0] => ({
  altKey: false,
  code: "",
  ctrlKey: false,
  key: "",
  metaKey: false,
  shiftKey: false,
  target: document.body,
  ...partial
});

describe("matchHistoryNavChord", () => {
  it("takes ⌘[ / ⌘] on macOS and Ctrl+[ / Ctrl+] elsewhere", () => {
    expect(
      matchHistoryNavChord(key({ metaKey: true, code: "BracketLeft" }), "darwin")
    ).toBe("back");
    expect(
      matchHistoryNavChord(key({ metaKey: true, code: "BracketRight" }), "darwin")
    ).toBe("forward");
    expect(
      matchHistoryNavChord(key({ ctrlKey: true, code: "BracketLeft" }), "darwin")
    ).toBeNull();
    expect(
      matchHistoryNavChord(key({ ctrlKey: true, code: "BracketLeft" }), "win32")
    ).toBe("back");
    expect(
      matchHistoryNavChord(
        key({ ctrlKey: true, metaKey: true, code: "BracketLeft" }),
        "win32"
      )
    ).toBeNull();
  });

  it("leaves ⌘⇧[ alone — that chord is a tab switch elsewhere", () => {
    expect(
      matchHistoryNavChord(
        key({ metaKey: true, shiftKey: true, code: "BracketLeft" }),
        "darwin"
      )
    ).toBeNull();
  });

  it("takes ⌥← / ⌥→ only outside text fields, where they move by word", () => {
    expect(
      matchHistoryNavChord(key({ altKey: true, key: "ArrowLeft" }), "darwin")
    ).toBe("back");
    const input = document.createElement("input");
    expect(
      matchHistoryNavChord(
        key({ altKey: true, key: "ArrowLeft", target: input }),
        "darwin"
      )
    ).toBeNull();
    // Bracket chords stay live inside inputs, as PwrAgnt's do.
    expect(
      matchHistoryNavChord(
        key({ metaKey: true, code: "BracketLeft", target: input }),
        "darwin"
      )
    ).toBe("back");
  });
});
