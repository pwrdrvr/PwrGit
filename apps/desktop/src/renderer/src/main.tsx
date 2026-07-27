import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LogsWindow } from "./features/logs/LogsWindow";
import { SettingsWindow } from "./features/settings/SettingsWindow";
import "./styles/app.css";

const container = document.getElementById("root");
if (container === null) throw new Error("root element not found");

// Auxiliary windows boot on a hash route (PwrAgnt pattern): `#logs` renders
// the Logs window and `#settings` the Settings window instead of the app
// shell.
const hash = window.location.hash;

createRoot(container).render(
  <StrictMode>
    {hash === "#settings" ? (
      <SettingsWindow />
    ) : hash === "#logs" ? (
      <LogsWindow />
    ) : (
      <App />
    )}
  </StrictMode>
);
