import type { CSSProperties } from "react";
import { useRef, useState } from "react";
import Creature from "../Creature";
import { formatRelativeTime, isRecent, presenceLabel, presenceStatus } from "../format";
import { BookmarkIcon, MoreIcon, PlusIcon, SearchIcon, SortIcon, StarIcon } from "../icons";
import { colorRgb } from "../../data/profile";
import { removeFriend, toggleFavorite, togglePin, useChatStore } from "../../data/store";
import type { Friend } from "../../data/types";
import AddFriendScreen from "./AddFriendScreen";

// Nouveau design du 29/09/2026, inspiré d'une maquette d'Antoine (grandes
// tuiles, onglets Tous/Favoris, tri, bouton favori) — voir les décisions
// prises avec lui avant de coder :
//  - reste amis uniquement (pas les groupes, contrairement à l'onglet Chats) ;
//  - garde l'avatar créature actuel, juste dans une tuile plus grande ;
//  - "Favoris" est un marque-page indépendant d'"Épingler sur le bureau"
//    (voir data/store.ts : toggleFavorite/favorites, séparé de pinned) ;
//  - le tri (icône ↕) bascule juste alphabétique ⇄ activité récente.
// Ligne + menu "⋮" repris du même habillage que Chats/Salons (voir
// ChatsScreen.tsx) pour rester cohérent dans toute l'app.
type SortMode = "alpha" | "recent";
type Tab = "tous" | "favoris";

// Même logique que ChatsScreen.tsx pour le statut sous le nom : au-delà
// d'hier, une date devient vite obsolète, on affiche le statut (en ligne /
// hors ligne) à la place ; pour aujourd'hui/hier, l'horodatage est plus
// parlant qu'un simple point de couleur.
function StatusLine({ friend }: { friend: Friend }) {
  const status = presenceStatus(friend.online, friend.away);
  if (friend.lastAt && friend.lastAt > 0 && !isRecent(friend.lastAt)) {
    return (
      <span className={`status-tag ${status}`}>
        <span className="status-dot" />
        {presenceLabel(status)}
      </span>
    );
  }
  if (friend.lastAt && friend.lastAt > 0) {
    return <span className="dir-recent">{formatRelativeTime(friend.lastAt)}</span>;
  }
  return (
    <span className={`status-tag ${status}`}>
      <span className="status-dot" />
      {presenceLabel(status)}
    </span>
  );
}

export default function DirectoryScreen({
  onOpenChat,
}: {
  onOpenChat: (friendId: string) => void;
}) {
  const { friends, pinned = [], favorites = [] } = useChatStore();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("tous");
  const [sort, setSort] = useState<SortMode>("alpha");
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  // Retirer un ami demande une confirmation : un premier clic propose, le
  // second (dans les 3 secondes) confirme.
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const confirmTimer = useRef<number | undefined>(undefined);

  if (adding) return <AddFriendScreen onBack={() => setAdding(false)} />;

  const askRemove = (id: string) => {
    setConfirmId(id);
    window.clearTimeout(confirmTimer.current);
    confirmTimer.current = window.setTimeout(() => setConfirmId(null), 3000);
  };
  const doRemove = (id: string) => {
    window.clearTimeout(confirmTimer.current);
    setConfirmId(null);
    setOptionsFor(null);
    removeFriend(id).catch(() => {});
  };

  const base = tab === "favoris" ? friends.filter((f) => favorites.includes(f.id)) : friends;
  const sorted = [...base].sort((a, b) => {
    if (sort === "alpha") return a.name.localeCompare(b.name, "fr");
    if (!!a.online !== !!b.online) return a.online ? -1 : 1;
    return (b.lastAt ?? 0) - (a.lastAt ?? 0);
  });
  const q = query.trim().toLowerCase();
  const filtered = q
    ? sorted.filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          f.discord?.toLowerCase().includes(q) ||
          f.steam?.toLowerCase().includes(q),
      )
    : sorted;

  const emptyMessage = q
    ? "Aucun résultat."
    : tab === "favoris"
      ? "Pas encore de favori — l'étoile sur une ligne l'ajoute ici."
      : "Ajoute des amis pour les retrouver ici.";

  return (
    <section className="screen screen-tab">
      <span className="screen-eyebrow">Amis</span>
      <div className="list-toolbar">
        <div className="search">
          <span className="search-icon">
            <SearchIcon />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un ami..."
          />
        </div>
        <button
          className="icon-btn"
          title={sort === "alpha" ? "Trier par activité récente" : "Trier par ordre alphabétique"}
          onClick={() => setSort((s) => (s === "alpha" ? "recent" : "alpha"))}
        >
          <SortIcon />
        </button>
        <button className="list-add-btn" onClick={() => setAdding(true)} aria-label="Ajouter un ami" title="Ajouter un ami">
          <PlusIcon />
        </button>
      </div>
      <div className="segmented-tabs">
        <button className={`segmented-tab ${tab === "tous" ? "active" : ""}`} onClick={() => setTab("tous")}>
          Tous
        </button>
        <button className={`segmented-tab ${tab === "favoris" ? "active" : ""}`} onClick={() => setTab("favoris")}>
          <StarIcon size={11} filled={tab === "favoris"} /> Favoris
        </button>
      </div>
      {filtered.length === 0 ? (
        <p className="no-result">{emptyMessage}</p>
      ) : (
        <ul className="chat-list chat-list-nested">
          {filtered.map((f) => {
            const isFav = favorites.includes(f.id);
            const isPinned = pinned.includes(f.id);
            return (
              <li key={f.id}>
                <div className="chat-row-wrap">
                  <button className="chat-row" onClick={() => onOpenChat(f.id)}>
                    <span
                      className="row-avatar row-avatar-tile dir-avatar-tile"
                      style={{ "--tile-rgb": colorRgb(f.color) } as CSSProperties}
                    >
                      {/* Taille alignée sur ChatsScreen.tsx (34 dans un conteneur de
                          40px) — retour d'Antoine du 29/09/2026 : les grandes tuiles
                          d'origine (52px, Creature à 44) donnaient l'impression que
                          tout le Répertoire était moins "dézoomé" que le reste de
                          l'appli, voir le commentaire dans ui.css (.dir-avatar-tile). */}
                      <Creature species={f.species} color={f.color} size={34} />
                      <span className={`row-status-dot ${presenceStatus(f.online, f.away)}`} />
                    </span>
                    <span className="chat-names">
                      <span className="chat-name">{f.name}</span>
                      <span className="chat-subtitle">
                        <StatusLine friend={f} />
                      </span>
                      {(f.discord || f.steam) && (
                        <span className="dir-links">
                          {f.discord && <span className="dir-link">Discord : {f.discord}</span>}
                          {f.steam && <span className="dir-link">Steam : {f.steam}</span>}
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    className={`fav-btn ${isFav ? "on" : ""}`}
                    onClick={() => toggleFavorite(f.id)}
                    aria-label={isFav ? "Retirer des favoris" : "Ajouter aux favoris"}
                    title={isFav ? "Retirer des favoris" : "Ajouter aux favoris"}
                  >
                    <StarIcon filled={isFav} />
                  </button>
                  <div className="chat-folder-pick">
                    <button
                      className="icon-btn"
                      title="Options"
                      onClick={() => setOptionsFor(optionsFor === f.id ? null : f.id)}
                    >
                      <MoreIcon />
                    </button>
                    {optionsFor === f.id && (
                      <div className="row-menu">
                        <button
                          onClick={() => {
                            togglePin(f.id);
                            setOptionsFor(null);
                          }}
                        >
                          <BookmarkIcon filled={isPinned} />
                          {isPinned ? "Détacher du bureau" : "Épingler sur le bureau"}
                        </button>
                        <div className="chat-folder-menu-sep" />
                        <button
                          className={`danger ${confirmId === f.id ? "confirm" : ""}`}
                          onClick={() => (confirmId === f.id ? doRemove(f.id) : askRemove(f.id))}
                        >
                          {confirmId === f.id ? "Sûr ? Cliquer à nouveau" : "Retirer cet ami"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
