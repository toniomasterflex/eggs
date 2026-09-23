// Amis, conversations et pets épinglés. Les données viennent du serveur
// (API + temps réel) ; ce fichier est la SEULE porte d'accès pour l'interface.
// Chaque fenêtre d'Eggs (menu, pets épinglés) a sa propre copie, tenue à jour
// par sa propre connexion.

import { useSyncExternalStore } from "react";
import { api } from "./api";
import type { ApiFriend, ApiMessage, ApiUser } from "./api";
import { realtime } from "./realtime";
import type { ServerEvent } from "./realtime";
import { getSession, subscribeSession } from "./session";
import type { Friend, Message, Species } from "./types";

/** Nombre maximum de pets d'amis épinglés sur le bureau. */
export const MAX_PINNED = 3;

export interface ChatState {
  friends: Friend[];
  messages: Record<string, Message[]>;
  unread: Record<string, number>;
  activeChat: string | null; // ami dont la conversation est ouverte
  pinned: string[]; // amis dont le pet est épinglé sur le bureau
  connected: boolean; // connexion au serveur en ce moment (temps réel)
}

const PINNED_KEY = "eggs.pinned";

function readPinned(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (raw) {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) return value.filter((x) => typeof x === "string").slice(0, MAX_PINNED);
    }
  } catch {
    // pas grave
  }
  return [];
}

function writePinned(list: string[]) {
  try {
    localStorage.setItem(PINNED_KEY, JSON.stringify(list));
  } catch {
    // pas grave
  }
}

let state: ChatState = {
  friends: [],
  messages: {},
  unread: {},
  activeChat: null,
  pinned: readPinned(),
  connected: false,
};

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

// ------------------------------------------------------- Bulle « vient d'écrire »
//
// Signal ponctuel, indépendant de l'état React ci-dessus : prévient qu'un ami
// vient d'envoyer un message, pour la petite bulle de dialogue sur son pet
// épinglé (voir pet/PinnedWindow.tsx). Volontairement séparé de `messages` /
// `unread` : ceux-là sont mémorisés, celui-ci ne l'est jamais (ne doit se
// déclencher QUE sur un vrai message reçu en direct, jamais quand on charge
// un historique ou qu'on rouvre une conversation).
type LiveMessageHandler = (friendId: string) => void;
const liveMessageHandlers = new Set<LiveMessageHandler>();

/** Prévient quand un ami vient d'écrire, à l'instant. */
export function onLiveMessage(handler: LiveMessageHandler) {
  liveMessageHandlers.add(handler);
  return () => {
    liveMessageHandlers.delete(handler);
  };
}

function setState(patch: Partial<ChatState>) {
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
export function useChatStore(): ChatState {
  return useSyncExternalStore(subscribe, () => state);
}

// ------------------------------------------------------------ Conversions

const toFriend = (u: ApiUser | ApiFriend): Friend => ({
  id: u.id,
  name: u.username,
  species: u.species as Species,
  color: u.color,
  lastAt: "lastAt" in u && u.lastAt !== null ? u.lastAt : undefined,
  readAt: "readAt" in u && u.readAt !== null ? u.readAt : undefined,
  online: "online" in u ? Boolean((u as ApiFriend).online) : undefined,
});

function toMessage(m: ApiMessage, myId: string): Message {
  return { id: String(m.id), mine: m.from === myId, text: m.text, time: m.at };
}

// ----------------------------------------------------------------- Chargement

const loaded = new Set<string>(); // conversations déjà chargées depuis le serveur

async function refresh() {
  try {
    const list = await api.friends();
    const unread: Record<string, number> = {};
    for (const f of list) {
      unread[f.id] = f.id === state.activeChat ? 0 : f.unread;
    }
    setState({
      friends: list.map(toFriend),
      unread,
      pinned: state.pinned.filter((id) => list.some((f) => f.id === id)),
    });
  } catch {
    // serveur injoignable : on réessaiera à la reconnexion
  }
}

async function loadMessages(friendId: string) {
  const myId = getSession()?.user.id;
  if (!myId) return;
  try {
    const list = await api.messages(friendId);
    loaded.add(friendId);
    setState({
      messages: { ...state.messages, [friendId]: list.map((m) => toMessage(m, myId)) },
    });
  } catch {
    // pas grave
  }
}

function addMessage(m: ApiMessage) {
  const myId = getSession()?.user.id;
  if (!myId) return;
  const mine = m.from === myId;
  const friendId = mine ? m.to : m.from;
  const message = toMessage(m, myId);

  const current = state.messages[friendId] ?? [];
  if (current.some((x) => x.id === message.id)) return; // déjà reçu (réponse de l'API + WebSocket)

  const patch: Partial<ChatState> = {
    messages: { ...state.messages, [friendId]: [...current, message] },
    friends: state.friends.map((f) => (f.id === friendId ? { ...f, lastAt: message.time } : f)),
  };

  if (!mine) {
    if (state.activeChat === friendId) {
      api.markRead(friendId).catch(() => {});
    } else {
      patch.unread = { ...state.unread, [friendId]: (state.unread[friendId] ?? 0) + 1 };
    }
  }
  if (!state.friends.some((f) => f.id === friendId)) refresh();
  setState(patch);
}

function onServerEvent(event: ServerEvent) {
  switch (event.type) {
    case "hello":
      // (re)connexion : on se remet à jour
      refresh();
      if (state.activeChat) loadMessages(state.activeChat);
      break;
    case "message": {
      const m = event.message as ApiMessage;
      addMessage(m);
      const myId = getSession()?.user.id;
      if (myId && m.from !== myId) liveMessageHandlers.forEach((h) => h(m.from));
      break;
    }
    case "read": {
      const friendId = String(event.friendId);
      setState({ unread: { ...state.unread, [friendId]: 0 } });
      break;
    }
    case "friend-added": {
      const f = toFriend(event.user as ApiUser);
      if (state.friends.some((x) => x.id === f.id)) break;
      setState({ friends: [...state.friends, f] });
      break;
    }
    case "friend-updated": {
      const f = toFriend(event.user as ApiUser);
      setState({
        friends: state.friends.map((x) =>
          x.id === f.id ? { ...x, ...f, lastAt: x.lastAt, readAt: x.readAt, online: x.online } : x,
        ),
      });
      break;
    }
    case "presence": {
      const userId = String(event.userId);
      const online = Boolean(event.online);
      setState({ friends: state.friends.map((f) => (f.id === userId ? { ...f, online } : f)) });
      break;
    }
    case "seen": {
      const by = String(event.by);
      const at = Number(event.at);
      setState({
        friends: state.friends.map((f) => (f.id === by ? { ...f, readAt: Math.max(f.readAt ?? 0, at) } : f)),
      });
      break;
    }
    case "friend-removed": {
      const id = String(event.userId);
      const pinned = state.pinned.filter((p) => p !== id);
      if (pinned.length !== state.pinned.length) writePinned(pinned);
      setState({
        friends: state.friends.filter((f) => f.id !== id),
        pinned,
        activeChat: state.activeChat === id ? null : state.activeChat,
      });
      break;
    }
  }
}

realtime.onEvent(onServerEvent);
realtime.onStatus((status) => setState({ connected: status === "online" }));

// ------------------------------------------------------------------ Session

let currentToken: string | null = null;

function onSessionChange() {
  const s = getSession();
  if (s) {
    if (s.token === currentToken) return;
    if (currentToken !== null) resetData(); // un autre compte se connecte
    currentToken = s.token;
    realtime.connect(s.token);
    refresh();
  } else {
    if (currentToken === null && state.friends.length === 0) {
      realtime.disconnect();
      return;
    }
    currentToken = null;
    realtime.disconnect();
    resetData();
  }
}

function resetData() {
  loaded.clear();
  writePinned([]);
  state = { friends: [], messages: {}, unread: {}, activeChat: null, pinned: [], connected: state.connected };
  notify();
}

subscribeSession(onSessionChange);
onSessionChange();

// ---------------------------------------------------------------- Messages

export function openChat(friendId: string) {
  setState({ activeChat: friendId, unread: { ...state.unread, [friendId]: 0 } });
  api.markRead(friendId).catch(() => {});
  loadMessages(friendId);
}

export function closeChat() {
  setState({ activeChat: null });
}

/** Envoie un message. Renvoie false si l'envoi a échoué. */
export async function sendMessage(friendId: string, text: string): Promise<boolean> {
  const clean = text.trim();
  if (!clean) return true;
  try {
    addMessage(await api.sendMessage(friendId, clean));
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- Amis

/** Cherche un utilisateur par son pseudo. « added » = déjà dans mes amis. */
export async function searchUsers(query: string): Promise<{ user: Friend; added: boolean }[]> {
  const q = query.trim();
  if (!q) return [];
  const list = await api.searchUsers(q);
  return list.map((u) => ({ user: toFriend(u), added: u.friend }));
}

export async function addFriend(user: Friend) {
  if (state.friends.some((f) => f.id === user.id)) return;
  await api.addFriend(user.id);
  if (!state.friends.some((f) => f.id === user.id)) {
    setState({ friends: [...state.friends, user] });
  }
}

/** Retire un ami : on ne voit plus ses messages ni sa créature. */
export async function removeFriend(friendId: string) {
  await api.removeFriend(friendId);
  const pinned = state.pinned.filter((id) => id !== friendId);
  if (pinned.length !== state.pinned.length) writePinned(pinned);
  const messages = { ...state.messages };
  delete messages[friendId];
  const unread = { ...state.unread };
  delete unread[friendId];
  setState({
    friends: state.friends.filter((f) => f.id !== friendId),
    pinned,
    messages,
    unread,
    activeChat: state.activeChat === friendId ? null : state.activeChat,
  });
}

// ---------------------------------------------------------- Pets épinglés

/** Épingle / détache le pet d'un ami sur le bureau. */
export function togglePin(friendId: string) {
  const { pinned } = state;

  if (pinned.includes(friendId)) {
    const next = pinned.filter((id) => id !== friendId);
    writePinned(next);
    setState({ pinned: next });
    return;
  }

  if (pinned.length >= MAX_PINNED) return;
  const next = [...pinned, friendId];
  writePinned(next);
  setState({ pinned: next });
}
