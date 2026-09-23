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
  lastAt?: number; // date du dernier message échangé (millisecondes)
  readAt?: number; // date jusqu'à laquelle cet ami a lu mes messages
  online?: boolean; // connecté au serveur en ce moment
}

export interface Message {
  id: string;
  mine: boolean; // true = envoyé par moi
  text: string;
  time: number; // horodatage en millisecondes
}
