import {
  setShowGround,
  setTheme,
  useAutoHideFullscreen,
  useAutostart,
  useMeetingMode,
  useSettings,
} from "../../data/settings";
import { setMyAwayStatus, useMyAwayStatus } from "../../data/session";

function SettingRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="setting-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="setting-label">{label}</span>
        <span className="setting-desc">{desc}</span>
      </span>
    </label>
  );
}

export default function SettingsScreen({ onBack }: { onBack: () => void }) {
  const settings = useSettings();
  const [autostart, setAutostart] = useAutostart();
  const [meetingMode, setMeetingMode] = useMeetingMode();
  const [autoHide, setAutoHide] = useAutoHideFullscreen();
  const away = useMyAwayStatus();

  return (
    <section className="conversation">
      <header className="conv-header">
        <button className="back" onClick={onBack} aria-label="Retour">
          &lsaquo;
        </button>
        <span className="conv-name">Réglages</span>
      </header>

      <div className="settings-list">
        {/* Thème clair "affiche jaune d'œuf" (planche fournie par Antoine le
            29/09/2026, voir ui.css) à la place du thème sombre d'origine —
            purement local à cet ordinateur, comme les réglages suivants
            (contrairement à "Absent" juste en dessous). Voir
            data/settings.ts : setTheme()/useTheme(). */}
        <SettingRow
          label="Thème clair"
          desc="Fond crème et texte foncé façon affiche, au lieu du thème sombre par défaut."
          checked={settings.theme === "light"}
          onChange={(on) => setTheme(on ? "light" : "dark")}
        />
        {/* Statut "absent" réglé à la main (façon Slack/Discord, demande
            d'Antoine du 21/09/2026) — contrairement aux réglages ci-dessus
            et ci-dessous (locaux à cet ordinateur), celui-ci est envoyé au
            serveur : mes amis et les gens dans mes salons le voient (point
            orange plutôt que vert, voir ui/format.ts : presenceStatus). */}
        <SettingRow
          label="Absent"
          desc="Affiche un point orange aux autres au lieu de vert, tant que tu es connecté(e) — jusqu'à ce que tu le désactives toi-même."
          checked={away}
          onChange={(on) => setMyAwayStatus(on).catch(() => {})}
        />
        <SettingRow
          label="Afficher le sol"
          desc="Une bande d'herbe apparaît sur la barre des tâches."
          checked={settings.showGround}
          onChange={setShowGround}
        />
        <SettingRow
          label="Démarrer avec Windows"
          desc="Egg se lance automatiquement à l'ouverture de session."
          checked={autostart}
          onChange={setAutostart}
        />
        <SettingRow
          label="Mode réunion"
          desc="Cache tout d'un coup, temporairement (pratique pendant un partage d'écran). Peut aussi se désactiver depuis l'icône d'Egg dans la zone de notification."
          checked={meetingMode}
          onChange={setMeetingMode}
        />
        <SettingRow
          label="Masquer automatiquement en plein écran"
          desc="Je m'efface tout seul pendant une vidéo ou une appli en plein écran, pour ne jamais gêner. Redémarre désactivé à chaque lancement, et peut aussi se désactiver depuis l'icône d'Egg dans la zone de notification."
          checked={autoHide}
          onChange={setAutoHide}
        />
      </div>
    </section>
  );
}
