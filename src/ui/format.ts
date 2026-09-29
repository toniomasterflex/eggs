// Petits formatages d'affichage partagés entre les écrans (voir .count-badge
// dans ui.css — badge carré à coins arrondis utilisé pour tout compteur :
// présence dans un salon, nombre d'éléments dans un espace...).

/** Un compteur affiché dans un badge : au-delà de 99, on plafonne l'affichage
 *  ("99+") plutôt que de laisser le badge s'élargir sans fin. */
export function formatCount(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** Un horodatage affiché sous le nom dans une liste de discussions (voir
 *  .chat-subtitle dans ui.css) — mêmes conventions que WhatsApp/Messenger :
 *  "à l'instant", "5 min", l'heure si c'est aujourd'hui, "Hier", une date
 *  compacte au-delà. Pas de compte à rebours en jours ("3 j", jugé peu
 *  lisible le 28/09/2026) ni de jour de la semaine ("Lundi", retiré le
 *  29/09/2026 — voir isRecent ci-dessous : pour un ami, ChatsScreen.tsx
 *  affiche son statut à la place au-delà d'hier, plus utile qu'une date qui
 *  devient vite obsolète). */
export function formatRelativeTime(ts: number): string {
  const now = new Date();
  const d = new Date(ts);
  const diff = now.getTime() - ts;

  if (diff < 60_000) return "à l'instant";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} min`;

  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Hier";

  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

/** Vrai si formatRelativeTime(ts) donne encore une info fraîche (aujourd'hui
 *  ou hier). Sert à ChatsScreen.tsx pour savoir quand basculer vers le
 *  statut d'un ami plutôt qu'une date — voir le commentaire ci-dessus. */
export function isRecent(ts: number): boolean {
  const now = new Date();
  const d = new Date(ts);
  if (d.toDateString() === now.toDateString()) return true;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  return d.toDateString() === yesterday.toDateString();
}

/** Les trois états affichés partout où on montre qui est connecté (liste de
 *  discussions, Répertoire, en-tête de conversation, présents d'un salon) —
 *  façon Slack/Discord (demande d'Antoine du 21/09/2026) : vert = en ligne et
 *  actif, orange = en ligne mais passé "absent" à la main (voir
 *  data/session.ts : setMyAwayStatus, ApiUser.away), rouge = pas connecté du
 *  tout. `away` ne veut rien dire tant qu'on n'est pas en ligne, d'où le
 *  online avant tout. Un seul nom de classe CSS par état (voir .status-tag/
 *  .row-status-dot/.presence-dot dans ui.css, mêmes trois classes partout). */
export type PresenceStatus = "online" | "away" | "offline";

export function presenceStatus(online: boolean | undefined, away: boolean | undefined): PresenceStatus {
  if (!online) return "offline";
  return away ? "away" : "online";
}

export function presenceLabel(status: PresenceStatus): string {
  return status === "online" ? "En ligne" : status === "away" ? "Absent" : "Hors ligne";
}
