import { useEffect, useState } from "react";
import PetPreview from "../../pet/PetPreview";
import { activateCreature, useCollection } from "../../data/profile";
import { logout, useSession } from "../../data/session";
import { setPinnedOnDesktop, useSettings } from "../../data/settings";
import AccountScreen from "./AccountScreen";
import CustomizeScreen from "./CustomizeScreen";
import SettingsScreen from "./SettingsScreen";

export default function ProfileScreen() {
  const session = useSession();
  const { creatures } = useCollection();
  const { pinnedOnDesktop } = useSettings();
  const [index, setIndex] = useState(0);
  const [view, setView] = useState<"main" | "customize" | "account" | "settings">("main");

  // Se place sur la créature active dès qu'on la connaît (ou si elle change
  // ailleurs, par ex. depuis Ma collection ou une autre fenêtre d'Eggs).
  useEffect(() => {
    const activeIndex = creatures.findIndex((c) => c.active);
    if (activeIndex >= 0) setIndex(activeIndex);
  }, [creatures]);

  if (view === "customize") return <CustomizeScreen onBack={() => setView("main")} />;
  if (view === "account") return <AccountScreen onBack={() => setView("main")} />;
  if (view === "settings") return <SettingsScreen onBack={() => setView("main")} />;

  // Flèches gauche/droite autour de l'avatar : changement d'avatar actif,
  // effet immédiat (même logique qu'avant dans Ma collection).
  const go = (delta: number) => {
    if (creatures.length === 0) return;
    const next = (index + delta + creatures.length) % creatures.length;
    setIndex(next);
    const creature = creatures[next];
    if (creature && !creature.active) activateCreature(creature.id).catch(() => {});
  };

  return (
    <section className="screen">
      <span className="screen-eyebrow">Mon compte</span>
      <h1>Profil</h1>
      <div className="profile-hero">
        <div className="collection-carousel">
          <button
            className="carousel-arrow"
            onClick={() => go(-1)}
            disabled={creatures.length < 2}
            aria-label="Créature précédente"
          >
            &lsaquo;
          </button>
          <div className="avatar-wrap">
            <PetPreview />
            <button
              className={`self-pin-btn${pinnedOnDesktop ? " on" : ""}`}
              onClick={() => setPinnedOnDesktop(!pinnedOnDesktop)}
              aria-label={pinnedOnDesktop ? "Ne plus épingler sur le bureau" : "Épingler sur le bureau"}
              title={pinnedOnDesktop ? "Ne plus épingler sur le bureau" : "Épingler sur le bureau"}
            >
              <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
                <path
                  fill="currentColor"
                  fillRule="evenodd"
                  d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"
                />
              </svg>
            </button>
          </div>
          <button
            className="carousel-arrow"
            onClick={() => go(1)}
            disabled={creatures.length < 2}
            aria-label="Créature suivante"
          >
            &rsaquo;
          </button>
        </div>
        <p className="profile-name">{session?.user.username}</p>
        <div className="profile-actions">
          <button className="soft-btn" onClick={() => setView("customize")}>
            Ma collection
          </button>
          <button className="soft-btn" onClick={() => setView("settings")}>
            Réglages
          </button>
          <button className="soft-btn" onClick={() => setView("account")}>
            Mon compte
          </button>
          <button className="soft-btn" onClick={() => logout()}>
            Se déconnecter
          </button>
        </div>
      </div>
    </section>
  );
}
