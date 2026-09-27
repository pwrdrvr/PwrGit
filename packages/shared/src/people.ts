/**
 * The key main's people store and every renderer use for one commit author.
 *
 * It is the email, normalized exactly as the identity service normalizes it
 * before hashing an author-account cache key: forges link command-line commits
 * to accounts by email, so two spellings of a name are one person and one
 * address in two cases is one person too.
 */
export function commitAuthorPersonKey(email: string): string {
  return email.trim().normalize("NFC").toLowerCase();
}
