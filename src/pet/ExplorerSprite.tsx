import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

// Le skin « Aventurier » (Shop) : images découpées dans les planches que
// m'a données Antoine (public/explorer/*.png). Contrairement au poussin,
// une seule pose (« idle ») et deux bandes de marche — pas de planche
// « réaction » dédiée, donc le clic garde le petit saut CSS classique
// (« joy », voir App.css) au lieu d'un rebond en plus par-dessus une
// planche qui n'existe pas.

const SHEETS = ["idle", "walk_l", "walk_r"] as const;
type Sheet = (typeof SHEETS)[number];
const FRAMES: Record<Sheet, number> = { idle: 1, walk_l: 8, walk_r: 8 };

// À incrémenter à chaque remplacement des images (même nom de fichier) :
// Tauri (WebView2) garde ces images en cache même après un redémarrage de
// l'appli, donc sans ce numéro de version dans l'URL, une image corrigée
// peut continuer d'afficher l'ancienne jusqu'à un vrai vidage du cache.
const ASSET_V = 2;
const src = (name: Sheet) => `/explorer/${name}.png?v=${ASSET_V}`;

interface Plan {
  sheet: Sheet;
  ms: number;
  loop: boolean;
}

// walkDir : posé sur l'herbe, il se balade tout seul (voir PinnedWindow.tsx /
// l'événement Rust "pet-walk") indépendamment de la phase, qui reste
// "VISIBLE" pendant toute la balade — seule l'animation change. On ignore ce
// paramètre pendant "INTERACTING" (petit saut au clic) pour ne pas couper la
// pose fixe pendant la réaction.
function planFor(phase?: string, edge?: string, walkDir?: "left" | "right"): Plan | null {
  const toward: Sheet = edge === "left" ? "walk_r" : "walk_l";
  const away: Sheet = edge === "left" ? "walk_l" : "walk_r";
  const front = edge === "top" || edge === "bottom";

  switch (phase) {
    case "ARRIVING":
      return front ? null : { sheet: toward, ms: 95, loop: true };
    case "EXITING":
      return front ? null : { sheet: away, ms: 95, loop: true };
    default:
      // VISIBLE, DRAGGING, ou simple vignette : pose fixe, sauf en balade.
      if (walkDir && phase !== "INTERACTING") {
        return { sheet: walkDir === "left" ? "walk_l" : "walk_r", ms: 95, loop: true };
      }
      return null;
  }
}

export default function ExplorerSprite({
  phase,
  edge,
  walkDir,
}: {
  phase?: string;
  edge?: string;
  walkDir?: "left" | "right";
}) {
  const plan = planFor(phase, edge, walkDir);
  const sheet: Sheet = plan?.sheet ?? "idle";
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    SHEETS.forEach((name) => {
      new Image().src = src(name);
    });
  }, []);

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
    backgroundImage: `url(${src(sheet)})`,
    backgroundPosition: `calc(var(--xw) * -${Math.min(frame, FRAMES[sheet] - 1)}) 0px`,
    backgroundSize: `calc(var(--xw) * ${FRAMES[sheet]}) var(--xh)`,
  };

  return (
    <div className="explorer" aria-hidden="true">
      <div className="xp2" style={style} />
    </div>
  );
}
