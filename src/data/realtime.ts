// Temps réel : connexion WebSocket au serveur.
//
// Deux sortes de choses passent par ici :
//   - les événements du serveur (nouveau message, ami ajouté...) -> onEvent
//   - les interactions entre créatures (un clic sur un pet) -> onInteraction / interact
//
// Une interaction n'est PAS un message : pas de notification, rien n'est
// enregistré. Si la créature visée est cachée quand elle arrive, elle est perdue.
//
// Principe : une créature appartient à son propriétaire (la « cible »). Quand
// quelqu'un clique dessus, elle réagit chez TOUS ceux qui l'affichent.
//   - je clique sur ma créature      -> cible « me »  (chez mes amis, elle saute)
//   - je clique sur celle d'un ami   -> cible = cet ami (chez lui et chez moi)
//   - un ami clique sur ma créature  -> reçu ici, cible « me »
//
// La position de la souris n'est JAMAIS envoyée : seulement « j'ai cliqué sur X ».

import { WS_URL } from "./api";
import { clearSession, getSession } from "./session";

export type InteractionKind = "poke";

/** Cible « ma créature à moi ». Les autres cibles sont des identifiants d'amis. */
export const ME = "me";

export interface PetInteraction {
  from: string; // qui a cliqué
  target: string; // la créature qui réagit : « me » ou l'identifiant d'un ami
  kind: InteractionKind;
  at: number;
}

/** Événement brut envoyé par le serveur. */
export interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

/** État de la connexion au serveur (pour afficher un petit signal si elle est coupée). */
export type ConnStatus = "connecting" | "online" | "offline";

type InteractionHandler = (interaction: PetInteraction) => void;
type EventHandler = (event: ServerEvent) => void;
type StatusHandler = (status: ConnStatus) => void;

const interactionHandlers = new Set<InteractionHandler>();
const eventHandlers = new Set<EventHandler>();
const statusHandlers = new Set<StatusHandler>();

let socket: WebSocket | null = null;
let token: string | null = null;
let retryTimer: number | undefined;
let attempt = 0;
let status: ConnStatus = "offline";

function setStatus(next: ConnStatus) {
  if (status === next) return;
  status = next;
  statusHandlers.forEach((h) => h(status));
}

function open() {
  if (!token) return;
  setStatus("connecting");
  const ws = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(token)}`);
  socket = ws;

  ws.onopen = () => {
    attempt = 0;
    setStatus("online");
  };

  ws.onmessage = (e) => {
    let event: ServerEvent;
    try {
      event = JSON.parse(String(e.data)) as ServerEvent;
    } catch {
      return;
    }

    if (event.type === "interaction") {
      const myId = getSession()?.user.id;
      const from = String(event.from);
      const target = String(event.target);
      const interaction: PetInteraction = {
        from,
        target: target === myId ? ME : target,
        kind: "poke",
        at: Date.now(),
      };
      interactionHandlers.forEach((h) => h(interaction));
      return;
    }
    eventHandlers.forEach((h) => h(event));
  };

  ws.onclose = (e) => {
    if (socket !== ws) return; // fermeture voulue
    socket = null;
    if (e.code === 4401) {
      // jeton refusé : session expirée
      setStatus("offline");
      clearSession();
      return;
    }
    // Reconnexion automatique, de plus en plus lente (max 15 s).
    setStatus("connecting");
    attempt += 1;
    const delay = Math.min(15000, 1000 * attempt);
    retryTimer = window.setTimeout(open, delay);
  };

  ws.onerror = () => {
    // onclose s'occupe de la reconnexion
  };
}

export const realtime = {
  /** Ouvre (ou rouvre) la connexion pour cette session. */
  connect(newToken: string) {
    if (socket && token === newToken) return;
    realtime.disconnect();
    token = newToken;
    attempt = 0;
    open();
  },

  disconnect() {
    window.clearTimeout(retryTimer);
    const ws = socket;
    socket = null;
    token = null;
    ws?.close();
    setStatus("offline");
  },

  /** Connexion au serveur perdue / en cours / rétablie. Appelé tout de suite avec l'état actuel. */
  onStatus(handler: StatusHandler) {
    statusHandlers.add(handler);
    handler(status);
    return () => {
      statusHandlers.delete(handler);
    };
  },

  /** Quelqu'un d'autre interagit avec une créature que j'affiche. */
  onInteraction(handler: InteractionHandler) {
    interactionHandlers.add(handler);
    return () => {
      interactionHandlers.delete(handler);
    };
  },

  /** Événements du serveur : message, read, friend-added, friend-removed... */
  onEvent(handler: EventHandler) {
    eventHandlers.add(handler);
    return () => {
      eventHandlers.delete(handler);
    };
  },

  /** J'interagis avec une créature (« me » = la mienne). */
  interact(target: string, kind: InteractionKind) {
    const myId = getSession()?.user.id;
    if (!myId || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "interact", target: target === ME ? myId : target, kind }));
  },

  /** Un message dans un salon : uniquement en direct, rien n'est enregistré
   *  côté serveur. Il faut être présent dans le salon pour que ça marche. */
  sendSalonMessage(salonId: string, text: string) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "salon-message", salonId, text }));
  },
};
