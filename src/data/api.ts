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
}

export interface ApiFriend extends ApiUser {
  unread: number;
  lastAt: number | null;
  readAt: number | null;
  online: boolean;
}

export interface ApiMessage {
  id: number;
  from: string;
  to: string;
  text: string;
  at: number;
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

// Salon : chaque personne a le sien (id = son propre id). Dans la liste
// (GET /salons), "present" est juste un compte ; dans le détail d'un salon et
// les réponses entrer/sortir, c'est la liste complète des personnes présentes.
export interface ApiSalonSummary {
  id: string;
  name: string;
  owner: ApiUser;
  present: number;
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

export const api = {
  register: (username: string, password: string) =>
    request<{ token: string; user: ApiUser }>("POST", "/auth/register", { username, password }, false),
  login: (username: string, password: string) =>
    request<{ token: string; user: ApiUser }>("POST", "/auth/login", { username, password }, false),
  logout: () => request<{ ok: true }>("POST", "/auth/logout"),
  changePassword: (current: string, next: string) =>
    request<{ ok: true }>("POST", "/me/password", { current, next }),
  deleteAccount: (password: string) => request<{ ok: true }>("DELETE", "/me", { password }),
  logoutAll: () => request<{ ok: true }>("POST", "/auth/logout-all"),
  me: () => request<ApiUser>("GET", "/me"),
  updateMe: (patch: { species?: string; color?: string }) => request<ApiUser>("PATCH", "/me", patch),
  searchUsers: (q: string) =>
    request<(ApiUser & { friend: boolean })[]>("GET", `/users/search?q=${encodeURIComponent(q)}`),
  friends: () => request<ApiFriend[]>("GET", "/friends"),
  addFriend: (userId: string) => request<ApiUser>("POST", "/friends", { userId }),
  removeFriend: (friendId: string) => request<{ ok: true }>("DELETE", `/friends/${friendId}`),
  messages: (friendId: string) => request<ApiMessage[]>("GET", `/messages/${friendId}`),
  sendMessage: (friendId: string, text: string) =>
    request<ApiMessage>("POST", `/messages/${friendId}`, { text }),
  markRead: (friendId: string) => request<{ ok: true }>("POST", `/messages/${friendId}/read`),
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
  enterSalon: (ownerId: string) => request<{ present: ApiUser[] }>("POST", `/salons/${ownerId}/enter`),
  leaveSalon: (ownerId: string) => request<{ present: ApiUser[] }>("POST", `/salons/${ownerId}/leave`),
  salonBlocks: () => request<ApiUser[]>("GET", "/salons/blocks"),
  blockFromSalon: (userId: string) => request<{ ok: true }>("POST", "/salons/blocks", { userId }),
  unblockFromSalon: (userId: string) => request<{ ok: true }>("DELETE", `/salons/blocks/${userId}`),
};
