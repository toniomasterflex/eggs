// Ma collection : créatures déjà écloses et œufs pas encore ouverts. Les
// données viennent du serveur ; ce fichier est la SEULE porte d'accès pour
// l'interface (comme store.ts pour les amis/messages).
//
// L'apparence affichée (bureau, avatar dans Profil) n'est plus un choix
// libre : c'est toujours celle de la créature marquée « active » ici, reflétée
// sur le compte (voir data/session.ts : useMyAppearance / updateSessionUser).

import { useSyncExternalStore } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { api } from "./api";
import type { ApiCreature, ApiEgg } from "./api";
import { realtime } from "./realtime";
import type { ServerEvent } from "./realtime";
import { getSession, subscribeSession, updateSessionUser } from "./session";
import type { Creature, Egg } from "./types";

// Couleurs possibles pour une créature (le serveur tire au hasard parmi
// celles-ci à l'éclosion — voir server/src/service.ts : COLORS).
export const PET_COLORS: { id: string; value: string }[] = [
  { id: "sun", value: "#ffd84d" },
  { id: "rose", value: "#ff9fb8" },
  { id: "sky", value: "#7cc7ff" },
  { id: "mint", value: "#8fe3b0" },
  { id: "lilac", value: "#c3a6ff" },
  { id: "peach", value: "#ffb27a" },
  { id: "cloud", value: "#e6ecf2" },
];

/** Code couleur (ex. « #ffd84d ») à partir de l'identifiant. */
export function colorValue(id: string): string {
  return (PET_COLORS.find((c) => c.id === id) ?? PET_COLORS[0]).value;
}

/** La même couleur, en "r, g, b" — pour composer une rgba() en CSS (halo
 *  coloré derrière un avatar, voir .row-avatar-tile dans ui.css). */
export function colorRgb(id: string): string {
  const hex = colorValue(id).replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

interface CollectionState {
  creatures: Creature[];
  eggs: Egg[];
  loaded: boolean;
  // Créatures (non actives) posées sur l'herbe du bureau — aucune limite de
  // nombre (jusqu'au 29/09/2026, plafonné à MAX_PINNED_CREATURES = 3 : une
  // fenêtre Windows par créature, coûteuse au-delà d'une poignée ; toutes
  // vivent maintenant dans une seule fenêtre partagée, voir
  // pet/GroundPetsWindow.tsx et setup_pets côté Rust).
  pinnedCreatures: string[];
}

const PINNED_CREATURES_KEY = "eggs.pinnedCreatures";
// Evénement Tauri (voir writePinnedCreatures et le listen() plus bas) — même
// mécanisme que PINNED_EVENT/FAVORITES_EVENT dans data/store.ts.
const PINNED_CREATURES_EVENT = "eggs://pinned-creatures-changed";

function readPinnedCreatures(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_CREATURES_KEY);
    if (raw) {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) {
        return value.filter((x) => typeof x === "string");
      }
    }
  } catch {
    // pas grave
  }
  return [];
}

function writePinnedCreatures(list: string[]) {
  try {
    localStorage.setItem(PINNED_CREATURES_KEY, JSON.stringify(list));
  } catch {
    // pas grave
  }
  // Voir le commentaire près de listen() plus bas : l'événement navigateur
  // "storage" ne suffit pas entre fenêtres Tauri/WebView2 séparées, on
  // utilise donc aussi le bus d'événements Tauri.
  emit(PINNED_CREATURES_EVENT).catch(() => {});
}

let state: CollectionState = {
  creatures: [],
  eggs: [],
  loaded: false,
  pinnedCreatures: readPinnedCreatures(),
};
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

function setState(patch: Partial<CollectionState>) {
  state = { ...state, ...patch };
  notify();
}

// `pinnedCreatures` est purement local (localStorage, aucun concept serveur
// — contrairement à `creatures`/`eggs`, tenus à jour par la connexion temps
// réel de CHAQUE fenêtre). Voir le commentaire équivalent (et plus détaillé)
// dans data/store.ts (pinned/favorites) : sans notification inter-fenêtres,
// poser une créature depuis « Ma collection » (fenêtre "main") ne faisait
// rien apparaître dans la fenêtre partagée "pets" (voir
// pet/GroundPetsWindow.tsx), qui a besoin de connaître `pinnedCreatures`
// pour savoir quoi dessiner. L'événement navigateur "storage" (premier
// essai) ne se propage pas de façon fiable entre fenêtres Tauri/WebView2
// distinctes sur Windows ; on utilise donc le bus d'événements de Tauri
// (emit/listen) comme mécanisme principal, avec "storage" gardé en secours.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === PINNED_CREATURES_KEY) setState({ pinnedCreatures: readPinnedCreatures() });
  });
  listen(PINNED_CREATURES_EVENT, () => {
    setState({ pinnedCreatures: readPinnedCreatures() });
  }).catch(() => {});
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hook React : ma collection (créatures, œufs). */
export function useCollection(): CollectionState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Combien d'œufs m'attendent — pour la pastille sur l'onglet Profil. */
export function pendingCount(s: CollectionState = state): number {
  return s.eggs.length;
}

// ----------------------------------------------------------------- Conversions

const toCreature = (c: ApiCreature): Creature => ({
  id: c.id,
  species: c.species as Creature["species"],
  color: c.color,
  active: c.active,
  partnerId: c.partnerId,
  bornAt: c.bornAt,
});

const toEgg = (e: ApiEgg): Egg => ({ id: e.id, source: e.source, partnerId: e.partnerId, grantedAt: e.grantedAt });

// ----------------------------------------------------------------- Chargement

/** Recharge tout depuis le serveur (œufs, créatures). */
export async function refreshCollection() {
  if (!getSession()) return;
  try {
    const [eggs, creatures] = await Promise.all([api.eggs(), api.creatures()]);
    const list = creatures.map(toCreature);
    const pinnedCreatures = state.pinnedCreatures.filter((id) => list.some((c) => c.id === id && !c.active));
    if (pinnedCreatures.length !== state.pinnedCreatures.length) writePinnedCreatures(pinnedCreatures);
    setState({
      eggs: eggs.map(toEgg),
      creatures: list,
      loaded: true,
      pinnedCreatures,
    });
  } catch {
    // serveur injoignable : on réessaiera à la reconnexion
  }
}

function onServerEvent(event: ServerEvent) {
  switch (event.type) {
    case "hello":
      refreshCollection();
      break;
    case "friend-updated":
      // Mon apparence a pu changer ailleurs (autre fenêtre) : sans effet ici,
      // ceci ne concerne que mes amis (voir data/store.ts).
      break;
    case "egg-gift": {
      // Un ami vient de m'offrir un œuf : il arrive directement dans ma
      // ferme (voir HatchScreen.tsx, l'animation d'arrivée s'en charge).
      const egg = toEgg(event.egg as ApiEgg);
      if (state.eggs.some((x) => x.id === egg.id)) break;
      setState({ eggs: [...state.eggs, egg] });
      break;
    }
  }
}

realtime.onEvent(onServerEvent);

let currentToken: string | null = null;
function onSessionChange() {
  const s = getSession();
  if (s) {
    if (s.token === currentToken) return;
    currentToken = s.token;
    refreshCollection();
  } else {
    currentToken = null;
    writePinnedCreatures([]);
    state = { creatures: [], eggs: [], loaded: false, pinnedCreatures: [] };
    notify();
  }
}
subscribeSession(onSessionChange);
onSessionChange();

// ------------------------------------------------------------------- Actions

/** Ouvre un œuf : éclosion immédiate, apparence tirée au sort et fixée pour
 *  toujours. Renvoie la nouvelle créature. */
export async function openEgg(eggId: string): Promise<Creature> {
  const apiCreature = await api.openEgg(eggId);
  const creature = toCreature(apiCreature);
  setState({
    eggs: state.eggs.filter((e) => e.id !== eggId),
    creatures: creature.active
      ? [...state.creatures.map((c) => ({ ...c, active: false })), creature]
      : [...state.creatures, creature],
  });
  if (creature.active) {
    // C'était ma toute première créature : elle devient mon apparence active.
    const me = await api.me().catch(() => null);
    if (me) updateSessionUser(me);
  }
  return creature;
}

/** Change ma créature active (flèches gauche/droite du Profil, effet immédiat). */
export async function activateCreature(creatureId: string) {
  const user = await api.activateCreature(creatureId);
  updateSessionUser(user);
  // Elle devient mon avatar sur le bureau (bord latéral) : inutile qu'elle
  // vive aussi sur l'herbe en même temps, on la détache si besoin.
  const pinnedCreatures = state.pinnedCreatures.filter((id) => id !== creatureId);
  if (pinnedCreatures.length !== state.pinnedCreatures.length) writePinnedCreatures(pinnedCreatures);
  setState({
    creatures: state.creatures.map((c) => ({ ...c, active: c.id === creatureId })),
    pinnedCreatures,
  });
}

/** Retire une créature de ma collection de l'herbe du bureau (bouton rond
 *  au-dessus d'elle, pet/GroundPet.tsx — pas de chat pour mes propres
 *  créatures, ce bouton lui sert à ranger celle-ci). */
export function unpinCreature(creatureId: string) {
  const next = state.pinnedCreatures.filter((id) => id !== creatureId);
  if (next.length === state.pinnedCreatures.length) return;
  writePinnedCreatures(next);
  setState({ pinnedCreatures: next });
}

/** Pose une créature de ma collection (non active) sur l'herbe du bureau —
 *  appelé quand l'utilisateur glisse une créature depuis la grille jusqu'en
 *  dehors de la fenêtre (voir CustomizeScreen.tsx). Jusqu'au 29/09/2026, la
 *  nouvelle fenêtre de la créature suivait tout de suite la souris (native
 *  window drag, voir l'historique de pin_pet côté Rust) ; depuis la fenêtre
 *  partagée "pets", elle apparaît directement à une position mémorisée (ou
 *  espacée par défaut, comme un ami épinglé) — CustomizeScreen.tsx déclenche
 *  maintenant l'appel au RELÂCHEMENT du glissement plutôt qu'à son début. */
export function pinCreatureByDrag(creatureId: string) {
  const { pinnedCreatures } = state;
  if (pinnedCreatures.includes(creatureId)) return;
  const next = [...pinnedCreatures, creatureId];
  writePinnedCreatures(next);
  setState({ pinnedCreatures: next });
}

/** Offre un œuf de ma ferme à un ami : transfert immédiat, il l'a tout de
 *  suite dans la sienne. */
export async function giftEgg(eggId: string, friendId: string): Promise<void> {
  await api.giftEgg(eggId, friendId);
  setState({ eggs: state.eggs.filter((e) => e.id !== eggId) });
}

/** Achète une boîte d'œufs (Shop) — maquette, voir service.ts côté serveur.
 *  Renvoie le nombre d'œufs ajoutés. */
export async function buyEggBox(boxId: string): Promise<number> {
  const { count } = await api.buyEggBox(boxId);
  await refreshCollection();
  return count;
}

/** Achète un skin rare (Shop) — maquette, voir service.ts côté serveur.
 *  Ajoute directement la créature à la collection (active si c'était la
 *  toute première, comme à l'ouverture d'un œuf). */
export async function buySkin(skinId: string): Promise<void> {
  const creature = await api.buySkin(skinId);
  await refreshCollection();
  if (creature.active) {
    const me = await api.me().catch(() => null);
    if (me) updateSessionUser(me);
  }
}
