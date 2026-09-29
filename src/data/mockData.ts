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
    { id: "l1", from: "lea", mine: false, text: "Salut", time: minutesAgo(42), attachment: null, reactions: [] },
    { id: "l2", from: "lea", mine: false, text: "Tu fais quoi ?", time: minutesAgo(41), attachment: null, reactions: [] },
    { id: "l3", from: "me", mine: true, text: "Pas grand-chose, et toi ?", time: minutesAgo(38), attachment: null, reactions: [] },
    { id: "l4", from: "lea", mine: false, text: "Ça va ?", time: minutesAgo(5), attachment: null, reactions: [] },
  ],
  thomas: [
    { id: "t1", from: "me", mine: true, text: "On se voit ce soir ?", time: minutesAgo(120), attachment: null, reactions: [] },
    { id: "t2", from: "thomas", mine: false, text: "Oui, 20h ?", time: minutesAgo(118), attachment: null, reactions: [] },
  ],
  lucas: [
    { id: "u1", from: "lucas", mine: false, text: "Tu as vu le match ?", time: minutesAgo(300), attachment: null, reactions: [] },
    { id: "u2", from: "me", mine: true, text: "Oui, incroyable", time: minutesAgo(298), attachment: null, reactions: [] },
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