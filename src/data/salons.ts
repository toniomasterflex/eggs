// Salons : chaque personne a le sien, ses amis peuvent y entrer et sortir
// librement (sauf blocage). Les données viennent du serveur (API + temps
// réel), comme pour store.ts. Un salon = son propriétaire (id du salon =
// users.id du propriétaire).

import { useSyncExternalStore } from "react";
import { api, ApiError } from "./api";
import type { ApiSalonDetail, ApiSalonSummary, ApiUser } from "./api";
import { realtime } from "./realtime";
import type { ServerEvent } from "./realtime";
import { getSession, subscribeSession } from "./session";

/** Un message de salon : uniquement en direct, jamais enregistré. Perdu dès
 *  qu'on quitte le salon ou qu'on se déconnecte — comme une vraie discussion
 *  de vive voix, pas un fil qu'on peut relire plus tard. */
export interface SalonMessage {
  id: string;
  from: ApiUser;
  text: string;
  at: number;
}

export interface SalonsState {
  mine: ApiSalonSummary | null;
  friends: ApiSalonSummary[];
  loaded: boolean;
  current: ApiSalonDetail | null; // salon affiché (aperçu ou dans lequel on est)
  inside: boolean; // suis-je actuellement dedans ?
  blocks: ApiUser[]; // bloqués de MON salon (chargé seulement si current = mon salon)
  messages: SalonMessage[]; // discussion en direct du salon affiché (vide si pas dedans)
  error: string; // message transitoire (accès refusé, bloqué...)
}

let state: SalonsState = {
  mine: null,
  friends: [],
  loaded: false,
  current: null,
  inside: false,
  blocks: [],
  messages: [],
  error: "",
};

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

function setState(patch: Partial<SalonsState>) {
  state = { ...state, ...patch };
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hook React : renvoie l'état et se met à jour tout seul. */
export function useSalonsStore(): SalonsState {
  return useSyncExternalStore(subscribe, () => state);
}

function flashError(message: string, ms = 3000) {
  setState({ error: message });
  window.setTimeout(() => setState({ error: "" }), ms);
}

// ----------------------------------------------------------------- Chargement

/** Recharge la liste : mon salon (s'il existe) puis ceux de mes amis. */
export async function refreshSalons() {
  try {
    const list = await api.salons();
    setState({ mine: list.mine, friends: list.friends, loaded: true });
  } catch {
    // serveur injoignable : on réessaiera à la reconnexion
  }
}

async function refreshBlocks() {
  try {
    setState({ blocks: await api.salonBlocks() });
  } catch {
    // pas grave
  }
}

/** Affiche l'aperçu d'un salon (sans y entrer) : qui est dedans en ce moment. */
export async function previewSalon(ownerId: string) {
  try {
    const detail = await api.salon(ownerId);
    const myId = getSession()?.user.id;
    setState({
      current: detail,
      inside: !!myId && detail.present.some((u) => u.id === myId),
      blocks: [],
      messages: [],
      error: "",
    });
    if (myId && detail.id === myId) refreshBlocks();
  } catch (err) {
    flashError(err instanceof ApiError ? err.message : "Salon introuvable.");
  }
}

/** Referme l'aperçu / la vue d'un salon. Si on y était entré, on en sort. */
export function closeSalon() {
  if (state.inside && state.current) {
    api.leaveSalon(state.current.id).catch(() => {});
  }
  setState({ current: null, inside: false, blocks: [], messages: [] });
}

/** Envoie un message dans le salon actuellement affiché (faut y être). */
export function sendSalonMessage(text: string) {
  const clean = text.trim();
  if (!clean || !state.current || !state.inside) return;
  realtime.sendSalonMessage(state.current.id, clean);
}

/** Entre dans le salon actuellement affiché. */
export async function enterCurrentSalon() {
  const id = state.current?.id;
  if (!id) return;
  try {
    const { present } = await api.enterSalon(id);
    if (state.current?.id === id) setState({ current: { ...state.current, present }, inside: true });
  } catch (err) {
    flashError(err instanceof ApiError ? err.message : "Impossible d'entrer dans ce salon.");
  }
}

/** Sort du salon actuellement affiché. */
export async function leaveCurrentSalon() {
  const id = state.current?.id;
  if (!id || !state.inside) return;
  try {
    const { present } = await api.leaveSalon(id);
    if (state.current?.id === id) setState({ current: { ...state.current, present }, inside: false, messages: [] });
  } catch {
    // pas grave
  }
}

/** Renomme mon salon. Renvoie false si le serveur a refusé (nom invalide...). */
export async function renameMySalon(name: string): Promise<boolean> {
  try {
    const detail = await api.renameSalon(name);
    setState({
      mine: state.mine ? { ...state.mine, name: detail.name } : state.mine,
      current: state.current && state.current.id === detail.id ? { ...state.current, name: detail.name } : state.current,
    });
    return true;
  } catch {
    return false;
  }
}

/** Bloque quelqu'un de mon salon (seulement quelqu'un présent en ce moment). */
export async function blockUser(userId: string) {
  const target = state.current?.present.find((u) => u.id === userId);
  try {
    await api.blockFromSalon(userId);
    setState({
      current: state.current
        ? { ...state.current, present: state.current.present.filter((u) => u.id !== userId) }
        : state.current,
      blocks: target && !state.blocks.some((b) => b.id === userId) ? [...state.blocks, target] : state.blocks,
      mine: target && state.mine ? { ...state.mine, present: Math.max(0, state.mine.present - 1) } : state.mine,
    });
  } catch {
    // pas grave
  }
}

/** Débloque quelqu'un. */
export async function unblockUser(userId: string) {
  try {
    await api.unblockFromSalon(userId);
    setState({ blocks: state.blocks.filter((u) => u.id !== userId) });
  } catch {
    // pas grave
  }
}

// ------------------------------------------------------------ Temps réel

function onServerEvent(event: ServerEvent) {
  switch (event.type) {
    case "hello":
      // (re)connexion : on se remet à jour
      refreshSalons();
      if (state.current) previewSalon(state.current.id);
      break;
    case "salon-presence": {
      const salonId = String(event.salonId);
      const present = ((event.present as ApiUser[] | undefined) ?? []) as ApiUser[];
      const patch: Partial<SalonsState> = {};
      if (state.mine && state.mine.id === salonId) patch.mine = { ...state.mine, present: present.length };
      if (state.friends.some((s) => s.id === salonId)) {
        patch.friends = state.friends.map((s) => (s.id === salonId ? { ...s, present: present.length } : s));
      }
      if (state.current && state.current.id === salonId) {
        const myId = getSession()?.user.id;
        patch.current = { ...state.current, present };
        patch.inside = !!myId && present.some((u) => u.id === myId);
      }
      if (Object.keys(patch).length > 0) setState(patch);
      break;
    }
    case "salon-message": {
      const salonId = String(event.salonId);
      if (state.current && state.current.id === salonId) {
        const from = event.from as ApiUser;
        const text = String(event.text);
        const at = Number(event.at);
        const message: SalonMessage = { id: `${at}-${from.id}-${state.messages.length}`, from, text, at };
        setState({ messages: [...state.messages, message] });
      }
      break;
    }
    case "salon-blocked": {
      const salonId = String(event.salonId);
      if (state.current && state.current.id === salonId) {
        setState({ current: null, inside: false, blocks: [], messages: [] });
        flashError("Tu as été bloqué·e de ce salon.", 4000);
      }
      break;
    }
  }
}

realtime.onEvent(onServerEvent);

// ------------------------------------------------------------------ Session

let currentToken: string | null = null;

function onSessionChange() {
  const s = getSession();
  if (s) {
    if (s.token === currentToken) return;
    currentToken = s.token;
    refreshSalons();
  } else {
    if (currentToken === null && state.mine === null && state.friends.length === 0) return;
    currentToken = null;
    state = {
      mine: null,
      friends: [],
      loaded: false,
      current: null,
      inside: false,
      blocks: [],
      messages: [],
      error: "",
    };
    notify();
  }
}

subscribeSession(onSessionChange);
onSessionChange();
