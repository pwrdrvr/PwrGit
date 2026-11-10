import { expect } from "@playwright/test";

/** A concurrent stash drop may remove refs/stash between Git's own reads. */
export async function expectEmptyStash(readStashes: () => string, timeout: number): Promise<void> {
  await expect(() => {
    expect(readStashes()).toBe("");
  }).toPass({ timeout });
}
