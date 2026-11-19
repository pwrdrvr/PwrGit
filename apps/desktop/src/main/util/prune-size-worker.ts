import { parentPort, workerData } from "node:worker_threads";
import { directorySizeInWorker } from "./dir-size.ts";

const port = parentPort;
if (port === null) throw new Error("A prune sizing worker needs a parent port.");
const cancelled = workerData as Int32Array;

port.on("message", async (root: string) => {
  port.postMessage(await directorySizeInWorker(root, cancelled));
});
