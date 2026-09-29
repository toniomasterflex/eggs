// Présence en direct dans les appels de salon (voix + partage d'écran) : qui
// est actuellement EN APPEL dans quel salon.
//
// Comme salons.ts (dont ce module s'inspire directement), ça vit uniquement
// en mémoire : un appel ne survit pas à un redémarrage du serveur, il se
// reconstruit tout seul si les participants rejoignent à nouveau après coup.
//
// Être « en appel » est distinct d'être « présent » dans le salon (voir
// salons.ts) : on peut très bien discuter par écrit dans un salon sans jamais
// rejoindre l'appel vocal. Rejoindre l'appel suppose déjà d'être présent dans
// le salon — c'est vérifié côté index.ts avant d'appeler joinCall ici, pas
// dans ce module.
//
// Mesh pair-à-pair direct (voir data/salonCall.ts côté client) : pas de
// serveur de mixage/relais audio-vidéo, chaque participant se connecte
// directement à chaque autre. Ça ne tient pas à l'échelle, donc on plafonne
// la taille d'un même appel — décision du 27/09/2026 (STUN public gratuit
// uniquement, pas de TURN, pour rester simple en v1).

export const MAX_CALL_SIZE = 5;

const calls = new Map<string, Set<string>>(); // salonId -> en appel (userId)

/** Fait entrer quelqu'un dans l'appel d'un salon (aucun effet si déjà dedans).
 *  Renvoie la liste à jour des participants, ou null si l'appel est déjà
 *  plein (et que cette personne n'y était pas encore). */
export function joinCall(salonId: string, userId: string): string[] | null {
  let set = calls.get(salonId);
  if (!set) calls.set(salonId, (set = new Set()));
  if (!set.has(userId) && set.size >= MAX_CALL_SIZE) return null;
  set.add(userId);
  return [...set];
}

/** Fait sortir quelqu'un de l'appel d'un salon (départ volontaire, sortie du
 *  salon, bannissement, ou déconnexion — voir leaveAllCalls). Renvoie la
 *  liste à jour. */
export function leaveCall(salonId: string, userId: string): string[] {
  const set = calls.get(salonId);
  if (!set) return [];
  set.delete(userId);
  if (set.size === 0) calls.delete(salonId);
  return [...set];
}

/** Qui est en appel dans un salon, en ce moment. */
export function whoIsInCall(salonId: string): string[] {
  return [...(calls.get(salonId) ?? [])];
}

/** Déconnexion : retire quelqu'un de TOUS les appels où il se trouvait.
 *  Renvoie la liste des salons dont l'appel vient de changer, pour prévenir
 *  ceux qui y sont encore. */
export function leaveAllCalls(userId: string): string[] {
  const changed: string[] = [];
  for (const [salonId, set] of calls) {
    if (set.delete(userId)) {
      changed.push(salonId);
      if (set.size === 0) calls.delete(salonId);
    }
  }
  return changed;
}
