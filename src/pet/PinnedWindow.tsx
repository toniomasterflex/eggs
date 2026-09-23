import { useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { colorValue, unpinCreature, useCollection } from "../data/profile";
import { MAX_SIZE, MIN_SIZE, getPlacement, parseSelfPinId, savePlacement } from "../data/placements";
import type { Edge, Placement } from "../data/placements";
import { closeChat, onLiveMessage, openChat, useChatStore } from "../data/store";
import { initialPetState, petReducer } from "../petMachine";
import PetSprite from "./PetSprite";
import { spriteTopOverflow } from "./spriteGeometry";
import ConversationScreen from "../ui/screens/ConversationScreen";
import "../App.css"; // fond transparent + dessin des pets
import "../ui/ui.css"; // interface du chat
import "./pinned.css";

// Taille (en pixels) de la fenêtre carrée d'un pet épinglé.
// Doit correspondre à WIN_PIN dans src-tauri/src/lib.rs.
const WIN = 800;
// Taille du chat ouvert (un peu plus grand qu'à l'origine, 190x320) et du
// petit bouton rond.
const PW = 250;
const PH = 400;
const BTN = 9;

// Direction dans laquelle le pet se cache, selon le bord.
const HIDE: Record<Edge, [number, number]> = {
  right: [WIN, 0],
  left: [-WIN, 0],
  top: [0, -WIN],
  bottom: [0, WIN],
};

// Sur l'herbe (bord bas), tous les pets doivent toucher exactement la même
// ligne de sol, quelle que soit leur taille — donc une marge FIXE, pas
// proportionnelle à la taille (sinon un gros pet flotte plus haut qu'un
// petit). On reprend le même petit coussin que la position la plus basse
// atteignable par mon propre pet sur le bord latéral (CORNER_PAD côté Rust),
// pour que le sol s'aligne avec ce repère déjà connu.
// Doit correspondre à CORNER_PAD dans src-tauri/src/lib.rs.
const GROUND_MARGIN = 8;

// Marge entre le pet et son bord : fixe sur l'herbe (voir GROUND_MARGIN),
// proportionnelle à la taille sur les bords latéraux (identique au calcul de
// Rust — pet_rect/window_pos).
function marginFor(edge: Edge, size: number): number {
  return edge === "bottom" ? GROUND_MARGIN : size / 3;
}

function layoutFor(edge: Edge, margin: number): CSSProperties {
  switch (edge) {
    case "right":
      return { justifyContent: "flex-end", alignItems: "center", paddingRight: margin };
    case "left":
      return { justifyContent: "flex-start", alignItems: "center", paddingLeft: margin };
    case "top":
      return { justifyContent: "center", alignItems: "flex-start", paddingTop: margin };
    default:
      return { justifyContent: "center", alignItems: "flex-end", paddingBottom: margin };
  }
}

// Position du pet dans sa fenêtre (identique au calcul de Rust).
function petBox(edge: Edge, size: number) {
  const m = marginFor(edge, size);
  switch (edge) {
    case "right":
      return { x: WIN - m - size, y: (WIN - size) / 2 };
    case "left":
      return { x: m, y: (WIN - size) / 2 };
    case "top":
      return { x: (WIN - size) / 2, y: m };
    default:
      return { x: (WIN - size) / 2, y: WIN - m - size };
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Une fenêtre épinglée montre soit le pet d'un ami (avec bouton + chat), soit
// une créature de MA collection posée sur l'herbe (juste la balade, pas de
// chat avec moi-même) — voir data/placements.ts : selfPinId/parseSelfPinId,
// et App.tsx qui crée la fenêtre avec l'identifiant préfixé "self-" dans ce
// second cas.
export default function PinnedWindow() {
  const label = getCurrentWindow().label; // « pin-lea » ou « pin-self-<id> »
  const rawId = label.replace(/^pin-/, "");
  const creatureId = parseSelfPinId(rawId);
  const isMine = creatureId !== null;
  const friendId = isMine ? null : rawId;

  const [pet, dispatch] = useReducer(petReducer, initialPetState);
  const [place, setPlace] = useState<Placement>(() => getPlacement(rawId));
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState({ x: 0, y: 0 });
  // Posé sur l'herbe, il se balade tout seul : Rust déplace vraiment la
  // fenêtre et nous prévient juste du sens pour l'animation (voir
  // tick_wander côté Rust). null = en pause / pas en balade.
  const [walkDir, setWalkDir] = useState<"left" | "right" | null>(null);
  // Petite bulle « vient d'écrire », le temps qu'on la remarque (voir
  // data/store.ts : onLiveMessage) — juste un symbole, pas le texte du
  // message (discrétion si quelqu'un regarde l'écran).
  const [bubblePhase, setBubblePhase] = useState<"hidden" | "in" | "out">("hidden");
  const bubbleTimer = useRef<number | undefined>(undefined);
  const { unread: unreadMap, activeChat, friends } = useChatStore();
  const { creatures } = useCollection();
  const friend = friendId ? friends.find((u) => u.id === friendId) : undefined;
  const mine = creatureId ? creatures.find((c) => c.id === creatureId) : undefined;
  const species = friend?.species ?? mine?.species;
  const color = friend?.color ?? mine?.color;
  const unread = friendId ? (unreadMap[friendId] ?? 0) : 0;
  const phaseRef = useRef(pet.phase);
  phaseRef.current = pet.phase;

  const { edge, size } = place;
  const box = petBox(edge, size);
  // Le bouton est au-dessus du pet (en dessous si le pet est en haut de
  // l'écran) — décalé selon la hauteur réelle de CETTE créature (poussin,
  // Aventurier...), pas une valeur fixe (voir spriteGeometry.ts). Inutile
  // pour mes propres créatures : pas de bouton, pas de chat avec moi-même.
  const btnTop = edge === "top" ? size + 10 : -(BTN + 10 + spriteTopOverflow(species) * (size / 96));
  const btnX = box.x + size / 2 - BTN / 2;
  const btnY = box.y + btnTop;
  // Bulle « vient d'écrire » : encore plus loin du pet que le bouton, du même
  // côté (au-dessus, ou en dessous si le pet est collé en haut de l'écran).
  const bubbleTop = edge === "top" ? btnTop + 24 : btnTop - 24;

  // Écoute Rust : souris près du bord, position finale.
  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const w = getCurrentWebviewWindow();

    // Toute fenêtre épinglée vit désormais sur l'herbe (ground_only côté
    // Rust, amis comme mes propres créatures) : elle doit être visible tout
    // de suite, sans attendre la souris. Rust prévient bien l'interface via
    // l'événement "zone-changed" au moment de la création — mais une seule
    // fois, tout de suite après avoir créé la fenêtre, alors que celle-ci
    // (nouveau webview : chargement de la page, React, ses écouteurs...) n'a
    // pas forcément fini de démarrer et peut le manquer. Résultat : le pet
    // restait bloqué invisible pour toujours (jamais revu ensuite, puisque
    // Rust ne renvoie plus cet événement une fois qu'il pense l'avoir déjà
    // envoyé). On ne dépend donc plus de cet événement pour apparaître : on
    // se déclare nous-mêmes « dans la zone » dès le montage ; s'il arrive
    // quand même, il ne fait rien de plus (ZONE_ENTER est sans effet si on
    // y est déjà).
    dispatch({ type: "ZONE_ENTER" });

    if (!isMine) {
      // Temps réel : cet ami vient d'interagir avec mon pet, le sien réagit aussi.
      w.listen<{ target: string }>("remote-interaction", (e) => {
        if (e.payload.target === friendId && phaseRef.current === "VISIBLE") {
          dispatch({ type: "CLICK" });
        }
      }).then((fn) => {
        if (cancelled) fn();
        else unlisten.push(fn);
      });
    }
    const add = (p: Promise<() => void>) =>
      p.then((fn) => {
        if (cancelled) fn();
        else unlisten.push(fn);
      });

    add(
      w.listen<boolean>("zone-changed", (e) =>
        dispatch({ type: e.payload ? "ZONE_ENTER" : "ZONE_LEAVE" }),
      ),
    );
    add(
      w.listen<{ edge: Edge; offset: number; size: number; dragged?: boolean }>(
        "pet-placed",
        (e) => {
          const next = {
            edge: e.payload.edge,
            offset: e.payload.offset,
            size: e.payload.size,
          };
          setPlace(next);
          savePlacement(rawId, next);
          if (e.payload.dragged) dispatch({ type: "DRAG_END" });
        },
      ),
    );
    // Balade sur l'herbe : Rust déplace la fenêtre lui-même, il nous dit
    // juste quand marcher (et dans quel sens) pour l'animation du sprite.
    add(
      w.listen<{ walking: boolean; dir: "left" | "right" }>("pet-walk", (e) => {
        setWalkDir(e.payload.walking ? e.payload.dir : null);
      }),
    );

    return () => {
      cancelled = true;
      unlisten.forEach((fn) => fn());
    };
  }, []);

  // Cet ami vient d'écrire : petite bulle, le temps qu'on la remarque. Sans
  // effet pour mes propres créatures (pas de chat avec moi-même).
  useEffect(() => {
    if (isMine || !friendId) return;
    const unsub = onLiveMessage((from) => {
      if (from !== friendId) return;
      window.clearTimeout(bubbleTimer.current);
      setBubblePhase("in");
      bubbleTimer.current = window.setTimeout(() => setBubblePhase("out"), 4000);
    });
    return () => {
      unsub();
      window.clearTimeout(bubbleTimer.current);
    };
  }, [isMine, friendId]);

  // Prévient Rust : le pet est-il à l'écran ? (les clics traversent la
  // fenêtre tant qu'il est caché)
  useEffect(() => {
    invoke("pin_set_active", { label, active: pet.phase !== "HIDDEN" }).catch(console.error);
  }, [pet.phase]);

  // Prévient Rust des zones cliquables : le bouton (ranger pour mes propres
  // créatures, conversation pour un ami), et le chat s'il est ouvert (jamais
  // le cas pour mes propres créatures — pas de chat avec moi-même, voir
  // openPanel plus bas). Le corps du pet, lui, reste toujours cliquable pour
  // la petite réaction, indépendamment de ces rects (voir pet_rect côté Rust).
  useEffect(() => {
    const rects: number[][] = [[btnX - 8, btnY - 8, btnX + BTN + 8, btnY + BTN + 8]];
    if (open) rects.push([panelPos.x, panelPos.y, panelPos.x + PW, panelPos.y + PH]);
    invoke("pin_set_ui", { label, panelOpen: open, rects }).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, panelPos.x, panelPos.y, edge, size, species]);

  const closePanel = () => {
    setOpen(false);
    if (friendId) closeChat();
  };

  // Le chat se ferme quand le pet repart ou qu'on le déplace.
  useEffect(() => {
    if (open && (pet.phase === "EXITING" || pet.phase === "HIDDEN" || pet.phase === "DRAGGING")) {
      closePanel();
    }
  }, [pet.phase]);

  // Retour (flèche du chat) : on ferme.
  useEffect(() => {
    if (!isMine && open && activeChat !== friendId) setOpen(false);
  }, [activeChat]);

  // Échap ferme le chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!species || !color) return null;

  // Ouvre le chat : à côté du pet, en restant dans l'écran. (Amis seulement.)
  const openPanel = async () => {
    if (open || !friendId) return;
    let x = box.x + size / 2 - PW / 2;
    let y = box.y + size / 2 - PH / 2;
    if (edge === "right") x = box.x - PW - 8;
    else if (edge === "left") x = box.x + size + 8;
    else if (edge === "top") y = box.y + size + 8;
    else y = box.y - PH - 8;

    try {
      const win = getCurrentWindow();
      const [pos, sf] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
      const s = window.screen as unknown as {
        availLeft?: number;
        availTop?: number;
        availWidth: number;
        availHeight: number;
      };
      const wx = pos.x / sf;
      const wy = pos.y / sf;
      const left = (s.availLeft ?? 0) - wx + 4;
      const top = (s.availTop ?? 0) - wy + 4;
      const right = (s.availLeft ?? 0) + s.availWidth - wx - PW - 4;
      const bottom = (s.availTop ?? 0) + s.availHeight - wy - PH - 4;
      x = clamp(x, left, Math.max(left, right));
      y = clamp(y, top, Math.max(top, bottom));
    } catch {
      // pas grave : l'API écran n'est pas disponible, on garde la position
      // prévue en restant au moins dans les limites de la fenêtre elle-même.
      x = clamp(x, 0, WIN - PW);
      y = clamp(y, 0, WIN - PH);
    }

    setPanelPos({ x, y });
    openChat(friendId);
    setOpen(true);
  };

  const [sx, sy] = HIDE[edge]; const d = Math.round(size * 1.4 + 20); const hx = sx === 0 ? 0 : Math.sign(sx) * d; const hy = sy === 0 ? 0 : Math.sign(sy) * d;
  const style = {
    ...layoutFor(edge, marginFor(edge, size)),
    "--hx": `${hx}px`,
    "--hy": `${hy}px`,
    "--size": `${size}px`,
    "--k": size / 96,
    "--bx": `${btnX}px`,
    "--by": `${btnY}px`,
    "--px": `${panelPos.x}px`,
    "--py": `${panelPos.y}px`,
  } as CSSProperties;

  // Appui sur le pet : si la souris bouge de plus de 5 px, on le déplace.
  const onPress = (e: ReactMouseEvent) => {
    if (e.button !== 0 || pet.phase !== "VISIBLE") return;
    const sx = e.screenX;
    const sy = e.screenY;
    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
    };
    const onMove = (m: MouseEvent) => {
      if (Math.hypot(m.screenX - sx, m.screenY - sy) < 5) return;
      stop();
      dispatch({ type: "DRAG_START" });
      invoke("pin_drag_start", { label })
        .then(() => getCurrentWindow().startDragging())
        .catch(console.error);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
  };

  // Molette : change la taille.
  const onWheel = (e: React.WheelEvent) => {
    if (pet.phase !== "VISIBLE") return;
    const next = Math.max(MIN_SIZE, Math.min(MAX_SIZE, size + (e.deltaY < 0 ? 8 : -8)));
    if (next === size) return;
    const updated = { ...place, size: next };
    setPlace(updated);
    savePlacement(rawId, updated);
    invoke("pin_resize", { label, size: next }).catch(console.error);
  };

  return (
    <div
      className="pw"
      data-phase={pet.phase.toLowerCase()}
      data-open={open ? "true" : "false"}
      data-edge={edge}
      data-walking={walkDir ? "true" : "false"}
      style={style}
    >
      <div
        className="pw-mover"
        onAnimationEnd={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.animationName === "pw-arrive") dispatch({ type: "ARRIVED" });
          if (e.animationName === "pw-leave") dispatch({ type: "EXITED" });
        }}
      >
        <div
          className="pw-scale"
          onMouseDown={onPress}
          onWheel={onWheel}
          onClick={() => {
            if (pet.phase === "VISIBLE") {
              dispatch({ type: "CLICK" });
              // J'interagis avec cet ami : on prévient la fenêtre principale.
              if (friendId) emit("pet-interaction-out", friendId).catch(console.error);
            }
          }}
          onAnimationEnd={(e) => {
            // "joy" (placeholders CSS) ou "joy-still" (poussin : la planche
            // « react » anime déjà tout, on garde juste le minutage).
            if (e.animationName === "joy" || e.animationName === "joy-still") {
              dispatch({ type: "INTERACTION_DONE" });
            }
          }}
        >
          <div className="pw-inner">
            <div className="pet-body" style={{ "--pet-color": colorValue(color) } as CSSProperties}>
              <PetSprite species={species} color={color} phase={pet.phase} edge={edge} walkDir={walkDir ?? undefined} />
            </div>
          </div>
          {!isMine && !open && bubblePhase !== "hidden" && (
            <span
              className="pw-bubble"
              data-phase={bubblePhase}
              style={{ left: size / 2, top: bubbleTop }}
              onAnimationEnd={(e) => {
                if (e.animationName === "pw-bubble-out") setBubblePhase("hidden");
              }}
            >
              💬
            </span>
          )}
          <button
            className="pw-btn"
            data-unread={!isMine && unread > 0 ? "true" : undefined}
            style={{ left: size / 2 - BTN / 2, top: btnTop }}
            aria-label={isMine ? "Ranger cette créature" : friend ? `Conversation avec ${friend.name}` : "Conversation"}
            title={isMine ? "Ranger (retirer de l'herbe)" : undefined}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (isMine && creatureId) unpinCreature(creatureId);
              else openPanel();
            }}
          />
        </div>
      </div>

      {!isMine && (
        <div className={`pw-panel ${open ? "open" : ""}`}>
          <div className="pw-panel-inner">
            <div className="pw-conv">
              {friend && (
                <div className="eggs-ui">
                  <main className="content">
                    <ConversationScreen friend={friend} />
                  </main>
                </div>
              )}
            </div>
            <button className="panel-close" onClick={closePanel} aria-label="Fermer">
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
