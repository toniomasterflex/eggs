// Amis, conversations et pets épinglés. Les données viennent du serveur
// (API + temps réel) ; ce fichier est la SEULE porte d'accès pour l'interface.
// Chaque fenêtre d'Eggs (menu, pets épinglés) a sa propre copie, tenue à jour
// par sa propre connexion.

import { useSyncExternalStore } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { api, ApiError, SERVER_URL } from "./api";
import type { ApiChatFolder, ApiFriend, ApiGroup, ApiGroupSummary, ApiMessage, ApiUser } from "./api";
import { labelForKind } from "./mediaKind";
import { realtime } from "./realtime";
import type { ServerEvent } from "./realtime";
import { getSession, subscribeSession } from "./session";
import type { Friend, Group, GroupMember, Message, Species } from "./types";
import { cancelPendingNotification, notifyNewMessage } from "./notifications";

// `messages` et `unread` sont indexés par « id de fil » : soit un id d'ami
// (discussion à deux), soit un id de groupe — les deux viennent de pools
// d'UUID distincts côté serveur, donc pas de risque de collision. Ça évite de
// dupliquer toute la logique de messagerie (pièces jointes, réactions, audio…)
// entre deux systèmes séparés (voir openChat plus bas : elle regarde d'abord
// si l'id est celui d'un groupe connu).
export interface ChatState {
  friends: Friend[];
  groups: Group[];
  messages: Record<string, Message[]>;
  unread: Record<string, number>;
  activeChat: string | null; // ami OU groupe dont la conversation est ouverte
  // Amis dont le pet est épinglé sur le bureau — aucune limite de nombre
  // (jusqu'au 29/09/2026, plafonné à MAX_PINNED = 3 : chaque pet avait sa
  // propre fenêtre Windows, coûteuse en mémoire/GPU au-delà d'une poignée ;
  // toutes vivent maintenant dans une seule fenêtre partagée, voir
  // pet/GroundPetsWindow.tsx et setup_pets côté Rust).
  pinned: string[];
  // Favoris (voir ui/screens/DirectoryScreen.tsx, nouveau design importé le
  // 29/09/2026, inspiré d'une maquette d'Antoine) : marque-page indépendant
  // du pin bureau ci-dessus — juste pour retrouver vite quelqu'un en haut de
  // l'onglet "Favoris". Uniquement local (localStorage), comme pinned : pas
  // de concept serveur.
  favorites: string[];
  connected: boolean; // connexion au serveur en ce moment (temps réel)
  // Cercles pour ranger ses discussions (voir ui/screens/ChatsScreen.tsx) —
  // système séparé de celui des salons (voir data/salons.ts). Un chat non
  // présent dans folder.chatIds, pour aucun cercle, est "non classé".
  chatFolders: ApiChatFolder[];
}

const PINNED_KEY = "eggs.pinned";
const FAVORITES_KEY = "eggs.favorites";
// Evénements Tauri (voir writePinned/writeFavorites et le listen() plus bas)
// — un simple signal "ça a changé, relis localStorage", pas de payload.
const PINNED_EVENT = "eggs://pinned-changed";
const FAVORITES_EVENT = "eggs://favorites-changed";

function readPinned(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_KEY);
    if (raw) {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) return value.filter((x) => typeof x === "string");
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
  // Prévient les AUTRES fenêtres (voir le commentaire près de listen() plus
  // bas) : l'événement navigateur "storage" ne suffit pas entre fenêtres
  // Tauri/WebView2 séparées, on utilise donc aussi le bus d'événements Tauri.
  emit(PINNED_EVENT).catch(() => {});
}

function readFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (raw) {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) return value.filter((x) => typeof x === "string");
    }
  } catch {
    // pas grave
  }
  return [];
}

function writeFavorites(list: string[]) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
  } catch {
    // pas grave
  }
  emit(FAVORITES_EVENT).catch(() => {});
}

let state: ChatState = {
  friends: [],
  groups: [],
  messages: {},
  unread: {},
  activeChat: null,
  pinned: readPinned(),
  favorites: readFavorites(),
  connected: false,
  chatFolders: [],
};

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

// ------------------------------------------------------- Bulle « vient d'écrire »
//
// Signal ponctuel, indépendant de l'état React ci-dessus : prévient qu'un ami
// vient d'envoyer un message, avec son texte, pour la bulle de bande dessinée
// sur son pet épinglé (voir pet/PinnedWindow.tsx). Volontairement séparé de
// `messages` / `unread` : ceux-là sont mémorisés, celui-ci ne l'est jamais (ne
// doit se déclencher QUE sur un vrai message reçu en direct, jamais quand on
// charge un historique ou qu'on rouvre une conversation).
type LiveMessageHandler = (friendId: string, text: string) => void;
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

// `pinned`/`favorites` sont purement locaux (localStorage, aucun concept
// serveur — contrairement à `friends`/`unread`/etc, tenus à jour par la
// connexion temps réel de CHAQUE fenêtre, voir le commentaire en haut de ce
// fichier). Un togglePin() dans la fenêtre "main" (ex: DirectoryScreen) met
// donc à jour SA copie de `state` et localStorage, mais ne prévenait pas les
// AUTRES fenêtres avant le 29/09/2026 — sans conséquence tant que "main"
// était la seule à s'en servir. Depuis la fenêtre partagée "pets" (voir
// pet/GroundPetsWindow.tsx), qui a besoin de connaître `pinned` pour savoir
// quelles créatures dessiner, ça ne suffit plus : sans ça, épingler un ami
// ne faisait plus rien apparaître sur le bureau (state.pinned de la fenêtre
// "pets" ne changeait jamais).
//
// Premier essai (l'événement navigateur "storage", censé se déclencher
// automatiquement dans les AUTRES documents de même origine) s'est avéré
// insuffisant : entre fenêtres Tauri/WebView2 distinctes sur Windows, cet
// événement ne se propage pas de façon fiable (contrairement au cas
// classique de plusieurs onglets d'un même navigateur — voir les retours de
// terrain sur tauri-apps/tauri#10981 et tauri-apps/wry#621). On utilise donc
// le bus d'événements de Tauri lui-même (emit/listen), déjà utilisé partout
// ailleurs dans l'app pour ce genre de communication inter-fenêtres
// (pets-tick, pet-placed, remote-interaction...) et fiable de façon
// éprouvée : `writePinned`/`writeFavorites` émettent un événement juste
// après l'écriture dans localStorage, et chaque fenêtre (y compris celle qui
// vient d'écrire, mise à jour à l'identique donc sans effet visible) relit
// localStorage dès qu'elle le reçoit.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === PINNED_KEY) setState({ pinned: readPinned() });
    else if (e.key === FAVORITES_KEY) setState({ favorites: readFavorites() });
  });
  listen(PINNED_EVENT, () => {
    setState({ pinned: readPinned() });
  }).catch(() => {});
  listen(FAVORITES_EVENT, () => {
    setState({ favorites: readFavorites() });
  }).catch(() => {});
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
  discord: u.discord,
  steam: u.steam,
  lastAt: "lastAt" in u && u.lastAt !== null ? u.lastAt : undefined,
  readAt: "readAt" in u && u.readAt !== null ? u.readAt : undefined,
  online: "online" in u ? Boolean((u as ApiFriend).online) : undefined,
  away: Boolean(u.away),
});

function toMessage(m: ApiMessage, myId: string): Message {
  return {
    id: String(m.id),
    from: m.from,
    mine: m.from === myId,
    text: m.text,
    time: m.at,
    // m.attachment.url est relative (voir data/api.ts) : complétée ici une
    // fois pour toutes avec l'adresse du serveur, pour que le reste de
    // l'interface n'ait jamais à s'en soucier.
    attachment: m.attachment ? { ...m.attachment, url: SERVER_URL + m.attachment.url } : null,
    reactions: m.reactions ?? [],
  };
}

// L'id de fil d'un message : l'id du groupe s'il est de groupe, sinon
// l'AUTRE participant (moi si je l'ai envoyé, sinon son expéditeur) — voir le
// commentaire sur ChatState plus haut.
function threadIdOf(m: ApiMessage, myId: string): string {
  if (m.groupId) return m.groupId;
  return m.from === myId ? (m.to as string) : m.from;
}

const toMember = (u: ApiUser): GroupMember => ({
  id: u.id,
  name: u.username,
  species: u.species as Species,
  color: u.color,
});

function toGroup(g: ApiGroup | ApiGroupSummary): Group {
  const summary = g as ApiGroupSummary;
  return {
    id: g.id,
    name: g.name,
    createdBy: g.createdBy,
    members: g.members.map(toMember),
    lastAt: "lastAt" in summary && summary.lastAt !== null ? summary.lastAt : undefined,
  };
}

/** Texte à montrer pour CE message dans un endroit qui ne peut afficher
 *  qu'une ligne (bulle "vient d'écrire", voir onLiveMessage plus bas) :
 *  le vrai texte s'il y en a un, sinon un mot pour la pièce jointe. */
function previewOf(m: ApiMessage): string {
  if (m.text) return m.text;
  if (m.attachment) return labelForKind(m.attachment.kind);
  return "";
}

// ----------------------------------------------------------------- Chargement

const loaded = new Set<string>(); // conversations déjà chargées depuis le serveur (amis ET groupes)

async function refresh() {
  try {
    const list = await api.friends();
    // On fusionne dans le non-lu existant plutôt que de l'écraser : un appel
    // à refreshGroups() en parallèle (voir onSessionChange) écrit ses propres
    // clés dans le même Record, il ne faut pas se marcher dessus.
    const unread: Record<string, number> = { ...state.unread };
    for (const f of list) unread[f.id] = f.id === state.activeChat ? 0 : f.unread;
    setState({
      friends: list.map(toFriend),
      unread,
      pinned: state.pinned.filter((id) => list.some((f) => f.id === id)),
      favorites: state.favorites.filter((id) => list.some((f) => f.id === id)),
    });
  } catch {
    // serveur injoignable : on réessaiera à la reconnexion
  }
}

async function refreshGroups() {
  try {
    const list = await api.groups();
    const unread: Record<string, number> = { ...state.unread };
    for (const g of list) unread[g.id] = g.id === state.activeChat ? 0 : g.unread;
    setState({ groups: list.map(toGroup), unread });
  } catch {
    // serveur injoignable : on réessaiera à la reconnexion
  }
}

async function refreshChatFolders() {
  try {
    setState({ chatFolders: await api.chatFolders() });
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

async function loadGroupMessages(groupId: string) {
  const myId = getSession()?.user.id;
  if (!myId) return;
  try {
    const list = await api.groupMessages(groupId);
    loaded.add(groupId);
    setState({
      messages: { ...state.messages, [groupId]: list.map((m) => toMessage(m, myId)) },
    });
  } catch {
    // pas grave
  }
}

function addMessage(m: ApiMessage) {
  const myId = getSession()?.user.id;
  if (!myId) return;
  const mine = m.from === myId;
  const threadId = threadIdOf(m, myId);
  const message = toMessage(m, myId);

  const current = state.messages[threadId] ?? [];
  if (current.some((x) => x.id === message.id)) return; // déjà reçu (réponse de l'API + WebSocket)

  const patch: Partial<ChatState> = {
    messages: { ...state.messages, [threadId]: [...current, message] },
    friends: state.friends.map((f) => (f.id === threadId ? { ...f, lastAt: message.time } : f)),
    groups: state.groups.map((g) => (g.id === threadId ? { ...g, lastAt: message.time } : g)),
  };

  if (!mine) {
    if (state.activeChat === threadId) {
      if (m.groupId) api.markGroupRead(threadId).catch(() => {});
      else api.markRead(threadId).catch(() => {});
    } else {
      patch.unread = { ...state.unread, [threadId]: (state.unread[threadId] ?? 0) + 1 };
      notifyNewMessage(threadId);
    }
  }
  const known = m.groupId ? state.groups.some((g) => g.id === threadId) : state.friends.some((f) => f.id === threadId);
  if (!known) {
    if (m.groupId) refreshGroups();
    else refresh();
  }
  setState(patch);
}

// Une réaction change sur un message déjà présent (pas un nouveau message :
// on remplace en place, voir onServerEvent "reaction" ci-dessous — addMessage
// ignorerait cet appel puisque l'id existe déjà). Ne fait rien si cette
// conversation n'est pas chargée ici, ou si ce message précis ne l'est pas
// (pagination) : rien à mettre à jour dans ce cas.
function updateMessage(m: ApiMessage) {
  const myId = getSession()?.user.id;
  if (!myId) return;
  const threadId = threadIdOf(m, myId);
  const current = state.messages[threadId];
  if (!current) return;
  const idx = current.findIndex((x) => x.id === String(m.id));
  if (idx === -1) return;
  const next = current.slice();
  next[idx] = toMessage(m, myId);
  setState({ messages: { ...state.messages, [threadId]: next } });
}

function onServerEvent(event: ServerEvent) {
  switch (event.type) {
    case "hello":
      // (re)connexion : on se remet à jour
      refresh();
      refreshGroups();
      refreshChatFolders();
      if (state.activeChat) {
        if (state.groups.some((g) => g.id === state.activeChat)) loadGroupMessages(state.activeChat);
        else loadMessages(state.activeChat);
      }
      break;
    case "message": {
      const m = event.message as ApiMessage;
      addMessage(m);
      const myId = getSession()?.user.id;
      // La bulle « vient d'écrire » (voir onLiveMessage plus haut) s'affiche
      // sur le pet épinglé d'UN ami précis : pas de sens pour un message de
      // groupe (pas de pet de groupe).
      if (myId && m.from !== myId && !m.groupId) liveMessageHandlers.forEach((h) => h(m.from, previewOf(m)));
      break;
    }
    case "reaction": {
      updateMessage(event.message as ApiMessage);
      break;
    }
    case "group-created": {
      const g = toGroup(event.group as ApiGroup | ApiGroupSummary);
      if (state.groups.some((x) => x.id === g.id)) break;
      setState({ groups: [...state.groups, g] });
      break;
    }
    // Un membre a rejoint ou quitté (voir "group-left" plus bas) : le serveur
    // renvoie le groupe à jour, on garde juste mon dernier `lastAt` local
    // (pas renvoyé par cette route, voir server/src/service.ts : getGroup).
    case "group-updated": {
      const g = toGroup(event.group as ApiGroup | ApiGroupSummary);
      setState({ groups: state.groups.map((x) => (x.id === g.id ? { ...g, lastAt: x.lastAt } : x)) });
      break;
    }
    // Je viens de quitter un groupe (peut-être depuis une autre fenêtre) :
    // il disparaît d'ici aussi.
    case "group-left": {
      dropGroup(String(event.groupId));
      break;
    }
    // Le créateur a supprimé le groupe : il disparaît pour tout le monde,
    // pas seulement pour moi (voir dropGroup — différent de "group-left").
    case "group-deleted": {
      dropGroup(String(event.groupId));
      break;
    }
    case "read": {
      const friendId = String(event.friendId);
      setState({ unread: { ...state.unread, [friendId]: 0 } });
      // Lu (peut-être depuis une autre fenêtre, voir notifications.ts) :
      // plus la peine d'annoncer ce qui restait en attente pour lui.
      cancelPendingNotification(friendId);
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
      const favorites = state.favorites.filter((p) => p !== id);
      if (favorites.length !== state.favorites.length) writeFavorites(favorites);
      setState({
        friends: state.friends.filter((f) => f.id !== id),
        pinned,
        favorites,
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
    refreshGroups();
    refreshChatFolders();
  } else {
    if (currentToken === null && state.friends.length === 0 && state.groups.length === 0) {
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
  writeFavorites([]);
  state = {
    friends: [],
    groups: [],
    messages: {},
    unread: {},
    activeChat: null,
    pinned: [],
    favorites: [],
    connected: state.connected,
    chatFolders: [],
  };
  notify();
}

subscribeSession(onSessionChange);
onSessionChange();

// ---------------------------------------------------------------- Messages

/** Ouvre une conversation : `id` est soit un ami, soit un groupe (voir le
 *  commentaire sur ChatState en haut de ce fichier) — on regarde d'abord
 *  dans les groupes connus pour savoir laquelle des deux c'est. */
export function openChat(id: string) {
  const group = state.groups.some((g) => g.id === id);
  setState({ activeChat: id, unread: { ...state.unread, [id]: 0 } });
  cancelPendingNotification(id);
  if (group) {
    api.markGroupRead(id).catch(() => {});
    loadGroupMessages(id);
  } else {
    api.markRead(id).catch(() => {});
    loadMessages(id);
  }
}

export function closeChat() {
  setState({ activeChat: null });
}

/** Marque une discussion comme lue sans l'ouvrir (menu "..." d'une ligne,
 *  voir ChatsScreen.tsx) — même appel serveur que openChat, juste sans
 *  charger les messages ni l'afficher. */
export function markThreadRead(id: string) {
  const group = state.groups.some((g) => g.id === id);
  setState({ unread: { ...state.unread, [id]: 0 } });
  if (group) api.markGroupRead(id).catch(() => {});
  else api.markRead(id).catch(() => {});
}

/** Marque une discussion comme non lue — purement local (pas d'équivalent
 *  côté serveur, qui ne connaît que "lu jusqu'à tel message") : sert de
 *  pense-bête pour se souvenir d'y répondre, pas un vrai compteur de
 *  messages. Revient à 0 dès l'ouverture de la discussion, ou à la vraie
 *  valeur du serveur au prochain rafraîchissement/reconnexion. */
export function markThreadUnread(id: string) {
  setState({ unread: { ...state.unread, [id]: 1 } });
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

/** Envoie une photo / vidéo / son (glissé-déposé ou collé, voir
 *  ui/screens/ConversationScreen.tsx). Renvoie un message d'erreur à montrer
 *  à l'utilisateur, ou null si l'envoi a réussi. */
export async function sendAttachment(friendId: string, blob: Blob, filename: string): Promise<string | null> {
  try {
    addMessage(await api.sendAttachment(friendId, blob, filename));
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.message : "Envoi impossible.";
  }
}

/** Même chose que sendMessage/sendAttachment, mais dans un groupe. */
export async function sendGroupMessage(groupId: string, text: string): Promise<boolean> {
  const clean = text.trim();
  if (!clean) return true;
  try {
    addMessage(await api.sendGroupMessage(groupId, clean));
    return true;
  } catch {
    return false;
  }
}

export async function sendGroupAttachment(groupId: string, blob: Blob, filename: string): Promise<string | null> {
  try {
    addMessage(await api.sendGroupAttachment(groupId, blob, filename));
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.message : "Envoi impossible.";
  }
}

// Réaction façon iMessage/WhatsApp sur un message (voir
// ui/screens/ConversationScreen.tsx). La réponse du serveur revient à ce
// même compte par WebSocket aussi (voir onServerEvent "reaction" ci-dessus),
// mais updateMessage ignore un id déjà à jour sans dégât — pas besoin
// d'attendre l'aller-retour WebSocket pour refléter le changement ici.
// Renvoie un message d'erreur à montrer (voir ConversationScreen.tsx), ou
// null si tout s'est bien passé — avant, l'échec était avalé en silence, ce
// qui rendait un vrai problème serveur indiscernable d'un souci d'affichage.
export async function setMessageReaction(messageId: string, emoji: string): Promise<string | null> {
  try {
    updateMessage(await api.setReaction(messageId, emoji));
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.message : "Réaction impossible.";
  }
}

export async function removeMessageReaction(messageId: string): Promise<string | null> {
  try {
    updateMessage(await api.removeReaction(messageId));
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.message : "Réaction impossible.";
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

/** Retire ce chat (ami ou groupe) de tous mes cercles, localement — le
 *  serveur a déjà fait le ménage de son côté (voir removeFriend/dropGroup
 *  ci-dessous, et server/src/service.ts : removeFriendship/deleteGroup/
 *  leaveGroup), pas la peine d'attendre un refreshChatFolders() pour que
 *  l'interface arrête de l'afficher dedans. */
function dropFromChatFolders(chatId: string) {
  if (!state.chatFolders.some((f) => f.chatIds.includes(chatId))) return;
  setState({
    chatFolders: state.chatFolders.map((f) =>
      f.chatIds.includes(chatId) ? { ...f, chatIds: f.chatIds.filter((id) => id !== chatId) } : f,
    ),
  });
}

/** Retire un ami : on ne voit plus ses messages ni sa créature. */
export async function removeFriend(friendId: string) {
  await api.removeFriend(friendId);
  const pinned = state.pinned.filter((id) => id !== friendId);
  if (pinned.length !== state.pinned.length) writePinned(pinned);
  const favorites = state.favorites.filter((id) => id !== friendId);
  if (favorites.length !== state.favorites.length) writeFavorites(favorites);
  const messages = { ...state.messages };
  delete messages[friendId];
  const unread = { ...state.unread };
  delete unread[friendId];
  setState({
    friends: state.friends.filter((f) => f.id !== friendId),
    pinned,
    favorites,
    messages,
    unread,
    activeChat: state.activeChat === friendId ? null : state.activeChat,
  });
  dropFromChatFolders(friendId);
}

// ----------------------------------------------------------------- Groupes
//
// Différent des Salons (data/salons.ts — une pièce ouverte, sans historique) :
// un groupe fermé façon WhatsApp, membres choisis à la création, affiché dans
// l'onglet Chats à côté des discussions à deux (voir ui/screens/ChatsScreen.tsx).

/** Crée un groupe avec les amis choisis (je fais partie du groupe d'office,
 *  voir server). Apparaît tout de suite dans l'onglet Chats, même sans
 *  premier message. */
export async function createGroup(name: string, memberIds: string[]): Promise<Group> {
  const g = toGroup(await api.createGroup(name, memberIds));
  if (!state.groups.some((x) => x.id === g.id)) setState({ groups: [...state.groups, g] });
  return g;
}

// Retire un groupe d'ici — localement seulement, l'appel réseau (quitter ou
// supprimer) a déjà eu lieu avant, voir leaveGroup / deleteGroupForEveryone
// ci-dessous et les cas "group-left" / "group-deleted" plus haut.
function dropGroup(groupId: string) {
  const messages = { ...state.messages };
  delete messages[groupId];
  const unread = { ...state.unread };
  delete unread[groupId];
  setState({
    groups: state.groups.filter((g) => g.id !== groupId),
    messages,
    unread,
    activeChat: state.activeChat === groupId ? null : state.activeChat,
  });
  dropFromChatFolders(groupId);
}

/** Quitter, pas supprimer : le groupe continue d'exister pour les autres
 *  membres (même logique que pour un ami retiré, voir removeFriend). */
export async function leaveGroup(groupId: string) {
  await api.leaveGroup(groupId);
  dropGroup(groupId);
}

/** Supprimer : réservé au créateur (voir server) — le groupe disparaît aussi
 *  chez tous les autres membres (voir onServerEvent "group-deleted"),
 *  contrairement à leaveGroup qui ne me retire que moi. Renvoie un message
 *  d'erreur à montrer (par ex. si je ne suis pas le créateur), ou null si
 *  tout s'est bien passé. */
export async function deleteGroupForEveryone(groupId: string): Promise<string | null> {
  try {
    await api.deleteGroup(groupId);
    dropGroup(groupId);
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.message : "Suppression impossible.";
  }
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

  const next = [...pinned, friendId];
  writePinned(next);
  setState({ pinned: next });
}

/** Ajoute/retire un ami des favoris (voir le commentaire sur ChatState en
 *  haut de ce fichier) — pas de limite, contrairement à togglePin ci-dessus. */
export function toggleFavorite(friendId: string) {
  const { favorites } = state;
  const next = favorites.includes(friendId)
    ? favorites.filter((id) => id !== friendId)
    : [...favorites, friendId];
  writeFavorites(next);
  setState({ favorites: next });
}

// -------------------------------------------------------- Espaces (chats)
//
// Organise l'onglet Chats (amis + groupes mêlés, voir ChatsScreen.tsx) —
// système séparé des espaces de salons (voir data/salons.ts). Un chat dans
// un espace au plus (décision produit du 27/09/2026 ; renommé "cercle" →
// "espace" le 27/09/2026 également, même système, juste un nom plus neutre).

/** Crée l'espace et renvoie son id — pratique pour aussitôt y ranger un chat
 *  (voir ChatsScreen.tsx : le "+ Nouvel espace" du menu "Ranger dans..."
 *  crée puis range en une seule action). */
export async function createChatFolder(name: string): Promise<string> {
  const folder = await api.createChatFolder(name);
  setState({ chatFolders: [...state.chatFolders, folder] });
  return folder.id;
}

export async function renameChatFolder(folderId: string, name: string): Promise<void> {
  await api.renameChatFolder(folderId, name);
  setState({ chatFolders: state.chatFolders.map((f) => (f.id === folderId ? { ...f, name } : f)) });
}

/** Supprime un espace : ce qu'il contenait redevient "non classé", rien
 *  d'autre ne change (pas les amis/groupes eux-mêmes). */
export async function deleteChatFolder(folderId: string): Promise<void> {
  await api.deleteChatFolder(folderId);
  setState({ chatFolders: state.chatFolders.filter((f) => f.id !== folderId) });
}

/** Range ce chat dans cet espace (`folderId` null = "non classé") — un seul
 *  à la fois, ça remplace le précédent automatiquement. */
export async function moveChatToFolder(chatId: string, folderId: string | null): Promise<void> {
  await api.setChatFolder(chatId, folderId);
  setState({
    chatFolders: state.chatFolders.map((f) => {
      const has = f.chatIds.includes(chatId);
      if (f.id === folderId) return has ? f : { ...f, chatIds: [...f.chatIds, chatId] };
      return has ? { ...f, chatIds: f.chatIds.filter((id) => id !== chatId) } : f;
    }),
  });
}
