import { useEffect, useRef, useState } from "react";
import { onToast } from "../data/notifications";
// Import "pour l'effet de bord" : c'est store.ts qui ouvre la connexion au
// serveur (WebSocket) et qui appelle notifyNewMessage/cancelPendingNotification
// à la réception d'un message — rien de tout ça ne se déclenche si ce
// fichier n'est jamais chargé dans CETTE fenêtre (chaque fenêtre Tauri a son
// propre contexte JS, voir data/realtime.ts : une connexion par fenêtre).
import "../data/store";
import "../App.css"; // fond transparent (html/body/#root)
import "./toast.css";

// Fenêtre dédiée (voir setup_toast côté Rust) : une petite carte maison pour
// annoncer un nouveau message, posée en bas-droite de l'écran — à la place
// d'une notification Windows classique, jugée trop "alerte système" pour
// l'esprit de l'appli. Aucune interaction : on la voit, on n'a rien à en
// faire (cohérent avec le "pas de pression" du reste d'Eggs) ; le petit
// point sur le bouton du menu reste le seul endroit qui persiste.
const VISIBLE_MS = 4000;

type Phase = "in" | "out";

export default function ToastWindow() {
  const [phase, setPhase] = useState<Phase | null>(null);
  const [text, setText] = useState("");
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(
    () =>
      onToast((t) => {
        window.clearTimeout(hideTimer.current);
        setText(t);
        setPhase("in");
        hideTimer.current = window.setTimeout(() => setPhase("out"), VISIBLE_MS);
      }),
    [],
  );

  if (!phase) return null;

  return (
    <div className="toast-card" data-phase={phase}>
      <span className="toast-dot" aria-hidden="true" />
      <span className="toast-text">{text}</span>
    </div>
  );
}
