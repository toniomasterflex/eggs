import Creature from "./Creature";
import type { GroupMember } from "../data/types";

// Avatar d'un groupe : pas d'image à uploader, on réutilise ce qu'on a déjà —
// jusqu'à 3 têtes de créature des membres, qui se chevauchent façon avatar de
// groupe WhatsApp (voir data/types.ts : Group, ui/screens/ChatsScreen.tsx).
export default function GroupAvatar({ members, size = 28 }: { members: GroupMember[]; size?: number }) {
  const shown = members.slice(0, 3);
  const inner = Math.round(size * 0.62);
  const step = size * 0.24;
  return (
    <span className="group-avatar" style={{ width: size, height: size }}>
      {shown.map((m, i) => (
        <span
          key={m.id}
          className="group-avatar-item"
          style={{
            zIndex: shown.length - i,
            transform: `translate(${i * step}px, ${i * step}px)`,
          }}
        >
          <Creature species={m.species} color={m.color} size={inner} />
        </span>
      ))}
    </span>
  );
}
