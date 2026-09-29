import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import Creature from "../Creature";
import GroupAvatar from "../GroupAvatar";
import { formatCount, formatRelativeTime, isRecent, presenceLabel, presenceStatus } from "../format";
import { BookmarkIcon, LinkIcon, MoreIcon, PlusIcon, PeopleIcon, SearchIcon } from "../icons";
import {
  createChatFolder,
  deleteChatFolder,
  deleteGroupForEveryone,
  leaveGroup,
  markThreadRead,
  markThreadUnread,
  moveChatToFolder,
  openChat,
  removeFriend,
  renameChatFolder,
  togglePin,
  useChatStore,
} from "../../data/store";
import { colorRgb } from "../../data/profile";
import { useSession } from "../../data/session";
import { enterCurrentSalon, previewSalon, renameMySalon, salonJoinLink, useSalonsStore } from "../../data/salons";
import ConversationScreen from "./ConversationScreen";
import CreateGroupScreen from "./CreateGroupScreen";
import { SalonDetail } from "./SalonsScreen";
import type { ApiChatFolder } from "../../data/api";
import type { GroupMember, Species } from "../../data/types";

// Une ligne de la liste : soit un ami (avec qui il y a déjà des messages),
// soit un groupe (toujours affiché, même sans premier message — le but de le
// créer est justement de le retrouver tout de suite dans cet onglet).
type Row =
  | {
      kind: "friend";
      id: string;
      name: string;
      lastAt: number;
      species: Species;
      color: string;
      online: boolean;
      away: boolean;
    }
  | { kind: "group"; id: string; name: string; lastAt: number; members: GroupMember[]; createdBy: string };

// Une ligne de salon (le mien, ou celui d'un ami) — voir data/salons.ts.
// Système séparé des amis/groupes (pas d'espaces pour les salons, voir la
// section SALONS plus bas).
interface SalonRow {
  id: string;
  name: string;
  species: Species;
  color: string;
  present: number;
  mine: boolean;
  inCall: boolean;
}

type Filter = "tous" | "amis" | "salons" | "groupes";

const FILTERS: { id: Filter; label: string; icon: string }[] = [
  { id: "tous", label: "Tous", icon: "💬" },
  { id: "amis", label: "Amis", icon: "👤" },
  { id: "salons", label: "Salons", icon: "🏠" },
  { id: "groupes", label: "Groupes", icon: "👥" },
];

// Depuis le 29/09/2026 : les salons (le mien + ceux de mes amis, voir
// data/salons.ts) sont fusionnés ici avec les amis et les groupes — demande
// d'Antoine, qui n'aimait pas les avoir dans un onglet séparé (voir
// MainApp.tsx : l'onglet "Salons" de la barre du bas a été retiré). Un salon
// ouvert (previewSalon) affiche <SalonDetail /> à la place de la liste, même
// principe qu'une conversation ouverte (activeChat) juste en dessous.
export default function ChatsScreen() {
  const { friends, groups, unread, activeChat, chatFolders, pinned = [] } = useChatStore();
  const { mine, friends: salonFriends, current: currentSalon } = useSalonsStore();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("tous");
  // Réduire/développer chacune des 3 sections (Amis/Salons/Groupes) — même
  // esprit que le chevron des espaces (voir ChatFolderedList plus bas), mais
  // un cran au-dessus. Ajouté le 29/09/2026 à la demande d'Antoine.
  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(new Set());
  const toggleType = (id: string) => {
    setCollapsedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const session = useSession();

  // Une conversation est ouverte : on l'affiche à la place de la liste.
  if (activeChat) {
    const friend = friends.find((f) => f.id === activeChat);
    if (friend) return <ConversationScreen target={{ kind: "friend", friend }} />;
    const group = groups.find((g) => g.id === activeChat);
    if (group) return <ConversationScreen target={{ kind: "group", group }} />;
  }

  // Un salon est ouvert (aperçu ou dedans) : même logique, voir le
  // commentaire au-dessus de ce composant.
  if (currentSalon) return <SalonDetail />;

  if (creating) return <CreateGroupScreen onBack={() => setCreating(false)} />;

  // Amis : seulement ceux avec qui il y a déjà des messages (comme avant).
  // Groupes : toujours, dès la création (voir le commentaire sur Row).
  const friendRows: Row[] = friends
    .filter((f) => f.lastAt !== undefined)
    .map(
      (f): Row => ({
        kind: "friend",
        id: f.id,
        name: f.name,
        lastAt: f.lastAt!,
        species: f.species,
        color: f.color,
        online: !!f.online,
        away: !!f.away,
      }),
    );
  const groupRows: Row[] = groups.map(
    (g): Row => ({ kind: "group", id: g.id, name: g.name, lastAt: g.lastAt ?? 0, members: g.members, createdBy: g.createdBy }),
  );

  const salonRows: SalonRow[] = [
    ...(mine && session
      ? [
          {
            id: mine.id,
            name: mine.name,
            species: session.user.species as Species,
            color: session.user.color,
            present: mine.present,
            mine: true,
            inCall: mine.inCall,
          },
        ]
      : []),
    ...[...salonFriends]
      .sort((a, b) => a.owner.username.localeCompare(b.owner.username, "fr"))
      .map(
        (s): SalonRow => ({
          id: s.id,
          name: s.name,
          species: s.owner.species as Species,
          color: s.owner.color,
          present: s.present,
          mine: false,
          inCall: s.inCall,
        }),
      ),
  ];

  const q = query.trim().toLowerCase();
  const filteredFriends = q ? friendRows.filter((r) => r.name.toLowerCase().includes(q)) : friendRows;
  const filteredGroups = q ? groupRows.filter((r) => r.name.toLowerCase().includes(q)) : groupRows;
  const filteredSalons = q ? salonRows.filter((r) => r.name.toLowerCase().includes(q)) : salonRows;

  const showAmis = filter === "tous" || filter === "amis";
  const showSalons = filter === "tous" || filter === "salons";
  const showGroupes = filter === "tous" || filter === "groupes";

  const salonEmptyMessage = q
    ? "Aucun résultat."
    : !mine && salonFriends.length === 0
      ? "Ajoute des amis pour voir leurs salons ici."
      : "Aucun résultat.";

  return (
    <section className="screen screen-tab">
      <span className="screen-eyebrow">Messagerie</span>
      <div className="list-toolbar">
        <div className="search">
          <span className="search-icon">
            <SearchIcon />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un ami, un salon..."
          />
        </div>
      </div>
      <div className="filter-pills">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`filter-pill ${filter === f.id ? "active" : ""}`}
            onClick={() => setFilter(f.id)}
          >
            {f.icon} {f.label}
          </button>
        ))}
      </div>

      {/* Pas de bouton "+" ici (retour d'Antoine du 29/09/2026) : ajouter un
          ami se fait déjà depuis le Répertoire (voir DirectoryScreen.tsx),
          pas besoin de le dupliquer dans Chats. */}
      {showAmis && (
        <TypeSection
          id="amis"
          color="var(--color-blue)"
          label="Amis"
          count={filteredFriends.length}
          collapsed={collapsedTypes.has("amis")}
          onToggle={() => toggleType("amis")}
        >
          {filteredFriends.length === 0 ? (
            <p className="no-result">Aucun résultat.</p>
          ) : (
            <ChatFolderedList rows={filteredFriends} folders={chatFolders} unread={unread} pinned={pinned} />
          )}
        </TypeSection>
      )}

      {showSalons && (
        <TypeSection
          id="salons"
          color="var(--color-terracotta)"
          label="Salons"
          count={filteredSalons.length}
          collapsed={collapsedTypes.has("salons")}
          onToggle={() => toggleType("salons")}
        >
          {filteredSalons.length === 0 ? (
            <p className="no-result">{salonEmptyMessage}</p>
          ) : (
            <SalonFlatList rows={filteredSalons} />
          )}
        </TypeSection>
      )}

      {showGroupes && (
        <TypeSection
          id="groupes"
          color="var(--color-sage)"
          label="Groupes"
          count={filteredGroups.length}
          collapsed={collapsedTypes.has("groupes")}
          onToggle={() => toggleType("groupes")}
          onAdd={() => setCreating(true)}
          addTitle="Nouveau groupe"
        >
          {filteredGroups.length === 0 ? (
            <p className="no-result">Aucun résultat.</p>
          ) : (
            <ChatFolderedList rows={filteredGroups} folders={chatFolders} unread={unread} pinned={pinned} />
          )}
        </TypeSection>
      )}
    </section>
  );
}

// En-tête d'une section de type (Amis / Salons / Groupes) — nouveau design
// du 29/09/2026 (fusion des trois listes, voir le commentaire sur
// ChatsScreen ci-dessus). Le bouton "+" n'apparaît que quand une vraie
// action existe derrière (ajouter un ami, nouveau groupe) : pas de salon "à
// créer", chacun a déjà le sien (voir data/salons.ts). Réductible/dépliable
// (même esprit que le chevron des espaces, voir ChatFolderedList) : le "+"
// reste en dehors du bouton de bascule pour ne pas replier la section quand
// on veut juste ajouter quelqu'un.
// Plus d'icône devant le nom (retour d'Antoine du 29/09/2026, jugée
// superflue) : chaque section est identifiée par une couleur à la place
// (chevron + nom), voir `color` ci-dessous et .type-section-label dans
// ui.css — une teinte de la planche "chaud/naturel/froid" par section
// (Amis en bleu, Salons en terracotta, Groupes en sauge, voir les 3 appels
// de TypeSection plus haut) plutôt qu'une couleur choisie ici.
function TypeSection({
  id,
  color,
  label,
  count,
  collapsed,
  onToggle,
  onAdd,
  addTitle,
  children,
}: {
  id: string;
  color: string;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addTitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="type-section" data-section={id} style={{ "--type-color": color } as CSSProperties}>
      <div className="type-section-header">
        <button className="type-section-toggle" onClick={onToggle}>
          <span className={`folder-chevron ${collapsed ? "closed" : ""}`}>▾</span>
          <span className="type-section-label">{label}</span>
          <span className="folder-count-badge">
            <PeopleIcon />
            {formatCount(count)}
          </span>
        </button>
        {onAdd && (
          <button className="icon-btn" title={addTitle} onClick={onAdd}>
            <PlusIcon />
          </button>
        )}
      </div>
      {!collapsed && children}
    </div>
  );
}

// Liste plate des salons (le mien + ceux de mes amis) : pas d'espaces (voir
// data/salons.ts — retirés le 29/09/2026 à la demande d'Antoine). Menu ⋮ :
// copier le lien (tout le monde), renommer / accès et modération (le mien
// seulement). Plus de bouton "Rejoindre" séparé depuis le 21/09/2026 (retour
// d'Antoine : "on entre dans un salon en cliquant dessus, comme un chat") —
// cliquer la ligne fait directement previewSalon + enterCurrentSalon (voir
// joinSalon ci-dessous), pour le mien comme pour ceux de mes amis ; si un mot
// de passe est nécessaire, enterCurrentSalon échoue proprement et on atterrit
// sur l'aperçu (SalonDetail) avec son formulaire "Entrer" habituel.
function SalonFlatList({ rows }: { rows: SalonRow[] }) {
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimerRef = useRef<number | undefined>(undefined);
  const [renamingMineId, setRenamingMineId] = useState<string | null>(null);
  const [renameMineValue, setRenameMineValue] = useState("");

  useEffect(() => () => window.clearTimeout(copiedTimerRef.current), []);

  const submitRenameMine = async () => {
    const name = renameMineValue.trim();
    setRenamingMineId(null);
    if (name) await renameMySalon(name);
  };

  // "Rejoindre" : ouvre l'aperçu puis tente d'entrer directement — si un mot
  // de passe est nécessaire et qu'on n'est ni ami ni modérateur, enterCurrentSalon
  // échoue proprement (voir data/salons.ts) et on reste sur l'aperçu, avec le
  // formulaire "Entrer" habituel pour le saisir.
  const joinSalon = async (id: string) => {
    await previewSalon(id);
    await enterCurrentSalon();
  };

  return (
    <ul className="chat-list chat-list-nested">
      {rows.map((r) => (
        <li key={r.id}>
          <div className="chat-row-wrap">
            {renamingMineId === r.id ? (
              <form
                className="salon-rename-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  submitRenameMine();
                }}
              >
                <input
                  autoFocus
                  value={renameMineValue}
                  maxLength={40}
                  onChange={(e) => setRenameMineValue(e.target.value)}
                  onBlur={submitRenameMine}
                />
              </form>
            ) : (
              <>
                {/* Même ligne unique (avatar + nom/sous-titre) que Chats et
                    Groupes — retour d'Antoine du 29/09/2026 : la carte sur 2
                    lignes (avatar 40px sous le nom) rendait les salons plus
                    "gros" que le reste, même avec des tailles de police/avatar
                    identiques. L'ancienne mise en page à 2 lignes datait du
                    29/09/2026 pour éviter que le nom ne chevauche le bouton
                    "Rejoindre" — bouton supprimé depuis (on entre en cliquant
                    sur la ligne, voir joinSalon), donc plus nécessaire : le
                    nom s'ellipse comme dans Chats/Groupes (voir .chat-name). */}
                <button className="chat-row" onClick={() => joinSalon(r.id)}>
                  <span
                    className="row-avatar row-avatar-tile"
                    style={{ "--tile-rgb": colorRgb(r.color) } as CSSProperties}
                  >
                    <Creature species={r.species} color={r.color} size={34} />
                  </span>
                  <span className="chat-names">
                    <span className="chat-name">
                      {r.name} {r.mine && <span className="salon-mine-tag">(toi)</span>}
                    </span>
                    {/* Plus de "Personne pour l'instant" (retour d'Antoine du
                        21/09/2026) : quand personne n'est présent, cette ligne
                        reste simplement vide plutôt que de le dire en toutes
                        lettres. */}
                    <span className="chat-subtitle">
                      {r.present > 0 && `${r.present} présent${r.present > 1 ? "s" : ""}`}
                      {r.inCall && <span className="salon-call-tag"> · 🎙 En vocal</span>}
                    </span>
                  </span>
                  {r.present > 0 && <span className="count-badge accent">{formatCount(r.present)}</span>}
                </button>
                <div className="chat-folder-pick">
                  <button
                    className="icon-btn"
                    title="Options"
                    onClick={() => {
                      const opening = optionsFor !== r.id;
                      setOptionsFor(opening ? r.id : null);
                      window.clearTimeout(copiedTimerRef.current);
                      setCopiedId(null);
                    }}
                  >
                    <MoreIcon />
                  </button>
                  {optionsFor === r.id && (
                    <div className="row-menu">
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(salonJoinLink(r.id));
                          } catch {
                            // presse-papiers refusé : pas grave, on montre quand même le retour
                          }
                          setCopiedId(r.id);
                          window.clearTimeout(copiedTimerRef.current);
                          copiedTimerRef.current = window.setTimeout(() => {
                            setCopiedId(null);
                            setOptionsFor(null);
                          }, 1200);
                        }}
                      >
                        {copiedId === r.id ? (
                          "✓ Lien copié !"
                        ) : (
                          <>
                            <LinkIcon /> Copier le lien du salon
                          </>
                        )}
                      </button>
                      {r.mine && (
                        <button
                          onClick={() => {
                            setOptionsFor(null);
                            setRenamingMineId(r.id);
                            setRenameMineValue(r.name);
                          }}
                        >
                          ✎ Renommer mon salon
                        </button>
                      )}
                      {r.mine && (
                        <button
                          onClick={() => {
                            setOptionsFor(null);
                            previewSalon(r.id, { openAccess: true });
                          }}
                        >
                          ⚙ Accès et modération
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

// Espaces pour ranger ses discussions (amis + groupes mêlés) — système
// séparé de celui des salons (voir SalonsScreen.tsx / data/salons.ts).
// Décision produit du 27/09/2026 : un chat dans un espace au plus. Tant
// qu'aucun espace n'existe, la liste reste un simple flux comme avant
// (pas de section "Sans espace" affichée pour rien). Renommé "cercle" →
// "espace" le 27/09/2026 également, et création fusionnée dans le bouton
// "Ranger dans..." de chaque ligne : plus de bouton "+ Cercle" à part, un
// seul geste pour créer un espace et y ranger la discussion.
//
// Depuis le 29/09/2026 : appelé une fois pour les amis, une fois pour les
// groupes (voir ChatsScreen ci-dessus, sections "Amis" et "Groupes") — les
// espaces restent un système unique mêlant les deux (folders.chatIds peut
// contenir des amis ET des groupes), seule la liste de `rows` passée ici est
// filtrée par type. Un espace qui ne contient que des amis peut donc
// apparaître vide côté Groupes (et inversement) : comportement attendu, pas
// un bug — à revoir avec Antoine si ça gêne à l'usage.
function ChatFolderedList({
  rows,
  folders,
  unread,
  pinned,
}: {
  rows: Row[];
  folders: ApiChatFolder[];
  unread: Record<string, number>;
  pinned: string[];
}) {
  const session = useSession();
  const myId = session?.user.id;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [newFolderName, setNewFolderName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmTimerRef = useRef<number | undefined>(undefined);
  const [menuFor, setMenuFor] = useState<string | null>(null); // id du chat dont le menu "ranger dans" est ouvert
  const [creatingIn, setCreatingIn] = useState<string | null>(null); // id du chat pour lequel le mini-formulaire "+ Nouvel espace" est ouvert, dans ce menu
  // Menu d'options "⋮" de chaque ligne (voir le nouveau design importé le
  // 29/09/2026) : remplace l'ancien bouton 🗂 direct — "Ranger dans un
  // espace" en fait maintenant partie et rouvre le même menuFor qu'avant.
  const [optionsFor, setOptionsFor] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const confirmRemoveTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(confirmTimerRef.current), []);
  useEffect(() => () => window.clearTimeout(confirmRemoveTimerRef.current), []);

  const closeOptions = () => {
    setOptionsFor(null);
    window.clearTimeout(confirmRemoveTimerRef.current);
    setConfirmRemoveId(null);
  };

  const toggleCollapsed = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Crée l'espace et y range aussitôt cette discussion — un seul geste, voir
  // le bouton "+ Nouvel espace" dans le menu "Ranger dans...".
  const submitNewFolderFor = async (chatId: string) => {
    const name = newFolderName.trim();
    setNewFolderName("");
    setCreatingIn(null);
    if (!name) return;
    const folderId = await createChatFolder(name);
    await moveChatToFolder(chatId, folderId);
    setMenuFor(null);
  };

  const submitRename = async (folderId: string) => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (name) await renameChatFolder(folderId, name);
  };

  // Même confirmation en deux clics que pour supprimer un groupe (voir
  // ConversationScreen.tsx) : pas de fenêtre native, juste un second clic
  // dans les 3 secondes.
  const askDelete = (folderId: string) => {
    if (confirmDeleteId !== folderId) {
      setConfirmDeleteId(folderId);
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = window.setTimeout(() => setConfirmDeleteId(null), 3000);
      return;
    }
    window.clearTimeout(confirmTimerRef.current);
    setConfirmDeleteId(null);
    deleteChatFolder(folderId);
  };

  const folderOf = new Map<string, string>();
  for (const f of folders) for (const id of f.chatIds) folderOf.set(id, f.id);

  type Section = { id: string | null; name: string; rows: Row[] };
  let sections: Section[];
  if (folders.length === 0) {
    sections = [{ id: null, name: "", rows }];
  } else {
    sections = [...folders.map((f) => ({ id: f.id, name: f.name, rows: [] as Row[] })), { id: null, name: "Sans espace", rows: [] }];
    for (const r of rows) {
      const fid = folderOf.get(r.id) ?? null;
      (sections.find((s) => s.id === fid) ?? sections[sections.length - 1]).rows.push(r);
    }
  }

  return (
    <>
      <ul className="chat-list">
        {sections.map((s) => (
          <li key={s.id ?? "unfiled"} className="folder-section">
            {s.id !== null && (
              <div className="folder-header">
                {renamingId === s.id ? (
                  <form
                    className="folder-rename-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      submitRename(s.id!);
                    }}
                  >
                    <input
                      autoFocus
                      value={renameValue}
                      maxLength={30}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => submitRename(s.id!)}
                    />
                  </form>
                ) : (
                  <button className="folder-header-btn" onClick={() => toggleCollapsed(s.id!)}>
                    <span className={`folder-chevron ${collapsed.has(s.id) ? "closed" : ""}`}>▾</span>
                    <span className="folder-name">{s.name}</span>
                    <span className="folder-count-badge">
                      <PeopleIcon />
                      {formatCount(s.rows.length)}
                    </span>
                  </button>
                )}
                {renamingId !== s.id && (
                  <span className="folder-actions">
                    <button
                      className="icon-btn"
                      title="Renommer"
                      onClick={() => {
                        setRenamingId(s.id);
                        setRenameValue(s.name);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className={`icon-btn delete ${confirmDeleteId === s.id ? "confirm" : ""}`}
                      title={confirmDeleteId === s.id ? "Cliquer à nouveau pour confirmer" : "Supprimer l'espace"}
                      onClick={() => askDelete(s.id!)}
                    >
                      ✕
                    </button>
                  </span>
                )}
              </div>
            )}
            {(s.id === null || !collapsed.has(s.id)) && (
              <>
                {s.id !== null && s.rows.length === 0 && <p className="folder-empty">Espace vide.</p>}
                <ul className="chat-list chat-list-nested">
                  {s.rows.map((r) => (
                    <li key={r.id}>
                      <div className="chat-row-wrap">
                        <button className="chat-row" onClick={() => openChat(r.id)}>
                          <span
                            className="row-avatar row-avatar-tile"
                            style={{ "--tile-rgb": colorRgb(r.kind === "friend" ? r.color : r.members[0]?.color ?? "sun") } as CSSProperties}
                          >
                            {r.kind === "friend" ? (
                              <Creature species={r.species} color={r.color} size={34} />
                            ) : (
                              <GroupAvatar members={r.members} size={34} />
                            )}
                            {r.kind === "friend" && (
                              <span className={`row-status-dot ${presenceStatus(r.online, r.away)}`} />
                            )}
                          </span>
                          <span className="chat-names">
                            <span className="chat-name">{r.name}</span>
                            <span className="chat-subtitle">
                              {r.kind === "friend" && r.lastAt > 0 && !isRecent(r.lastAt) ? (
                                <span className={`status-tag ${presenceStatus(r.online, r.away)}`}>
                                  <span className="status-dot" />
                                  {presenceLabel(presenceStatus(r.online, r.away))}
                                </span>
                              ) : r.lastAt > 0 ? (
                                formatRelativeTime(r.lastAt)
                              ) : r.kind === "group" ? (
                                "Nouveau groupe"
                              ) : (
                                ""
                              )}
                            </span>
                          </span>
                          {(unread[r.id] ?? 0) > 0 && (
                            <span className="count-badge accent">{formatCount(unread[r.id])}</span>
                          )}
                        </button>
                        <div className="chat-folder-pick">
                          <button
                            className="icon-btn"
                            title="Options"
                            onClick={() => {
                              const opening = optionsFor !== r.id;
                              setOptionsFor(opening ? r.id : null);
                              setMenuFor(null);
                              setCreatingIn(null);
                              setNewFolderName("");
                              window.clearTimeout(confirmRemoveTimerRef.current);
                              setConfirmRemoveId(null);
                            }}
                          >
                            <MoreIcon />
                          </button>
                          {optionsFor === r.id && (
                            <div className="row-menu">
                              <button
                                onClick={() => {
                                  setOptionsFor(null);
                                  setMenuFor(r.id);
                                }}
                              >
                                🗂 Ranger dans un espace
                              </button>
                              {r.kind === "friend" && (
                                <button
                                  onClick={() => {
                                    togglePin(r.id);
                                    closeOptions();
                                  }}
                                >
                                  <BookmarkIcon filled={pinned.includes(r.id)} />
                                  {pinned.includes(r.id) ? "Détacher du bureau" : "Épingler sur le bureau"}
                                </button>
                              )}
                              <button
                                onClick={() => {
                                  if ((unread[r.id] ?? 0) > 0) markThreadRead(r.id);
                                  else markThreadUnread(r.id);
                                  closeOptions();
                                }}
                              >
                                {(unread[r.id] ?? 0) > 0 ? "✓ Marquer comme lu" : "● Marquer comme non lu"}
                              </button>
                              <div className="chat-folder-menu-sep" />
                              <button
                                className={`danger ${confirmRemoveId === r.id ? "confirm" : ""}`}
                                onClick={() => {
                                  if (confirmRemoveId !== r.id) {
                                    setConfirmRemoveId(r.id);
                                    window.clearTimeout(confirmRemoveTimerRef.current);
                                    confirmRemoveTimerRef.current = window.setTimeout(() => setConfirmRemoveId(null), 3000);
                                    return;
                                  }
                                  window.clearTimeout(confirmRemoveTimerRef.current);
                                  if (r.kind === "friend") removeFriend(r.id);
                                  else if (r.createdBy === myId) deleteGroupForEveryone(r.id);
                                  else leaveGroup(r.id);
                                  closeOptions();
                                }}
                              >
                                {confirmRemoveId === r.id
                                  ? "Sûr ? Cliquer à nouveau"
                                  : r.kind === "friend"
                                    ? "Retirer cet ami"
                                    : r.createdBy === myId
                                      ? "Supprimer le groupe"
                                      : "Quitter le groupe"}
                              </button>
                            </div>
                          )}
                          {menuFor === r.id && (
                            <div className="chat-folder-menu">
                              {folders.length > 0 && (
                                <>
                                  <button
                                    className={folderOf.get(r.id) === undefined ? "active" : ""}
                                    onClick={() => {
                                      moveChatToFolder(r.id, null);
                                      setMenuFor(null);
                                    }}
                                  >
                                    Sans espace
                                  </button>
                                  {folders.map((f) => (
                                    <button
                                      key={f.id}
                                      className={folderOf.get(r.id) === f.id ? "active" : ""}
                                      onClick={() => {
                                        moveChatToFolder(r.id, f.id);
                                        setMenuFor(null);
                                      }}
                                    >
                                      {f.name}
                                    </button>
                                  ))}
                                  <div className="chat-folder-menu-sep" />
                                </>
                              )}
                              {creatingIn === r.id ? (
                                <form
                                  className="folder-new-form"
                                  onSubmit={(e) => {
                                    e.preventDefault();
                                    submitNewFolderFor(r.id);
                                  }}
                                >
                                  <input
                                    autoFocus
                                    value={newFolderName}
                                    onChange={(e) => setNewFolderName(e.target.value)}
                                    onBlur={() => {
                                      if (!newFolderName.trim()) setCreatingIn(null);
                                    }}
                                    placeholder="Nom de l'espace"
                                    maxLength={30}
                                  />
                                  <button type="submit" className="soft-btn">
                                    Créer
                                  </button>
                                </form>
                              ) : (
                                <button className="add" onClick={() => setCreatingIn(r.id)}>
                                  + Nouvel espace
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
