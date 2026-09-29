import { useEffect, useRef, useState } from "react";
import PetPreview from "../../pet/PetPreview";
import CreatureAvatar from "../Creature";
import { giftEgg, openEgg, useCollection } from "../../data/profile";
import { useChatStore } from "../../data/store";
import type { Creature } from "../../data/types";

const CLICKS_TO_OPEN = 3;

type GiftStatus = "sending" | "sent" | "error";

// Onglet Œufs : une petite ferme personnelle. Tous les œufs en attente sont
// posés côte à côte, ensemble — pas un seul à la fois caché derrière les
// autres — et on choisit lequel faire éclore, et quand (3 taps : les 2
// premiers font juste trembler l'œuf, le 3e lance le craquement). Chaque œuf
// a aussi un petit bouton cadeau : on choisit un ami, l'œuf part chez lui
// tout de suite (transfert immédiat, pas de proposition à accepter — voir
// service.ts côté serveur : giftEgg). C'est aussi ICI, et seulement ici,
// qu'on offre un œuf à un ami (nulle part ailleurs dans l'app).
// Un œuf qui vient d'arriver (cadeau reçu, œuf de la semaine...) a un petit
// effet d'arrivée, pour qu'on le remarque tout de suite.
export default function HatchScreen() {
  const { eggs, loaded } = useCollection();
  const { friends } = useChatStore();

  // Craquement : un seul œuf « actif » à la fois (celui qu'on est en train de
  // taper), les autres restent simplement posés là.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [clicks, setClicks] = useState(0);
  const [shaking, setShaking] = useState(false);
  const [cracking, setCracking] = useState(false);
  const [opening, setOpening] = useState(false);
  const [hatched, setHatched] = useState<Creature | null>(null);
  const busyHatch = shaking || cracking || opening;

  // Offrir un œuf : replié par défaut, ouvert via le petit bouton cadeau
  // posé sur l'œuf concerné.
  const [giftingId, setGiftingId] = useState<string | null>(null);
  const [giftStatus, setGiftStatus] = useState<Record<string, GiftStatus>>({});

  // Œufs arrivés depuis le dernier rendu (cadeau reçu, œuf de la semaine...) :
  // petit effet d'arrivée pendant une seconde, puis oublié.
  const knownIds = useRef<Set<string> | null>(null);
  const [justArrived, setJustArrived] = useState<Set<string>>(new Set());
  useEffect(() => {
    // Tant que la collection n'est pas encore chargée une première fois, on
    // ne sait pas ce qui est réellement nouveau : on attend, pour ne pas
    // faire clignoter tous les œufs déjà là au premier chargement.
    if (!loaded) return;
    const currentIds = new Set(eggs.map((e) => e.id));
    if (knownIds.current) {
      const fresh = [...currentIds].filter((id) => !knownIds.current!.has(id));
      if (fresh.length > 0) {
        setJustArrived((s) => new Set([...s, ...fresh]));
        window.setTimeout(() => {
          setJustArrived((s) => {
            const next = new Set(s);
            fresh.forEach((id) => next.delete(id));
            return next;
          });
        }, 1200);
      }
    }
    knownIds.current = currentIds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, eggs.map((e) => e.id).join(",")]);

  // Si l'œuf actif (ou celui qu'on est en train d'offrir) disparaît pour une
  // autre raison, on ne reste pas bloqué dessus.
  useEffect(() => {
    if (activeId && !eggs.some((e) => e.id === activeId)) {
      setActiveId(null);
      setClicks(0);
      setShaking(false);
      setCracking(false);
    }
  }, [eggs, activeId]);
  useEffect(() => {
    if (giftingId && !eggs.some((e) => e.id === giftingId)) {
      setGiftingId(null);
      setGiftStatus({});
    }
  }, [eggs, giftingId]);

  const toggleGifting = (eggId: string) => {
    setGiftingId((cur) => (cur === eggId ? null : eggId));
    setGiftStatus({});
  };

  const sendGift = async (friendId: string) => {
    const eggId = giftingId;
    if (!eggId) return;
    setGiftStatus((s) => ({ ...s, [friendId]: "sending" }));
    try {
      await giftEgg(eggId, friendId);
      setGiftStatus((s) => ({ ...s, [friendId]: "sent" }));
      window.setTimeout(() => {
        setGiftingId(null);
        setGiftStatus({});
      }, 700);
    } catch {
      setGiftStatus((s) => ({ ...s, [friendId]: "error" }));
      window.setTimeout(() => {
        setGiftStatus((s) => {
          const next = { ...s };
          delete next[friendId];
          return next;
        });
      }, 2000);
    }
  };

  // Clic sur un œuf : les 2 premiers font juste trembler, le 3e lance le
  // craquement (le vrai appel réseau se fait une fois l'animation terminée,
  // dans onCrackDone).
  const tap = (eggId: string) => {
    if (busyHatch || giftingId) return;
    const next = activeId === eggId ? clicks + 1 : 1;
    setActiveId(eggId);
    setClicks(next);
    if (next >= CLICKS_TO_OPEN) setCracking(true);
    else setShaking(true);
  };

  const onShakeDone = () => setShaking(false);

  const onCrackDone = async () => {
    setCracking(false);
    setClicks(0);
    const eggId = activeId;
    if (!eggId) return;
    setOpening(true);
    try {
      const creature = await openEgg(eggId);
      setHatched(creature);
    } catch {
      // pas grave : l'œuf reste dans la liste, on pourra réessayer
    } finally {
      setOpening(false);
      setActiveId(null);
    }
  };

  if (hatched) {
    return (
      <section className="screen">
        <h1>Une nouvelle créature !</h1>
        <div className="hatch-result">
          <PetPreview scale={1.1} species={hatched.species} color={hatched.color} />
          <p>Elle rejoint ta collection, pour toujours.</p>
          <button className="soft-btn" onClick={() => setHatched(null)}>
            Continuer
          </button>
        </div>
      </section>
    );
  }

  const giftingFriend = friends.length > 0;

  return (
    <section className="screen screen-tab">
      <span className="screen-eyebrow">Collection</span>

      {eggs.length === 0 && <p className="hatch-empty">Rien à couver pour l'instant. Reviens lundi prochain !</p>}

      <div className="farm-grid">
        {eggs.map((e) => {
          const isActive = activeId === e.id;
          const isGifting = giftingId === e.id;
          return (
            <div key={e.id} className="farm-cell">
              <button
                className={`farm-egg${justArrived.has(e.id) ? " arrived" : ""}${isGifting ? " selected" : ""}`}
                onClick={() => tap(e.id)}
                disabled={busyHatch || giftingId !== null}
                aria-label="Ouvrir cet œuf"
              >
                <PetPreview
                  scale={0.5}
                  species="egg"
                  color=""
                  crackStage={isActive ? clicks : 0}
                  shaking={isActive && shaking}
                  cracking={isActive && cracking}
                  onShakeEnd={isActive ? onShakeDone : undefined}
                  onCrackEnd={isActive ? onCrackDone : undefined}
                />
              </button>
              <button
                className="farm-gift-btn"
                onClick={(ev) => {
                  ev.stopPropagation();
                  toggleGifting(e.id);
                }}
                disabled={busyHatch}
                aria-label="Offrir cet œuf à un ami"
                title="Offrir cet œuf à un ami"
              >
                🎁
              </button>
            </div>
          );
        })}
      </div>

      {eggs.length > 0 && !giftingId && <p className="farm-hint">Tape 3 fois sur un œuf pour l'ouvrir.</p>}

      {giftingId && (
        <>
          <div className="farm-gift-head">
            <span>Offrir cet œuf à…</span>
            <button onClick={() => toggleGifting(giftingId)} aria-label="Annuler">
              ✕
            </button>
          </div>
          <ul className="hatch-friend-list">
            {!giftingFriend && <li className="hatch-empty">Ajoute des amis pour leur offrir un œuf.</li>}
            {[...friends]
              .sort((a, b) => a.name.localeCompare(b.name, "fr"))
              .map((f) => (
                <li key={f.id} className="dir-row">
                  <div className="row-main">
                    <CreatureAvatar species={f.species} color={f.color} />
                    <span className="chat-name">{f.name}</span>
                  </div>
                  <button
                    className={`egg-btn ${giftStatus[f.id] === "sending" ? "pending" : (giftStatus[f.id] ?? "")}`}
                    disabled={!!giftStatus[f.id]}
                    onClick={() => sendGift(f.id)}
                    aria-label={`Offrir cet œuf à ${f.name}`}
                    title={
                      giftStatus[f.id] === "sent"
                        ? "Envoyé !"
                        : giftStatus[f.id] === "error"
                          ? "Échec, réessaie"
                          : `Offrir cet œuf à ${f.name}`
                    }
                  >
                    {giftStatus[f.id] === "sent" ? "✓" : giftStatus[f.id] === "error" ? "!" : "🎁"}
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
}
