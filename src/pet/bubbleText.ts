// Longueur max du texte affiché dans une bulle « vient d'écrire » (voir
// pinned.css : .pw-bubble — utilisé à la fois par PinnedWindow.tsx, pour le
// pet d'un ami ou un extra de « Ma collection », et par App.tsx, pour ma
// créature principale). Tient sur ~3 lignes à cette largeur/police.
//
// En JS plutôt qu'en CSS pur (-webkit-line-clamp) : ce dernier ne coupait
// pas toujours net selon les mots et laissait dépasser le haut d'une 4e
// ligne.
export const BUBBLE_MAX_CHARS = 60;

export function truncateBubble(text: string): string {
  const clean = text.trim();
  if (clean.length <= BUBBLE_MAX_CHARS) return clean;
  return `${clean.slice(0, BUBBLE_MAX_CHARS).trimEnd()}…`;
}
