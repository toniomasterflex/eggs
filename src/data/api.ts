// Parle au serveur d'Eggs (HTTP). C'est la seule porte d'accès au réseau,
// avec realtime.ts pour le temps réel.

// Adresse du serveur. Pour un serveur en ligne, on changera seulement ceci
// (ou on écrira l'adresse dans localStorage, clé « eggs.server »).
const DEFAULT_SERVER =
  (import.meta.env.VITE_SERVER_URL as string | undefined) || "https://tmf.taila61565.ts.net";

function readServer(): string {
  try {
    return localStorage.getItem("eggs.server") || DEFAULT_SERVER;
  } catch {
    return DEFAULT_SERVER;
  }
}

export const SERVER_URL = readServer().replace(/\/+$/, "");

/** Change l'adresse du serveur (vide = adresse par défaut). Recharger ensuite la fenêtre. */
export function saveServerUrl(url: string) {
  try {
    const clean = url.trim().replace(/\/+$/, "");
    if (clean) localStorage.setItem("eggs.server", clean);
    else localStorage.removeItem("eggs.server");
  } catch {
    // pas grave
  }
}
export const WS_URL = SERVER_URL.replace(/^http/, "ws");

export const SESSION_KEY = "eggs.session";

export interface ApiUser {
  id: string;
  username: string;
  species: string;
  color: string;
  // Pseudos affichés sur le profil et le Répertoire (simple affichage, saisi
  // à la main — pas d'import de liste d'amis, voir server/src/service.ts :
  // updateProfileLinks). null = pas renseigné.
  discord: string | null;
  steam: string | null;
  // Statut « absent » réglé à la main par la personne elle-même (voir
  // api.setAwayStatus/PATCH /me/status côté server) — distinct de `online`
  // sur ApiFriend, qui lui reflète la connexion elle-même. Toujours présent
  // (même sur "moi") puisqu'il vient de USER_COLS côté serveur.
  away: boolean;
}

/** Réponse de GET /me uniquement : email/emailVerified restent privés (voir
 *  server/src/service.ts, jamais dans USER_COLS partagé avec le profil des
 *  autres) — absents des amis, groupes, résultats de recherche, etc. */
export interface ApiMe extends ApiUser {
  email: string | null;
  emailVerified: boolean;
}

export interface ApiFriend extends ApiUser {
  unread: number;
  lastAt: number | null;
  readAt: number | null;
  online: boolean;
}

export interface ApiAttachment {
  url: string; // relative au serveur ("/uploads/…") — voir data/store.ts : toMessage
  kind: "image" | "video" | "audio";
  name: string;
}

export interface ApiReaction {
  userId: string;
  emoji: string;
}

// `to` est null pour un message de groupe (voir groupId à la place) —
// exactement un des deux est renseigné (voir server/src/service.ts : Message).
export interface ApiMessage {
  id: number;
  from: string;
  to: string | null;
  groupId: string | null;
  text: string;
  at: number;
  attachment: ApiAttachment | null;
  reactions: ApiReaction[];
}

// Groupe fermé façon WhatsApp (voir data/types.ts : Group).
export interface ApiGroup {
  id: string;
  name: string;
  createdBy: string;
  members: ApiUser[];
}

export interface ApiGroupSummary extends ApiGroup {
  lastAt: number | null;
  unread: number;
}

export interface ApiCreature {
  id: string;
  species: string;
  color: string;
  active: boolean;
  partnerId: string | null;
  bornAt: number;
}

export interface ApiEgg {
  id: string;
  source: "welcome" | "weekly" | "gift" | "shop";
  partnerId: string | null;
  grantedAt: number;
}

// Shop : maquette, voir service.ts (serveur) — pas de vrai paiement pour
// l'instant, priceLabel n'est là que pour l'affichage.
export interface ApiEggBox {
  id: string;
  count: number;
  label: string;
  priceLabel: string;
}

// Skin rare : achat = une créature de cette espèce ajoutée directement à la
// collection (pas d'œuf à ouvrir), un seul exemplaire par personne.
export interface ApiSkin {
  id: string;
  label: string;
  priceLabel: string;
}

// Niveaux d'accès et réglages d'écriture — écran "Modération du salon" en
// fenêtre entière du 29/09/2026 (voir SalonModerationScreen.tsx), inspiré
// d'une maquette d'Antoine. Fait évoluer la décision du 23/09/2026 qui
// excluait la chaîne "amis d'amis" pour REJOINDRE un salon (Antoine a choisi
// d'aller plus loin) ; "friends_of_friends" ici sert aussi bien pour
// accessLevel (qui peut entrer) que pour writePermission (qui peut écrire).
export type SalonAccessLevel = "private" | "friends" | "friends_of_friends" | "open";
export type SalonWritePermission = "members" | "friends_of_friends" | "everyone";

// Salon : chaque personne a le sien (id = son propre id). Dans la liste
// (GET /salons), "present" est juste un compte ; dans le détail d'un salon et
// les réponses entrer/sortir, c'est la liste complète des personnes présentes.
export interface ApiSalonSummary {
  id: string;
  name: string;
  owner: ApiUser;
  present: number;
  // Un mot de passe protège l'entrée pour les non-amis, voir la décision du
  // 26/09/2026 (les amis et modérateurs entrent toujours librement).
  hasPassword: boolean;
  moderatorIds: string[];
  // Un appel vocal est en cours dans ce salon en ce moment (voir
  // server/src/calls.ts : whoIsInCall) — ajouté le 28/09/2026 pour afficher
  // "En vocal" directement dans la liste, sans avoir à ouvrir le salon.
  inCall: boolean;
  accessLevel: SalonAccessLevel;
  writePermission: SalonWritePermission;
  requireApproval: boolean;
  allowMemberInvites: boolean;
}

export interface ApiSalonList {
  mine: ApiSalonSummary | null;
  friends: ApiSalonSummary[];
}

export interface ApiSalonDetail {
  id: string;
  name: string;
  owner: ApiUser;
  present: ApiUser[];
  hasPassword: boolean;
  moderatorIds: string[];
  accessLevel: SalonAccessLevel;
  writePermission: SalonWritePermission;
  requireApproval: boolean;
  allowMemberInvites: boolean;
}

/** Un signalement de contenu (voir SalonModerationScreen.tsx) : la
 *  discussion n'étant jamais enregistrée côté serveur, on ne garde qu'un
 *  instantané du texte signalé au moment du signalement. */
export interface ApiSalonReport {
  id: string;
  reporter: ApiUser;
  reported: ApiUser | null;
  messageText: string;
  reason: string;
  createdAt: string;
}

// Cercles (voir data/store.ts / data/salons.ts) : deux systèmes séparés,
// un pour l'onglet Chats (amis + groupes mêlés), un pour l'onglet Salons —
// décision du 27/09/2026. Chaque cercle arrive déjà avec ce qu'il contient
// (chatIds/salonIds), pas d'appel à part pour ça.
export interface ApiChatFolder {
  id: string;
  name: string;
  chatIds: string[]; // id d'ami OU de groupe — même espace que ChatsScreen.tsx
}

export interface ApiSalonFolder {
  id: string;
  name: string;
  salonIds: string[]; // id du propriétaire du salon, comme partout ailleurs
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized: (() => void) | null = null;

/** Appelée quand le serveur refuse le jeton (session expirée). */
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

function readToken(): string | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) return (JSON.parse(raw) as { token?: string }).token ?? null;
  } catch {
    // pas de session
  }
  return null;
}

export const hasToken = () => readToken() !== null;

async function request<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = auth ? readToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(SERVER_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Serveur injoignable.");
  }

  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    if (res.status === 401 && auth) onUnauthorized?.();
    throw new ApiError(res.status, data?.error ?? "Erreur.");
  }
  return data as T;
}

// Photo / vidéo / son : à part de request() ci-dessus, qui n'envoie que du
// JSON — ici un vrai fichier (multipart), pas de body JSON. Partagé entre
// l'envoi à un ami et l'envoi dans un groupe (seul le chemin change).
async function uploadAttachment(path: string, blob: Blob, filename: string): Promise<ApiMessage> {
  const token = readToken();
  const form = new FormData();
  form.append("file", blob, filename);

  let res: Response;
  try {
    res = await fetch(SERVER_URL + path, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
  } catch {
    throw new ApiError(0, "Serveur injoignable.");
  }

  const data = (await res.json().catch(() => null)) as (ApiMessage & { error?: string }) | null;
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    throw new ApiError(res.status, data?.error ?? "Erreur.");
  }
  return data as ApiMessage;
}

export const api = {
  register: (username: string, email: string, password: string) =>
    request<{ token: string; user: ApiUser }>("POST", "/auth/register", { username, email, password }, false),
  login: (username: string, password: string) =>
    request<{ token: string; user: ApiUser }>("POST", "/auth/login", { username, password }, false),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  changePassword: (current: string, next: string) =>
    request<{ ok: true }>("POST", "/me/password", { current, next }),
  deleteAccount: (password: string) => request<{ ok: true }>("DELETE", "/me", { password }),
  logoutAll: () => request<{ ok: true }>("POST", "/auth/logout-all"),
  me: () => request<ApiMe>("GET", "/me"),
  // Renvoie l'email de vérification (voir server/src/mail.ts) — utile si le
  // premier n'est jamais arrivé ou si son lien (24h) a expiré.
  resendVerification: () => request<{ ok: true; alreadyVerified?: boolean }>("POST", "/me/resend-verification"),
  updateMe: (patch: { species?: string; color?: string; discord?: string; steam?: string }) =>
    request<ApiUser>("PATCH", "/me", patch),
  // Statut « absent » réglé à la main (façon Slack/Discord) — voir ApiUser.away.
  setAwayStatus: (away: boolean) => request<ApiUser>("PATCH", "/me/status", { away }),
  searchUsers: (q: string) =>
    request<(ApiUser & { friend: boolean })[]>("GET", `/users/search?q=${encodeURIComponent(q)}`),
  friends: () => request<ApiFriend[]>("GET", "/friends"),
  addFriend: (userId: string) => request<ApiUser>("POST", "/friends", { userId }),
  removeFriend: (friendId: string) => request<{ ok: true }>("DELETE", `/friends/${friendId}`),
  messages: (friendId: string) => request<ApiMessage[]>("GET", `/messages/${friendId}`),
  sendMessage: (friendId: string, text: string) =>
    request<ApiMessage>("POST", `/messages/${friendId}`, { text }),
  // Photo / vidéo / son (voir data/mediaKind.ts) : à part de request() ci-dessus,
  // qui n'envoie que du JSON — ici un vrai fichier (multipart), pas de body JSON.
  sendAttachment: (friendId: string, blob: Blob, filename: string) =>
    uploadAttachment(`/messages/${friendId}/attachment`, blob, filename),
  markRead: (friendId: string) => request<{ ok: true }>("POST", `/messages/${friendId}/read`),
  // Réaction façon iMessage/WhatsApp (voir ui/screens/ConversationScreen.tsx).
  setReaction: (messageId: string, emoji: string) =>
    request<ApiMessage>("PUT", `/messages/${messageId}/reaction`, { emoji }),
  removeReaction: (messageId: string) => request<ApiMessage>("DELETE", `/messages/${messageId}/reaction`),
  // Œufs et créatures
  eggs: () => request<ApiEgg[]>("GET", "/eggs"),
  openEgg: (eggId: string) => request<ApiCreature>("POST", `/eggs/${eggId}/open`),
  creatures: () => request<ApiCreature[]>("GET", "/creatures"),
  activateCreature: (creatureId: string) => request<ApiUser>("POST", `/creatures/${creatureId}/activate`),
  giftEgg: (eggId: string, friendId: string) => request<ApiEgg>("POST", `/eggs/${eggId}/gift`, { friendId }),
  // Shop
  eggBoxes: () => request<ApiEggBox[]>("GET", "/shop/eggs"),
  buyEggBox: (boxId: string) => request<{ count: number }>("POST", `/shop/eggs/${boxId}`),
  skins: () => request<ApiSkin[]>("GET", "/shop/skins"),
  buySkin: (skinId: string) => request<ApiCreature>("POST", `/shop/skins/${skinId}`),
  // Salons
  salons: () => request<ApiSalonList>("GET", "/salons"),
  salon: (ownerId: string) => request<ApiSalonDetail>("GET", `/salons/${ownerId}`),
  renameSalon: (name: string) => request<ApiSalonDetail>("PATCH", "/salons/me", { name }),
  // Chaîne vide = retirer le mot de passe (voir server/src/index.ts).
  setSalonPassword: (password: string) => request<ApiSalonDetail>("PATCH", "/salons/me/password", { password }),
  // Réglages d'accès/modération (écran "Modération du salon") : tous
  // ensemble, un seul bouton "Enregistrer les paramètres" côté client.
  updateSalonSettings: (patch: {
    accessLevel: SalonAccessLevel;
    writePermission: SalonWritePermission;
    requireApproval: boolean;
    allowMemberInvites: boolean;
  }) => request<ApiSalonDetail>("PATCH", "/salons/me/settings", patch),
  // `pending: true` = salon 'private' ou approbation manuelle active, une
  // demande vient d'être posée au lieu d'entrer pour de vrai (voir
  // assertSalonEntry côté serveur).
  enterSalon: (ownerId: string, password?: string) =>
    request<{ present: ApiUser[]; pending?: false } | { pending: true }>(
      "POST",
      `/salons/${ownerId}/enter`,
      password ? { password } : {},
    ),
  leaveSalon: (ownerId: string) => request<{ present: ApiUser[] }>("POST", `/salons/${ownerId}/leave`),
  // Bans (voir server/src/index.ts : réservé au propriétaire ET aux modérateurs).
  salonBans: (ownerId: string) => request<ApiUser[]>("GET", `/salons/${ownerId}/bans`),
  banFromSalon: (ownerId: string, userId: string) =>
    request<{ ok: true }>("POST", `/salons/${ownerId}/bans`, { userId }),
  unbanFromSalon: (ownerId: string, userId: string) =>
    request<{ ok: true }>("DELETE", `/salons/${ownerId}/bans/${userId}`),
  // Modérateurs (réservé au propriétaire, contrairement aux bans ci-dessus).
  salonModerators: (ownerId: string) => request<ApiUser[]>("GET", `/salons/${ownerId}/moderators`),
  addSalonModerator: (ownerId: string, userId: string) =>
    request<{ ok: true }>("POST", `/salons/${ownerId}/moderators`, { userId }),
  removeSalonModerator: (ownerId: string, userId: string) =>
    request<{ ok: true }>("DELETE", `/salons/${ownerId}/moderators/${userId}`),
  // Membres explicites (accès permanent indépendant du niveau d'accès — voir
  // server/src/db.ts : salon_members). Invitation directe (assertSalonInvite
  // côté serveur : propriétaire/modérateurs toujours, autres membres
  // seulement si allowMemberInvites).
  salonMembers: (ownerId: string) => request<ApiUser[]>("GET", `/salons/${ownerId}/members`),
  addSalonMember: (ownerId: string, userId: string) =>
    request<{ ok: true }>("POST", `/salons/${ownerId}/members`, { userId }),
  removeSalonMember: (ownerId: string, userId: string) =>
    request<{ ok: true }>("DELETE", `/salons/${ownerId}/members/${userId}`),
  // Demandes d'entrée en attente (salon 'private' ou approbation manuelle).
  salonJoinRequests: (ownerId: string) => request<ApiUser[]>("GET", `/salons/${ownerId}/requests`),
  approveSalonJoinRequest: (ownerId: string, userId: string) =>
    request<{ ok: true }>("POST", `/salons/${ownerId}/requests/${userId}/approve`),
  declineSalonJoinRequest: (ownerId: string, userId: string) =>
    request<{ ok: true }>("DELETE", `/salons/${ownerId}/requests/${userId}`),
  // Mots interdits (filtre simple, vérifié à l'envoi de chaque message).
  salonBannedWords: (ownerId: string) => request<string[]>("GET", `/salons/${ownerId}/banned-words`),
  addSalonBannedWord: (ownerId: string, word: string) =>
    request<string[]>("POST", `/salons/${ownerId}/banned-words`, { word }),
  removeSalonBannedWord: (ownerId: string, word: string) =>
    request<{ ok: true }>("DELETE", `/salons/${ownerId}/banned-words/${encodeURIComponent(word)}`),
  // Signalements de contenu.
  salonReports: (ownerId: string) => request<ApiSalonReport[]>("GET", `/salons/${ownerId}/reports`),
  reportSalonContent: (ownerId: string, payload: { reportedUserId?: string; messageText: string; reason: string }) =>
    request<{ ok: true }>("POST", `/salons/${ownerId}/reports`, payload),
  dismissSalonReport: (ownerId: string, reportId: string) =>
    request<{ ok: true }>("DELETE", `/salons/${ownerId}/reports/${reportId}`),
  // Groupes (voir data/types.ts : Group) — coexistent avec les Salons, ne les remplacent pas.
  groups: () => request<ApiGroupSummary[]>("GET", "/groups"),
  createGroup: (name: string, memberIds: string[]) =>
    request<ApiGroup>("POST", "/groups", { name, memberIds }),
  groupMessages: (groupId: string) => request<ApiMessage[]>("GET", `/groups/${groupId}/messages`),
  sendGroupMessage: (groupId: string, text: string) =>
    request<ApiMessage>("POST", `/groups/${groupId}/messages`, { text }),
  sendGroupAttachment: (groupId: string, blob: Blob, filename: string) =>
    uploadAttachment(`/groups/${groupId}/messages/attachment`, blob, filename),
  markGroupRead: (groupId: string) => request<{ ok: true }>("POST", `/groups/${groupId}/read`),
  leaveGroup: (groupId: string) => request<{ ok: true }>("POST", `/groups/${groupId}/leave`),
  // Réservé au créateur (voir server) : le groupe disparaît pour tout le monde.
  deleteGroup: (groupId: string) => request<{ ok: true }>("DELETE", `/groups/${groupId}`),
  // Cercles de chats (voir data/api.ts : ApiChatFolder) — système séparé
  // des cercles de salons plus bas.
  chatFolders: () => request<ApiChatFolder[]>("GET", "/chat-folders"),
  createChatFolder: (name: string) => request<ApiChatFolder>("POST", "/chat-folders", { name }),
  renameChatFolder: (folderId: string, name: string) =>
    request<{ ok: true }>("PATCH", `/chat-folders/${folderId}`, { name }),
  deleteChatFolder: (folderId: string) => request<{ ok: true }>("DELETE", `/chat-folders/${folderId}`),
  // `folderId` null = retire du classement (redevient "non classé").
  setChatFolder: (chatId: string, folderId: string | null) =>
    request<{ ok: true }>("PUT", `/chat-folders/items/${chatId}`, { folderId }),
  // Cercles de salons — même principe, système séparé.
  salonFolders: () => request<ApiSalonFolder[]>("GET", "/salon-folders"),
  createSalonFolder: (name: string) => request<ApiSalonFolder>("POST", "/salon-folders", { name }),
  renameSalonFolder: (folderId: string, name: string) =>
    request<{ ok: true }>("PATCH", `/salon-folders/${folderId}`, { name }),
  deleteSalonFolder: (folderId: string) => request<{ ok: true }>("DELETE", `/salon-folders/${folderId}`),
  setSalonFolder: (salonId: string, folderId: string | null) =>
    request<{ ok: true }>("PUT", `/salon-folders/items/${salonId}`, { folderId }),
};
