import { useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrent as getCurrentDeepLinkUrls, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { ME_GROUND_ID, ME_ID, getPlacement, savePlacement, selfPinId } from "./data/placements";
import type { Edge, Placement } from "./data/placements";
import { colorValue, useCollection } from "./data/profile";
import { ME, realtime } from "./data/realtime";
import { previewSalon } from "./data/salons";
import { useMyAppearance } from "./data/session";
import { syncSettingsToBackend, useSettings } from "./data/settings";
import { onLiveMessage, openChat, useChatStore } from "./data/store";
import PetSprite from "./pet/PetSprite";
import { spriteTopOverflow } from "./pet/spriteGeometry";
import { truncateBubble } from "./pet/bubbleText";
import { initialPetState, petReducer } from "./petMachine";
import MainApp from "./ui/MainApp";
import eggLogo from "./assets/brand/egg-logo.png";
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

// Lien de salon partageable : eggs://salon/<ownerId> (voir tauri.conf.json,
// src-tauri/Cargo.toml/lib.rs, et server/src/index.ts pour la page relais
// https://.../join/<ownerId> qui déclenche ce lien depuis un vrai
// navigateur). On n'accepte que ce format précis, hôte "salon" suivi d'un
// seul segment de chemin — le reste est ignoré silencieusement.
function salonIdFromDeepLink(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "eggs:") return null;
    // Selon la plateforme, "salon" atterrit soit dans `host` (eggs://salon/x)
    // soit comme premier segment de `pathname` (eggs:salon/x) — on couvre les
    // deux pour rester robuste.
    const host = u.hostname || u.host;
    const segments = u.pathname.split("/").filter(Boolean);
    if (host === "salon" && segments.length >= 1) return segments[0];
    if (segments[0] === "salon" && segments.length >= 2) return segments[1];
    return null;
  } catch {
    return null;
  }
}

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
  // Bulle de bande dessinée « vient d'écrire » : un ami PAS épinglé m'a
  // écrit, mais moi je suis épinglé(e) et visible — pas de pet à lui sur
  // lequel afficher sa bulle, alors c'est la mienne qui la montre à sa
  // place (voir self_pin_active côté Rust / data/notifications.ts, qui
  // coupe la carte "nouveau message" dans ce cas pour ne pas faire
  // doublon). Même bulle que pour un ami épinglé, voir pet/GroundPet.tsx.
  const [bubblePhase, setBubblePhase] = useState<"hidden" | "in" | "out">("hidden");
  const [bubbleText, setBubbleText] = useState("");
  const bubbleTimer = useRef<number | undefined>(undefined);
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
  // Bulle « vient d'écrire » : encore plus loin du pet que le bouton, du même
  // côté (au-dessus, ou en dessous si le pet est collé en haut de l'écran).
  const bubbleTop = edge === "top" ? btnTop + 24 : btnTop - 24;

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
    // La fenêtre est créée avec `focus: false` (voir tauri.conf.json) pour ne
    // jamais voler le focus tant que le panneau n'est pas ouvert — mais une
    // fois ouvert, il faut bien le redemander explicitement : sinon les clics
    // marchent (Windows les route à la fenêtre sous la souris) mais le
    // clavier continue d'aller à la dernière fenêtre réellement focus, et
    // aucun champ texte du panneau (nom de groupe, recherche, message...) ne
    // reçoit jamais ce qu'on tape.
    getCurrentWindow()
      .setFocus()
      .catch(() => {});
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

  // Lien de salon partageable (eggs://salon/<ownerId>) : au démarrage à froid
  // (l'appli n'était pas lancée, Windows la lance avec le lien en argument)
  // ET pendant qu'elle tourne déjà (tauri-plugin-single-instance relance
  // l'appli avec le nouveau lien, tauri-plugin-deep-link l'intercepte au lieu
  // d'ouvrir une deuxième fenêtre — voir Cargo.toml/lib.rs). Ne marche que sur
  // une version installée (le protocole eggs:// est enregistré par
  // l'installeur NSIS) — pas en `npm run tauri dev`.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const openFromUrl = (url: string | null | undefined) => {
      const ownerId = url ? salonIdFromDeepLink(url) : null;
      if (!ownerId) return;
      previewSalon(ownerId).catch(console.error);
      openPanel();
    };

    // Démarrage à froid : le lien qui a lancé l'appli, s'il y en a un.
    getCurrentDeepLinkUrls()
      .then((urls) => {
        if (!cancelled) openFromUrl(urls?.[0]);
      })
      .catch(console.error);

    // Appli déjà lancée : un nouveau lien arrive en direct.
    onOpenUrl((urls) => openFromUrl(urls?.[0])).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
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

  // Ajoute / retire une créature à la simulation côté Rust pour chaque pet
  // épinglé — les amis, et mes propres créatures (non actives) posées sur
  // l'herbe (identifiant préfixé "self-" via selfPinId, pour ne jamais
  // entrer en collision avec un ami ; voir pet/GroundPet.tsx qui s'en sert
  // pour reconnaître les deux cas). Depuis le 29/09/2026 (fenêtre partagée
  // "pets", voir pet/GroundPetsWindow.tsx), pin_pet ne crée plus de fenêtre
  // — juste une entrée dans la simulation — donc plus de paramètre "edge"
  // (toujours le bas, ground_only côté Rust) ni "drag" (le glisser-déposer
  // depuis « Ma collection » ne suit plus la souris dès l'apparition, voir
  // pinCreatureByDrag dans data/profile.ts).
  useEffect(() => {
    const wanted = new Set([...pinned, ...pinnedCreatures.map(selfPinId)]);

    pinned.forEach((id, index) => {
      if (created.current.has(id)) return;
      created.current.add(id);
      const p = getPlacement(id, index);
      savePlacement(id, p);
      invoke("pin_pet", { id, offset: p.offset, size: p.size }).catch(console.error);
    });
    pinnedCreatures.forEach((creatureId, index) => {
      const id = selfPinId(creatureId);
      if (created.current.has(id)) return;
      created.current.add(id);
      const p = getPlacement(id, pinned.length + index);
      savePlacement(id, p);
      invoke("pin_pet", { id, offset: p.offset, size: p.size }).catch(console.error);
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

  // Un ami PAS épinglé vient d'écrire, mais MOI je suis visible à l'écran
  // (voir self_pin_active côté Rust) : pas de pet à lui sur lequel afficher
  // sa bulle, alors c'est la mienne qui la montre à sa place.
  useEffect(() => {
    const unsub = onLiveMessage((from, text) => {
      invoke<boolean>("pin_is_active", { friendId: from })
        .catch(() => false)
        .then((friendPinVisible) => {
          if (friendPinVisible) return; // son propre pet s'en charge déjà
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
  }, []);

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
          {bubblePhase !== "hidden" && (
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
            style={{ left: size / 2 - BTN / 2, top: btnTop }}
            aria-label="Ouvrir Egg"
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
          {/* Barre de titre façon fenêtre, demandée le 28/09/2026 sur la base
              de la maquette "Messages". Ce n'est pas une vraie fenêtre système
              (le panneau est ancré à la créature, toujours au-dessus, sans
              entrée dans la barre des tâches — voir tauri.conf.json :
              decorations/skipTaskbar) : réduire et fermer font donc la même
              chose ici, replier le panneau (comme l'ancien bouton ✕ seul,
              qu'elle remplace). */}
          <div className="panel-titlebar">
            <img className="panel-titlebar-logo" src={eggLogo} alt="Egg" />
            <span className="panel-titlebar-actions">
              <button className="panel-title-btn" onClick={closePanel} aria-label="Réduire" title="Réduire">
                &#8211;
              </button>
              <button className="panel-title-btn close" onClick={closePanel} aria-label="Fermer" title="Fermer">
                ✕
              </button>
            </span>
          </div>
          <div className="pw-conv">
            <MainApp />
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
