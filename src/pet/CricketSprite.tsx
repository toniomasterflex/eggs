import type { CSSProperties } from "react";
import { useSpriteFrame } from "./useSpriteFrame";
import type { SpritePlan } from "./useSpriteFrame";

// Le Grillon (Shop : « L'Éclaireur ») : images découpées dans les planches
// qu'Antoine a fournies (public/cricket/*.png — extraites de sa planche de
// référence via un script de découpe/nettoyage, voir extract.py), sur le
// même principe que le poussin et l'Aventurier — voir useSpriteFrame.ts pour
// la mécanique commune (préchargement, défilement des poses).
//
// Deux allures existent, avec chacune un vrai rôle dans l'appli :
//   - marche (walk_l/walk_r) : en balade tout seul sur l'herbe du bureau,
//     comme le poussin. walk_r est un simple miroir de walk_l (Antoine n'a
//     fourni qu'un sens de marche) ; walk_l reste la planche d'origine.
//   - course (run_l/run_r) : mouvement plus vif, réservé aux arrivées et
//     départs du bord de l'écran (un aller-retour bien plus court que la
//     balade, ça se justifie).
// « interact » et « hurt » sont chargées et comptées ici, prêtes à servir,
// mais rien dans l'appli ne les déclenche encore : il n'existe pour l'instant
// aucune mécanique de ramassage d'objet ni de dégât. Ce sera à brancher plus
// tard, sans rien reconstruire, le jour où une fonctionnalité en a besoin.
// (« interact » montre en fait un salut de la main — planche livrée par
// Antoine sous ce nom plutôt qu'un vrai geste de ramassage ; ça conviendra
// tout aussi bien le jour où ce sera branché.)
const SHEETS = ["idle", "walk_l", "walk_r", "run_l", "run_r", "jump", "interact", "hurt"] as const;
type Sheet = (typeof SHEETS)[number];
const FRAMES: Record<Sheet, number> = {
  idle: 4,
  walk_l: 8,
  walk_r: 8,
  run_l: 8,
  run_r: 8,
  jump: 6,
  interact: 6,
  hurt: 8,
};

// Vitesse de chaque planche (ms par pose) — valeurs de départ, à ajuster une
// fois les vraies images en place (voir App.css : la durée de « jump » doit
// rester alignée sur .creature:has(> .cricket)[data-phase="interacting"]).
const MS: Record<Sheet, number> = {
  idle: 220,
  walk_l: 110,
  walk_r: 110,
  run_l: 70,
  run_r: 70,
  jump: 90,
  interact: 110,
  hurt: 130,
};

// À incrémenter à chaque remplacement des images (le cache de la WebView
// garde les anciennes sous le même nom, voir ExplorerSprite.tsx).
// v3 : seules run_l.png/run_r.png étaient inversées par rapport à leur nom
// (run_l.png montrait en fait le Grillon courir vers la droite, etc.) —
// corrigé en échangeant leur contenu, d'où l'entrée/sortie à l'envers
// signalée par Antoine.
// v4 : correctif de trop côté walk_l/walk_r dans le v3 — ces deux fichiers
// étaient en fait déjà bien nommés à l'origine ; les avoir échangés par
// erreur (en supposant la même inversion que pour run_l/run_r) a cassé la
// balade sur l'herbe une fois épinglé. Revenus à leur contenu d'origine ;
// seuls run_l/run_r restent (à juste titre) échangés.
const ASSET_V = 4;
const src = (name: Sheet) => `/cricket/${name}.png?v=${ASSET_V}`;

function planFor(phase?: string, edge?: string, walkDir?: "left" | "right"): SpritePlan<Sheet> | null {
  const runToward: Sheet = edge === "left" ? "run_r" : "run_l"; // sens de l'arrivée
  const runAway: Sheet = edge === "left" ? "run_l" : "run_r"; // sens du départ
  const front = edge === "top" || edge === "bottom"; // bord haut/bas : de face

  switch (phase) {
    case "ARRIVING": {
      const sheet: Sheet = front ? "idle" : runToward;
      return { sheet, ms: MS[sheet], loop: true };
    }
    case "EXITING": {
      const sheet: Sheet = front ? "idle" : runAway;
      return { sheet, ms: MS[sheet], loop: true };
    }
    case "INTERACTING":
      // Sursaute au clic, comme un insecte surpris — une seule fois.
      return { sheet: "jump", ms: MS.jump, loop: false };
    case "VISIBLE":
    case "DRAGGING":
      if (walkDir) {
        const sheet: Sheet = walkDir === "left" ? "walk_l" : "walk_r";
        return { sheet, ms: MS[sheet], loop: true };
      }
      return { sheet: "idle", ms: MS.idle, loop: true };
    default:
      return null; // caché, ou simple vignette : première pose fixe
  }
}

export default function CricketSprite({
  phase,
  edge,
  walkDir,
}: {
  phase?: string;
  edge?: string;
  walkDir?: "left" | "right";
}) {
  const plan = planFor(phase, edge, walkDir);
  const { sheet, frame } = useSpriteFrame(SHEETS, FRAMES, plan, "idle", src, [phase, edge, walkDir]);

  const style: CSSProperties = {
    backgroundImage: `url(${src(sheet)})`,
    backgroundPosition: `calc(var(--crw) * -${Math.min(frame, FRAMES[sheet] - 1)}) 0px`,
    backgroundSize: `calc(var(--crw) * ${FRAMES[sheet]}) var(--crh)`,
  };

  return (
    <div className="cricket" aria-hidden="true">
      <div className="cr2" style={style} />
    </div>
  );
}
