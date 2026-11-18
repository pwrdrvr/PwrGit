/**
 * Keep keyboard focus on `el` while a change it caused lands.
 *
 * A menu command that moves its own trigger (Pin, Move up) gives focus back to
 * the trigger, then the list re-renders and React moves that node. Chromium
 * drops focus from a node it moves, so focus falls to `<body>` and a keyboard
 * reader loses their place (SC 2.4.3). The update can arrive frames later
 * (after main answers), so this watches for `ms` and puts focus back each
 * time it has fallen to `<body>`. It never takes focus from anything else:
 * once the reader moves on, it stops.
 */
export function holdFocus(el: HTMLElement, ms = 1000): void {
  const until = performance.now() + ms;
  const tick = (): void => {
    if (!el.isConnected) return;
    const active = document.activeElement;
    const fallen = active === null || active === document.body;
    if (!fallen && !el.contains(active)) return;
    if (fallen) el.focus({ preventScroll: true });
    if (performance.now() < until) window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}
