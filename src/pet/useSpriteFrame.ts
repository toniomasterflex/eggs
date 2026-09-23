import { useEffect, useState } from "react";
import type { DependencyList } from "react";

// Mécanique commune à toute créature dessinée en planches d'images (poussin,
// Aventurier, Grillon...) : précharge les planches, puis fait défiler les
// poses selon un « plan » (quelle planche jouer, à quelle vitesse, en
// boucle ou une seule fois). Chaque créature garde son propre fichier
// *Sprite.tsx pour choisir CE plan (planFor) — seule cette mécanique de
// défilement, elle, est partagée.

export interface SpritePlan<Sheet extends string> {
  sheet: Sheet;
  ms: number; // durée d'une pose
  loop: boolean;
}

export function useSpriteFrame<Sheet extends string>(
  sheets: readonly Sheet[],
  frames: Record<Sheet, number>,
  plan: SpritePlan<Sheet> | null,
  fallback: Sheet,
  src: (sheet: Sheet) => string,
  deps: DependencyList,
): { sheet: Sheet; frame: number } {
  const sheet = plan?.sheet ?? fallback;
  const [frame, setFrame] = useState(0);

  // Charge les images à l'avance pour éviter un clignotement.
  useEffect(() => {
    sheets.forEach((name) => {
      new Image().src = src(name);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fait défiler les poses.
  useEffect(() => {
    setFrame(0);
    if (!plan) return;
    const timer = window.setInterval(() => {
      setFrame((f) => (plan.loop ? (f + 1) % frames[plan.sheet] : Math.min(f + 1, frames[plan.sheet] - 1)));
    }, plan.ms);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { sheet, frame };
}
