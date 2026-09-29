import { useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import PetPreview from "../../pet/PetPreview";
import { activateCreature, pinCreatureByDrag, useCollection } from "../../data/profile";

// Distance (en pixels écran) à partir de laquelle un appui devient un
// glissement plutôt qu'un simple clic.
const DRAG_THRESHOLD = 6;

// « Ma collection » : toutes les créatures déjà écloses, en grille (3 par
// rang, 4 rangs visibles avant de devoir défiler). Le changement rapide
// d'avatar actif se fait maintenant directement dans Profil (flèches
// gauche/droite autour de l'avatar) ; ici un simple clic sur une créature
// l'adopte comme avatar actif. Pour les créatures non actives, on peut aussi
// la GLISSER hors de cette fenêtre jusque sur le bureau : elle se pose sur
// l'herbe et s'y balade toute seule, comme les pets d'amis épinglés (voir
// pinCreatureByDrag). Pour la ranger, un petit bouton apparaît au-dessus
// d'elle une fois posée (pet/GroundPet.tsx).
//
// Jusqu'au 29/09/2026, franchir le seuil de glissement posait la créature
// TOUT DE SUITE (elle avait alors sa propre fenêtre Windows, dont le
// glissement natif prenait le relais de la souris pour de vrai — voir
// l'historique de pin_pet côté Rust). Depuis la fenêtre partagée "pets", il
// n'y a plus de fenêtre à faire apparaître sous le curseur : la créature se
// pose désormais au RELÂCHEMENT de la souris (toujours après avoir franchi
// le même seuil, pour ne pas confondre avec un simple clic), directement à
// une position mémorisée ou espacée par défaut, comme un ami épinglé.
export default function CustomizeScreen({ onBack }: { onBack: () => void }) {
  const { creatures, loaded, pinnedCreatures = [] } = useCollection();
  // Créature actuellement glissée (voir onPress) : juste un retour visuel
  // (la carte s'estompe) pendant le geste, rien de plus.
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const pick = (id: string, active: boolean) => {
    if (!active) activateCreature(id).catch(() => {});
  };

  const onPress = (e: ReactMouseEvent, id: string) => {
    if (e.button !== 0) return;
    const sx = e.screenX;
    const sy = e.screenY;
    let dragging = false;
    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    const onMove = (m: MouseEvent) => {
      if (dragging || Math.hypot(m.screenX - sx, m.screenY - sy) < DRAG_THRESHOLD) return;
      dragging = true;
      setDraggingId(id);
    };
    const onUp = () => {
      stop();
      setDraggingId(null);
      if (dragging) pinCreatureByDrag(id);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <section className="conversation">
      <header className="conv-header">
        <button className="back" onClick={onBack} aria-label="Retour">
          &lsaquo;
        </button>
        <span className="conv-name">Ma collection</span>
      </header>

      {creatures.length === 0 ? (
        <div className="collection-empty">
          <PetPreview scale={0.75} species="egg" color="" />
          <p>
            {loaded
              ? "Pas encore de créature : ouvre un œuf depuis l'onglet Œufs pour la découvrir."
              : "Chargement…"}
          </p>
        </div>
      ) : (
        <div className="collection-grid">
          {creatures.map((c) => {
            const isPinned = pinnedCreatures.includes(c.id);
            return (
              <div
                key={c.id}
                className={`collection-grid-item${c.active ? " active" : ""}${draggingId === c.id ? " dragging" : ""}`}
              >
                <button
                  className="collection-pick"
                  onMouseDown={(e) => !c.active && onPress(e, c.id)}
                  onClick={() => pick(c.id, c.active)}
                  aria-label={c.active ? "Créature active" : "Adopter comme avatar (ou glisser sur le bureau)"}
                  title={
                    c.active
                      ? "Créature active"
                      : isPinned
                        ? "Déjà posée sur l'herbe"
                        : "Cliquer pour adopter, ou glisser hors de la fenêtre pour la poser sur l'herbe"
                  }
                >
                  <PetPreview scale={0.42} species={c.species} color={c.color} />
                </button>
                {isPinned && <span className="collection-pinned-dot" aria-hidden="true" title="Sur l'herbe" />}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
