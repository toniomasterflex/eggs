import { useEffect, useState } from "react";
import Creature from "../Creature";
import { addFriend, searchUsers } from "../../data/store";
import type { Friend } from "../../data/types";

interface Result {
  user: Friend;
  added: boolean;
}

export default function AddFriendScreen({ onBack }: { onBack: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [searched, setSearched] = useState(false);

  // Recherche sur le serveur, un peu après la dernière lettre tapée.
  useEffect(() => {
    let cancelled = false;
    if (!query.trim()) {
      setResults([]);
      setSearched(false);
      return;
    }
    const timer = window.setTimeout(() => {
      searchUsers(query)
        .then((r) => {
          if (cancelled) return;
          setResults(r);
          setSearched(true);
        })
        .catch(() => {
          if (!cancelled) {
            setResults([]);
            setSearched(true);
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const add = async (user: Friend) => {
    try {
      await addFriend(user);
      setResults((list) => list.map((r) => (r.user.id === user.id ? { ...r, added: true } : r)));
    } catch {
      // pas grave : le bouton reste disponible
    }
  };

  return (
    <section className="conversation">
      <header className="conv-header">
        <button className="back" onClick={onBack} aria-label="Retour">
          &lsaquo;
        </button>
        <span className="conv-name">Ajouter un ami</span>
      </header>

      <div className="search">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher un pseudo..."
        />
      </div>

      <div className="results">
        {searched && query.trim() !== "" && results.length === 0 && (
          <p className="no-result">Aucun résultat</p>
        )}
        {results.map(({ user, added }) => (
          <div key={user.id} className="chat-row static">
            <Creature species={user.species} color={user.color} />
            <span className="chat-name">{user.name}</span>
            {added ? (
              <span className="added">&#10003;</span>
            ) : (
              <button className="round-btn" onClick={() => add(user)} aria-label="Ajouter">
                +
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
