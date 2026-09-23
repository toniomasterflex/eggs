import type { CSSProperties } from "react";
import { colorValue } from "../data/profile";
import type { Species } from "../data/types";
import PetSprite from "../pet/PetSprite";

// Petite tête de créature pour les listes : la même que celle du pet sur le bureau.
export default function Creature({
  species,
  color,
  size = 28,
}: {
  species: Species;
  color?: string;
  size?: number;
}) {
  return (
    <span
      className="creature-avatar"
      style={{ width: size, height: size }}
      role="img"
      aria-label={species}
    >
      <span
        className="avatar-inner"
        style={{ transform: `scale(${size / 96})` }}
      >
        <span
          className="pet-body"
          style={{ "--pet-color": colorValue(color ?? "sun") } as CSSProperties}
        >
          <PetSprite species={species} color={color ?? "sun"} />
        </span>
      </span>
    </span>
  );
}