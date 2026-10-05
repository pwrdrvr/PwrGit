/**
 * jsdom decodes no images and has no canvas. These stand in for the two
 * Chromium halves of a clipboard copy — `HTMLImageElement.decode` and the 2D
 * canvas — and record which URL each decode was fed, so a test can tie a
 * decode back to the Blob it was minted from (see object-urls.ts).
 */
export type CanvasStubs = {
  decodedFrom: string[];
  /** Make every later decode reject, as undecodable bytes would. */
  failDecodes: () => void;
  restore: () => void;
};

export function installCanvasStubs(): CanvasStubs {
  const decodedFrom: string[] = [];
  let fail = false;
  const originals = {
    decode: Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode"),
    getContext: Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext"),
    toBlob: Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "toBlob")
  };
  const define = (target: object, key: string, value: unknown) =>
    Object.defineProperty(target, key, { value, configurable: true, writable: true });

  define(HTMLImageElement.prototype, "decode", async function (this: HTMLImageElement) {
    decodedFrom.push(this.getAttribute("src") ?? "");
    if (fail) throw new Error("not an image");
  });
  // Every 2D call the copy path makes; a new one belongs here, once.
  define(HTMLCanvasElement.prototype, "getContext", () => ({
    drawImage: () => undefined,
    fillRect: () => undefined,
    fillText: () => undefined
  }));
  define(HTMLCanvasElement.prototype, "toBlob", function (callback: BlobCallback) {
    callback(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }));
  });

  return {
    decodedFrom,
    failDecodes: () => {
      fail = true;
    },
    restore: () => {
      const put = (target: object, key: string, had: PropertyDescriptor | undefined) => {
        if (had === undefined) Reflect.deleteProperty(target, key);
        else Object.defineProperty(target, key, had);
      };
      put(HTMLImageElement.prototype, "decode", originals.decode);
      put(HTMLCanvasElement.prototype, "getContext", originals.getContext);
      put(HTMLCanvasElement.prototype, "toBlob", originals.toBlob);
    }
  };
}
