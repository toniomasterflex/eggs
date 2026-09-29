import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import Creature from "../Creature";
import { api } from "../../data/api";
import type { ApiSalonDetail, ApiUser, SalonAccessLevel, SalonWritePermission } from "../../data/api";
import type { Species } from "../../data/types";
import {
  addBannedWordToCurrentSalon,
  approveJoinRequest,
  banFromCurrentSalon,
  canModerateCurrentSalon,
  declineJoinRequest,
  dismissReportFromCurrentSalon,
  inviteToCurrentSalon,
  removeBannedWordFromCurrentSalon,
  removeModeratorFromCurrentSalon,
  removeSalonMemberFromCurrent,
  setMySalonPassword,
  unbanFromCurrentSalon,
  updateCurrentSalonSettings,
  useSalonsStore,
} from "../../data/salons";
import { useSession } from "../../data/session";

// Écran "Modération du salon" — demande d'Antoine du 29/09/2026 ("je veux
// une fenêtre entière, pas un petit panneau"), inspirée d'une maquette qu'il
// a fournie, puis corrigée le même jour : pas une nouvelle fenêtre flottante
// (overlay/dialog par-dessus tout), mais un écran normal DANS l'appli, exact
// même mécanisme que les sous-menus du Profil (AccountScreen, ShopScreen,
// etc.) — remplace le contenu de SalonDetail plutôt que de s'afficher
// par-dessus (voir SalonsScreen.tsx : SalonDetail fait un retour anticipé
// `if (managingAccess) return <SalonModerationScreen .../>`). Remplace
// l'ancien panneau inline ".salon-access" de SalonsScreen.tsx (accessible
// par le même bouton ⚙, voir SalonDetail). Décisions prises avec lui avant
// de coder (AskUserQuestion) :
//  - 4 niveaux d'accès (Privé/Amis/Amis d'amis/Ouvert), qui remplacent le
//    système "amis + mot de passe optionnel" — fait sciemment évoluer la
//    décision du 23/09/2026 qui excluait la chaîne "amis d'amis" ;
//  - un seul réglage "qui peut écrire" (pas de distinction publier/commenter
//    façon maquette : le salon n'a qu'un seul fil de discussion, pas de
//    stickers) ;
//  - mots interdits + signalements de contenu réellement construits (pas un
//    placeholder) ;
//  - approbation manuelle des demandes réellement construite : un salon
//    'private' ou avec l'approbation active pose une vraie demande
//    (salon_join_requests côté serveur) au lieu d'laisser entrer directement.
//
// Les réglages du haut (accès/écriture/approbation/invitations) sont modifiés
// en brouillon local puis envoyés d'un coup par "Enregistrer les
// paramètres", comme sur la maquette — pas un enregistrement par toggle.
// Les listes (bannis, modérateurs, mots interdits, signalements, demandes,
// membres) restent en revanche immédiates, comme partout ailleurs dans
// l'appli.

type SubView = "main" | "banned-words" | "reports" | "bans" | "moderators" | "members";

const ACCESS_LEVELS: { id: SalonAccessLevel; icon: string; label: string; sub: string }[] = [
  { id: "private", icon: "🔒", label: "Privé", sub: "Sur invitation uniquement" },
  { id: "friends", icon: "👥", label: "Amis uniquement", sub: "Vos amis peuvent rejoindre" },
  { id: "friends_of_friends", icon: "👤👥", label: "Amis d'amis", sub: "Les amis de vos amis peuvent rejoindre" },
  { id: "open", icon: "🌐", label: "Ouvert", sub: "Tout le monde peut rejoindre" },
];

const WRITE_PERMISSIONS: { id: SalonWritePermission; label: string }[] = [
  { id: "members", label: "Membres uniquement" },
  { id: "friends_of_friends", label: "Membres + amis d'amis" },
  { id: "everyone", label: "Tout le monde" },
];

const REPORT_REASONS = ["Contenu inapproprié", "Harcèlement", "Spam", "Autre"];

export function SalonModerationScreen({ onBack }: { onBack: () => void }) {
  const { current, bans, moderators, members, joinRequests, bannedWords, reports } = useSalonsStore();
  const session = useSession();
  const salon = current as ApiSalonDetail;
  const myId = session?.user.id;
  const isMine = salon.id === myId;
  const canModerate = canModerateCurrentSalon();

  const [view, setView] = useState<SubView>("main");
  const [accessLevel, setAccessLevel] = useState<SalonAccessLevel>(salon.accessLevel);
  const [writePermission, setWritePermission] = useState<SalonWritePermission>(salon.writePermission);
  const [requireApproval, setRequireApproval] = useState(salon.requireApproval);
  const [allowMemberInvites, setAllowMemberInvites] = useState(salon.allowMemberInvites);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [passwordMsg, setPasswordMsg] = useState("");
  const [newWord, setNewWord] = useState("");
  const [inviteQuery, setInviteQuery] = useState("");
  const [inviteResults, setInviteResults] = useState<(ApiUser & { friend: boolean })[]>([]);
  const [invited, setInvited] = useState<Set<string>>(new Set());

  // Le brouillon suit le salon affiché (rouvrir l'écran sur un autre salon,
  // ou un changement arrivé d'ailleurs, ne doit pas garder l'ancien brouillon).
  useEffect(() => {
    setAccessLevel(salon.accessLevel);
    setWritePermission(salon.writePermission);
    setRequireApproval(salon.requireApproval);
    setAllowMemberInvites(salon.allowMemberInvites);
    setSaved(false);
  }, [salon.id, salon.accessLevel, salon.writePermission, salon.requireApproval, salon.allowMemberInvites]);

  useEffect(() => {
    let cancelled = false;
    if (!inviteQuery.trim()) {
      setInviteResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      api
        .searchUsers(inviteQuery)
        .then((r) => !cancelled && setInviteResults(r))
        .catch(() => !cancelled && setInviteResults([]));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [inviteQuery]);

  if (!isMine && !canModerate) {
    // Ne devrait pas arriver (le bouton n'est proposé qu'aux personnes
    // habilitées, voir SalonsScreen.tsx), filet de sécurité.
    return null;
  }

  const dirty =
    accessLevel !== salon.accessLevel ||
    writePermission !== salon.writePermission ||
    requireApproval !== salon.requireApproval ||
    allowMemberInvites !== salon.allowMemberInvites;

  const save = async () => {
    setSaving(true);
    const ok = await updateCurrentSalonSettings({ accessLevel, writePermission, requireApproval, allowMemberInvites });
    setSaving(false);
    if (ok) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    }
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setPasswordMsg("");
    const err = await setMySalonPassword(newPassword.trim());
    if (err) setPasswordMsg(err);
    else {
      setPasswordMsg(newPassword.trim() ? "Mot de passe enregistré." : "Mot de passe retiré.");
      setNewPassword("");
    }
  };

  const submitWord = (e: FormEvent) => {
    e.preventDefault();
    if (!newWord.trim()) return;
    addBannedWordToCurrentSalon(newWord);
    setNewWord("");
  };

  const invite = (user: ApiUser) => {
    inviteToCurrentSalon(user.id, user);
    setInvited((s) => new Set(s).add(user.id));
  };

  return (
    <section className="conversation">
      <header className="conv-header">
        <button
          className="back"
          onClick={() => (view === "main" ? onBack() : setView("main"))}
          aria-label="Retour"
        >
          &lsaquo;
        </button>
        <span className="conv-name">{view === "main" ? "Modération du salon" : viewTitle(view)}</span>
      </header>

      <div className="salon-mod-body">
          {view === "main" && (
            <>
              <section className="salon-mod-card">
                <CardHeader icon="🛡️" title="Accès au salon" sub="Choisissez qui peut voir, rejoindre et interagir dans ce salon." />
                {isMine ? (
                  <div className="salon-mod-levels">
                    {ACCESS_LEVELS.map((lvl) => (
                      <button
                        key={lvl.id}
                        className={`salon-mod-level ${accessLevel === lvl.id ? "selected" : ""}`}
                        onClick={() => setAccessLevel(lvl.id)}
                      >
                        {accessLevel === lvl.id && <span className="salon-mod-level-check">✓</span>}
                        <span className="salon-mod-level-icon">{lvl.icon}</span>
                        <span className="salon-mod-level-label">{lvl.label}</span>
                        <span className="salon-mod-level-sub">{lvl.sub}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="account-line">{ACCESS_LEVELS.find((l) => l.id === salon.accessLevel)?.label}</p>
                )}

                {isMine && (
                  <form className="salon-password-form" onSubmit={submitPassword}>
                    <label className="account-line" htmlFor="salon-password">
                      Mot de passe (optionnel, fait entrer directement même sans remplir les conditions ci-dessus) :
                    </label>
                    <div className="salon-password-row">
                      <input
                        id="salon-password"
                        type="text"
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        placeholder={salon.hasPassword ? "Changer le mot de passe…" : "Aucun — en ajouter un"}
                        maxLength={60}
                      />
                      <button className="soft-btn" type="submit">
                        {salon.hasPassword ? "Changer" : "Ajouter"}
                      </button>
                    </div>
                    {salon.hasPassword && (
                      <button
                        type="button"
                        className="auth-switch"
                        onClick={() => setMySalonPassword("").then(() => setPasswordMsg("Mot de passe retiré."))}
                      >
                        Retirer le mot de passe
                      </button>
                    )}
                    {passwordMsg && <p className="account-done">{passwordMsg}</p>}
                  </form>
                )}
              </section>

              <section className="salon-mod-card">
                <CardHeader icon="💬" title="Qui peut écrire dans ce salon" sub="Un seul fil de discussion en direct — s'applique à tous les messages." />
                <div className="salon-mod-radios">
                  {WRITE_PERMISSIONS.map((p) => (
                    <label key={p.id} className="salon-mod-radio">
                      <input
                        type="radio"
                        name="write-permission"
                        checked={writePermission === p.id}
                        disabled={!isMine}
                        onChange={() => setWritePermission(p.id)}
                      />
                      {p.label}
                    </label>
                  ))}
                </div>
              </section>

              <section className="salon-mod-card">
                <CardHeader icon="👥" title="Gestion des membres" sub="Contrôlez qui peut inviter, et comment les rejoindre." />
                <label className="salon-mod-toggle-row">
                  <span>Autoriser les membres à inviter d'autres personnes</span>
                  <input
                    type="checkbox"
                    checked={allowMemberInvites}
                    disabled={!isMine}
                    onChange={(e) => setAllowMemberInvites(e.target.checked)}
                  />
                </label>
                <label className="salon-mod-toggle-row">
                  <span>Approbation manuelle des nouvelles demandes</span>
                  <input
                    type="checkbox"
                    checked={requireApproval}
                    disabled={!isMine}
                    onChange={(e) => setRequireApproval(e.target.checked)}
                  />
                </label>
                {joinRequests.length > 0 && (
                  <button className="salon-mod-row" onClick={() => setView("members")}>
                    <span>Demandes en attente</span>
                    <span className="salon-mod-row-right">
                      <span className="count-badge accent">{joinRequests.length}</span> &rsaquo;
                    </span>
                  </button>
                )}
                {accessLevel === "private" && (
                  <button className="salon-mod-row" onClick={() => setView("members")}>
                    <span>Membres avec accès permanent</span>
                    <span className="salon-mod-row-right">{members.length} &rsaquo;</span>
                  </button>
                )}
              </section>

              <section className="salon-mod-card">
                <CardHeader icon="🛡️" title="Outils de modération" sub="Gérez le comportement et la sécurité de votre salon." />
                <button className="salon-mod-row danger-row" onClick={() => setView("banned-words")}>
                  <span>🚫 Mots interdits (liste de filtres)</span>
                  <span className="salon-mod-row-right">&rsaquo;</span>
                </button>
                <button className="salon-mod-row danger-row" onClick={() => setView("reports")}>
                  <span>🚩 Signaler du contenu</span>
                  <span className="salon-mod-row-right">
                    {reports.length > 0 && <span className="count-badge accent">{reports.length}</span>} &rsaquo;
                  </span>
                </button>
                <button className="salon-mod-row danger-row" onClick={() => setView("bans")}>
                  <span>🚫 Bloquer un membre</span>
                  <span className="salon-mod-row-right">&rsaquo;</span>
                </button>
                <button className="salon-mod-row" onClick={() => setView("moderators")}>
                  <span>👑 Rôles de modération</span>
                  <span className="salon-mod-row-right">&rsaquo;</span>
                </button>
              </section>
            </>
          )}

          {view === "banned-words" && (
            <section className="salon-mod-card">
              <p className="account-line">Un message contenant un de ces mots (insensible à la casse) est refusé.</p>
              <form className="salon-password-row" onSubmit={submitWord}>
                <input value={newWord} onChange={(e) => setNewWord(e.target.value)} placeholder="Ajouter un mot..." maxLength={40} />
                <button className="soft-btn" type="submit">
                  Ajouter
                </button>
              </form>
              {bannedWords.length === 0 ? (
                <p className="salon-presence-empty">Aucun mot interdit pour l'instant.</p>
              ) : (
                <div className="account-list">
                  {bannedWords.map((w) => (
                    <button key={w} className="account-btn" onClick={() => removeBannedWordFromCurrentSalon(w)}>
                      Retirer « {w} »
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {view === "reports" && (
            <section className="salon-mod-card">
              {reports.length === 0 ? (
                <p className="salon-presence-empty">Aucun signalement pour l'instant.</p>
              ) : (
                <div className="salon-mod-reports">
                  {reports.map((r) => (
                    <div key={r.id} className="salon-mod-report">
                      <div className="salon-mod-report-head">
                        <span>
                          Signalé par <b>{r.reporter.username}</b>
                          {r.reported && (
                            <>
                              {" "}
                              à propos de <b>{r.reported.username}</b>
                            </>
                          )}
                        </span>
                        {r.reason && <span className="salon-mod-report-reason">{r.reason}</span>}
                      </div>
                      <p className="salon-mod-report-text">« {r.messageText} »</p>
                      <div className="salon-mod-report-actions">
                        {r.reported && canModerate && r.reported.id !== myId && (
                          <button className="account-btn" onClick={() => banFromCurrentSalon(r.reported!.id)}>
                            Bannir {r.reported.username}
                          </button>
                        )}
                        <button className="account-btn" onClick={() => dismissReportFromCurrentSalon(r.id)}>
                          Classer sans suite
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {view === "bans" && (
            <section className="salon-mod-card">
              <p className="account-line">Présents en ce moment :</p>
              {salon.present.filter((u) => u.id !== myId && u.id !== salon.id).length === 0 ? (
                <p className="salon-presence-empty">Personne d'autre pour l'instant.</p>
              ) : (
                <div className="account-list">
                  {salon.present
                    .filter((u) => u.id !== myId && u.id !== salon.id)
                    .map((u) => (
                      <button key={u.id} className="account-btn danger" onClick={() => banFromCurrentSalon(u.id)}>
                        Bannir {u.username}
                      </button>
                    ))}
                </div>
              )}
              <p className="account-line">Bannis :</p>
              {bans.length === 0 ? (
                <p className="salon-presence-empty">Personne de banni pour l'instant.</p>
              ) : (
                <div className="account-list">
                  {bans.map((u) => (
                    <button key={u.id} className="account-btn" onClick={() => unbanFromCurrentSalon(u.id)}>
                      Débannir {u.username}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {view === "moderators" && (
            <section className="salon-mod-card">
              <p className="account-line">Nommer quelqu'un de présent modérateur, avec l'étoile ★ à côté de son nom dans le salon.</p>
              {moderators.length === 0 ? (
                <p className="salon-presence-empty">Aucun modérateur pour l'instant.</p>
              ) : (
                <div className="account-list">
                  {moderators.map((m) => (
                    <button key={m.id} className="account-btn" onClick={() => removeModeratorFromCurrentSalon(m.id)}>
                      Retirer {m.username}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {view === "members" && (
            <section className="salon-mod-card">
              {joinRequests.length > 0 && (
                <>
                  <p className="account-line">Demandes en attente :</p>
                  <div className="salon-mod-requests">
                    {joinRequests.map((r) => (
                      <div key={r.id} className="salon-mod-request">
                        <Creature species={r.species as Species} color={r.color} size={20} />
                        <span className="salon-chip-name">{r.username}</span>
                        <button className="soft-btn" onClick={() => approveJoinRequest(r.id)}>
                          Accepter
                        </button>
                        <button className="salon-leave-btn" onClick={() => declineJoinRequest(r.id)}>
                          Refuser
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {accessLevel === "private" && (
                <>
                  <p className="account-line">Inviter quelqu'un directement :</p>
                  <div className="search">
                    <input value={inviteQuery} onChange={(e) => setInviteQuery(e.target.value)} placeholder="Rechercher un pseudo..." />
                  </div>
                  {inviteResults.length > 0 && (
                    <div className="results">
                      {inviteResults.map((u) => (
                        <div key={u.id} className="chat-row static">
                          <Creature species={u.species as Species} color={u.color} />
                          <span className="chat-name">{u.username}</span>
                          {invited.has(u.id) || members.some((m) => m.id === u.id) ? (
                            <span className="added">&#10003;</span>
                          ) : (
                            <button className="round-btn" onClick={() => invite(u)} aria-label="Inviter">
                              +
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <p className="account-line">Membres avec accès permanent :</p>
                  {members.length === 0 ? (
                    <p className="salon-presence-empty">Personne pour l'instant.</p>
                  ) : (
                    <div className="account-list">
                      {members.map((m) => (
                        <button key={m.id} className="account-btn" onClick={() => removeSalonMemberFromCurrent(m.id)}>
                          Retirer {m.username}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </div>

      {view === "main" && isMine && (
        <button className="salon-mod-save" disabled={!dirty || saving} onClick={save}>
          {saved ? "✓ Enregistré" : saving ? "Enregistrement..." : "✓ Enregistrer les paramètres"}
        </button>
      )}
    </section>
  );
}

function CardHeader({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div className="salon-mod-card-head">
      <span className="salon-mod-card-icon">{icon}</span>
      <span className="salon-mod-card-text">
        <span className="salon-mod-card-title">{title}</span>
        <span className="salon-mod-card-sub">{sub}</span>
      </span>
    </div>
  );
}

function viewTitle(view: SubView): string {
  switch (view) {
    case "banned-words":
      return "Mots interdits";
    case "reports":
      return "Signalements";
    case "bans":
      return "Bloquer un membre";
    case "moderators":
      return "Rôles de modération";
    case "members":
      return "Membres et demandes";
    default:
      return "";
  }
}

/** Petit bouton "signaler" sur une bulle de message de la discussion en
 *  direct (voir SalonsScreen.tsx : SalonDetail) — ouvre un choix de raison,
 *  puis envoie l'instantané du message (la discussion elle-même n'est
 *  jamais enregistrée côté serveur, voir salon_reports dans db.ts). */
export function ReportMessageButton({ onReport }: { onReport: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);

  if (sent) return <span className="salon-report-done">Signalé</span>;

  return (
    <div className="salon-report-pick">
      <button className="salon-report-btn" title="Signaler ce message" onClick={() => setOpen((v) => !v)}>
        ⚑
      </button>
      {open && (
        <div className="row-menu salon-report-menu">
          {REPORT_REASONS.map((reason) => (
            <button
              key={reason}
              onClick={() => {
                onReport(reason);
                setOpen(false);
                setSent(true);
              }}
            >
              {reason}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
