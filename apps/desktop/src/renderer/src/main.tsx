import { AgentConsentWindow } from "./features/settings/AgentConsentWindow";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppDocumentWindow } from "./features/documents/AppDocumentWindow";
import { RootErrorFallback } from "./features/shell/ErrorFallbacks";
import { LogsWindow } from "./features/logs/LogsWindow";
import { SettingsWindow } from "./features/settings/SettingsWindow";
import { isSettingsHash } from "@pwrgit/shared";
import { startAppearanceSync } from "./lib/appearance";
import { ErrorBoundary } from "./lib/ErrorBoundary";
import {
  installRendererErrorReporting,
  rendererRootErrorOptions
} from "./lib/renderer-errors";
import { startWindowFrameSync } from "./lib/window-frame";
import "./styles/app.css";

// Before the setup calls below, so an error in any of them reaches the app
// log rather than only this window's DevTools console.
installRendererErrorReporting();

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
// shell. Settings also boots on a deep link, `#settings?page=…`, which
// `settings:open` mints for a window that is not open yet.
const hash = window.location.hash;

// The root options send every React error — uncaught, caught by a boundary,
// or recovered — to the app log with its component stack. The boundary is
// the last resort: without it, one render error unmounts the whole tree and
// leaves a blank window with nothing to click.
createRoot(container, rendererRootErrorOptions).render(
  <StrictMode>
    <ErrorBoundary
      fallback={({ error }) => (
        <RootErrorFallback error={error} showLogs={hash !== "#logs"} />
      )}
    >
      {hash === "#agent-consent" ? (
        <AgentConsentWindow />
      ) : isSettingsHash(hash) ? (
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
    </ErrorBoundary>
  </StrictMode>
);
