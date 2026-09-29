// La session : qui est connecté sur cet ordinateur. Partagée entre toutes les
// fenêtres d'Eggs (le menu et les pets épinglés) via le stockage local.

import { useSyncExternalStore } from "react";
import { SESSION_KEY, api, setUnauthorizedHandler } from "./api";
import type { ApiUser } from "./api";
import type { Species } from "./types";

export interface Session {
  token: string;
  user: ApiUser;
}

function load(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Session;
      if (s && typeof s.token === "string" && s.user && typeof s.user.id === "string") return s;
    }
  } catch {
    // pas de session
  }
  return null;
}

let session: Session | null = load();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

function setSession(next: Session | null) {
  session = next;
  try {
    if (next) localStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // pas grave
  }
  notify();
}

// Une autre fenêtre s'est connectée ou déconnectée.
window.addEventListener("storage", (e) => {
  if (e.key !== SESSION_KEY) return;
  session = load();
  notify();
});

// Le serveur refuse le jeton : on se déconnecte.
setUnauthorizedHandler(() => setSession(null));

export function getSession(): Session | null {
  return session;
}

export function subscribeSession(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hook React : la session courante (null = déconnecté). */
export function useSession(): Session | null {
  return useSyncExternalStore(subscribeSession, () => session);
}

/** Mon apparence actuelle : toujours celle de ma créature active (ou « egg »
 *  si je n'ai encore rien éclos). Vient directement du compte, jamais choisie
 *  librement (voir data/profile.ts pour l'éclosion et le choix de créature). */
export function useMyAppearance(): { species: Species; color: string } {
  const s = useSession();
  return { species: (s?.user.species as Species | undefined) ?? "egg", color: s?.user.color ?? "" };
}

/** Met à jour l'apparence (et le reste de la fiche) après une éclosion ou un
 *  changement de créature active, sans attendre une reconnexion. */
export function updateSessionUser(user: ApiUser) {
  if (!session) return;
  setSession({ ...session, user });
}

export async function login(username: string, password: string) {
  const { token, user } = await api.login(username, password);
  setSession({ token, user });
}

export async function register(username: string, email: string, password: string) {
  const { token, user } = await api.register(username, email, password);
  setSession({ token, user });
}

export async function logout() {
  try {
    await api.logout();
  } catch {
    // le serveur est peut-être injoignable : on se déconnecte quand même
  }
  setSession(null);
}

/** Déconnexion locale (le serveur a coupé la connexion). */
export function clearSession() {
  setSession(null);
}

/** Change mon mot de passe (les autres appareils sont déconnectés). */
export async function changePassword(current: string, next: string) {
  await api.changePassword(current, next);
}

/** Met à jour mes pseudos Discord/Steam affichés sur le profil et le
 *  Répertoire (simple affichage, voir data/api.ts : ApiUser). Chaîne vide =
 *  effacer le pseudo. */
export async function updateProfileLinks(discord: string, steam: string) {
  const user = await api.updateMe({ discord, steam });
  updateSessionUser(user);
}

/** Mon statut « absent », réglé à la main (voir ApiUser.away) — indépendant
 *  d'être connecté ou non. Toujours `false` tant qu'on ne l'a pas activé. */
export function useMyAwayStatus(): boolean {
  const s = useSession();
  return s?.user.away ?? false;
}

/** Change mon statut « absent » (façon Slack/Discord, demande d'Antoine du
 *  21/09/2026) — persisté côté serveur (voir PATCH /me/status), donc visible
 *  par mes amis et dans les salons dès la prochaine synchro. */
export async function setMyAwayStatus(away: boolean) {
  const user = await api.setAwayStatus(away);
  updateSessionUser(user);
}

/** Supprime définitivement mon compte, puis me déconnecte. */
export async function deleteAccount(password: string) {
  await api.deleteAccount(password);
  setSession(null);
}

/** Email et son état de vérification (voir server/src/mail.ts) — pas dans
 *  session.user (voir data/api.ts : ApiUser vs ApiMe, resté privé), donc
 *  chargé à la demande là où c'est affiché (voir AccountScreen.tsx). */
export async function getMyEmailStatus() {
  const me = await api.me();
  return { email: me.email, emailVerified: me.emailVerified };
}

/** Renvoie l'email de vérification (voir server/src/mail.ts) — utile si le
 *  premier n'est jamais arrivé ou si son lien (24h) a expiré. */
export async function resendVerificationEmail() {
  return api.resendVerification();
}

/** Me déconnecte de tous mes appareils, y compris celui-ci. */
export async function logoutAll() {
  try {
    await api.logoutAll();
  } catch {
    // le serveur est peut-être injoignable : on se déconnecte quand même ici
  }
  setSession(null);
}
