// Salons : chaque personne a le sien. Depuis le 26/09/2026, un salon n'est
// plus réservé aux amis : n'importe qui peut le rejoindre via son lien
// partageable (voir SalonsScreen.tsx : "Copier le lien", et server/src/index.ts
// : GET /join/:ownerId), avec un mot de passe optionnel pour les non-amis —
// les amis et modérateurs entrent toujours librement (cercle de confiance
// existant). Les données viennent du serveur (API + temps réel), comme pour
// store.ts. Un salon = son propriétaire (id du salon = users.id du propriétaire).

import { useSyncExternalStore } from "react";
import { api, ApiError, SERVER_URL } from "./api";
import type {
  ApiSalonDetail,
  ApiSalonFolder,
  ApiSalonReport,
  ApiSalonSummary,
  ApiUser,
  SalonAccessLevel,
  SalonWritePermission,
} from "./api";
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
  bans: ApiUser[]; // bannis du salon affiché (chargé seulement si j'ai le droit de modérer, voir refreshBans)
  moderators: ApiUser[]; // modérateurs du salon affiché (même condition)
  members: ApiUser[]; // membres explicites du salon affiché (même condition, voir refreshModeration)
  joinRequests: ApiUser[]; // demandes d'entrée en attente (même condition)
  bannedWords: string[]; // mots interdits du salon affiché (même condition)
  reports: ApiSalonReport[]; // signalements en attente du salon affiché (même condition)
  messages: SalonMessage[]; // discussion en direct du salon affiché (vide si pas dedans)
  error: string; // message transitoire (accès refusé, mot de passe...)
  // Ma propre demande d'entrée pour le salon affiché vient d'être posée
  // (salon 'private' ou approbation manuelle active côté propriétaire) : en
  // attente qu'il ou un modérateur l'accepte — voir enterCurrentSalon et
  // l'événement temps réel "salon-join-approved"/"salon-join-declined".
  entryPending: boolean;
  // Espaces pour ranger l'onglet Salons (le mien + ceux de mes amis) —
  // système séparé de celui des chats (voir data/store.ts). Décision du
  // 27/09/2026 (renommé "cercle" → "espace" le 27/09/2026 également).
  folders: ApiSalonFolder[];
  // Signal one-shot posé par previewSalon(id, {openAccess:true}) (voir
  // SalonsScreen.tsx : "⚙ Accès et modération" du menu ⋮) pour que
  // SalonDetail ouvre directement le panneau réglages, sans clic
  // supplémentaire sur l'engrenage une fois arrivé. Consommé et remis à
  // false par clearPendingOpenAccess() dès que SalonDetail l'a lu.
  pendingOpenAccess: boolean;
}

// Regroupe tout ce qui dépend du salon affiché et se recharge/efface
// ensemble (aperçu changé, sortie, session perdue...) — évite de répéter les
// mêmes 7 champs vides à chaque endroit qui réinitialise l'état.
const EMPTY_MODERATION = {
  bans: [] as ApiUser[],
  moderators: [] as ApiUser[],
  members: [] as ApiUser[],
  joinRequests: [] as ApiUser[],
  bannedWords: [] as string[],
  reports: [] as ApiSalonReport[],
};

let state: SalonsState = {
  mine: null,
  friends: [],
  loaded: false,
  current: null,
  inside: false,
  ...EMPTY_MODERATION,
  messages: [],
  error: "",
  folders: [],
  pendingOpenAccess: false,
  entryPending: false,
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

/** Puis-je modérer (bannir/débannir) le salon actuellement affiché ? Le
 *  propriétaire ou un de ses modérateurs — voir server/src/index.ts :
 *  assertSalonModeration. */
export function canModerateCurrentSalon(): boolean {
  const myId = getSession()?.user.id;
  if (!myId || !state.current) return false;
  return state.current.id === myId || state.current.moderatorIds.includes(myId);
}

/** Lien partageable vers le salon d'un propriétaire donné (page relais, voir
 *  server/src/index.ts : GET /join/:ownerId) — ne dépend pas d'avoir déjà
 *  ouvert ce salon, utilisable directement depuis une ligne de la liste. */
export function salonJoinLink(ownerId: string): string {
  return `${SERVER_URL}/join/${ownerId}`;
}

/** Le lien partageable du salon affiché. */
export function currentSalonJoinLink(): string | null {
  if (!state.current) return null;
  return salonJoinLink(state.current.id);
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

async function refreshSalonFolders() {
  try {
    setState({ folders: await api.salonFolders() });
  } catch {
    // serveur injoignable : on réessaiera à la reconnexion
  }
}

async function refreshModeration() {
  const id = state.current?.id;
  if (!id || !canModerateCurrentSalon()) {
    setState({ ...EMPTY_MODERATION });
    return;
  }
  try {
    const [bans, moderators, members, joinRequests, bannedWords, reports] = await Promise.all([
      api.salonBans(id),
      api.salonModerators(id),
      api.salonMembers(id),
      api.salonJoinRequests(id),
      api.salonBannedWords(id),
      api.salonReports(id),
    ]);
    if (state.current?.id === id) setState({ bans, moderators, members, joinRequests, bannedWords, reports });
  } catch {
    // pas grave
  }
}

/** Affiche l'aperçu d'un salon (sans y entrer) : qui est dedans en ce moment.
 *  Public (comme une invitation) — pas besoin d'être ami ni de fournir un mot
 *  de passe juste pour voir, seulement pour entrer (voir enterCurrentSalon).
 *  `openAccess` (voir pendingOpenAccess sur SalonsState) : ouvre directement
 *  sur le panneau réglages, pour le raccourci "⚙ Accès et modération" du
 *  menu ⋮ — n'a d'effet que si `ownerId` est bien mon salon. */
export async function previewSalon(ownerId: string, opts?: { openAccess?: boolean }) {
  try {
    const detail = await api.salon(ownerId);
    const myId = getSession()?.user.id;
    setState({
      current: detail,
      inside: !!myId && detail.present.some((u) => u.id === myId),
      ...EMPTY_MODERATION,
      messages: [],
      error: "",
      entryPending: false,
      pendingOpenAccess: !!opts?.openAccess && ownerId === myId,
    });
    refreshModeration();
  } catch (err) {
    flashError(err instanceof ApiError ? err.message : "Salon introuvable.");
  }
}

/** Consomme le signal posé par previewSalon(id, {openAccess:true}) — voir
 *  SalonDetail, qui l'appelle dès qu'il a initialisé son panneau réglages
 *  avec, pour ne l'utiliser qu'une fois. */
export function clearPendingOpenAccess() {
  setState({ pendingOpenAccess: false });
}

/** Referme l'aperçu / la vue d'un salon. Si on y était entré, on en sort. */
export function closeSalon() {
  if (state.inside && state.current) {
    api.leaveSalon(state.current.id).catch(() => {});
  }
  setState({ current: null, inside: false, ...EMPTY_MODERATION, messages: [], entryPending: false });
}

/** Envoie un message dans le salon actuellement affiché (faut y être). */
export function sendSalonMessage(text: string) {
  const clean = text.trim();
  if (!clean || !state.current || !state.inside) return;
  realtime.sendSalonMessage(state.current.id, clean);
}

/** Entre dans le salon actuellement affiché. `password` n'est nécessaire que
 *  pour un salon protégé quand on n'est ni ami ni modérateur — voir
 *  server/src/index.ts : assertSalonEntry (le serveur tranche, pas le client).
 *  Si le salon est 'private' ou exige une approbation manuelle, on ne rentre
 *  pas tout de suite : une demande est posée (entryPending devient vrai),
 *  voir l'événement temps réel "salon-join-approved"/"-declined" plus bas. */
export async function enterCurrentSalon(password?: string) {
  const id = state.current?.id;
  if (!id) return;
  try {
    const result = await api.enterSalon(id, password);
    if (state.current?.id !== id) return;
    if ("pending" in result && result.pending) {
      setState({ entryPending: true, error: "" });
      return;
    }
    setState({ current: { ...state.current, present: result.present }, inside: true, error: "", entryPending: false });
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

/** Change (chaîne vide = retire) le mot de passe d'entrée de mon salon.
 *  Renvoie un message d'erreur, ou null si ça a marché. */
export async function setMySalonPassword(password: string): Promise<string | null> {
  try {
    const detail = await api.setSalonPassword(password);
    setState({
      mine: state.mine ? { ...state.mine, hasPassword: detail.hasPassword } : state.mine,
      current:
        state.current && state.current.id === detail.id
          ? { ...state.current, hasPassword: detail.hasPassword }
          : state.current,
    });
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.message : "Impossible de changer le mot de passe.";
  }
}

/** Bannit quelqu'un du salon affiché (propriétaire ou modérateur). */
export async function banFromCurrentSalon(userId: string) {
  const salonId = state.current?.id;
  if (!salonId) return;
  const target = state.current?.present.find((u) => u.id === userId);
  try {
    await api.banFromSalon(salonId, userId);
    setState({
      current: state.current ? { ...state.current, present: state.current.present.filter((u) => u.id !== userId) } : state.current,
      bans: target && !state.bans.some((b) => b.id === userId) ? [...state.bans, target] : state.bans,
      moderators: state.moderators.filter((m) => m.id !== userId), // un banni perd aussi son statut de modérateur
      // ...et son statut de membre explicite / sa demande en attente, voir
      // server/src/index.ts : POST .../bans.
      members: state.members.filter((m) => m.id !== userId),
      joinRequests: state.joinRequests.filter((r) => r.id !== userId),
      mine: target && state.mine && state.mine.id === salonId ? { ...state.mine, present: Math.max(0, state.mine.present - 1) } : state.mine,
    });
  } catch (err) {
    flashError(err instanceof ApiError ? err.message : "Impossible de bannir cette personne.");
  }
}

/** Débannit quelqu'un du salon affiché. */
export async function unbanFromCurrentSalon(userId: string) {
  const salonId = state.current?.id;
  if (!salonId) return;
  try {
    await api.unbanFromSalon(salonId, userId);
    setState({ bans: state.bans.filter((u) => u.id !== userId) });
  } catch {
    // pas grave
  }
}

/** Nomme quelqu'un modérateur du salon affiché (propriétaire seul, voir
 *  server/src/index.ts). */
export async function addModeratorToCurrentSalon(userId: string) {
  const salonId = state.current?.id;
  if (!salonId) return;
  const target = state.current?.present.find((u) => u.id === userId);
  try {
    await api.addSalonModerator(salonId, userId);
    setState({
      current: state.current ? { ...state.current, moderatorIds: [...state.current.moderatorIds, userId] } : state.current,
      moderators: target && !state.moderators.some((m) => m.id === userId) ? [...state.moderators, target] : state.moderators,
    });
  } catch (err) {
    flashError(err instanceof ApiError ? err.message : "Impossible de nommer cette personne modératrice.");
  }
}

/** Retire le statut de modérateur (propriétaire seul). */
export async function removeModeratorFromCurrentSalon(userId: string) {
  const salonId = state.current?.id;
  if (!salonId) return;
  try {
    await api.removeSalonModerator(salonId, userId);
    setState({
      current: state.current
        ? { ...state.current, moderatorIds: state.current.moderatorIds.filter((id) => id !== userId) }
        : state.current,
      moderators: state.moderators.filter((m) => m.id !== userId),
    });
  } catch {
    // pas grave
  }
}

// -------------------------------------------------- Réglages d'accès (moi)
//
// Écran "Modération du salon" en fenêtre entière (SalonModerationScreen.tsx,
// 29/09/2026) : niveau d'accès, qui peut écrire, approbation manuelle des
// demandes, autoriser les membres à inviter — tous changés localement
// (brouillon) puis envoyés en un seul appel par "Enregistrer les
// paramètres", voir l'écran lui-même pour le brouillon.

/** Sauvegarde d'un coup les 4 réglages (voir server/src/index.ts :
 *  PATCH /salons/me/settings). Renvoie false si le serveur a refusé. */
export async function updateCurrentSalonSettings(patch: {
  accessLevel: SalonAccessLevel;
  writePermission: SalonWritePermission;
  requireApproval: boolean;
  allowMemberInvites: boolean;
}): Promise<boolean> {
  try {
    const detail = await api.updateSalonSettings(patch);
    setState({
      mine: state.mine ? { ...state.mine, ...patch } : state.mine,
      current: state.current && state.current.id === detail.id ? { ...state.current, ...patch } : state.current,
    });
    return true;
  } catch (err) {
    flashError(err instanceof ApiError ? err.message : "Impossible d'enregistrer les paramètres.");
    return false;
  }
}

// ------------------------------------------------ Membres et demandes d'entrée
//
// Voir server/src/db.ts : salon_members / salon_join_requests. Un membre a
// un accès permanent indépendant du niveau d'accès ; une demande est posée
// automatiquement par le serveur (voir enterCurrentSalon) quand le salon est
// 'private' ou exige une approbation manuelle.

/** Invite directement quelqu'un (accès accordé tout de suite, sans demande)
 *  — propriétaire/modérateurs toujours, un simple membre seulement si le
 *  propriétaire l'a autorisé (voir server/src/index.ts : assertSalonInvite). */
export async function inviteToCurrentSalon(userId: string, user?: ApiUser) {
  const salonId = state.current?.id;
  if (!salonId) return;
  try {
    await api.addSalonMember(salonId, userId);
    if (user && !state.members.some((m) => m.id === userId)) {
      setState({ members: [...state.members, user] });
    }
  } catch (err) {
    flashError(err instanceof ApiError ? err.message : "Impossible d'inviter cette personne.");
  }
}

/** Retire l'accès permanent de quelqu'un (propriétaire ou modérateur). */
export async function removeSalonMemberFromCurrent(userId: string) {
  const salonId = state.current?.id;
  if (!salonId) return;
  try {
    await api.removeSalonMember(salonId, userId);
    setState({ members: state.members.filter((m) => m.id !== userId) });
  } catch {
    // pas grave
  }
}

/** Accepte une demande d'entrée : elle devient membre. */
export async function approveJoinRequest(userId: string) {
  const salonId = state.current?.id;
  if (!salonId) return;
  const requester = state.joinRequests.find((r) => r.id === userId);
  try {
    await api.approveSalonJoinRequest(salonId, userId);
    setState({
      joinRequests: state.joinRequests.filter((r) => r.id !== userId),
      members: requester && !state.members.some((m) => m.id === userId) ? [...state.members, requester] : state.members,
    });
  } catch (err) {
    flashError(err instanceof ApiError ? err.message : "Impossible d'accepter cette demande.");
  }
}

/** Refuse une demande d'entrée : elle disparaît simplement. */
export async function declineJoinRequest(userId: string) {
  const salonId = state.current?.id;
  if (!salonId) return;
  try {
    await api.declineSalonJoinRequest(salonId, userId);
    setState({ joinRequests: state.joinRequests.filter((r) => r.id !== userId) });
  } catch {
    // pas grave
  }
}

// -------------------------------------------------------------- Mots interdits

export async function addBannedWordToCurrentSalon(word: string) {
  const salonId = state.current?.id;
  const clean = word.trim();
  if (!salonId || !clean) return;
  try {
    const words = await api.addSalonBannedWord(salonId, clean);
    setState({ bannedWords: words });
  } catch (err) {
    flashError(err instanceof ApiError ? err.message : "Impossible d'ajouter ce mot.");
  }
}

export async function removeBannedWordFromCurrentSalon(word: string) {
  const salonId = state.current?.id;
  if (!salonId) return;
  try {
    await api.removeSalonBannedWord(salonId, word);
    setState({ bannedWords: state.bannedWords.filter((w) => w !== word) });
  } catch {
    // pas grave
  }
}

// ------------------------------------------------------------------ Signalements

/** Signale un message vu dans la discussion en direct du salon affiché — le
 *  texte est envoyé tel quel (la discussion n'est jamais enregistrée côté
 *  serveur, voir salon_reports dans db.ts, donc c'est le seul moment où on a
 *  encore le texte sous la main). */
export async function reportSalonMessage(message: SalonMessage, reason: string) {
  const salonId = state.current?.id;
  if (!salonId) return;
  try {
    await api.reportSalonContent(salonId, { reportedUserId: message.from.id, messageText: message.text, reason });
  } catch (err) {
    flashError(err instanceof ApiError ? err.message : "Impossible d'envoyer le signalement.");
  }
}

export async function dismissReportFromCurrentSalon(reportId: string) {
  const salonId = state.current?.id;
  if (!salonId) return;
  try {
    await api.dismissSalonReport(salonId, reportId);
    setState({ reports: state.reports.filter((r) => r.id !== reportId) });
  } catch {
    // pas grave
  }
}

// -------------------------------------------------------- Espaces (salons)
//
// Organise l'onglet Salons (le mien + ceux de mes amis, voir
// SalonsScreen.tsx) — système séparé des espaces de chats (voir
// data/store.ts). Un salon dans un espace au plus.

/** Crée l'espace et renvoie son id — pratique pour aussitôt y ranger un
 *  salon (voir SalonsScreen.tsx : le "+ Nouvel espace" du menu "Ranger
 *  dans..." crée puis range en une seule action). */
export async function createSalonFolder(name: string): Promise<string> {
  const folder = await api.createSalonFolder(name);
  setState({ folders: [...state.folders, folder] });
  return folder.id;
}

export async function renameSalonFolder(folderId: string, name: string): Promise<void> {
  await api.renameSalonFolder(folderId, name);
  setState({ folders: state.folders.map((f) => (f.id === folderId ? { ...f, name } : f)) });
}

/** Supprime un espace : ce qu'il contenait redevient "non classé", les
 *  salons eux-mêmes ne changent pas. */
export async function deleteSalonFolder(folderId: string): Promise<void> {
  await api.deleteSalonFolder(folderId);
  setState({ folders: state.folders.filter((f) => f.id !== folderId) });
}

/** Range ce salon dans cet espace (`folderId` null = "non classé") — un
 *  seul à la fois, ça remplace le précédent automatiquement. */
export async function moveSalonToFolder(salonId: string, folderId: string | null): Promise<void> {
  await api.setSalonFolder(salonId, folderId);
  setState({
    folders: state.folders.map((f) => {
      const has = f.salonIds.includes(salonId);
      if (f.id === folderId) return has ? f : { ...f, salonIds: [...f.salonIds, salonId] };
      return has ? { ...f, salonIds: f.salonIds.filter((id) => id !== salonId) } : f;
    }),
  });
}

// ------------------------------------------------------------ Temps réel

function onServerEvent(event: ServerEvent) {
  switch (event.type) {
    case "hello":
      // (re)connexion : on se remet à jour
      refreshSalons();
      refreshSalonFolders();
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
    case "salon-call-status": {
      // Un appel démarre/s'arrête dans ce salon — indépendant de qui discute
      // par écrit dedans (voir server/src/index.ts : broadcastSalonCallStatus,
      // ajouté le 28/09/2026), pour afficher "En vocal" dans la liste sans
      // avoir à l'ouvrir.
      const salonId = String(event.salonId);
      const inCall = !!event.inCall;
      const patch: Partial<SalonsState> = {};
      if (state.mine && state.mine.id === salonId) patch.mine = { ...state.mine, inCall };
      if (state.friends.some((s) => s.id === salonId)) {
        patch.friends = state.friends.map((s) => (s.id === salonId ? { ...s, inCall } : s));
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
        setState({ current: null, inside: false, ...EMPTY_MODERATION, messages: [], entryPending: false });
        flashError("Tu as été banni·e de ce salon.", 4000);
      }
      break;
    }
    // Quelqu'un vient de demander à entrer dans un salon que je possède ou
    // modère (salon 'private' ou approbation manuelle active) — voir
    // server/src/index.ts : POST .../enter et notifySalonStaff. Mis à jour
    // en direct si l'écran de modération est déjà ouvert dessus.
    case "salon-join-request": {
      const salonId = String(event.salonId);
      if (state.current && state.current.id === salonId && canModerateCurrentSalon()) {
        const from = event.from as ApiUser;
        if (!state.joinRequests.some((r) => r.id === from.id)) {
          setState({ joinRequests: [...state.joinRequests, from] });
        }
      }
      break;
    }
    // Ma propre demande d'entrée (ou l'invitation directe qui me concerne)
    // vient d'être acceptée : je réessaie d'entrer tout de suite, sans avoir
    // à retaper quoi que ce soit — voir enterCurrentSalon.
    case "salon-join-approved": {
      const salonId = String(event.salonId);
      if (state.current && state.current.id === salonId) {
        setState({ entryPending: false });
        enterCurrentSalon();
      }
      break;
    }
    case "salon-join-declined": {
      const salonId = String(event.salonId);
      if (state.current && state.current.id === salonId) {
        setState({ entryPending: false });
        flashError("Ta demande d'entrée a été refusée.", 4000);
      }
      break;
    }
    // Mon dernier message n'est pas passé (droit d'écrire insuffisant, ou
    // mot interdit) — voir index.ts, handler WS "salon-message".
    case "salon-write-denied": {
      const salonId = String(event.salonId);
      if (state.current && state.current.id === salonId) {
        flashError(
          event.reason === "banned-word"
            ? "Ce message contient un mot interdit dans ce salon."
            : "Tu n'as pas le droit d'écrire dans ce salon.",
        );
      }
      break;
    }
    // Un signalement vient d'être posé sur un salon que je possède ou
    // modère : on recharge la liste si l'écran de modération est ouvert
    // dessus (pas de contenu à fusionner à la main, un signalement arrive
    // avec peu d'infos côté événement).
    case "salon-report": {
      const salonId = String(event.salonId);
      if (state.current && state.current.id === salonId && canModerateCurrentSalon()) {
        api.salonReports(salonId).then((reports) => {
          if (state.current?.id === salonId) setState({ reports });
        }).catch(() => {});
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
    refreshSalonFolders();
  } else {
    if (currentToken === null && state.mine === null && state.friends.length === 0) return;
    currentToken = null;
    state = {
      mine: null,
      friends: [],
      loaded: false,
      current: null,
      inside: false,
      ...EMPTY_MODERATION,
      messages: [],
      error: "",
      folders: [],
      pendingOpenAccess: false,
      entryPending: false,
    };
    notify();
  }
}

subscribeSession(onSessionChange);
onSessionChange();
