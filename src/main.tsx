import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Plusieurs fenêtres, un seul code :
// - "main"      = mon pet + le panneau Eggs
// - "pin-<ami>" = le pet épinglé d'un ami
// - "ground"    = la bande d'herbe décorative sur la barre des tâches
async function start() {
  const label = getCurrentWindow().label;

  const mod =
    label === "main"
      ? await import("./App")
      : label === "ground"
        ? await import("./pet/GroundView")
        : await import("./pet/PinnedWindow");
  const Root = mod.default;

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}

start();