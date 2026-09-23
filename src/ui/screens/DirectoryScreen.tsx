import { useRef, useState } from "react";
import Creature from "../Creature";
import { MAX_PINNED, removeFriend, togglePin, useChatStore } from "../../data/store";
import AddFriendScreen from "./AddFriendScreen";

export default function DirectoryScreen({
  onOpenChat,
}: {
  onOpenChat: (friendId: string) => void;
}) {
  const { friends, pinned = [] } = useChatStore();
  const [adding, setAdding] = useState(false);
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
    removeFriend(id).catch(() => {});
  };

  const sorted = [...friends].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  const limitReached = pinned.length >= MAX_PINNED;

  return (
    <section className="screen">
      <span className="screen-eyebrow">Amis</span>
      <h1>Répertoire</h1>
      <ul className="chat-list">
        {sorted.map((f) => {
          const isPinned = pinned.includes(f.id);
          return (
            <li key={f.id}>
              <div className="dir-row">
                <button className="row-main" onClick={() => onOpenChat(f.id)}>
                  <Creature species={f.species} color={f.color} />
                  <span className="chat-name">{f.name}</span>
                </button>
                <button
                  className={`pin-btn ${isPinned ? "on" : ""}`}
                  disabled={!isPinned && limitReached}
                  onClick={() => togglePin(f.id)}
                  aria-label={isPinned ? "Détacher du bureau" : "Épingler sur le bureau"}
                  title={isPinned ? "Détacher du bureau" : "Épingler sur le bureau"}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                    <path
                      fill="currentColor"
                      fillRule="evenodd"
                      d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"
                    />
                  </svg>
                </button>
                <button
                  className={`remove-btn ${confirmId === f.id ? "confirm" : ""}`}
                  onClick={() => (confirmId === f.id ? doRemove(f.id) : askRemove(f.id))}
                  aria-label={confirmId === f.id ? `Confirmer : retirer ${f.name}` : `Retirer ${f.name}`}
                  title={confirmId === f.id ? "Confirmer" : "Retirer cet ami"}
                >
                  {confirmId === f.id ? "✓" : "✕"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button className="add-btn" onClick={() => setAdding(true)}>
        + Ajouter un ami
      </button>
    </section>
  );
}