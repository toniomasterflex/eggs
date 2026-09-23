import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import Creature from "../Creature";
import { useSession } from "../../data/session";
import {
  blockUser,
  closeSalon,
  enterCurrentSalon,
  leaveCurrentSalon,
  previewSalon,
  renameMySalon,
  sendSalonMessage,
  unblockUser,
  useSalonsStore,
} from "../../data/salons";
import type { ApiSalonDetail } from "../../data/api";
import type { Species } from "../../data/types";

export default function SalonsScreen() {
  const { mine, friends, current } = useSalonsStore();
  const session = useSession();

  if (current) return <SalonDetail />;

  const sorted = [...friends].sort((a, b) => a.owner.username.localeCompare(b.owner.username, "fr"));

  return (
    <section className="screen">
      <span className="screen-eyebrow">En direct</span>
      <h1>Salons</h1>
      <ul className="chat-list">
        {mine && session && (
          <li>
            <button className="chat-row" onClick={() => previewSalon(mine.id)}>
              <Creature species={session.user.species as Species} color={session.user.color} />
              <span className="chat-name">
                {mine.name} <span className="salon-mine-tag">(toi)</span>
              </span>
              {mine.present > 0 && <span className="salon-count">{mine.present}</span>}
            </button>
          </li>
        )}
        {sorted.map((s) => (
          <li key={s.id}>
            <button className="chat-row" onClick={() => previewSalon(s.id)}>
              <Creature species={s.owner.species as Species} color={s.owner.color} />
              <span className="chat-name">{s.name}</span>
              {s.present > 0 && <span className="salon-count">{s.present}</span>}
            </button>
          </li>
        ))}
      </ul>
      {!mine && friends.length === 0 && (
        <p className="salon-empty">Ajoute des amis pour voir leurs salons ici.</p>
      )}
    </section>
  );
}

function SalonDetail() {
  const { current, inside, blocks, error, messages } = useSalonsStore();
  const session = useSession();
  const myId = session?.user.id;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const salon = current as ApiSalonDetail;
  const isMine = salon.id === myId;

  useEffect(() => {
    setRenaming(false);
    setName(salon.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salon.id]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submitRename = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || clean === salon.name) {
      setRenaming(false);
      return;
    }
    if (await renameMySalon(clean)) setRenaming(false);
  };

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    sendSalonMessage(text);
    setText("");
  };

  return (
    <section className="conversation">
      <header className="conv-header">
        <button className="back" onClick={closeSalon} aria-label="Retour">
          &lsaquo;
        </button>
        <Creature species={salon.owner.species as Species} color={salon.owner.color} size={20} />
        {renaming ? (
          <form className="salon-rename" onSubmit={submitRename}>
            <input
              autoFocus
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              onBlur={submitRename}
            />
          </form>
        ) : (
          <span className="conv-name">
            {salon.name}
            {isMine && (
              <button className="salon-rename-btn" onClick={() => setRenaming(true)} title="Renommer mon salon">
                ✎
              </button>
            )}
          </span>
        )}
      </header>

      <div className="salon-presence">
        {salon.present.length === 0 ? (
          <span className="salon-presence-empty">Personne pour l'instant.</span>
        ) : (
          salon.present.map((u) => (
            <span key={u.id} className="salon-chip">
              <Creature species={u.species as Species} color={u.color} size={18} />
              <span className="salon-chip-name">
                {u.username}
                {u.id === myId ? " (toi)" : ""}
              </span>
              {isMine && u.id !== myId && (
                <button className="salon-chip-block" onClick={() => blockUser(u.id)} title="Bloquer de mon salon">
                  ✕
                </button>
              )}
            </span>
          ))
        )}
      </div>

      {error && <p className="auth-error salon-error">{error}</p>}

      {!inside ? (
        <div className="salon-enter">
          <p className="account-line">Entre pour voir la discussion en direct et y participer.</p>
          <button className="soft-btn" onClick={enterCurrentSalon}>
            Entrer
          </button>
        </div>
      ) : (
        <>
          <div className="messages" ref={scrollRef}>
            {messages.length === 0 && (
              <p className="salon-chat-empty">
                {isMine ? "Personne n'a encore rien dit. À toi de lancer la discussion !" : "Personne n'a encore rien dit."}
              </p>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`bubble ${m.from.id === myId ? "mine" : "theirs"}`}>
                {m.from.id !== myId && <span className="salon-bubble-author">{m.from.username}</span>}
                {m.text}
              </div>
            ))}
          </div>
          <form className="composer" onSubmit={send}>
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Écrire dans le salon..."
            />
            <button type="submit" aria-label="Envoyer">
              &uarr;
            </button>
          </form>
          <button className="salon-leave-btn" onClick={leaveCurrentSalon}>
            Sortir du salon
          </button>
        </>
      )}

      {isMine && blocks.length > 0 && (
        <div className="salon-blocks">
          <p className="account-line">Bloqués de mon salon :</p>
          <div className="account-list">
            {blocks.map((u) => (
              <button key={u.id} className="account-btn" onClick={() => unblockUser(u.id)}>
                Débloquer {u.username}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
