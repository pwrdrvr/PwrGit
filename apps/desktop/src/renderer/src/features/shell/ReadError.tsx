export function ReadError(props: {
  title: string;
  message: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={`read-error${props.compact === true ? " read-error--compact" : ""}`}
      role="alert"
    >
      <div className="read-error__copy">
        <strong>{props.title}</strong>
        <span>{props.message}</span>
      </div>
      <button className="read-error__retry" type="button" onClick={props.onRetry}>
        Try again
      </button>
    </div>
  );
}
