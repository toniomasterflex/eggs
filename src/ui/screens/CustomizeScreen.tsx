import type { MouseEvent as ReactMouseEvent } from "react";
import PetPreview from "../../pet/PetPreview";
import { MAX_PINNED_CREATURES, activateCreature, pinCreatureByDrag, useCollection } from "../../data/profile";

// Distance (en pixels écran) à partir de laquelle un appui devient un
// glissement plutôt qu'un simple clic — même valeur que pour déplacer un pet
// déjà épinglé (App.tsx / PinnedWindow.tsx : onPress).
const DRAG_THRESHOLD = 6;

// « Ma collection » : toutes les créatures déjà écloses, en grille (3 par
// rang, 4 rangs visibles avant de devoir défiler). Le changement rapide
// d'avatar actif se fait maintenant directement dans Profil (flèches
// gauche/droite autour de l'avatar) ; ici un simple clic sur une créature
// l'adopte comme avatar actif. Pour les créatures non actives, on peut aussi
// la GLISSER hors de cette fenêtre jusque sur le bureau : elle se pose sur
// l'herbe et s'y balade toute seule, comme les pets d'amis épinglés (voir
// pinCreatureByDrag : la nouvelle fenêtre suit tout de suite la souris,
// pin_pet/drag côté Rust). Pour la ranger, un petit bouton apparaît
// au-dessus d'elle une fois posée (PinnedWindow.tsx).
export default function CustomizeScreen({ onBack }: { onBack: () => void }) {
  const { creatures, loaded, pinnedCreatures = [] } = useCollection();
  const limitReached = pinnedCreatures.length >= MAX_PINNED_CREATURES;

  const pick = (id: string, active: boolean) => {
    if (!active) activateCreature(id).catch(() => {});
  };

  // Appui sur une créature non active : si la souris s'éloigne assez avant
  // d'être relâchée, on la pose sur le bureau au lieu de l'adopter (le clic
  // normal, lui, passe par l'onClick habituel du bouton).
  const onPress = (e: ReactMouseEvent, id: string) => {
    if (e.button !== 0) return;
    const sx = e.screenX;
    const sy = e.screenY;
    const stop = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", stop);
    };
    const onMove = (m: MouseEvent) => {
      if (Math.hypot(m.screenX - sx, m.screenY - sy) < DRAG_THRESHOLD) return;
      stop();
      pinCreatureByDrag(id);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", stop);
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
              <div key={c.id} className={`collection-grid-item${c.active ? " active" : ""}`}>
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
                        : limitReached
                          ? "Maximum de créatures posées atteint"
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
