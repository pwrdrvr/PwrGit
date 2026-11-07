import type { Page } from "@playwright/test";

/** Resize through the real control. An out-of-band localStorage write can be
 * overwritten by useColumnResize's pending mount save before a reload lands. */
export async function setSidebarWidth(page: Page, px: number): Promise<void> {
  const resizer = page.getByRole("separator", { name: "Resize sidebar" });
  const box = await resizer.boundingBox();
  if (box === null) throw new Error("Sidebar resizer is not visible");
  const current = Number(await resizer.getAttribute("aria-valuenow"));
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  try {
    await page.mouse.move(x + px - current, y);
  } finally {
    await page.mouse.up();
  }
}
