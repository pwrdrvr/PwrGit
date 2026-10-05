/**
 * jsdom has no `URL.createObjectURL`. This stands in for it with a ledger, so
 * a test can ask both halves of the question blob URLs raise: which URLs were
 * minted (and from which Blob), and which were revoked. A picture whose `src`
 * is in `revoked` is one the page has already let go of.
 */
export type ObjectUrlLedger = {
  minted: Map<string, Blob>;
  revoked: string[];
  /** Minted and not yet revoked. */
  live: () => string[];
  restore: () => void;
};

type UrlStatics = {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
};

export function installObjectUrlLedger(): ObjectUrlLedger {
  const statics = URL as unknown as UrlStatics;
  const previous = {
    create: statics.createObjectURL,
    revoke: statics.revokeObjectURL
  };
  const minted = new Map<string, Blob>();
  const revoked: string[] = [];
  let next = 0;
  statics.createObjectURL = (blob: Blob) => {
    next += 1;
    const url = `blob:pwrgit-test/${next}`;
    minted.set(url, blob);
    return url;
  };
  statics.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  return {
    minted,
    revoked,
    live: () => [...minted.keys()].filter((url) => !revoked.includes(url)),
    restore: () => {
      if (previous.create === undefined) delete statics.createObjectURL;
      else statics.createObjectURL = previous.create;
      if (previous.revoke === undefined) delete statics.revokeObjectURL;
      else statics.revokeObjectURL = previous.revoke;
    }
  };
}
