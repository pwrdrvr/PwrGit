import { useEffect, useState } from "react";

/**
 * Whether this window is maximized, kept in step with the window itself.
 *
 * Two surfaces need the answer and neither can ask the DOM for it: the
 * maximize button has to draw the right glyph, and the Linux window hairline
 * has to disappear once the frame is flush with the screen edges. The window
 * manager maximizes windows without going through our buttons — a double-click
 * on the drag region, Super+Up, a tiling keybind — so main pushes the changes
 * and this follows them.
 *
 * The state is also stamped on `<html>` as `data-window-frame`, because the
 * hairline is a stylesheet's business, not a component's.
 */
export function useWindowFrameState(): boolean {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.pwrgit.readWindowFrameState().then((state) => {
      if (!cancelled && state !== null) setMaximized(state.maximized);
    });
    const stopListening = window.pwrgit.onWindowFrameState((state) => {
      setMaximized(state.maximized);
    });
    return () => {
      cancelled = true;
      stopListening();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset["windowFrame"] = maximized
      ? "maximized"
      : "restored";
    return () => {
      delete document.documentElement.dataset["windowFrame"];
    };
  }, [maximized]);

  return maximized;
}
