import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError } from "../../data/api";
import {
  changePassword,
  deleteAccount,
  getMyEmailStatus,
  logout,
  logoutAll,
  resendVerificationEmail,
  updateProfileLinks,
  useSession,
} from "../../data/session";

type Panel = null | "password" | "delete" | "links";

export default function AccountScreen({ onBack }: { onBack: () => void }) {
  const session = useSession();
  const [panel, setPanel] = useState<Panel>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [discord, setDiscord] = useState("");
  const [steam, setSteam] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);

  // Email et son état de vérification (voir server/src/mail.ts) : chargé à
  // part, pas dans session.user (voir data/session.ts : getMyEmailStatus).
  // null = pas encore chargé, undefined = pas d'email sur ce compte (créé
  // avant le 27/09/2026).
  const [emailStatus, setEmailStatus] = useState<{ email: string | null; emailVerified: boolean } | null>(null);
  const [resendBusy, setResendBusy] = useState(false);
  const [resendMsg, setResendMsg] = useState("");

  useEffect(() => {
    getMyEmailStatus()
      .then(setEmailStatus)
      .catch(() => {});
  }, []);

  const resend = async () => {
    if (resendBusy) return;
    setResendBusy(true);
    setResendMsg("");
    try {
      const r = await resendVerificationEmail();
      if (r.alreadyVerified) {
        setEmailStatus((s) => (s ? { ...s, emailVerified: true } : s));
        setResendMsg("Cette adresse est déjà vérifiée.");
      } else {
        setResendMsg("Email envoyé — vérifie ta boîte de réception.");
      }
    } catch (err) {
      setResendMsg(err instanceof ApiError ? err.message : "Erreur inattendue.");
    } finally {
      setResendBusy(false);
    }
  };

  const open = (p: Panel) => {
    setPanel(p);
    setCurrent("");
    setNext("");
    setAgain("");
    setDiscord(session?.user.discord ?? "");
    setSteam(session?.user.steam ?? "");
    setError("");
    setDone("");
  };

  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : "Erreur inattendue.");

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (next !== again) {
      setError("Les deux nouveaux mots de passe sont différents.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await changePassword(current, next);
      setPanel(null);
      setDone("Mot de passe modifié.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const submitLinks = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await updateProfileLinks(discord.trim(), steam.trim());
      setPanel(null);
      setDone("Pseudos mis à jour.");
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const submitDelete = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await deleteAccount(current); // me déconnecte : l'écran de connexion réapparaît
    } catch (err) {
      fail(err);
      setBusy(false);
    }
  };

  return (
    <section className="conversation">
      <header className="conv-header">
        <button className="back" onClick={onBack} aria-label="Retour">
          &lsaquo;
        </button>
        <span className="conv-name">Mon compte</span>
      </header>

      <div className="account">
        <p className="account-line">
          Connecté en tant que <strong>{session?.user.username}</strong>
        </p>
        {emailStatus?.email && (
          <p className="account-line account-email">
            {emailStatus.email}
            {emailStatus.emailVerified ? (
              <span className="account-email-badge ok"> · vérifié ✓</span>
            ) : (
              <span className="account-email-badge"> · pas encore vérifié</span>
            )}
            {!emailStatus.emailVerified && (
              <button className="account-resend-btn" onClick={resend} disabled={resendBusy}>
                {resendBusy ? "..." : "Renvoyer l'email"}
              </button>
            )}
          </p>
        )}
        {resendMsg && <p className="account-done">{resendMsg}</p>}
        {done && <p className="account-done">{done}</p>}

        {panel === null && (
          <div className="account-list">
            <button className="account-btn" onClick={() => open("password")}>
              Changer le mot de passe
            </button>
            <button className="account-btn" onClick={() => open("links")}>
              Pseudos Discord / Steam
            </button>
            <button className="account-btn" onClick={() => logout()}>
              Se déconnecter
            </button>
            <button className="account-btn" onClick={() => logoutAll()}>
              Se déconnecter de tous les appareils
            </button>
            <button className="account-btn danger" onClick={() => open("delete")}>
              Supprimer mon compte
            </button>
          </div>
        )}

        {panel === "password" && (
          <form className="auth-form" onSubmit={submitPassword}>
            <input
              type="password"
              autoFocus
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              placeholder="Mot de passe actuel"
              autoComplete="current-password"
            />
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="Nouveau mot de passe (8 caractères min.)"
              autoComplete="new-password"
            />
            <input
              type="password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
              placeholder="Répéter le nouveau mot de passe"
              autoComplete="new-password"
            />
            {error && <p className="auth-error">{error}</p>}
            <button className="soft-btn" type="submit" disabled={busy || !current || !next || !again}>
              {busy ? "..." : "Enregistrer"}
            </button>
            <button type="button" className="auth-switch" onClick={() => open(null)}>
              Annuler
            </button>
          </form>
        )}

        {panel === "links" && (
          <form className="auth-form" onSubmit={submitLinks}>
            <p className="hint">
              Affichés sur ton profil et dans le Répertoire de tes amis. Rien n'est importé automatiquement,
              c'est juste pour que tes amis retrouvent ton pseudo ailleurs.
            </p>
            <input
              autoFocus
              value={discord}
              onChange={(e) => setDiscord(e.target.value)}
              placeholder="Pseudo Discord"
              maxLength={40}
            />
            <input
              value={steam}
              onChange={(e) => setSteam(e.target.value)}
              placeholder="Pseudo Steam"
              maxLength={40}
            />
            {error && <p className="auth-error">{error}</p>}
            <button className="soft-btn" type="submit" disabled={busy}>
              {busy ? "..." : "Enregistrer"}
            </button>
            <button type="button" className="auth-switch" onClick={() => open(null)}>
              Annuler
            </button>
          </form>
        )}

        {panel === "delete" && (
          <form className="auth-form" onSubmit={submitDelete}>
            <p className="account-warn">
              Ton compte, tes amitiés et tes messages seront supprimés définitivement. Entre ton mot de
              passe pour confirmer.
            </p>
            <input
              type="password"
              autoFocus
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              placeholder="Mot de passe"
              autoComplete="current-password"
            />
            {error && <p className="auth-error">{error}</p>}
            <button className="soft-btn danger" type="submit" disabled={busy || !current}>
              {busy ? "..." : "Supprimer définitivement"}
            </button>
            <button type="button" className="auth-switch" onClick={() => open(null)}>
              Annuler
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
