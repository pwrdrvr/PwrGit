import { aroundAll, aroundEach } from "vitest";
import { getActWarningGuard } from "../../../../test-support/act-warning-guard";

// Renderer component tests use jsdom and React's act(). Tell React that act()
// is supported before any test module renders a component.
if (typeof document !== "undefined") {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const guard = getActWarningGuard();
  guard.install();
  // Vitest parses this parameter as fixture names and requires destructuring.
  aroundAll((runSuite, {}, suite) => guard.owners.run(suite, runSuite));
  aroundEach((runTest, { task }) => guard.owners.run(task, runTest));
}
