import { useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { colorValue, unpinCreature, useCollection } from "../data/profile";
import { MAX_SIZE, MIN_SIZE } from "../data/placements";
import type { Edge } from "../data/placements";
import type { Species } from "../data/types";
import { closeChat, onLiveMessage, openChat, useChatStore } from "../data/store";
import { initialPetState, petReducer } from "../petMachine";
import PetSprite from "./PetSprite";
import { spriteTopOverflow } from "./spriteGeometry";
import { truncateBubble } from "./bubbleText";
import ConversationScreen from "../ui/screens/ConversationScreen";

// Taille (en pixels) de la boîte virtuelle d'un pet épinglé — plus une vraie
// fenêtre depuis le 29/09/2026 (voir GroundPetsWindow.tsx), juste l'espace
// dans lequel le pet se positionne (bouton, chat...), exactement comme avant.
// Doit correspondre à WIN_PIN dans src-tauri/src/lib.rs.
const WIN = 800;
const PW = 250;
const PH = 400;
const BTN = 9;

// Toutes les créatures de l'herbe (amies ou à moi) vivent sur le bord bas —
// voir snap()/ground_only côté Rust : jamais un autre bord.
const EDGE: Edge = "bottom";

// Marge fixe entre le pet et le bas de sa boîte (le sol) — doit correspondre
// à CORNER_PAD côté Rust.
const GROUND_MARGIN = 8;

// Espèces dessinées avec une vraie image (voir PetSprite.tsx) plutôt qu'un
// placeholder CSS teinté par --pet-color : leur rendu ne dépend pas de
// `color`, qui peut donc rester vide (ex. skins rares du Shop, achetés sans
// variante de couleur) sans empêcher l'affichage. Sans cette liste, un ami
// avec l'une de ces espèces et un `color` vide ne s'affichait jamais (bug du
// 29/09/2026, ex. le skin « Grillon »).
const SPECIES_WITHOUT_COLOR: Species[] = ["egg", "explorer", "cricket"];

function layoutFor(): CSSProperties {
  return { justifyContent: "center", alignItems: "flex-end", paddingBottom: GROUND_MARGIN };
}

function petBox(size: number) {
  return { x: (WIN - size) / 2, y: WIN - GROUND_MARGIN - size };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface GroundPetTick {
  x: number; // coin haut gauche de la boîte 800×800, pixels LOGIQUES locaux
  y: number; // (relatifs au coin haut gauche du moniteur, voir local_xy côté Rust)
  size: number;
  walking: boolean;
  walkLeft: boolean;
}

interface GroundPetProps {
  id: string; // « lea » (ami) ou « self-<creatureId> » (une de mes créatures)
  isMine: boolean;
  friendId: string | null;
  tick: GroundPetTick | undefined; // dernière position connue (voir GroundPetsWindow)
}

// Une créature posée sur l'herbe : soit le pet d'un ami (avec bouton + chat),
// soit une créature de MA collection (juste la balade, pas de chat avec
// moi-même). Depuis le 29/09/2026, toutes les créatures de l'herbe vivent
// dans la même fenêtre partagée "pets" (voir GroundPetsWindow.tsx qui rend
// une instance de ce composant par créature épinglée) — avant cette date,
// chacune avait sa propre fenêtre WebviewWindow, ce qui plafonnait leur
// nombre (voir l'historique de pin_pet côté Rust pour le pourquoi du
// changement). Position/taille/balade viennent maintenant du parent (prop
// `tick`, alimentée par l'événement "pets-tick") plutôt que de la fenêtre
// elle-même.
export default function GroundPet({ id, isMine, friendId, tick }: GroundPetProps) {
  const label = `pin-${id}`;

  const [pet, dispatch] = useReducer(petReducer, initialPetState);
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState({ x: 0, y: 0 });
  // Position pendant un glissement local (voir onPress) : prioritaire sur
  // `tick` tant qu'elle est définie (Rust exclut une créature en cours de
  // glissement de "pets-tick", voir tick_pinned) — redevient inutile dès que
  // le prochain tick/pet-placed arrive après le lâcher (voir l'effet
  // ci-dessous), pas besoin de la vider explicitement au mouseup : ça
  // éviterait un clignotement (la créature disparaîtrait un instant, le
  // temps que Rust confirme la position posée).
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (tick) setDragPos(null);
  }, [tick]);

  // Bulle de bande dessinée « vient d'écrire », avec le texte du message.
  const [bubblePhase, setBubblePhase] = useState<"hidden" | "in" | "out">("hidden");
  const [bubbleText, setBubbleText] = useState("");
  const bubbleTimer = useRef<number | undefined>(undefined);
  const { unread: unreadMap, activeChat, friends } = useChatStore();
  const { creatures } = useCollection();
  const friend = friendId ? friends.find((u) => u.id === friendId) : undefined;
  const creatureId = isMine ? id.replace(/^self-/, "") : null;
  const mine = creatureId ? creatures.find((c) => c.id === creatureId) : undefined;
  const species = friend?.species ?? mine?.species;
  const color = friend?.color ?? mine?.color;
  const unread = friendId ? (unreadMap[friendId] ?? 0) : 0;
  const phaseRef = useRef(pet.phase);
  phaseRef.current = pet.phase;

  const size = tick?.size ?? 72; // valeur de secours, écrasée dès le 1er tick
  const box = petBox(size);
  const btnTop = -(BTN + 10 + spriteTopOverflow(species) * (size / 96));
  const btnX = box.x + size / 2 - BTN / 2;
  const btnY = box.y + btnTop;
  const bubbleTop = btnTop - 24;

  // Toujours « dans la zone » dès le montage : une créature de l'herbe est
  // visible en permanence, elle ne dépend pas de la souris (voir le
  // commentaire équivalent dans l'ancien PinnedWindow.tsx, avant le
  // 29/09/2026 — inchangé sur ce point). Rust n'envoie d'ailleurs plus jamais
  // "zone-changed" pour une créature de l'herbe (seulement pour "main").
  useEffect(() => {
    dispatch({ type: "ZONE_ENTER" });
  }, []);

  // Filet de sécurité : tant que la phase reste "ARRIVING", le bouton de
  // chat reste volontairement inerte (pointer-events: none tant que
  // data-phase !== "visible"/"interacting", voir pinned.css) — sans ça, on
  // pourrait cliquer sur un pet encore à moitié arrivé. La sortie normale de
  // cette phase passe par la fin de l'animation CSS "pw-arrive" (voir
  // onAnimationEnd sur .pw-mover ci-dessous), mais un pet qui a longtemps
  // gardé `phase=ARRIVING` sans jamais avoir de `.pw-mover` dans le DOM pour
  // la jouer (ex : ce composant est resté monté en rendant `null`, comme
  // avant le correctif du bug de couleur vide côté Grillon) peut la manquer.
  // Ce timer rattrape le coup dès que la boîte a une position connue, même
  // si l'événement d'animation n'a jamais été reçu.
  useEffect(() => {
    if (pet.phase !== "ARRIVING" || !(tick ?? dragPos)) return;
    const t = window.setTimeout(() => dispatch({ type: "ARRIVED" }), 1600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet.phase, !!(tick ?? dragPos)]);

  // Temps réel : cet ami vient d'interagir avec mon pet, le sien réagit
  // aussi (diffusé globalement, voir App.tsx : emit("remote-interaction")).
  useEffect(() => {
    if (isMine) return;
    let cancelled = false;
    const w = getCurrentWebviewWindow();
    let off: (() => void) | undefined;
    w.listen<{ target: string }>("remote-interaction", (e) => {
      if (e.payload.target === friendId && phaseRef.current === "VISIBLE") {
        dispatch({ type: "CLICK" });
      }
    }).then((fn) => {
      if (cancelled) fn();
      else off = fn;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [isMine, friendId]);

  // Cet ami vient d'écrire : petite bulle, le temps qu'on la remarque.
  useEffect(() => {
    if (isMine || !friendId) return;
    const unsub = onLiveMessage((from, text) => {
      if (from !== friendId) return;
      window.clearTimeout(bubbleTimer.current);
      setBubbleText(truncateBubble(text));
      setBubblePhase("in");
      bubbleTimer.current = window.setTimeout(() => setBubblePhase("out"), 4000);
    });
    return () => {
      unsub();
      window.clearTimeout(bubbleTimer.current);
    };
  }, [isMine, friendId]);

  // Un ami PAS épinglé vient d'écrire, mais MOI je suis épinglé(e) et
  // visible à l'écran : pas de pet à lui sur lequel afficher sa bulle, alors
  // c'est la mienne qui la montre à sa place.
  useEffect(() => {
    if (!isMine) return;
    const unsub = onLiveMessage((from, text) => {
      invoke<boolean>("pin_is_active", { friendId: from })
        .catch(() => false)
        .then((friendPinVisible) => {
          if (friendPinVisible) return;
          window.clearTimeout(bubbleTimer.current);
          setBubbleText(truncateBubble(text));
          setBubblePhase("in");
          bubbleTimer.current = window.setTimeout(() => setBubblePhase("out"), 4000);
        });
    });
    return () => {
      unsub();
      window.clearTimeout(bubbleTimer.current);
    };
  }, [isMine]);

  // Prévient Rust : le pet est-il à l'écran ? (les clics traversent la
  // fenêtre partagée tant qu'aucune créature n'est active/survolée)
  useEffect(() => {
    invoke("pin_set_active", { label, active: pet.phase !== "HIDDEN" }).catch(console.error);
  }, [pet.phase, label]);

  // Prévient Rust des zones cliquables de CETTE créature (bouton, chat) :
  // toujours en coordonnées relatives à sa propre boîte 800×800, comme avant.
  useEffect(() => {
    const rects: number[][] = [[btnX - 8, btnY - 8, btnX + BTN + 8, btnY + BTN + 8]];
    if (open) rects.push([panelPos.x, panelPos.y, panelPos.x + PW, panelPos.y + PH]);
    invoke("pin_set_ui", { label, panelOpen: open, rects }).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, panelPos.x, panelPos.y, size, species, label]);

  const closePanel = () => {
    setOpen(false);
    if (friendId) closeChat();
  };

  useEffect(() => {
    if (open && (pet.phase === "EXITING" || pet.phase === "HIDDEN" || pet.phase === "DRAGGING")) {
      closePanel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet.phase]);

  useEffect(() => {
    if (!isMine && open && activeChat !== friendId) setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const boxPos = tick ?? dragPos;
  // Pas encore de position connue, d'espèce identifiée, ou (pour une espèce
  // qui en a besoin, voir SPECIES_WITHOUT_COLOR) de couleur : rien à afficher
  // pour l'instant.
  const needsColor = !!species && !SPECIES_WITHOUT_COLOR.includes(species);
  if (!boxPos || !species || (needsColor && !color)) {
    return null;
  }

  // Ouvre le chat : à côté du pet, en restant dans la fenêtre partagée — qui
  // couvre tout le moniteur (voir setup_pets côté Rust), donc ses propres
  // dimensions (window.innerWidth/innerHeight) SONT déjà les limites de
  // l'écran : plus besoin de comparer à window.screen ni à la position de la
  // fenêtre comme avant le 29/09/2026 (chaque pet avait sa petite fenêtre à
  // lui, pas forcément alignée avec l'écran).
  const openPanel = () => {
    if (open || !friendId) return;
    // Toujours au-dessus du pet (bord bas, voir EDGE), centré horizontalement
    // dessus — même calcul que l'ancien PinnedWindow.tsx pour edge="bottom".
    let x = boxPos.x + box.x + size / 2 - PW / 2;
    let y = boxPos.y + box.y - PH - 8;
    x = clamp(x, 0, Math.max(0, window.innerWidth - PW));
    y = clamp(y, 0, Math.max(0, window.innerHeight - PH));
    // Coordonnées locales à la fenêtre partagée : le panneau se positionne
    // en absolu par rapport à CETTE créature (voir --px/--py plus bas), donc
    // relatives à sa boîte, pas à la fenêtre entière.
    setPanelPos({ x: x - boxPos.x, y: y - boxPos.y });
    openChat(friendId);
    setOpen(true);
    getCurrentWindow()
      .setFocus()
      .catch(() => {});
  };

  // Bord bas uniquement (EDGE) : se cache toujours vers le bas de sa boîte.
  const hx = 0;
  const hy = Math.round(size * 1.4 + 20);
  const style = {
    ...layoutFor(),
    "--gx": `${boxPos.x}px`,
    "--gy": `${boxPos.y}px`,
    "--hx": `${hx}px`,
    "--hy": `${hy}px`,
    "--size": `${size}px`,
    "--k": size / 96,
    "--bx": `${btnX}px`,
    "--by": `${btnY}px`,
    "--px": `${panelPos.x}px`,
    "--py": `${panelPos.y}px`,
  } as CSSProperties;

  // Appui sur le pet : si la souris bouge de plus de 5 px, on le déplace —
  // en JS depuis le 29/09/2026 (plus de vraie fenêtre à faire suivre la
  // souris nativement, voir pin_drag_at côté Rust). clientX/clientY : la
  // fenêtre partagée couvre tout le moniteur depuis son coin haut gauche, ce
  // sont donc déjà les coordonnées locales attendues par pin_drag_at, sans
  // conversion.
  const onPress = (e: ReactMouseEvent) => {
    if (e.button !== 0 || pet.phase !== "VISIBLE") return;
    const startX = e.clientX;
    const startY = e.clientY;
    const originX = boxPos.x;
    const originY = boxPos.y;
    let dragging = false;
    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onMove = (m: MouseEvent) => {
      if (!dragging) {
        if (Math.hypot(m.clientX - startX, m.clientY - startY) < 5) return;
        dragging = true;
        dispatch({ type: "DRAG_START" });
        invoke("pin_drag_start", { label }).catch(console.error);
      }
      const nx = originX + (m.clientX - startX);
      const ny = originY + (m.clientY - startY);
      setDragPos({ x: nx, y: ny });
      invoke("pin_drag_at", { label, x: nx, y: ny }).catch(console.error);
    };
    const onUp = () => {
      stop();
      if (dragging) dispatch({ type: "DRAG_END" });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Molette : change la taille — pas de mise à jour optimiste locale
  // nécessaire (voir pin_resize côté Rust) : le prochain "pets-tick" (60ms
  // max) reflète déjà la nouvelle taille, un délai imperceptible.
  const onWheel = (e: React.WheelEvent) => {
    if (pet.phase !== "VISIBLE") return;
    const next = clamp(size + (e.deltaY < 0 ? 8 : -8), MIN_SIZE, MAX_SIZE);
    if (next === size) return;
    invoke("pin_resize", { label, size: next }).catch(console.error);
  };

  return (
    <div
      className="pw"
      data-shared="true"
      data-phase={pet.phase.toLowerCase()}
      data-open={open ? "true" : "false"}
      data-edge={EDGE}
      data-walking={!dragPos && tick?.walking ? "true" : "false"}
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
              if (friendId) emit("pet-interaction-out", friendId).catch(console.error);
            }
          }}
          onAnimationEnd={(e) => {
            if (e.animationName === "joy" || e.animationName === "joy-still") {
              dispatch({ type: "INTERACTION_DONE" });
            }
          }}
        >
          <div className="pw-inner">
            <div className="pet-body" style={{ "--pet-color": colorValue(color ?? "") } as CSSProperties}>
              <PetSprite
                species={species}
                color={color}
                phase={pet.phase}
                edge={EDGE}
                walkDir={!dragPos && tick?.walking ? (tick.walkLeft ? "left" : "right") : undefined}
              />
            </div>
          </div>
          {!open && bubblePhase !== "hidden" && (
            <span
              className="pw-bubble"
              data-phase={bubblePhase}
              style={{ left: size / 2, top: bubbleTop }}
              onAnimationEnd={(e) => {
                if (e.animationName === "pw-bubble-out") setBubblePhase("hidden");
              }}
            >
              {bubbleText}
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
                    <ConversationScreen target={{ kind: "friend", friend }} />
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
