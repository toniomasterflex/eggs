// Présence en direct dans les salons : qui est actuellement « chez » qui.
//
// Contrairement au nom du salon ou à la liste de blocage (voir service.ts,
// stockés en base), qui est présent maintenant n'a pas besoin de survivre à
// un redémarrage du serveur — ça se reconstruit tout seul dès que les gens
// se reconnectent. Donc uniquement en mémoire, comme la présence en ligne
// dans hub.ts.
//
// Un salon = son propriétaire : pas d'identifiant séparé, salonId est
// toujours users.id du propriétaire.

const presence = new Map<string, Set<string>>(); // salonId -> présents (userId)

/** Fait entrer quelqu'un dans un salon (aucun effet si déjà présent).
 *  Renvoie la liste à jour des présents. */
export function enterSalon(salonId: string, userId: string): string[] {
  let set = presence.get(salonId);
  if (!set) presence.set(salonId, (set = new Set()));
  set.add(userId);
  return [...set];
}

/** Fait sortir quelqu'un d'un salon (départ volontaire, ou blocage).
 *  Renvoie la liste à jour des présents. */
export function leaveSalon(salonId: string, userId: string): string[] {
  const set = presence.get(salonId);
  if (!set) return [];
  set.delete(userId);
  if (set.size === 0) presence.delete(salonId);
  return [...set];
}

/** Qui est présent dans un salon, en ce moment. */
export function whoIsInSalon(salonId: string): string[] {
  return [...(presence.get(salonId) ?? [])];
}

/** Nombre de présents par salon (pour l'indicateur dans la liste des salons).
 *  Seuls les salons avec au moins une personne dedans apparaissent. */
export function salonPresenceCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [salonId, set] of presence) counts.set(salonId, set.size);
  return counts;
}

/** Déconnexion : retire quelqu'un de TOUS les salons où il se trouvait.
 *  Renvoie la liste des salons qu'il vient de quitter, pour prévenir ceux qui
 *  y sont encore. */
export function leaveAllSalons(userId: string): string[] {
  const left: string[] = [];
  for (const [salonId, set] of presence) {
    if (set.delete(userId)) {
      left.push(salonId);
      if (set.size === 0) presence.delete(salonId);
    }
  }
  return left;
}
