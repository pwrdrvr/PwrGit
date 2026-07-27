import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SettingsWindow } from "./features/settings/SettingsWindow";
import "./styles/app.css";

const container = document.getElementById("root");
if (container === null) throw new Error("root element not found");

// Auxiliary windows boot on a hash route (PwrAgnt pattern): `#settings`
// renders the Settings window instead of the app shell.
const isSettingsWindow = window.location.hash === "#settings";

createRoot(container).render(
  <StrictMode>{isSettingsWindow ? <SettingsWindow /> : <App />}</StrictMode>
);
