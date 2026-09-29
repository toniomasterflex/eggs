import { useState } from "react";
import Creature from "../Creature";
import { createGroup, openChat, useChatStore } from "../../data/store";

// Groupe fermé façon WhatsApp : on choisit le nom et les membres (parmi mes
// amis seulement, voir server/src/index.ts : POST /groups) à la création —
// pas d'invitation à un inconnu, pas d'ajout après coup pour cette première
// version (voir data/types.ts : Group).
export default function CreateGroupScreen({ onBack }: { onBack: () => void }) {
  const { friends } = useChatStore();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sorted = [...friends].sort((a, b) => a.name.localeCompare(b.name, "fr"));

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Au moins 2 amis (donc 3 personnes en tout) : à 2, il vaut mieux utiliser
  // le chat direct déjà existant avec cet ami plutôt qu'un groupe qui ferait
  // doublon (voir server/src/index.ts : POST /groups).
  const canCreate = name.trim().length > 0 && selected.size >= 2 && !busy;

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const group = await createGroup(name.trim(), Array.from(selected));
      openChat(group.id);
      onBack();
    } catch {
      setError("Impossible de créer le groupe.");
      setBusy(false);
    }
  };

  return (
    <section className="conversation">
      <header className="conv-header">
        <button className="back" onClick={onBack} aria-label="Retour">
          &lsaquo;
        </button>
        <span className="conv-name">Nouveau groupe</span>
      </header>

      <div className="search">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nom du groupe…"
          maxLength={60}
        />
      </div>

      {error && <div className="attach-error">{error}</div>}
      {selected.size === 1 && (
        <p className="hint">
          Pour discuter à deux, ferme cet écran et utilise directement le chat avec cet ami — un groupe demande
          au moins 2 amis.
        </p>
      )}

      <div className="results">
        {sorted.length === 0 && <p className="no-result">Ajoute d'abord des amis pour créer un groupe.</p>}
        {sorted.map((f) => {
          const on = selected.has(f.id);
          return (
            <button key={f.id} type="button" className={`chat-row member-row ${on ? "on" : ""}`} onClick={() => toggle(f.id)}>
              <Creature species={f.species} color={f.color} />
              <span className="chat-name">{f.name}</span>
              <span className={`member-check ${on ? "on" : ""}`}>{on ? "✓" : ""}</span>
            </button>
          );
        })}
      </div>

      <button className="add-btn primary" disabled={!canCreate} onClick={submit}>
        {busy ? "Création…" : `Créer${selected.size > 0 ? ` (${selected.size + 1})` : ""}`}
      </button>
    </section>
  );
}
