// Connexions temps réel (WebSocket) : qui est en ligne, et comment lui écrire.

import type { WebSocket } from "ws";

const online = new Map<string, Set<WebSocket>>();

/** Ajoute une connexion. Renvoie true si l'utilisateur vient de passer en ligne
 *  (c'était sa première fenêtre connectée). */
export function addConnection(userId: string, ws: WebSocket): boolean {
  let set = online.get(userId);
  const wasOnline = !!set;
  if (!set) online.set(userId, (set = new Set()));
  set.add(ws);
  return !wasOnline;
}

/** Retire une connexion. Renvoie true si l'utilisateur vient de passer hors
 *  ligne (c'était sa dernière fenêtre connectée). */
export function removeConnection(userId: string, ws: WebSocket): boolean {
  const set = online.get(userId);
  if (!set) return false;
  set.delete(ws);
  if (set.size === 0) {
    online.delete(userId);
    return true;
  }
  return false;
}

export function isOnline(userId: string): boolean {
  return online.has(userId);
}

/** Envoie un événement à toutes les fenêtres connectées d'un utilisateur. */
export function push(userId: string, event: unknown) {
  const set = online.get(userId);
  if (!set) return;
  const data = JSON.stringify(event);
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(data);
}

/** Coupe toutes les connexions d'un utilisateur (code 4401 : l'application se déconnecte). */
export function closeUser(userId: string) {
  const set = online.get(userId);
  if (!set) return;
  for (const ws of [...set]) ws.close(4401, "Connexion requise");
}
