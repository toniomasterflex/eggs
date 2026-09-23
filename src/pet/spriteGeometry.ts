import type { Species } from "../data/types";

// Certaines créatures (poussin, Aventurier...) sont dessinées dans une boîte
// d'image plus haute que les 96px de .creature/.pet-body, et débordent donc
// vers le haut (voir App.css : .ck2 pour le poussin, .xp2 pour l'Aventurier).
// App.tsx / PinnedWindow.tsx s'en servent pour placer le petit bouton juste
// au-dessus de CHAQUE créature, plutôt que de supposer une hauteur fixe
// (ce qui le faisait apparaître au niveau du torse pour un skin plus grand
// que le poussin).
//
// Valeurs = hauteur de base de la boîte (--ch/--xh avant le facteur
// d'agrandissement --s/--xs, qui vaut 1.23 pour les deux actuellement).
const SPRITE_SCALE = 1.23; // --s (poussin) / --xs (Aventurier) / --crs (Grillon) dans App.css
const SPRITE_BASE_HEIGHT: Partial<Record<Species, number>> = {
  chick: 130,
  // Doit rester égal au --xh de base de .xp2 (App.css) : c'est ce qui a
  // bougé (130 -> 95) quand l'Aventurier a été rétréci dans Profil, sans
  // que cette valeur-ci soit mise à jour — d'où le bouton resté à
  // l'ancienne hauteur, trop haut au-dessus du personnage rapetissé.
  explorer: 95,
  // Doit rester égal au --crh de base de .cr2 (App.css).
  cricket: 170,
};
const SPRITE_BOTTOM = 6; // décalage bas commun à ces boîtes (bottom: -6px * échelle)

// Espèces sans vraie image (silhouette CSS dans la boîte de 96px) : pas de
// débordement, on garde le petit espacement déjà utilisé avant ce réglage.
const DEFAULT_OVERFLOW = 96 * 0.12;

/** Distance (en px, à l'échelle de base 96) entre le haut de la boîte de
 *  96px et le haut réel du dessin de cette créature — à multiplier par
 *  (size / 96) pour l'utiliser à la taille affichée du pet. */
export function spriteTopOverflow(species: Species | undefined): number {
  const baseH = species ? SPRITE_BASE_HEIGHT[species] : undefined;
  if (!baseH) return DEFAULT_OVERFLOW;
  return baseH * SPRITE_SCALE - 96 - SPRITE_BOTTOM * SPRITE_SCALE;
}
