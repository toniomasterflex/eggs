// Léa, Thomas et Lucas : des faux amis gérés par le serveur, pour tester Eggs
// sans deuxième ordinateur. Ils répondent aux messages et aux clics.
// (À supprimer ou désactiver avec SEED_BOTS=false quand de vrais amis arrivent.)

import { push } from "./hub.js";
import { insertMessage, createUser, usernameTaken, usernameKey, giveStarterFriends } from "./service.js";
import { query } from "./db.js";

const BOTS = [
  { username: "Léa", species: "cat", color: "rose" },
  { username: "Thomas", species: "fox", color: "peach" },
  { username: "Lucas", species: "penguin", color: "sky" },
];

const REPLIES = ["Haha oui", "Ok !", "Je suis là", "Ah bon ?", "Carrément", "Je te réponds tout à l'heure"];

const botIds: string[] = [];

export async function ensureBots(): Promise<string[]> {
  botIds.length = 0;
  for (const b of BOTS) {
    if (!(await usernameTaken(b.username))) {
      await createUser(b.username, null, { species: b.species, color: b.color, bot: true });
    }
    const rows = await query<{ id: string }>("SELECT id FROM users WHERE username_key = $1", [
      usernameKey(b.username),
    ]);
    botIds.push(rows[0].id);
  }
  return botIds;
}

export async function welcomeNewUser(userId: string) {
  await giveStarterFriends(userId, botIds);
  // Léa dit bonjour : un message non lu pour voir l'indicateur.
  const lea = botIds[0];
  if (lea) {
    const message = await insertMessage(lea, userId, "Salut !");
    push(userId, { type: "message", message });
  }
}

/** Un utilisateur écrit à un robot : il répond au bout de 1,5 à 3 secondes. */
export function botOnMessage(botId: string, userId: string) {
  setTimeout(async () => {
    try {
      const text = REPLIES[Math.floor(Math.random() * REPLIES.length)];
      const message = await insertMessage(botId, userId, text);
      push(userId, { type: "message", message });
    } catch (err) {
      console.error("[bot] réponse impossible", err);
    }
  }, 1500 + Math.random() * 1500);
}

/** Un utilisateur clique sur la créature d'un robot : il clique sur la sienne en retour. */
export function botOnInteraction(botId: string, userId: string) {
  setTimeout(() => {
    push(userId, { type: "interaction", from: botId, target: userId, kind: "poke" });
  }, 3000);
}
