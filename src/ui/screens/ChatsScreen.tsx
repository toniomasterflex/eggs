import Creature from "../Creature";
import { openChat, useChatStore } from "../../data/store";
import ConversationScreen from "./ConversationScreen";

export default function ChatsScreen() {
  const { friends, unread, activeChat } = useChatStore();

  // Une conversation est ouverte : on l'affiche à la place de la liste.
  if (activeChat) {
    const friend = friends.find((f) => f.id === activeChat);
    if (friend) return <ConversationScreen friend={friend} />;
  }

  // Seulement les amis avec qui il y a déjà des messages, le plus récent en haut.
  const chats = friends
    .filter((f) => f.lastAt !== undefined)
    .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));

  return (
    <section className="screen">
      <span className="screen-eyebrow">Messagerie</span>
      <h1>Chats</h1>
      <ul className="chat-list">
        {chats.map((f) => (
          <li key={f.id}>
            <button className="chat-row" onClick={() => openChat(f.id)}>
              <Creature species={f.species} color={f.color} />
              <span className="chat-name">{f.name}</span>
              {(unread[f.id] ?? 0) > 0 && <span className="unread-dot" />}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}