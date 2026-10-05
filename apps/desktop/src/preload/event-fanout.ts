/**
 * Server events reach the renderer over ONE IPC channel: main sends
 * `(eventChannel, payload)` on `IPC_EVENT_CHANNEL` for every channel there is.
 * Registering an `ipcRenderer` listener per subscription would make every
 * event run every subscriber's channel filter, and a window legitimately
 * holds dozens of subscriptions at once (about 40 with one repo open, plus one
 * per expanded sidebar repo) — well past EventEmitter's leak warning at 10.
 *
 * So the preload registers a single listener and routes by channel here. An
 * event costs only the subscribers of its own channel, and the IPC listener
 * count is 1 however many subscriptions there are.
 */

type Handler = (payload: unknown) => void;

/** The slice of `ipcRenderer` this needs; an EventEmitter in tests. */
export type IpcEventSource = {
  on(
    channel: string,
    listener: (event: unknown, eventChannel: unknown, payload: unknown) => void
  ): unknown;
};

export function createEventFanout(
  ipc: IpcEventSource,
  ipcChannel: string,
  // A throwing subscriber must not starve the ones after it, but must still
  // surface: rethrown on its own turn, it reaches the console as uncaught.
  reportError: (error: unknown) => void = (error) =>
    queueMicrotask(() => {
      throw error;
    })
): (channel: string, handler: Handler) => () => void {
  const subscribers = new Map<string, Set<Handler>>();

  ipc.on(ipcChannel, (_event, eventChannel, payload) => {
    const current = subscribers.get(eventChannel as string);
    if (current === undefined) return;
    // A snapshot, so a subscriber added by a handler waits for the next event;
    // the `has` check, so one removed by a handler gets nothing more.
    for (const handler of [...current]) {
      if (!current.has(handler)) continue;
      try {
        handler(payload);
      } catch (error) {
        reportError(error);
      }
    }
  });

  return (channel, handler) => {
    // Wrapped, so each subscription is its own entry: the same function
    // subscribed twice is called twice, and either unsubscribe drops only its own.
    const entry: Handler = (payload) => handler(payload);
    let current = subscribers.get(channel);
    if (current === undefined) {
      current = new Set();
      subscribers.set(channel, current);
    }
    current.add(entry);
    return () => {
      const set = subscribers.get(channel);
      if (set === undefined || !set.delete(entry)) return;
      if (set.size === 0) subscribers.delete(channel);
    };
  };
}
