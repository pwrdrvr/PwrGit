export function DiffStat({
  additions,
  deletions
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <span className="diff-stat" aria-label={`+${additions} −${deletions}`}>
      <span className="diff-stat__add">+{additions}</span>
      <span className="diff-stat__del">−{deletions}</span>
    </span>
  );
}
