import { describe, expect, it } from "vitest";
import { RESCAN_FOLDERS_TOAST_KEY, rescanFoldersToast } from "./rescan-folders";

const repo = (name: string) => ({ id: `id-${name}`, name });

describe("rescanFoldersToast", () => {
  it("says the folders were looked through when nothing is new", () => {
    expect(rescanFoldersToast([], 4)).toMatchObject({
      key: RESCAN_FOLDERS_TOAST_KEY,
      title: "No new repositories",
      message: "Looked through 4 folders. Everything there is already listed."
    });
    expect(rescanFoldersToast([], 1).message).toContain("1 folder.");
  });

  it("names one new repository and gives it the chip that goes there", () => {
    const toast = rescanFoldersToast([repo("rgit")], 4);
    expect(toast.title).toBe("New repository");
    expect(toast.message).toBe("Found in your 4 folders and added to the sidebar.");
    expect(toast.subject).toEqual({ repoId: "id-rgit" });
    expect(toast.key).toBe(RESCAN_FOLDERS_TOAST_KEY);
  });

  it("names up to four and counts the rest", () => {
    expect(rescanFoldersToast(["a", "b"].map(repo), 2)).toMatchObject({
      title: "2 new repositories",
      message: "a, b."
    });
    const many = rescanFoldersToast(["a", "b", "c", "d", "e", "f"].map(repo), 2);
    expect(many.message).toBe("a, b, c, d and 2 more.");
    expect(many.subject).toBeUndefined();
  });
});
