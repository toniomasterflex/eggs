import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { parseSelfPinId, savePlacement, selfPinId } from "../data/placements";
import { useCollection } from "../data/profile";
import { useChatStore } from "../data/store";
import GroundPet from "./GroundPet";
import type { GroundPetTick } from "./GroundPet";
import "../App.css"; // fond transparent + dessin des pets
import "../ui/ui.css"; // interface du chat
import "./pinned.css";

// Côté Rust (voir pin_pet dans src-tauri/src/lib.rs), chaque créature de
// l'herbe est stockée dans PINNED sous la clé `label = format!("pin-{id}")`,
// et c'est ce `label` (pas l'`id` nu) qui est renvoyé dans les événements
// "pets-tick"/"pet-placed". Cette fenêtre affiche et indexe par contre par
// identifiant NU (voir `ids` plus bas, construit à partir de pinned/
// pinnedCreatures) : il faut donc retirer le préfixe "pin-" avant de s'en
// servir comme clé de `ticks`, sous peine de ne jamais matcher (bug du
// 29/09/2026 : rien ne s'affichait jamais sur l'herbe).
function stripPinPrefix(label: string): string {
  return label.startsWith("pin-") ? label.slice(4) : label;
}

// Racine de la fenêtre partagée "pets" (voir setup_pets côté Rust) : couvre
// tout le moniteur et affiche TOUTES les créatures posées sur l'herbe (amis
// épinglés + mes propres créatures sorties de la collection) — avant le
// 29/09/2026, chacune avait sa propre fenêtre (voir main.tsx :
// "pin-<id>" routait vers pet/PinnedWindow.tsx), ce qui plafonnait leur
// nombre (coût mémoire/GPU d'une fenêtre WebView2 par créature). Cette
// fenêtre unique reçoit à la place un seul événement groupé ("pets-tick",
// 60ms) avec la position de chacune (voir tick_pinned), et rend une
// instance de GroundPet par créature actuellement épinglée.
export default function GroundPetsWindow() {
  const { pinned = [] } = useChatStore(); // amis épinglés (identifiants de compte)
  const { pinnedCreatures = [] } = useCollection(); // mes créatures posées sur l'herbe

  const [ticks, setTicks] = useState<Record<string, GroundPetTick>>({});

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const w = getCurrentWebviewWindow();
    const add = (p: Promise<() => void>) =>
      p.then((fn) => {
        if (cancelled) fn();
        else unlisten.push(fn);
      });

    // Position groupée de toutes les créatures de l'herbe, toutes les 60ms
    // (voir tick_pinned côté Rust) : remplace entièrement la table à chaque
    // fois — une créature en cours de glissement (voir GroundPet.tsx :
    // pin_drag_start) en est volontairement absente (Rust l'exclut le temps
    // du glissement), GroundPet garde alors sa propre position locale.
    //
    // BUG CORRIGÉ (29/09/2026) : côté Rust, `id` ici est `label`, c'est-à-dire
    // la clé complète de PINNED (`pin-<id>`, voir pin_pet), alors que `ids`
    // plus bas (et donc les clés utilisées pour l'affichage/lookup dans
    // `ticks`) sont des identifiants NUS (sans le préfixe "pin-"). Sans le
    // stripPinPrefix ci-dessous, `ticks[id]` ne matchait jamais côté rendu :
    // aucune créature de l'herbe (amie ou à moi) ne s'affichait jamais,
    // même une fois épinglée avec succès côté Rust.
    add(
      w.listen<{ pets: Array<{ id: string } & GroundPetTick> }>("pets-tick", (e) => {
        const next: Record<string, GroundPetTick> = {};
        for (const p of e.payload.pets) {
          next[stripPinPrefix(p.id)] = {
            x: p.x,
            y: p.y,
            size: p.size,
            walking: p.walking,
            walkLeft: p.walkLeft,
          };
        }
        setTicks(next);
      }),
    );

    // Fin d'un glissement (voir finish_drag côté Rust) : position posée
    // (bord/marge déjà appliqués), envoyée tout de suite plutôt que
    // d'attendre jusqu'à 60ms le prochain "pets-tick" — sans ça, on verrait
    // la créature sauter légèrement au moment du lâcher. On en profite pour
    // mémoriser la position (offset le long du bas de l'écran) pour le
    // prochain lancement d'Eggs, comme avant le 29/09/2026.
    add(
      w.listen<{ id: string; x: number; y: number; size: number; offset: number; falling: boolean }>(
        "pet-placed",
        (e) => {
          // Même correctif que pour "pets-tick" ci-dessus : `id` envoyé par
          // Rust est ici aussi le `label` complet ("pin-<id>"), à ramener à
          // l'identifiant nu utilisé pour l'affichage.
          const { id: rawId, x, y, size, offset } = e.payload;
          const id = stripPinPrefix(rawId);
          setTicks((prev) => ({
            ...prev,
            [id]: { x, y, size, walking: false, walkLeft: prev[id]?.walkLeft ?? true },
          }));
          savePlacement(id, { edge: "bottom", offset, size });
        },
      ),
    );

    return () => {
      cancelled = true;
      unlisten.forEach((fn) => fn());
    };
  }, []);

  const ids = [...pinned, ...pinnedCreatures.map(selfPinId)];

  // La position de départ (mémorisée, ou espacée par défaut) est envoyée à
  // Rust par App.tsx au moment de pin_pet (voir son getPlacement/index) :
  // cette fenêtre n'a rien à en faire elle-même, elle attend juste le
  // premier "pets-tick" pour chaque créature (voir GroundPet.tsx : rend
  // `null` tant qu'aucune position n'est encore connue).
  return (
    <>
      {ids.map((id) => {
        const creatureId = parseSelfPinId(id);
        const isMine = creatureId !== null;
        const friendId = isMine ? null : id;
        return (
          <GroundPet key={id} id={id} isMine={isMine} friendId={friendId} tick={ticks[id]} />
        );
      })}
    </>
  );
}
