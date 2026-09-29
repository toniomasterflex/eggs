// Petites icônes inline partagées entre les écrans — pas de dépendance à une
// librairie d'icônes pour si peu. Voir .folder-count-badge dans ui.css
// (nouveau design en pilule importé le 29/09/2026).

// Jeu d'icônes "trait" ajouté le 30/09/2026 pour suivre la charte graphique
// fournie par Antoine (section "Icônes d'action") : même gabarit pour
// toutes (viewBox 24x24, trait 1.8, bouts arrondis), afin de remplacer les
// caractères un peu ad hoc utilisés jusqu'ici (⋮ ★ ↕ + 📌 🔗 &uarr;) par un
// style cohérent. Chacune prend `size` (px) comme PeopleIcon ci-dessus ;
// StarIcon/BookmarkIcon prennent en plus `filled` pour l'état actif/inactif
// (favoris, épinglé) — remplace le couple de caractères ★/☆ utilisé avant.
const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function PlusIcon({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...STROKE}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function SearchIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...STROKE}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M19.5 19.5 15 15" />
    </svg>
  );
}

export function SendIcon({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20.5 21 12 4 3.5l0 6.5L15 12 4 14z" />
    </svg>
  );
}

export function StarIcon({ size = 15, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
    >
      <path d="M12 3.3l2.6 5.5 6 .7-4.4 4.1 1.2 6-5.4-3-5.4 3 1.2-6-4.4-4.1 6-.7Z" />
    </svg>
  );
}

export function BookmarkIcon({ size = 14, filled = false }: { size?: number; filled?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinejoin="round"
    >
      <path d="M6 3.5h12v17l-6-4-6 4Z" />
    </svg>
  );
}

export function LinkIcon({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...STROKE}>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M11 6.5 12.6 4.9a4 4 0 0 1 5.6 5.6L16.6 12" />
      <path d="M13 17.5 11.4 19.1a4 4 0 0 1-5.6-5.6L7.4 12" />
    </svg>
  );
}

export function EditIcon({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...STROKE}>
      <path d="M15.7 4.3a1.8 1.8 0 0 1 2.5 0l1.5 1.5a1.8 1.8 0 0 1 0 2.5L8.5 19.5 4 21l1.5-4.5Z" />
      <path d="M14 6l4 4" />
    </svg>
  );
}

export function TrashIcon({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...STROKE}>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2" />
      <path d="M6.5 7l.8 12.2A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.8L17.5 7" />
      <path d="M10.3 11v6M13.7 11v6" />
    </svg>
  );
}

export function SortIcon({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...STROKE}>
      <path d="M7 4v16M3.5 7.5 7 4l3.5 3.5" />
      <path d="M17 20V4M13.5 16.5 17 20l3.5-3.5" />
    </svg>
  );
}

export function MoreIcon({ size = 15 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <circle cx="12" cy="5.2" r="1.9" fill="currentColor" />
      <circle cx="12" cy="12" r="1.9" fill="currentColor" />
      <circle cx="12" cy="18.8" r="1.9" fill="currentColor" />
    </svg>
  );
}

/** Deux silhouettes qui se chevauchent, pour le badge de compteur d'un
 *  espace (nombre de discussions/salons dedans). */
export function PeopleIcon({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 16" width={size} height={(size * 16) / 20} aria-hidden="true">
      <circle cx="7" cy="4" r="3" fill="currentColor" />
      <path fill="currentColor" d="M1 15c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5H1Z" />
      <circle cx="15" cy="5" r="2.4" fill="currentColor" opacity="0.75" />
      <path
        fill="currentColor"
        opacity="0.75"
        d="M12.3 9.7c.9-.4 1.9-.6 2.7-.6 2.6 0 4.6 1.7 4.6 4.3v1.1h-5.2c-.1-1.9-.9-3.5-2.1-4.8Z"
      />
    </svg>
  );
}
