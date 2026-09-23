import type { Species } from "../data/types";
import ChickSprite from "./ChickSprite";
import CricketSprite from "./CricketSprite";
import ExplorerSprite from "./ExplorerSprite";

// Le dessin du pet, selon l'espèce.
// Le poussin, l'Aventurier et le Grillon utilisent de vraies images ; les
// autres animaux sont encore des placeholders en CSS.
// La couleur vient de la variable CSS --pet-color posée par le parent
// (et de l'identifiant « color » pour le poussin).
// « phase » et « edge » servent au poussin pour choisir son animation.

const POINTED_EARS: Species[] = ["cat", "fox", "owl"];
const NOSE: Species[] = ["cat", "fox", "rabbit", "panda", "frog"];

// L'œuf a 3 dessins (public/egg/stage0.png à stage2.png) : entier, puis de
// plus en plus craquelé au fil des clics — pour qu'on voie tout de suite
// qu'un clic a été pris en compte.
function eggSrc(crackStage = 0) {
  const stage = Math.max(0, Math.min(2, Math.round(crackStage)));
  return `/egg/stage${stage}.png`;
}

export default function PetSprite({
  species,
  color,
  phase,
  edge,
  crackStage,
  cracking,
  shaking,
  walkDir,
}: {
  species: Species;
  color?: string;
  phase?: string;
  edge?: string;
  crackStage?: number;
  cracking?: boolean;
  shaking?: boolean;
  // Posé sur l'herbe et en balade autonome (voir PinnedWindow.tsx) : dans
  // quel sens il marche en ce moment, indépendamment de « phase ».
  walkDir?: "left" | "right";
}) {
  if (species === "egg") {
    const cls = cracking ? "egg-shape cracking" : shaking ? "egg-shape shaking" : "egg-shape";
    return <img className={cls} src={eggSrc(crackStage)} alt="" draggable={false} />;
  }
  if (species === "chick") return <ChickSprite color={color} phase={phase} edge={edge} walkDir={walkDir} />;
  if (species === "explorer") return <ExplorerSprite phase={phase} edge={edge} walkDir={walkDir} />;
  if (species === "cricket") return <CricketSprite phase={phase} edge={edge} walkDir={walkDir} />;

  return (
    <>
      {POINTED_EARS.includes(species) && (
        <>
          <div className="ear cat left" />
          <div className="ear cat right" />
        </>
      )}
      {species === "rabbit" && (
        <>
          <div className="ear rabbit left" />
          <div className="ear rabbit right" />
        </>
      )}
      {species === "panda" && (
        <>
          <div className="ear round left" />
          <div className="ear round right" />
        </>
      )}
      {species === "penguin" && <div className="belly" />}

      <div className="eye left" />
      <div className="eye right" />
      <div className={NOSE.includes(species) ? "beak nose" : "beak"} />
    </>
  );
}