// Renderer component tests use jsdom and React's act(). Tell React that act()
// is supported before any test module renders a component.
if (typeof document !== "undefined") {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}
