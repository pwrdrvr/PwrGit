import { AgentConsentWindow } from "./features/settings/AgentConsentWindow";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppDocumentWindow } from "./features/documents/AppDocumentWindow";
import { LogsWindow } from "./features/logs/LogsWindow";
import { SettingsWindow } from "./features/settings/SettingsWindow";
import { startAppearanceSync } from "./lib/appearance";
import { startWindowFrameSync } from "./lib/window-frame";
import "./styles/app.css";

const container = document.getElementById("root");
if (container === null) throw new Error("root element not found");

// Window chrome is platform-specific: macOS traffic lights reserve space on
// the left; Windows caption buttons overlay the right side of our titlebar.
// Stamp this before React renders so the first frame uses the correct layout.
document.documentElement.dataset["platform"] = window.pwrgit.platform;

// Linux gives a window no frame of its own to be told apart from what sits
// behind it, so the app paints its own edge and has to know when the window is
// maximized and there is no edge left to draw. Every window kind starts this,
// the same way every one of them stamps the platform above.
startWindowFrameSync();

// Stamp the appearance axes on <html> before the first render, for every
// window kind — otherwise a non-default text size would flash at its default
// on each launch.
startAppearanceSync();

// Auxiliary windows boot on a hash route (PwrAgnt pattern): `#logs` renders
// the Logs window and `#settings` the Settings window instead of the app
// shell.
const hash = window.location.hash;

createRoot(container).render(
  <StrictMode>
    {hash === "#agent-consent" ? (
      <AgentConsentWindow />
    ) : hash === "#settings" ? (
      <SettingsWindow />
    ) : hash === "#logs" ? (
      <LogsWindow />
    ) : hash === "#document-license" ? (
      <AppDocumentWindow kind="license" />
    ) : hash === "#document-third-party-notices" ? (
      <AppDocumentWindow kind="third-party-notices" />
    ) : (
      <App />
    )}
  </StrictMode>
);
