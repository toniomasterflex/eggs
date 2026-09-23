import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError, SERVER_URL, saveServerUrl } from "../../data/api";
import { login, register } from "../../data/session";

export default function LoginScreen() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showServer, setShowServer] = useState(false);
  const [server, setServer] = useState(SERVER_URL);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (mode === "register" && password !== again) {
      setError("Les deux mots de passe sont différents.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (mode === "login") await login(username.trim(), password);
      else await register(username.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erreur inattendue.");
    } finally {
      setBusy(false);
    }
  };

  const register_ = mode === "register";

  return (
    <section className="screen auth">
      <h1>{register_ ? "Créer un compte" : "Connexion"}</h1>
      <form className="auth-form" onSubmit={submit}>
        <input
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Pseudo"
          autoComplete="username"
        />
        <input
          type={visible ? "text" : "password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={register_ ? "Mot de passe (8 caractères min.)" : "Mot de passe"}
          autoComplete={register_ ? "new-password" : "current-password"}
        />
        {register_ && (
          <input
            type={visible ? "text" : "password"}
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            placeholder="Répéter le mot de passe"
            autoComplete="new-password"
          />
        )}
        <label className="auth-check">
          <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
          Afficher le mot de passe
        </label>
        {error && <p className="auth-error">{error}</p>}
        <button className="soft-btn" type="submit" disabled={busy || !username.trim() || !password || (register_ && !again)}>
          {busy ? "..." : register_ ? "Créer mon compte" : "Se connecter"}
        </button>
      </form>
      <button
        className="auth-switch"
        onClick={() => {
          setMode(register_ ? "login" : "register");
          setError("");
          setAgain("");
        }}
      >
        {register_ ? "J'ai déjà un compte" : "Pas de compte ? En créer un"}
      </button>
      <button className="auth-switch" onClick={() => setShowServer(!showServer)}>
        Serveur
      </button>
      {showServer && (
        <form
          className="auth-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveServerUrl(server);
            window.location.reload();
          }}
        >
          <input
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="https://..."
            spellCheck={false}
          />
          <button className="soft-btn" type="submit">
            Enregistrer l'adresse
          </button>
        </form>
      )}
    </section>
  );
}
