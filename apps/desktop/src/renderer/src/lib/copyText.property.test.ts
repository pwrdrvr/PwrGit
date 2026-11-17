// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { copyTextAsCodeBlock } from "./copyText";

afterEach(() => { Reflect.deleteProperty(navigator, "clipboard"); vi.unstubAllGlobals(); });

it("preserves literal text and supplies an escaped code block, with plain-text fallback", async () => {
  vi.stubGlobal("Blob", NodeBlob);
  let content: Record<string, NodeBlob> = {};
  vi.stubGlobal("ClipboardItem", class {
    constructor(items: Record<string, NodeBlob>) { content = items; }
  });
  await fc.assert(fc.asyncProperty(fc.string(), fc.boolean(), async (value, fails) => {
    const text = `<profile>&\n${value}`;
    const write = vi.fn(async () => { if (fails) throw new Error("rich clipboard unavailable"); });
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write, writeText } });
    await copyTextAsCodeBlock(text);
    expect(write).toHaveBeenCalledOnce();
    if (fails) expect(writeText).toHaveBeenCalledExactlyOnceWith(text);
    else {
      expect(writeText).not.toHaveBeenCalled();
      expect(await content["text/plain"]!.text()).toBe(text);
      const html = await content["text/html"]!.text();
      const container = document.createElement("div");
      container.innerHTML = html;
      expect(container.querySelectorAll("pre > code")).toHaveLength(1);
      expect(container.querySelector("code")!.childElementCount).toBe(0);
      // HTML normalizes CR and null characters; the plain-text flavor above
      // preserves the exact original, including those characters.
      expect(container.textContent).toBe(text.replace(/\r\n?/g, "\n").replace(/\0/g, "\ufffd"));
    }
  }));
});
