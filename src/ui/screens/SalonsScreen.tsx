import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import Creature from "../Creature";
import { useSession } from "../../data/session";
import {
  addModeratorToCurrentSalon,
  banFromCurrentSalon,
  canModerateCurrentSalon,
  clearPendingOpenAccess,
  closeSalon,
  currentSalonJoinLink,
  enterCurrentSalon,
  leaveCurrentSalon,
  renameMySalon,
  reportSalonMessage,
  sendSalonMessage,
  useSalonsStore,
} from "../../data/salons";
import {
  closeScreenSharePicker,
  joinCurrentCall,
  leaveCurrentCall,
  openScreenSharePicker,
  startScreenShareFrom,
  stopScreenShare,
  toggleCallMic,
  useSalonCallStore,
} from "../../data/salonCall";
import type { CaptureSourceInfo } from "../../data/salonCall";
import { ReportMessageButton, SalonModerationScreen } from "./SalonModerationScreen";
import type { ApiSalonDetail } from "../../data/api";
import type { Species } from "../../data/types";
import { presenceLabel, presenceStatus } from "../format";

// La liste des salons (le mien + ceux de mes amis) vit désormais dans
// ChatsScreen.tsx — fusionnée avec les amis et les groupes, demande
// d'Antoine du 29/09/2026 ("je n'aime pas que les salons soient dans une
// fenêtre séparée"). Ce fichier ne garde plus que la vue détail d'un salon
// (aperçu, discussion en direct, appel vocal, modération), affichée par
// ChatsScreen dès que data/salons.ts a un `current` défini — même mécanisme
// qu'avant, juste appelé depuis un autre écran.
export function SalonDetail() {
  const { current, inside, error, messages, pendingOpenAccess, entryPending } = useSalonsStore();
  const call = useSalonCallStore();
  const session = useSession();
  const myId = session?.user.id;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [joinPassword, setJoinPassword] = useState("");
  // Ouvre l'écran "Modération du salon" (SalonModerationScreen), qui
  // remplace cette vue le temps d'y être — plus un petit panneau inline,
  // demande d'Antoine du 29/09/2026.
  const [managingAccess, setManagingAccess] = useState(false);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const salon = current as ApiSalonDetail;
  const isMine = salon.id === myId;
  const canModerate = canModerateCurrentSalon();
  const isModerator = !isMine && myId ? salon.moderatorIds.includes(myId) : false;
  const inCall = call.salonId === salon.id;

  // Corrigé le 29/09/2026 : ce n'était d'abord qu'un rendu conditionnel en
  // overlay par-dessus la discussion, ce qu'Antoine a vu comme "une nouvelle
  // fenêtre" ; il veut le même mécanisme que les sous-menus du Profil
  // (AccountScreen, ShopScreen...) — l'écran de modération REMPLACE cette
  // vue plutôt que de s'afficher dessus. D'où le retour anticipé plus bas,
  // après tous les Hooks (règle React : jamais de Hook après un retour
  // conditionnel).

  useEffect(() => {
    setRenaming(false);
    setName(salon.name);
    // Ouvre direct sur le panneau réglages si on vient du raccourci "⚙ Accès
    // et modération" du menu ⋮ (voir previewSalon dans data/salons.ts).
    setManagingAccess(pendingOpenAccess);
    if (pendingOpenAccess) clearPendingOpenAccess();
    setJoinPassword("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salon.id]);

  // On quitte l'appel en cours dès qu'on change de salon affiché, ou qu'on
  // referme cette vue (l'appel n'a pas de sens sans le salon qui va avec).
  useEffect(() => {
    return () => leaveCurrentCall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salon.id]);

  // Sorti du salon par écrit (bouton "Sortir", ou banni) => forcément aussi
  // sorti de son appel, voir server/src/index.ts.
  useEffect(() => {
    if (!inside) leaveCurrentCall();
  }, [inside]);

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

  const copyLink = async () => {
    const link = currentSalonJoinLink();
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // le presse-papiers a refusé : pas grave, le lien reste affichable ailleurs
    }
  };

  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    sendSalonMessage(text);
    setText("");
  };

  if (managingAccess) return <SalonModerationScreen onBack={() => setManagingAccess(false)} />;

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
        {(isMine || isModerator) && (
          <button className="salon-access-btn" onClick={() => setManagingAccess((v) => !v)} title="Accès et modération">
            ⚙
          </button>
        )}
      </header>

      {isMine && (
        <button className="salon-share-btn" onClick={copyLink}>
          {copied ? "Lien copié !" : "Copier le lien du salon"}
        </button>
      )}

      {/* Plus de "Personne pour l'instant" (retour d'Antoine du 21/09/2026) :
          rien à afficher quand personne n'est là, comme un salon Discord
          vide. Chaque personne présente porte son propre point de statut
          (vert = actif, orange = absent réglé à la main — voir ApiUser.away)
          plutôt qu'un simple compteur : tout le monde ici est par définition
          connecté (cette liste vient de la présence en direct dans CE
          salon), donc jamais rouge/hors-ligne ici. */}
      {salon.present.length > 0 && (
        <div className="salon-presence">
          {salon.present.map((u) => {
            const uIsModerator = salon.moderatorIds.includes(u.id);
            const status = presenceStatus(true, u.away);
            return (
              <span key={u.id} className="salon-chip">
                <span className="row-avatar">
                  <Creature species={u.species as Species} color={u.color} size={18} />
                  <span className={`row-status-dot ${status}`} title={presenceLabel(status)} />
                </span>
                <span className="salon-chip-name">
                  {u.username}
                  {u.id === myId ? " (toi)" : ""}
                  {uIsModerator && <span className="salon-mod-tag" title="Modérateur">★</span>}
                </span>
                {isMine && u.id !== myId && !uIsModerator && (
                  <button
                    className="salon-chip-mod"
                    onClick={() => addModeratorToCurrentSalon(u.id)}
                    title="Nommer modérateur"
                  >
                    ★
                  </button>
                )}
                {canModerate && u.id !== myId && u.id !== salon.id && (
                  <button className="salon-chip-block" onClick={() => banFromCurrentSalon(u.id)} title="Bannir de ce salon">
                    ✕
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {error && <p className="auth-error salon-error">{error}</p>}

      {!inside ? (
        <div className="salon-enter">
          {entryPending ? (
            // Salon 'private', ou approbation manuelle active côté
            // propriétaire (voir SalonModerationScreen.tsx) : la demande est
            // posée, on entrera automatiquement dès qu'elle est acceptée
            // (voir data/salons.ts, événement "salon-join-approved").
            <p className="account-line">Demande envoyée — en attente d'approbation du propriétaire.</p>
          ) : (
            <>
              <p className="account-line">Entre pour voir la discussion en direct et y participer.</p>
              {salon.hasPassword && !isMine && !isModerator && (
                <input
                  type="password"
                  value={joinPassword}
                  onChange={(e) => setJoinPassword(e.target.value)}
                  placeholder="Mot de passe du salon"
                  className="salon-join-password"
                />
              )}
              <button className="soft-btn" onClick={() => enterCurrentSalon(joinPassword)}>
                Entrer
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="salon-call">
            {!inCall ? (
              <button className="soft-btn salon-call-join" onClick={() => joinCurrentCall(salon.id)}>
                🎙 Rejoindre l'appel
              </button>
            ) : (
              <div className="salon-call-panel">
                <div className="salon-call-people">
                  {call.participants.map((p) => (
                    <span key={p.id} className="salon-chip">
                      <Creature species={p.species as Species} color={p.color} size={18} />
                      <span className="salon-chip-name">
                        {p.username}
                        {p.id === myId ? " (toi)" : ""}
                      </span>
                      {call.mutedPeerIds.includes(p.id) && <span title="Micro coupé">🔇</span>}
                      {call.screenSharingPeerIds.includes(p.id) && <span title="Partage son écran">🖥️</span>}
                    </span>
                  ))}
                </div>
                {Object.entries(call.remoteScreens).map(([peerId, stream]) => (
                  <ScreenShareTile key={peerId} stream={stream} />
                ))}
                {call.screenSharePicker && <ScreenSharePicker sources={call.screenSharePicker} />}
                <div className="salon-call-controls">
                  <button className="soft-btn" onClick={toggleCallMic}>
                    {call.micOn ? "🎙 Couper le micro" : "🔇 Activer le micro"}
                  </button>
                  <button className="soft-btn" onClick={call.screenSharing ? stopScreenShare : openScreenSharePicker}>
                    {call.screenSharing ? "Arrêter le partage" : "Partager mon écran"}
                  </button>
                  <button className="salon-leave-btn" onClick={leaveCurrentCall}>
                    Quitter l'appel
                  </button>
                </div>
              </div>
            )}
            {call.error && <p className="auth-error salon-error">{call.error}</p>}
          </div>

          <div className="messages" ref={scrollRef}>
            {messages.length === 0 && (
              <p className="salon-chat-empty">
                {isMine ? "Personne n'a encore rien dit. À toi de lancer la discussion !" : "Personne n'a encore rien dit."}
              </p>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`bubble salon-bubble ${m.from.id === myId ? "mine" : "theirs"}`}>
                {m.from.id !== myId && <span className="salon-bubble-author">{m.from.username}</span>}
                {m.text}
                {m.from.id !== myId && <ReportMessageButton onReport={(reason) => reportSalonMessage(m, reason)} />}
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
    </section>
  );
}

/** Un flux de partage d'écran reçu : `srcObject` n'est pas une prop React,
 *  il faut passer par une ref. */
function ScreenShareTile({ stream }: { stream: MediaStream }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  return <video ref={videoRef} className="salon-call-screen" autoPlay playsInline muted />;
}

/** Notre propre sélecteur d'écran/fenêtre (voir data/salonCall.ts et
 *  src-tauri/src/capture.rs pour pourquoi ce n'est pas getDisplayMedia). Une
 *  simple liste de noms — pas de vignettes pour l'instant. */
function ScreenSharePicker({ sources }: { sources: CaptureSourceInfo[] }) {
  const monitors = sources.filter((s) => s.kind === "monitor");
  const windows = sources.filter((s) => s.kind === "window");

  return (
    <div className="salon-share-picker">
      <p className="account-line">Que veux-tu partager ?</p>
      {monitors.length > 0 && (
        <div className="salon-share-picker-list">
          {monitors.map((s) => (
            <button key={`monitor-${s.index}`} className="account-btn" onClick={() => startScreenShareFrom(s)}>
              🖥️ {s.name}
            </button>
          ))}
        </div>
      )}
      {windows.length > 0 && (
        <div className="salon-share-picker-list">
          {windows.map((s) => (
            <button key={`window-${s.index}`} className="account-btn" onClick={() => startScreenShareFrom(s)}>
              🪟 {s.name}
            </button>
          ))}
        </div>
      )}
      {sources.length === 0 && <p className="salon-presence-empty">Rien à partager pour l'instant.</p>}
      <button className="salon-leave-btn" onClick={closeScreenSharePicker}>
        Annuler
      </button>
    </div>
  );
}
