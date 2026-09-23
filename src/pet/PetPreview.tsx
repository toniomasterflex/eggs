import type { AnimationEvent, CSSProperties } from "react";
import { colorValue } from "../data/profile";
import { useMyAppearance } from "../data/session";
import type { Species } from "../data/types";
import PetSprite from "./PetSprite";

// Aperçu d'un pet (dans le Profil). Sans espèce/couleur donnée, montre ma
// créature active (ou un œuf) ; avec, montre celle demandée (carrousel de
// la collection dans Ma collection).
export default function PetPreview({
  scale = 1,
  species,
  color,
  crackStage,
  cracking,
  shaking,
  onCrackEnd,
  onShakeEnd,
}: {
  scale?: number;
  species?: Species;
  color?: string;
  crackStage?: number;
  cracking?: boolean;
  shaking?: boolean;
  onCrackEnd?: () => void;
  onShakeEnd?: () => void;
}) {
  const mine = useMyAppearance();
  const look = species ? { species, color: color ?? "" } : mine;
  const size = 96 * scale;

  const handleAnimationEnd =
    onCrackEnd || onShakeEnd
      ? (e: AnimationEvent<HTMLDivElement>) => {
          if (e.animationName === "egg-crack") onCrackEnd?.();
          else if (e.animationName === "egg-shake") onShakeEnd?.();
        }
      : undefined;

  return (
    <div className="pet-preview" style={{ width: size, height: size }}>
      <div
        style={{
          width: 96,
          height: 96,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        <div
          className="creature"
          style={{ "--pet-color": colorValue(look.color) } as CSSProperties}
          onAnimationEnd={handleAnimationEnd}
        >
          <PetSprite
            species={look.species}
            color={look.color}
            crackStage={crackStage}
            cracking={cracking}
            shaking={shaking}
          />
        </div>
      </div>
    </div>
  );
}