import { Fragment, useEffect, useRef, useState } from "react";
import Creature from "../Creature";
import { closeChat, sendMessage, useChatStore } from "../../data/store";
import type { Friend } from "../../data/types";

// Sous quelle forme afficher l'heure d'un message.
function clockOf(ts: number) {
  return new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
function dividerOf(ts: number) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) return clockOf(ts);
  return `${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${clockOf(ts)}`;
}
// Un nouveau repère de date/heure au-dessus du premier message, puis dès
// qu'il s'écoule plus de 30 minutes entre deux messages.
const DIVIDER_GAP_MS = 30 * 60 * 1000;

export default function ConversationScreen({ friend }: { friend: Friend }) {
  const { messages } = useChatStore();
  const list = messages[friend.id] ?? [];
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Mon dernier message a-t-il été lu ?
  let lastMine: (typeof list)[number] | undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].mine) {
      lastMine = list[i];
      break;
    }
  }
  const seen = !!lastMine && friend.readAt !== undefined && lastMine.time <= friend.readAt;

  // Descend automatiquement sur le dernier message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [list.length]);

  const send = () => {
    const sent = text;
    if (!sent.trim()) return;
    setText("");
    // Si l'envoi échoue, on remet le texte pour ne rien perdre.
    sendMessage(friend.id, sent).then((ok) => {
      if (!ok) setText((current) => current || sent);
    });
  };

  return (
    <section className="conversation">
      <header className="conv-header">
        <button className="back" onClick={closeChat} aria-label="Retour">
          &lsaquo;
        </button>
        <Creature species={friend.species} color={friend.color} size={20} />
        <span className="conv-name">
          {friend.name}
          <span
            className={`presence-dot ${friend.online ? "on" : ""}`}
            title={friend.online ? "En ligne" : "Hors ligne"}
          />
        </span>
      </header>

      <div className="messages" ref={scrollRef}>
        {list.map((m, i) => {
          const prev = list[i - 1];
          const showDivider = !prev || m.time - prev.time > DIVIDER_GAP_MS;
          return (
            <Fragment key={m.id}>
              {showDivider && <div className="time-divider">{dividerOf(m.time)}</div>}
              <div className={`bubble ${m.mine ? "mine" : "theirs"}`}>{m.text}</div>
            </Fragment>
          );
        })}
        {seen && <div className="seen-mark">Vu</div>}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Écrire un message..."
        />
        <button type="submit" aria-label="Envoyer">
          &uarr;
        </button>
      </form>
    </section>
  );
}