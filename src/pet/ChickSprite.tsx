import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

// Le poussin : images découpées dans la planche (public/chick/<couleur>/*.png).
// Chaque image est une bande de 9 poses ; ce composant change de pose lui-même.

const COLORS = ["sun", "rose", "sky", "mint", "lilac", "peach", "cloud"];
const SHEETS = ["idle", "walk_l", "walk_r", "react"] as const;
type Sheet = (typeof SHEETS)[number];
const FRAMES: Record<Sheet, number> = { idle: 9, walk_l: 4, walk_r: 4, react: 9 };

interface Plan {
  sheet: Sheet;
  ms: number; // durée d'une pose
  loop: boolean;
}

// Quelle bande jouer, et à quelle vitesse, selon ce que fait le poussin.
// walkDir : posé sur l'herbe, il se balade tout seul (voir PinnedWindow.tsx /
// l'événement Rust "pet-walk") indépendamment de la phase, qui reste
// "VISIBLE" pendant toute la balade — seule l'animation change.
function planFor(phase?: string, edge?: string, walkDir?: "left" | "right"): Plan | null {
  const toward: Sheet = edge === "left" ? "walk_r" : "walk_l"; // sens de l'arrivée
  const away: Sheet = edge === "left" ? "walk_l" : "walk_r"; // sens du départ
  const front = edge === "top" || edge === "bottom"; // bord haut/bas : de face

  switch (phase) {
    case "ARRIVING":
      return { sheet: front ? "idle" : toward, ms: 190, loop: true };
    case "EXITING":
      return { sheet: front ? "idle" : away, ms: 190, loop: true };
    case "INTERACTING":
      // Ralenti (78ms → 130ms/pose) : à 78ms c'était trop rapide, on ne
      // distinguait plus les poses (cœur, ailes...).
      return { sheet: "react", ms: 130, loop: false };
    case "VISIBLE":
    case "DRAGGING":
      if (walkDir) return { sheet: walkDir === "left" ? "walk_l" : "walk_r", ms: 190, loop: true };
      return { sheet: "idle", ms: 267, loop: true };
    default:
      return null; // caché, ou simple vignette : première pose fixe
  }
}

export default function ChickSprite({
  color = "sun",
  phase,
  edge,
  walkDir,
}: {
  color?: string;
  phase?: string;
  edge?: string;
  walkDir?: "left" | "right";
}) {
  const id = COLORS.includes(color) ? color : "sun";
  const plan = planFor(phase, edge, walkDir);
  const sheet: Sheet = plan?.sheet ?? "idle";
  const [frame, setFrame] = useState(0);

  // Charge les images à l'avance pour éviter un clignotement.
  useEffect(() => {
    SHEETS.forEach((name) => {
      new Image().src = `/chick/${id}/${name}.png`;
    });
  }, [id]);

  // Fait défiler les poses.
  useEffect(() => {
    setFrame(0);
    const p = planFor(phase, edge, walkDir);
    if (!p) return;
    const timer = window.setInterval(() => {
      setFrame((f) => (p.loop ? (f + 1) % FRAMES[p.sheet] : Math.min(f + 1, FRAMES[p.sheet] - 1)));
    }, p.ms);
    return () => window.clearInterval(timer);
  }, [phase, edge, walkDir]);

  const style: CSSProperties = {
    backgroundImage: `url(/chick/${id}/${sheet}.png)`,
    backgroundPosition: `calc(var(--cw) * -${Math.min(frame, FRAMES[sheet] - 1)}) 0px`, backgroundSize: `calc(var(--cw) * ${FRAMES[sheet]}) var(--ch)`,
  };

  return (
    <div className="chick" aria-hidden="true">
      <div className="ck2" style={style} />
    </div>
  );
}