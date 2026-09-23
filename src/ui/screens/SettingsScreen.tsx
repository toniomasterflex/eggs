import {
  setShowGround,
  useAutoHideFullscreen,
  useAutostart,
  useMeetingMode,
  useSettings,
} from "../../data/settings";

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

  return (
    <section className="conversation">
      <header className="conv-header">
        <button className="back" onClick={onBack} aria-label="Retour">
          &lsaquo;
        </button>
        <span className="conv-name">Réglages</span>
      </header>

      <div className="settings-list">
        <SettingRow
          label="Afficher le sol"
          desc="Une bande d'herbe apparaît sur la barre des tâches."
          checked={settings.showGround}
          onChange={setShowGround}
        />
        <SettingRow
          label="Démarrer avec Windows"
          desc="Eggs se lance automatiquement à l'ouverture de session."
          checked={autostart}
          onChange={setAutostart}
        />
        <SettingRow
          label="Mode réunion"
          desc="Cache tout d'un coup, temporairement (pratique pendant un partage d'écran). Peut aussi se désactiver depuis l'icône d'Eggs dans la zone de notification."
          checked={meetingMode}
          onChange={setMeetingMode}
        />
        <SettingRow
          label="Masquer automatiquement en plein écran"
          desc="Je m'efface tout seul pendant une vidéo ou une appli en plein écran, pour ne jamais gêner. Redémarre désactivé à chaque lancement, et peut aussi se désactiver depuis l'icône d'Eggs dans la zone de notification."
          checked={autoHide}
          onChange={setAutoHide}
        />
      </div>
    </section>
  );
}
