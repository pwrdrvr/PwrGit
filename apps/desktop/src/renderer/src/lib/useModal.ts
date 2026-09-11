import { useRef, type RefObject } from "react";
import { useDismissable } from "./useDismissable";
import { useFocusTrap } from "./useFocusTrap";

/**
 * The whole keyboard contract for a modal dialog, in one call.
 *
 * Every dialog in the app hand-rolled some subset of this and five had no
 * Escape at all, so the only way out was the mouse. Put the returned ref on the
 * `.modal` element and give it `role="dialog"` + `aria-modal="true"`; the rest
 * follows:
 *
 * - Escape closes, and only the innermost overlay answers, so a menu opened
 *   inside a dialog does not take the dialog down with it.
 * - Tab stays inside, which is what makes it a modal rather than a panel that
 *   happens to sit on top (SC 2.4.3).
 * - Focus enters on open and returns to whatever opened it on close.
 *
 * Dismissal here means "the user asked to leave". A dialog mid-flight (a push
 * running, a clone in progress) should pass an `onClose` that refuses, exactly
 * as its backdrop click already does — this hook does not decide that.
 */
export function useModal<T extends HTMLElement = HTMLDivElement>({
  onClose,
  initialFocusRef
}: {
  onClose: () => void;
  /** Where focus lands on open. Defaults to the first tabbable control. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}): RefObject<T | null> {
  const surfaceRef = useRef<T>(null);
  // A dialog has no trigger element to hand focus back to — useFocusTrap owns
  // the restore, because it captured the opener before focus moved inside.
  const noTrigger = useRef<HTMLElement | null>(null);

  useDismissable({
    open: true,
    onDismiss: onClose,
    triggerRef: noTrigger,
    surfaceRef
  });
  useFocusTrap({
    open: true,
    containerRef: surfaceRef,
    ...(initialFocusRef === undefined ? {} : { initialFocusRef })
  });

  return surfaceRef;
}
