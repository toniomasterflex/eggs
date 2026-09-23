// Données FICTIVES pour tester l'interface. Sera remplacé par le serveur.

import type { Friend, Message } from "./types";

export const FRIENDS: Friend[] = [
  { id: "lea", name: "Léa", species: "cat", color: "rose" },
  { id: "thomas", name: "Thomas", species: "fox", color: "peach" },
  { id: "lucas", name: "Lucas", species: "penguin", color: "sky" },
];

const minutesAgo = (n: number) => Date.now() - n * 60000;

export const INITIAL_MESSAGES: Record<string, Message[]> = {
  lea: [
    { id: "l1", mine: false, text: "Salut", time: minutesAgo(42) },
    { id: "l2", mine: false, text: "Tu fais quoi ?", time: minutesAgo(41) },
    { id: "l3", mine: true, text: "Pas grand-chose, et toi ?", time: minutesAgo(38) },
    { id: "l4", mine: false, text: "Ça va ?", time: minutesAgo(5) },
  ],
  thomas: [
    { id: "t1", mine: true, text: "On se voit ce soir ?", time: minutesAgo(120) },
    { id: "t2", mine: false, text: "Oui, 20h ?", time: minutesAgo(118) },
  ],
  lucas: [
    { id: "u1", mine: false, text: "Tu as vu le match ?", time: minutesAgo(300) },
    { id: "u2", mine: true, text: "Oui, incroyable", time: minutesAgo(298) },
  ],
};

// Nombre de messages non lus par ami au démarrage.
export const INITIAL_UNREAD: Record<string, number> = { lea: 1 };

// Réponses automatiques fictives (pour tester l'arrivée de nouveaux messages).
export const FAKE_REPLIES = [
  "Haha oui",
  "Ok !",
  "Je suis là",
  "Ah bon ?",
  "Carrément",
  "Je te réponds tout à l'heure",
];

// Utilisateurs FICTIFS que l'on peut chercher dans « Ajouter un ami ».
// Sera remplacé par la recherche sur le serveur.
export const USERS: Friend[] = [
  { id: "lea", name: "Léa", species: "cat", color: "rose" },
  { id: "thomas", name: "Thomas", species: "fox", color: "peach" },
  { id: "lucas", name: "Lucas", species: "penguin", color: "sky" },
  { id: "emma", name: "Emma", species: "rabbit", color: "cloud" },
  { id: "noah", name: "Noah", species: "panda", color: "cloud" },
  { id: "chloe", name: "Chloé", species: "frog", color: "mint" },
  { id: "hugo", name: "Hugo", species: "owl", color: "lilac" },
  { id: "manon", name: "Manon", species: "cat", color: "sun" },
];