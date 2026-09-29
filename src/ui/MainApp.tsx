import { useEffect, useState } from "react";
import { openChat, useChatStore } from "../data/store";
import { pendingCount, useCollection } from "../data/profile";
import { useSalonsStore } from "../data/salons";
import { useSession } from "../data/session";
import ChatsScreen from "./screens/ChatsScreen";
import DirectoryScreen from "./screens/DirectoryScreen";
import HatchScreen from "./screens/HatchScreen";
import LoginScreen from "./screens/LoginScreen";
import ProfileScreen from "./screens/ProfileScreen";
import iconChats from "../assets/brand/tabs/tab-chats.png";
import iconDirectory from "../assets/brand/tabs/tab-directory.png";
import iconEggs from "../assets/brand/tabs/tab-eggs.png";
import iconProfile from "../assets/brand/tabs/tab-profile.png";
import "./ui.css";

// Le Shop n'est plus un onglet séparé : il vit dans le Profil, juste sous la
// collection (voir ProfileScreen.tsx) — demande du 26/09/2026, pour
// simplifier la barre du bas. Idem pour Salons depuis le 29/09/2026 : plus
// d'onglet séparé, les salons sont fusionnés dans l'onglet Chats (voir
// ChatsScreen.tsx) — demande d'Antoine, qui n'aimait pas les avoir dans une
// fenêtre à part.
type Tab = "chats" | "directory" | "eggs" | "profile";

// Icônes façon "verre sombre" fournies par Antoine le 29/09/2026 (à la place
// des emojis d'origine), recadrées individuellement en PNG transparent
// (voir src/assets/brand/tabs/) — le fond noir de la planche devient
// transparent tout seul (fond quasi noir → alpha quasi nul), donc l'icône
// s'intègre aussi bien sur fond sombre que sur le thème clair.
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "chats", label: "Chats", icon: iconChats },
  { id: "directory", label: "Répertoire", icon: iconDirectory },
  { id: "eggs", label: "Œufs", icon: iconEggs },
  { id: "profile", label: "Profil", icon: iconProfile },
];

export default function MainApp() {
  const [tab, setTab] = useState<Tab>("chats");
  const { activeChat, connected } = useChatStore();
  const { current: currentSalon } = useSalonsStore();
  const session = useSession();
  const collection = useCollection();
  const pending = pendingCount(collection);

  // Dès qu'une conversation s'ouvre (depuis un pet épinglé, par exemple),
  // on affiche l'onglet Chats.
  useEffect(() => {
    if (activeChat) setTab("chats");
  }, [activeChat]);

  // Idem pour un salon ouvert via un lien eggs://salon/<id> (voir App.tsx) :
  // previewSalon() remplit currentSalon, on doit alors afficher l'onglet
  // Chats pour que l'utilisateur voie tout de suite le salon visé (les
  // salons vivent dans cet onglet depuis le 29/09/2026, voir ChatsScreen.tsx).
  useEffect(() => {
    if (currentSalon) setTab("chats");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSalon?.id]);

  // Pas connecté : écran de connexion.
  if (!session) {
    return (
      <div className="eggs-ui">
        <main className="content">
          <LoginScreen />
        </main>
      </div>
    );
  }

  // Dans une conversation (ou dans la vue d'un salon, désormais dans le même
  // onglet Chats), on cache la barre d'onglets pour gagner de la place.
  const inConversation = tab === "chats" && (activeChat !== null || currentSalon !== null);

  return (
    <div className="eggs-ui">
      {!connected && <div className="conn-banner">Connexion au serveur interrompue…</div>}
      <main className="content">
        {tab === "chats" && <ChatsScreen />}
        {tab === "directory" && <DirectoryScreen onOpenChat={openChat} />}
        {tab === "eggs" && <HatchScreen />}
        {tab === "profile" && <ProfileScreen />}
      </main>

      {!inConversation && (
        <nav className="tabbar">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              <span className="icon">
                <img src={t.icon} alt="" className="tab-icon-img" />
                {t.id === "eggs" && pending > 0 && <span className="tab-badge" />}
              </span>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}