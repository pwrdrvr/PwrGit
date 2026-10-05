import { Component, type ReactNode } from "react";

export type ErrorFallbackProps = {
  error: unknown;
  /** Render the children again — for a "Try again" that might now work. */
  reset: () => void;
};

type Props = {
  children: ReactNode;
  fallback: (props: ErrorFallbackProps) => ReactNode;
  /** A side effect for the owner — close an overlay, raise a toast. Logging
   *  is not this prop's job: the root's `onCaughtError` reports every catch
   *  (lib/renderer-errors.ts), so a boundary cannot forget to. */
  onError?: (error: unknown) => void;
  /** The boundary clears itself when this changes, so pointing the pane at
   *  something else is a fresh attempt rather than the same fallback. */
  resetKey?: unknown;
};

type State = { resetKey: unknown } & (
  | { failed: false }
  | { failed: true; error: unknown }
);

/**
 * Keeps one broken surface from blanking the window. Without a boundary, an
 * error thrown while rendering unmounts React's whole root and leaves a white
 * window behind it. The thrown value can be anything, `null` included, hence
 * `failed` rather than testing `error` for presence.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { resetKey: this.props.resetKey, failed: false };

  // Derived during render rather than in componentDidUpdate, so a key change
  // whose own render throws is one failure, not a reset and a second throw.
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return Object.is(props.resetKey, state.resetKey)
      ? null
      : { resetKey: props.resetKey, failed: false };
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, error };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  private readonly reset = (): void => {
    this.setState({ failed: false });
  };

  override render(): ReactNode {
    return this.state.failed
      ? this.props.fallback({ error: this.state.error, reset: this.reset })
      : this.props.children;
  }
}

/** One line for a fallback or a toast: the message, not the stack. */
export function errorSummary(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  return "An unexpected error occurred.";
}
