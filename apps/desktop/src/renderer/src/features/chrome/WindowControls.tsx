import {
  useCallback,
  useSyncExternalStore,
  type ReactElement
} from "react";
import type { WindowControlAction } from "@pwrgit/shared";
import {
  isWindowMaximized,
  subscribeWindowFrame
} from "../../lib/window-frame";

/** One glyph geometry for all three buttons, so their weights match. */
const glyph = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round",
  strokeLinejoin: "round"
} as const;

/**
 * Linux caption buttons, painted into the strip.
 *
 * macOS hands us its traffic lights and Windows fills the Window Controls
 * Overlay it reserves at the right edge; Linux has neither in a frameless
 * window, so a window with a hidden title bar has no minimize, maximize or
 * close at all unless we draw them. Right-hand side, GNOME's order and
 * roundness — that is where Ubuntu puts them.
 *
 * The maximize glyph follows the window rather than the last click: a
 * double-click on the drag region, Super+Up or a tiling keybind all maximize
 * behind our back, and main pushes those through `onWindowFrameState`.
 */
export function WindowControls(): ReactElement {
  // The window's own maximize events are the truth, not this button's last
  // click: `maximize()` that the WM refuses fires nothing, and a maximize from
  // anywhere else fires all the same.
  const maximized = useSyncExternalStore(
    subscribeWindowFrame,
    isWindowMaximized,
    isWindowMaximized
  );

  const run = useCallback((action: WindowControlAction): void => {
    void window.pwrgit.runWindowControl(action);
  }, []);

  return (
    <div className="titlebar__controls">
      <button
        type="button"
        className="titlebar__control"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => run("minimize")}
      >
        <svg {...glyph}>
          <path d="M4 8h8" />
        </svg>
      </button>
      <button
        type="button"
        className="titlebar__control"
        aria-label={maximized ? "Restore" : "Maximize"}
        title={maximized ? "Restore" : "Maximize"}
        onClick={() => run("toggle-maximize")}
      >
        <svg {...glyph}>
          {maximized ? (
            <>
              <rect x="3.5" y="6" width="6.5" height="6.5" rx="1.2" />
              <path d="M6 3.5h4.5A2 2 0 0 1 12.5 6v4.5" />
            </>
          ) : (
            <rect x="4" y="4" width="8" height="8" rx="1.4" />
          )}
        </svg>
      </button>
      <button
        type="button"
        className="titlebar__control titlebar__control--close"
        aria-label="Close"
        title="Close"
        onClick={() => run("close")}
      >
        <svg {...glyph}>
          <path d="m4.6 4.6 6.8 6.8M11.4 4.6l-6.8 6.8" />
        </svg>
      </button>
    </div>
  );
}
