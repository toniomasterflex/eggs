// Types de données d'Eggs. Ils correspondent à ce que renvoie le serveur.

export type Species =
  | "egg" // pas encore éclos
  | "chick"
  | "explorer" // skin rare, acheté dans le Shop (voir data/profile.ts : SKINS)
  | "cricket" // skin rare, acheté dans le Shop — « L'Éclaireur »
  | "cat"
  | "fox"
  | "penguin"
  | "rabbit"
  | "panda"
  | "frog"
  | "owl";

// Une créature déjà éclose (fixée pour toujours), dans ma collection.
export interface Creature {
  id: string;
  species: Species;
  color: string;
  active: boolean; // celle affichée en ce moment
  partnerId: string | null; // si née d'un œuf offert : de quel ami
  bornAt: number;
}

// Un œuf pas encore ouvert.
export interface Egg {
  id: string;
  source: "welcome" | "weekly" | "gift" | "shop";
  partnerId: string | null; // pour 'gift' : qui te l'a offert
  grantedAt: number;
}

export interface Friend {
  id: string;
  name: string; // pseudo
  species: Species;
  color: string; // identifiant d'une couleur de PET_COLORS (data/profile.ts)
  discord?: string | null; // pseudo Discord affiché (simple affichage, voir data/api.ts)
  steam?: string | null; // pseudo Steam affiché
  lastAt?: number; // date du dernier message échangé (millisecondes)
  readAt?: number; // date jusqu'à laquelle cet ami a lu mes messages
  online?: boolean; // connecté au serveur en ce moment
  away?: boolean; // statut "absent" réglé à la main par cet ami (indépendant d'online)
}

export interface MessageAttachment {
  url: string; // déjà absolue (SERVER_URL + chemin), prête pour <img>/<video>/<audio>
  kind: "image" | "video" | "audio";
  name: string;
}

// Réaction façon iMessage/WhatsApp (tapback) sur un message : une seule par
// personne (voir ui/screens/ConversationScreen.tsx). userId sert à savoir si
// c'est LA MIENNE (pour la mettre en avant / la retirer d'un clic).
export interface MessageReaction {
  userId: string;
  emoji: string;
}

export interface Message {
  id: string;
  from: string; // id de l'expéditeur — sert à afficher son nom au-dessus du
  // message dans un groupe (voir ui/screens/ConversationScreen.tsx)
  mine: boolean; // true = envoyé par moi
  text: string;
  time: number; // horodatage en millisecondes
  attachment: MessageAttachment | null;
  reactions: MessageReaction[];
}

// Un membre d'un groupe, tel qu'affiché dans la conversation (nom + créature).
export interface GroupMember {
  id: string;
  name: string;
  species: Species;
  color: string;
}

// Groupe fermé façon WhatsApp : les membres sont choisis à la création,
// l'historique reste. Différent d'un Salon (data/salons.ts — une pièce
// ouverte, sans historique) : affiché dans l'onglet Chats, à côté des
// discussions à deux (voir ui/screens/ChatsScreen.tsx).
export interface Group {
  id: string;
  name: string;
  createdBy: string;
  members: GroupMember[];
  lastAt?: number; // date du dernier message (millisecondes)
}
