import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from "react";
import type { Extent } from "./image-layout";

/** Where the content box sits in the stage, and how big it is drawn. */
export type View = { scale: number; x: number; y: number };

const MIN_SCALE = 0.02;
const MAX_SCALE = 16;
/**
 * How far "Fit" may enlarge something smaller than the stage. A favicon opened
 * at 100% is a speck in a full-screen viewer, so fit grows it — but only so
 * far, because past this it is more blur than icon.
 */
const MAX_FIT_UPSCALE = 8;

export function fitScaleFor(stage: Extent, content: Extent): number {
  if (content.w <= 0 || content.h <= 0 || stage.w <= 0 || stage.h <= 0) return 1;
  const scale = Math.min(stage.w / content.w, stage.h / content.h);
  return Math.min(Math.max(scale, MIN_SCALE), MAX_FIT_UPSCALE);
}

/**
 * Keeps the picture reachable. Content smaller than the stage centres on that
 * axis — there is nothing to pan toward — and content larger than it cannot be
 * dragged so far that an edge comes inside the frame, which is how a viewer
 * ends up showing an empty stage with the image somewhere off to the left.
 */
export function clampView(view: View, stage: Extent, content: Extent): View {
  const axis = (pos: number, drawn: number, frame: number): number =>
    drawn <= frame
      ? (frame - drawn) / 2
      : Math.min(0, Math.max(frame - drawn, pos));
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale));
  return {
    scale,
    x: axis(view.x, content.w * scale, stage.w),
    y: axis(view.y, content.h * scale, stage.h)
  };
}

/**
 * One zoom-and-pan viewport over a fixed content box.
 *
 * The content box is the diff's REFERENCE extent, not any one revision's size,
 * so the same `view` frames the same region of before, after and the pixel
 * diff. Flipping between them at 300% therefore lands on the same pixels —
 * which is the only way a lightbox helps you find what changed.
 */
export function useZoomPan(content: Extent | null): {
  stageRef: RefObject<HTMLDivElement | null>;
  view: View;
  atFit: boolean;
  fit: () => void;
  actual: () => void;
  zoomBy: (factor: number) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  panning: boolean;
} {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<Extent>({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  // The gesture handlers are registered once and read the live view from here;
  // a stale closure mid-pinch snaps the picture back a frame at a time.
  const viewRef = useRef(view);
  viewRef.current = view;
  const stageRef2 = useRef(stage);
  stageRef2.current = stage;
  const contentRef = useRef(content);
  contentRef.current = content;
  // Fit once per content box, not on every resize — re-fitting under the user
  // while they are zoomed in throws away the region they were reading.
  const fitted = useRef<string | null>(null);

  useEffect(() => {
    const node = stageRef.current;
    if (node === null) return;
    const measure = () =>
      setStage({ w: node.clientWidth, h: node.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const commit = useCallback((next: View) => {
    const box = contentRef.current;
    if (box === null) return;
    setView(clampView(next, stageRef2.current, box));
  }, []);

  const fit = useCallback(() => {
    const box = contentRef.current;
    if (box === null) return;
    const scale = fitScaleFor(stageRef2.current, box);
    commit({ scale, x: 0, y: 0 });
  }, [commit]);

  const actual = useCallback(() => {
    const current = viewRef.current;
    const frame = stageRef2.current;
    // Zoom about the centre so "100%" lands on whatever was being looked at.
    const ratio = 1 / current.scale;
    commit({
      scale: 1,
      x: frame.w / 2 - (frame.w / 2 - current.x) * ratio,
      y: frame.h / 2 - (frame.h / 2 - current.y) * ratio
    });
  }, [commit]);

  const zoomAbout = useCallback(
    (factor: number, px: number, py: number) => {
      const current = viewRef.current;
      const scale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, current.scale * factor)
      );
      const ratio = scale / current.scale;
      commit({
        scale,
        x: px - (px - current.x) * ratio,
        y: py - (py - current.y) * ratio
      });
    },
    [commit]
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const frame = stageRef2.current;
      zoomAbout(factor, frame.w / 2, frame.h / 2);
    },
    [zoomAbout]
  );

  // Seed the view the moment the content box and the stage are both known.
  useEffect(() => {
    if (content === null || stage.w === 0) return;
    const key = `${content.w}x${content.h}`;
    if (fitted.current === key) return;
    fitted.current = key;
    fit();
  }, [content, stage.w, stage.h, fit]);

  // Trackpad. Registered natively because the listener must not be passive:
  // without preventDefault a pinch zooms the whole window instead.
  useEffect(() => {
    const node = stageRef.current;
    if (node === null) return;
    const onWheel = (event: WheelEvent) => {
      if (contentRef.current === null) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        zoomAbout(
          1 - event.deltaY / 240,
          event.clientX - rect.left,
          event.clientY - rect.top
        );
        return;
      }
      const current = viewRef.current;
      commit({
        ...current,
        x: current.x - event.deltaX,
        y: current.y - event.deltaY
      });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [commit, zoomAbout]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || contentRef.current === null) return;
      const node = event.currentTarget;
      node.setPointerCapture(event.pointerId);
      setPanning(true);
      let lastX = event.clientX;
      let lastY = event.clientY;
      const onMove = (move: PointerEvent) => {
        const current = viewRef.current;
        commit({
          ...current,
          x: current.x + (move.clientX - lastX),
          y: current.y + (move.clientY - lastY)
        });
        lastX = move.clientX;
        lastY = move.clientY;
      };
      const onUp = () => {
        setPanning(false);
        node.releasePointerCapture(event.pointerId);
        node.removeEventListener("pointermove", onMove);
        node.removeEventListener("pointerup", onUp);
        node.removeEventListener("pointercancel", onUp);
      };
      node.addEventListener("pointermove", onMove);
      node.addEventListener("pointerup", onUp);
      node.addEventListener("pointercancel", onUp);
    },
    [commit]
  );

  const atFit =
    content !== null &&
    Math.abs(view.scale - fitScaleFor(stage, content)) < 0.001;

  return { stageRef, view, atFit, fit, actual, zoomBy, onPointerDown, panning };
}
