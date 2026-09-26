/** Up to two initials, "?" for a blank name. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

/**
 * A commit author's face: initials, with the proven GitHub avatar painted over
 * them when there is one. The initials stay underneath rather than being
 * swapped out, so a thumbnail that fails to decode simply hides and leaves them
 * showing — no second render, no empty circle.
 *
 * `block` names the classes (`${block}`, `${block}-initials`,
 * `${block}-image`) so the lineage row and the commit context card can size it
 * independently. Decorative: the name is always beside it or on its card.
 */
export function AuthorAvatar({
  block,
  name,
  avatarUrl,
  size
}: {
  block: string;
  name: string;
  /** Only a local `pwrgit-avatar://` thumbnail from a proven identity. */
  avatarUrl: string | undefined;
  size: number;
}) {
  return (
    <span className={block} aria-hidden="true">
      <span className={`${block}-initials`}>{initials(name)}</span>
      {avatarUrl !== undefined ? (
        <img
          className={`${block}-image`}
          src={avatarUrl}
          alt=""
          width={size}
          height={size}
          decoding="sync"
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.hidden = true;
          }}
        />
      ) : null}
    </span>
  );
}
