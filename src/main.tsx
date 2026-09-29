import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Plusieurs fenêtres, un seul code :
// - "main"   = mon pet + le panneau Eggs
// - "pets"   = fenêtre partagée pour TOUTES les créatures posées sur l'herbe
//              (amis épinglés + mes propres créatures) — depuis le
//              29/09/2026, remplace l'ancienne fenêtre par créature
//              ("pin-<id>", routée vers pet/PinnedWindow.tsx, désormais
//              obsolète — voir ce fichier) : voir pet/GroundPetsWindow.tsx
//              et setup_pets côté Rust pour le pourquoi de ce changement.
// - "ground" = la bande d'herbe décorative sur la barre des tâches
// - "toast"  = la petite carte "nouveau message" (voir data/notifications.ts)
async function start() {
  const label = getCurrentWindow().label;

  const mod =
    label === "main"
      ? await import("./App")
      : label === "ground"
        ? await import("./pet/GroundView")
        : label === "toast"
          ? await import("./pet/ToastWindow")
          : await import("./pet/GroundPetsWindow");
  const Root = mod.default;

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  );
}

start();