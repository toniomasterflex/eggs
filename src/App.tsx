import { useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DEFAULT_SIZE, ME_GROUND_ID, ME_ID, getPlacement, savePlacement, selfPinId } from "./data/placements";
import type { Edge, Placement } from "./data/placements";
import { colorValue, takeDragPinId, useCollection } from "./data/profile";
import { ME, realtime } from "./data/realtime";
import { useMyAppearance } from "./data/session";
import { syncSettingsToBackend, useSettings } from "./data/settings";
import { openChat, useChatStore } from "./data/store";
import PetSprite from "./pet/PetSprite";
import { spriteTopOverflow } from "./pet/spriteGeometry";
import { initialPetState, petReducer } from "./petMachine";
import MainApp from "./ui/MainApp";
import "./App.css";
import "./pet/pinned.css";

// Fenêtre carrée : mon pet vit maintenant dans le même système que les pets
// épinglés des amis (doit correspondre à WIN_PIN dans src-tauri/src/lib.rs
// et à la taille de la fenêtre « main » dans tauri.conf.json).
const WIN = 800;
// Taille du panneau Eggs ouvert (un peu plus grand qu'à l'origine, 190x320)
// et du petit bouton rond.
const PW = 250;
const PH = 400;
const BTN = 9;
// Identifiant Tauri de cette fenêtre (une seule fenêtre « main »).
const label = "main";

// Direction dans laquelle le pet se cache, selon le bord.
const HIDE: Record<Edge, [number, number]> = {
  right: [WIN, 0],
  left: [-WIN, 0],
  top: [0, -WIN],
  bottom: [0, WIN],
};

// Sur l'herbe (bord bas), tous les pets touchent exactement la même ligne de
// sol, quelle que soit leur taille — une marge FIXE (le même petit coussin
// que la position la plus basse atteignable sur un bord latéral), pas
// proportionnelle à la taille (sinon un gros pet flotte plus haut qu'un
// petit, les pieds ne touchent plus le gazon). Voir PinnedWindow.tsx
// (GROUND_MARGIN/marginFor) et CORNER_PAD dans src-tauri/src/lib.rs : les
// trois doivent rester identiques.
const GROUND_MARGIN = 8;

function marginFor(edge: Edge, size: number): number {
  return edge === "bottom" ? GROUND_MARGIN : size / 3;
}

// Le pet est collé à son bord (marge fixe sur l'herbe, sinon un tiers de sa
// taille — voir marginFor).
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

function App() {
  const [pet, dispatch] = useReducer(petReducer, initialPetState);
  // Épinglée sur le bureau (bouton dans Profil) : ma créature ne repart
  // jamais, même quand la souris s'éloigne pour de vrai — et elle vit sur
  // l'herbe comme les créatures des amis (marche/course au bord bas), au
  // lieu de rester collée à un bord du bureau. On lit ce réglage tout de
  // suite pour choisir la bonne position mémorisée dès le premier rendu
  // (voir ME_GROUND_ID dans placements.ts : une position à part de celle du
  // mode bureau, pour ne jamais perdre l'une en basculant vers l'autre).
  const { pinnedOnDesktop } = useSettings();
  const [place, setPlace] = useState<Placement>(() =>
    getPlacement(pinnedOnDesktop ? ME_GROUND_ID : ME_ID),
  );
  const [walkDir, setWalkDir] = useState<"left" | "right" | null>(null);
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState({ x: 0, y: 0 });
  const look = useMyAppearance(); // toujours celle de ma créature active
  const { pinned = [], unread = {} } = useChatStore();
  const { pinnedCreatures = [] } = useCollection(); // mes créatures posées sur l'herbe
  const unreadRef = useRef(unread);
  unreadRef.current = unread;
  const created = useRef<Set<string>>(new Set());
  const phaseRef = useRef(pet.phase);
  phaseRef.current = pet.phase;

  const pinnedRef = useRef(pinnedOnDesktop);
  pinnedRef.current = pinnedOnDesktop;
  // Dernière position réelle de la souris (zone ou non), même si on l'ignore
  // pendant qu'on est épinglé — pour pouvoir s'en resservir si on désépingle.
  const lastZoneRef = useRef(false);

  const { edge, size } = place;
  const box = petBox(edge, size);
  // Le bouton est au-dessus du pet (en dessous si le pet est en haut de
  // l'écran) — décalé selon la hauteur réelle de CETTE créature (poussin,
  // Aventurier...), pas une valeur fixe (voir spriteGeometry.ts).
  const btnTop = edge === "top" ? size + 10 : -(BTN + 10 + spriteTopOverflow(look.species) * (size / 96));
  const btnX = box.x + size / 2 - BTN / 2;
  const btnY = box.y + btnTop;

  // Ouvre le panneau Eggs : à côté du pet, en restant dans l'écran.
  const openPanel = async () => {
    if (open) return;
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
    setOpen(true);
  };

  const closePanel = () => setOpen(false);

  // Au montage : Rust a placé la fenêtre à un endroit par défaut (coin bas
  // droit). On corrige avec l'emplacement mémorisé sur cet ordinateur — et
  // à chaque bascule du réglage « Épingler sur le bureau » dans Profil, on
  // recharge la position propre à ce mode (bureau ou herbe) et on prévient
  // Rust, qui bascule side_only/ground_only en conséquence (voir place_me
  // dans src-tauri/src/lib.rs).
  useEffect(() => {
    const id = pinnedOnDesktop ? ME_GROUND_ID : ME_ID;
    const p = getPlacement(id);
    setPlace(p);
    // Sécurité : un sens de marche mémorisé pendant une balade sur l'herbe
    // (walkDir, mis à jour par l'événement Rust "pet-walk") ne doit jamais
    // survivre au passage en mode bureau — sinon, une fois calée sur son
    // bord latéral (immobile), la créature continue d'afficher une pose de
    // marche figée dans ce sens-là au lieu de son repos normal, ce qui
    // donnait l'impression qu'elle « entrait à l'envers » à l'appel suivant.
    setWalkDir(null);
    invoke("place_me", { edge: p.edge, offset: p.offset, size: p.size, ground: pinnedOnDesktop }).catch(
      console.error,
    );
  }, [pinnedOnDesktop]);

  // Au montage : Rust démarre avec des réglages par défaut, on lui envoie
  // ceux mémorisés sur cet ordinateur (herbe visible ou non, etc.).
  useEffect(() => {
    syncSettingsToBackend();
  }, []);

  // Écoute Rust : souris près du bord, position finale après un glissement.
  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const w = getCurrentWebviewWindow();
    const add = (p: Promise<() => void>) =>
      p.then((fn) => {
        if (cancelled) fn();
        else unlisten.push(fn);
      });

    add(
      w.listen<boolean>("zone-changed", (e) => {
        lastZoneRef.current = e.payload;
        // Tant que c'est épinglé, on ignore les départs : elle reste.
        if (e.payload) dispatch({ type: "ZONE_ENTER" });
        else if (!pinnedRef.current) dispatch({ type: "ZONE_LEAVE" });
      }),
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
          savePlacement(pinnedRef.current ? ME_GROUND_ID : ME_ID, next);
          if (e.payload.dragged) dispatch({ type: "DRAG_END" });
        },
      ),
    );
    // Sur l'herbe : Rust fait marcher/courir mon pet tout seul, comme ceux
    // des amis (voir tick_wander côté Rust, et pin-*/PinnedWindow.tsx qui
    // écoute déjà le même événement).
    add(
      w.listen<{ walking: boolean; dir: "left" | "right" }>("pet-walk", (e) => {
        setWalkDir(e.payload.walking ? e.payload.dir : null);
      }),
    );
    // Un pet épinglé demande d'ouvrir une conversation.
    add(
      w.listen<string>("open-chat", (e) => {
        openChat(e.payload);
        openPanel();
      }),
    );
    // Un pet épinglé vient de s'ouvrir : on lui envoie les messages non lus.
    add(
      w.listen("pin-ready", () => {
        emit("unread-changed", unreadRef.current).catch(console.error);
      }),
    );

    return () => {
      cancelled = true;
      unlisten.forEach((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Épinglage activé/désactivé (bouton dans Profil, ou au démarrage si déjà
  // épinglée) : on fait sortir la créature tout de suite, ou — si on vient
  // de désépingler et que la souris n'est déjà plus dans la zone pour de
  // vrai — on la laisse repartir sans attendre le prochain mouvement.
  useEffect(() => {
    if (pinnedOnDesktop) dispatch({ type: "ZONE_ENTER" });
    else if (!lastZoneRef.current) dispatch({ type: "ZONE_LEAVE" });
  }, [pinnedOnDesktop]);

  // Temps réel : quelqu'un interagit avec une créature que j'affiche
  // (la connexion est ouverte par store.ts).
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const off = realtime.onInteraction((interaction) => {
      if (interaction.target === ME) {
        // Un ami clique sur MA créature : elle saute, si elle est à l'écran.
        // Rien n'est enregistré.
        if (phaseRef.current === "VISIBLE") dispatch({ type: "CLICK" });
      } else {
        // Un ami clique sur SA créature : son pet épinglé saute chez moi aussi.
        emit("remote-interaction", { target: interaction.target }).catch(console.error);
      }
    });

    // J'ai cliqué sur la créature d'un ami : on le transmet au temps réel.
    getCurrentWebviewWindow()
      .listen<string>("pet-interaction-out", (e) => realtime.interact(e.payload, "poke"))
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });

    return () => {
      cancelled = true;
      off();
      unlisten?.();
    };
  }, []);

  // Crée / ferme la fenêtre de chaque pet épinglé — les amis, et mes propres
  // créatures (non actives) posées sur l'herbe (identifiant préfixé
  // "self-" via selfPinId, pour ne jamais entrer en collision avec un ami ;
  // voir PinnedWindow.tsx qui s'en sert pour reconnaître les deux cas).
  useEffect(() => {
    const wanted = new Set([...pinned, ...pinnedCreatures.map(selfPinId)]);

    pinned.forEach((id, index) => {
      if (created.current.has(id)) return;
      created.current.add(id);
      const p = getPlacement(id, index);
      savePlacement(id, p);
      invoke("pin_pet", { id, edge: p.edge, offset: p.offset, size: p.size, drag: false }).catch(
        console.error,
      );
    });
    pinnedCreatures.forEach((creatureId, index) => {
      const id = selfPinId(creatureId);
      if (created.current.has(id)) return;
      created.current.add(id);
      // Posée par glissement depuis « Ma collection » : la nouvelle fenêtre
      // doit tout de suite suivre la souris (drag: true côté Rust, qui
      // enchaîne sur start_dragging()) plutôt que réapparaître à une
      // position mémorisée — sa taille/position réelle sera de toute façon
      // écrasée par l'événement "pet-placed" une fois le glissement relâché.
      const drag = takeDragPinId(creatureId);
      const p = drag
        ? { edge: "bottom" as const, offset: 0.5, size: DEFAULT_SIZE }
        : getPlacement(id, pinned.length + index);
      savePlacement(id, p);
      invoke("pin_pet", { id, edge: p.edge, offset: p.offset, size: p.size, drag }).catch(
        console.error,
      );
    });

    created.current.forEach((id) => {
      if (wanted.has(id)) return;
      created.current.delete(id);
      invoke("unpin_pet", { id }).catch(console.error);
    });
  }, [pinned, pinnedCreatures]);

  // Envoie aux pets épinglés le nombre de messages non lus.
  useEffect(() => {
    emit("unread-changed", unread).catch(console.error);
  }, [unread]);

  // Prévient Rust : mon pet est-il à l'écran ? (les clics traversent la
  // fenêtre tant qu'il est caché) — aussi à chaque bascule du réglage
  // « Épingler sur le bureau » (et pas seulement à chaque changement de
  // phase) : sur l'herbe, la créature est déjà VISIBLE en permanence, donc
  // rien ne redéclenche forcément cet effet côté phase au moment précis du
  // passage en mode bureau ; on republie l'état actuel pour être sûr que le
  // bouton reste cliquable dès l'activation, sans dépendre d'une transition
  // de phase qui a peut-être déjà eu lieu.
  useEffect(() => {
    invoke("pin_set_active", { label, active: pet.phase !== "HIDDEN" }).catch(console.error);
  }, [pet.phase, pinnedOnDesktop]);

  // Prévient Rust des zones cliquables : le bouton, et le panneau s'il est ouvert.
  useEffect(() => {
    const rects: number[][] = [[btnX - 8, btnY - 8, btnX + BTN + 8, btnY + BTN + 8]];
    if (open) rects.push([panelPos.x, panelPos.y, panelPos.x + PW, panelPos.y + PH]);
    invoke("pin_set_ui", { label, panelOpen: open, rects }).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, panelPos.x, panelPos.y, edge, size, look.species]);

  // Le pet repart ou est déplacé : le panneau se referme.
  useEffect(() => {
    if (open && (pet.phase === "EXITING" || pet.phase === "HIDDEN" || pet.phase === "DRAGGING")) {
      closePanel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pet.phase]);

  // Échap ferme le panneau.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [hsx, hsy] = HIDE[edge];
  const hd = Math.round(size * 1.4 + 20);
  const hx = hsx === 0 ? 0 : Math.sign(hsx) * hd;
  const hy = hsy === 0 ? 0 : Math.sign(hsy) * hd;
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
          onClick={() => {
            if (pet.phase === "VISIBLE") {
              dispatch({ type: "CLICK" });
              // Mon pet saute : mes amis qui l'ont épinglé le voient sauter.
              realtime.interact(ME, "poke");
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
            <div className="pet-body" style={{ "--pet-color": colorValue(look.color) } as CSSProperties}>
              <PetSprite
                species={look.species}
                color={look.color}
                phase={pet.phase}
                edge={edge}
                walkDir={walkDir ?? undefined}
              />
            </div>
          </div>
          <button
            className="pw-btn"
            style={{ left: size / 2 - BTN / 2, top: btnTop }}
            aria-label="Ouvrir Eggs"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              openPanel();
            }}
          />
        </div>
      </div>

      <div className={`pw-panel ${open ? "open" : ""}`}>
        <div className="pw-panel-inner">
          <div className="pw-conv">
            <MainApp />
          </div>
          <button className="panel-close" onClick={closePanel} aria-label="Fermer">
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
