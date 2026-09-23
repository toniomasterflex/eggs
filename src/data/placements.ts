// Où vit chaque pet épinglé : sur quel bord de l'écran, à quelle position
// le long du bord (0 à 1) et à quelle taille. Mémorisé sur cet ordinateur.
// Plus tard : { screen, edge, offset, size } avec le numéro d'écran.

export type Edge = "left" | "right" | "top" | "bottom";

export interface Placement {
  edge: Edge;
  offset: number; // 0 = début du bord, 1 = fin du bord
  size: number; // taille du pet en pixels
}

export const MIN_SIZE = 40;
export const MAX_SIZE = 200;
export const DEFAULT_SIZE = 72;
// Identifiant de placement de mon propre pet (pas de compte lié, donc pas
// d'id ami) ; sa taille par défaut reste celle d'avant (96 px).
export const ME_ID = "me";
export const DEFAULT_SIZE_ME = 96;
// Quand mon pet est épinglé « sur l'herbe » (comportement des créatures des
// amis : marche/course en bas de l'écran) plutôt que côté bureau, sa
// position vit sous un id à part — pour que basculer le réglage aller-
// retour ne fasse pas perdre l'une des deux positions mémorisées.
export const ME_GROUND_ID = "me-ground";

// Une créature de ma collection (non active), posée sur l'herbe : sa fenêtre
// épinglée a besoin d'un identifiant à elle, distinct de ceux des amis (par
// ailleurs des identifiants de comptes différents, mais on préfixe quand
// même pour être sûr qu'il n'y ait jamais de collision). Utilisé à la fois
// pour la créer (App.tsx) et pour la reconnaître (PinnedWindow.tsx).
const SELF_PIN_PREFIX = "self-";
export const selfPinId = (creatureId: string) => `${SELF_PIN_PREFIX}${creatureId}`;
export const parseSelfPinId = (rawId: string): string | null =>
  rawId.startsWith(SELF_PIN_PREFIX) ? rawId.slice(SELF_PIN_PREFIX.length) : null;

const KEY = "eggs.placements";

function readAll(): Record<string, Placement> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const value = JSON.parse(raw);
      if (value && typeof value === "object") return value;
    }
  } catch {
    // pas grave
  }
  return {};
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Bords autorisés pour mon propre pet : seulement les côtés (pas haut/bas).
const ME_EDGES: Edge[] = ["left", "right"];
// Les amis vivent toujours sur l'herbe (bord bas) — voir snap()/ground_only
// côté Rust : ils peuvent être glissés n'importe où, ils y retombent
// toujours. Une ancienne valeur gauche/haut/droite (avant ce réglage) est
// ignorée ci-dessous, comme pour ME_EDGES.
const FRIEND_EDGES: Edge[] = ["bottom"];
// Mon pet sur l'herbe : comme les amis, toujours le bord bas.
const ME_GROUND_EDGES: Edge[] = ["bottom"];

/** Position d'un pet épinglé. « index » sert à espacer les nouveaux pets. */
export function getPlacement(id: string, index = 0): Placement {
  const saved = readAll()[id];
  const allowed = id === ME_ID ? ME_EDGES : id === ME_GROUND_ID ? ME_GROUND_EDGES : FRIEND_EDGES;
  if (
    saved &&
    allowed.includes(saved.edge) &&
    typeof saved.offset === "number" &&
    typeof saved.size === "number"
  ) {
    return {
      edge: saved.edge,
      offset: clamp(saved.offset, 0, 1),
      size: clamp(saved.size, MIN_SIZE, MAX_SIZE),
    };
  }
  if (id === ME_ID) {
    // Par défaut : coin bas droit, comme avant (doit rester cohérent avec
    // le point de départ posé côté Rust dans src-tauri/src/lib.rs). Si une
    // valeur haut/bas était mémorisée (essai précédent), on l'ignore ici.
    return { edge: "right", offset: 0.9, size: DEFAULT_SIZE_ME };
  }
  if (id === ME_GROUND_ID) {
    // Par défaut : au milieu du gazon, à sa taille habituelle (pas celle,
    // plus petite, des amis) pour ne pas donner l'impression de rétrécir.
    return { edge: "bottom", offset: 0.5, size: DEFAULT_SIZE_ME };
  }
  // Par défaut : posé sur l'herbe, chacun espacé le long du gazon.
  return { edge: "bottom", offset: Math.min(0.1 + index * 0.15, 0.9), size: DEFAULT_SIZE };
}

export function savePlacement(id: string, placement: Placement) {
  try {
    const all = readAll();
    all[id] = placement;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // pas grave
  }
}