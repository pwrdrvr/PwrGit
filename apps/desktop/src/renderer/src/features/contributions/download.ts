/** A local, explicit download. Nothing here leaves the machine. */
export function downloadFile(name: string, body: BlobPart, type: string): void {
  const url = URL.createObjectURL(
    body instanceof Blob ? body : new Blob([body], { type })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
