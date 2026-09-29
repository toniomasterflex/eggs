// Signal "nouveau message" pour la petite carte flottante maison (voir
// pet/ToastWindow.tsx), à la place d'une notification Windows classique —
// jugée trop "alerte système", pas dans l'esprit de l'appli.
//
// Ce fichier tourne dans TOUTES les fenêtres (importé par store.ts, comme
// tout le reste), mais ne fait quoi que ce soit que dans la fenêtre "toast"
// elle-même : les autres (main, pin-<ami>...) n'ont pas de carte à afficher,
// donc tout ici est un no-op ailleurs (voir isToastWindow).
//
// Volontairement discret, comme demandé :
//   - un seul avis groupé si plusieurs messages arrivent d'affilée avant
//     qu'on regarde, pas un par message qui s'empile ;
//   - jamais de nom d'expéditeur ni d'aperçu du texte dedans, juste
//     « Nouveau message » / « X nouveaux messages » ;
//   - coupé pendant le Mode réunion (voir settings.ts / get_meeting_mode
//     côté Rust — revérifié à l'affichage, pas à la réception) ;
//   - coupé aussi si le pet épinglé de cet ami est actuellement à l'écran
//     (voir pin_is_active côté Rust) : sa bulle de bande dessinée (voir
//     store.ts : onLiveMessage / pet/PinnedWindow.tsx) fait déjà l'annonce,
//     pas la peine de la carte en plus ;
//   - coupé aussi si SA propre créature (celle de l'ami, pas la nôtre)
//     n'est pas épinglée mais qu'une de MES créatures l'est (voir
//     self_pin_active côté Rust) : la bulle apparaît alors sur ma créature
//     plutôt que sur la sienne (voir PinnedWindow.tsx), toujours pas de
//     doublon avec la carte ;
//   - annulé dès que la conversation est lue, MÊME depuis une autre fenêtre
//     (le bouton d'un ami épinglé peut ouvrir sa propre conversation) —
//     voir store.ts : case "read", qui arrive ici via le serveur quelle que
//     soit la fenêtre qui a fait la lecture (voir server/src/index.ts).

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const GROUP_DELAY_MS = 1500; // fenêtre de regroupement avant d'afficher la carte

function isToastWindow(): boolean {
  try {
    return getCurrentWindow().label === "toast";
  } catch {
    return false;
  }
}

type ToastHandler = (text: string) => void;
const toastHandlers = new Set<ToastHandler>();

/** ToastWindow.tsx : prévient quand afficher la carte, avec le texte déjà prêt. */
export function onToast(handler: ToastHandler) {
  toastHandlers.add(handler);
  return () => {
    toastHandlers.delete(handler);
  };
}

const pending = new Map<string, { count: number; timer: number }>();

/** Un message vient d'arriver de `friendId`. Regroupe avec les suivants
 *  pendant GROUP_DELAY_MS avant d'annoncer, pour éviter une carte par
 *  message. */
export function notifyNewMessage(friendId: string) {
  if (!isToastWindow()) return;
  const entry = pending.get(friendId);
  if (entry) {
    entry.count += 1;
    return; // le timer déjà lancé s'en chargera
  }
  const timer = window.setTimeout(() => void flush(friendId), GROUP_DELAY_MS);
  pending.set(friendId, { count: 1, timer });
}

/** La conversation vient d'être lue (ici ou ailleurs) : ce qui restait à
 *  annoncer n'a plus lieu d'être. */
export function cancelPendingNotification(friendId: string) {
  if (!isToastWindow()) return;
  const entry = pending.get(friendId);
  if (!entry) return;
  window.clearTimeout(entry.timer);
  pending.delete(friendId);
}

async function flush(friendId: string) {
  const entry = pending.get(friendId);
  pending.delete(friendId);
  if (!entry) return;

  try {
    const meeting = await invoke<boolean>("get_meeting_mode");
    if (meeting) return;
  } catch {
    // pas grave : au pire on annonce quand même
  }

  try {
    const pinnedVisible = await invoke<boolean>("pin_is_active", { friendId });
    if (pinnedVisible) return; // déjà annoncé par sa bulle
  } catch {
    // pas grave : au pire on annonce en double
  }

  try {
    const mineVisible = await invoke<boolean>("self_pin_active");
    if (mineVisible) return; // déjà annoncé sur ma propre créature
  } catch {
    // pas grave : au pire on annonce en double
  }

  const text = entry.count > 1 ? `${entry.count} nouveaux messages` : "Nouveau message";
  toastHandlers.forEach((h) => h(text));
}
