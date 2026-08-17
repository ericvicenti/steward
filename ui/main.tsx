import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Token arrives via `steward open` as #t=..., then persists in localStorage.
const hashToken = new URLSearchParams(location.hash.slice(1)).get("t");
if (hashToken) {
  localStorage.setItem("steward-token", hashToken);
  history.replaceState(null, "", location.pathname);
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
