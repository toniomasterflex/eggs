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
import SalonsScreen from "./screens/SalonsScreen";
import ShopScreen from "./screens/ShopScreen";
import "./ui.css";

type Tab = "chats" | "directory" | "salons" | "eggs" | "shop" | "profile";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "chats", label: "Chats", icon: "💬" },
  { id: "directory", label: "Répertoire", icon: "👥" },
  { id: "salons", label: "Salons", icon: "🏠" },
  { id: "eggs", label: "Œufs", icon: "🥚" },
  { id: "shop", label: "Shop", icon: "🛒" },
  { id: "profile", label: "Profil", icon: "🐣" },
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

  // Dans une conversation (ou dans la vue d'un salon), on cache la barre
  // d'onglets pour gagner de la place.
  const inConversation =
    (tab === "chats" && activeChat !== null) || (tab === "salons" && currentSalon !== null);

  return (
    <div className="eggs-ui">
      {!connected && <div className="conn-banner">Connexion au serveur interrompue…</div>}
      <main className="content">
        {tab === "chats" && <ChatsScreen />}
        {tab === "directory" && <DirectoryScreen onOpenChat={openChat} />}
        {tab === "salons" && <SalonsScreen />}
        {tab === "eggs" && <HatchScreen />}
        {tab === "shop" && <ShopScreen />}
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
                {t.icon}
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