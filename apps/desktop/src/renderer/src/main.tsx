import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LogsWindow } from "./features/logs/LogsWindow";
import "./styles/app.css";

const container = document.getElementById("root");
if (container === null) throw new Error("root element not found");

// Auxiliary windows boot on a hash route (PwrAgnt pattern): `#logs` renders
// the Logs window instead of the app shell.
const isLogsWindow = window.location.hash === "#logs";

createRoot(container).render(
  <StrictMode>{isLogsWindow ? <LogsWindow /> : <App />}</StrictMode>
);
