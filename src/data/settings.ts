// Réglages personnels (case à cocher dans Personnaliser > Réglages).
// Mémorisés sur cet ordinateur, et transmis à Rust (qui gère vraiment
// l'affichage des fenêtres) à chaque changement.
// Pour ajouter un réglage : une ligne dans Settings, dans DEFAULT_SETTINGS,
// dans load(), un setter, et la commande Rust correspondante dans lib.rs.

import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface Settings {
  showGround: boolean; // afficher l'herbe sur la barre des tâches
  pinnedOnDesktop: boolean; // ma créature reste toujours affichée (ne repart jamais)
}

export const DEFAULT_SETTINGS: Settings = {
  showGround: true,
  pinnedOnDesktop: false,
};

const STORAGE_KEY = "eggs.settings";

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return {
        showGround:
          typeof saved.showGround === "boolean" ? saved.showGround : DEFAULT_SETTINGS.showGround,
        pinnedOnDesktop:
          typeof saved.pinnedOnDesktop === "boolean"
            ? saved.pinnedOnDesktop
            : DEFAULT_SETTINGS.pinnedOnDesktop,
      };
    }
  } catch {
    // pas grave : on prend les réglages par défaut
  }
  return DEFAULT_SETTINGS;
}

let settings: Settings = load();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function apply(next: Settings) {
  settings = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // pas grave
  }
  listeners.forEach((listener) => listener());
}

/** Hook React : renvoie les réglages actuels et se met à jour tout seul. */
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, () => settings);
}

/** Envoie l'état actuel des réglages à Rust (au montage de la fenêtre « main »). */
export function syncSettingsToBackend() {
  invoke("set_show_ground", { on: settings.showGround }).catch(console.error);
}

export function setShowGround(on: boolean) {
  apply({ ...settings, showGround: on });
  invoke("set_show_ground", { on }).catch(console.error);
}

/**
 * Épinglée sur le bureau : ma créature reste toujours affichée, même quand
 * la souris s'éloigne (voir App.tsx : ignore les ZONE_LEAVE tant que c'est
 * activé). Purement côté app — pas besoin de Rust ici, contrairement aux
 * autres réglages ci-dessous.
 */
export function setPinnedOnDesktop(on: boolean) {
  apply({ ...settings, pinnedOnDesktop: on });
}

/**
 * Démarrage automatique avec Windows : l'état vient de Rust (pas mémorisé
 * ici), pour toujours refléter la vraie configuration du système — y
 * compris si elle a été changée ailleurs (icône de la zone de notification).
 */
export function useAutostart(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_autostart").then(setOn).catch(console.error);
  }, []);

  const set = (next: boolean) => {
    setOn(next);
    invoke("set_autostart", { on: next }).catch(console.error);
  };

  return [on, set];
}

/**
 * Mode réunion : l'état vient de Rust et n'est JAMAIS mémorisé ici
 * (volontairement) — l'app repart toujours avec ce réglage désactivé, pour
 * ne jamais rouvrir sur une créature cachée sans qu'on l'ait redemandé.
 * Peut aussi se désactiver depuis l'icône d'Eggs dans la zone de notification.
 */
export function useMeetingMode(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_meeting_mode").then(setOn).catch(console.error);
  }, []);

  const set = (next: boolean) => {
    setOn(next);
    invoke("set_meeting_mode", { on: next }).catch(console.error);
  };

  return [on, set];
}

/**
 * Masquer automatiquement en plein écran : l'état vient de Rust et n'est
 * JAMAIS mémorisé ici (volontairement) — l'app repart toujours avec ce
 * réglage désactivé. C'est une détection automatique qui peut se tromper
 * (voir AUTO_HIDE_ITEM côté Rust) ; ne pas la mémoriser évite qu'un mauvais
 * déclenchement revienne tout seul au prochain lancement. Peut aussi se
 * couper depuis l'icône d'Eggs dans la zone de notification.
 */
export function useAutoHideFullscreen(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_auto_hide_fullscreen").then(setOn).catch(console.error);
  }, []);

  const set = (next: boolean) => {
    setOn(next);
    invoke("set_auto_hide_fullscreen", { on: next }).catch(console.error);
  };

  return [on, set];
}
