// Serveur d'Eggs : API (comptes, amis, messages) + WebSocket (temps réel).
//
// Ce qui passe par le temps réel (interactions entre créatures) n'est JAMAIS
// enregistré. Le serveur ne connaît pas la position de la souris : le client
// n'envoie qu'un « j'ai cliqué sur telle créature ».

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { z } from "zod";
import { createSession, deleteSession, deleteSessions, userIdFromToken, verifyPassword } from "./auth.js";
import { botOnInteraction, botOnMessage, ensureBots, welcomeNewUser } from "./bots.js";
import { config } from "./config.js";
import { migrate } from "./db.js";
import { addConnection, closeUser, isOnline, push, removeConnection } from "./hub.js";
import { enterSalon, leaveAllSalons, leaveSalon, salonPresenceCounts, whoIsInSalon } from "./salons.js";
import * as svc from "./service.js";

const SPECIES = ["chick", "cat", "fox", "penguin", "rabbit", "panda", "frog", "owl"];
const COLORS = ["sun", "rose", "sky", "mint", "lilac", "peach", "cloud"];

const app = Fastify({ logger: { level: "warn" } });
await app.register(cors, { origin: true, allowedHeaders: ["Content-Type", "Authorization"], methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"] });
await app.register(websocket);

// Accepte aussi une requête JSON sans contenu (ex. « marquer comme lu »).
app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
  if (!body) return done(null, undefined);
  try {
    done(null, JSON.parse(body as string));
  } catch (err) {
    done(err as Error, undefined);
  }
});

await migrate();
if (config.seedBots) await ensureBots();

// ------------------------------------------------------------ Utilitaires

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

app.setErrorHandler((err: any, _req, reply) => {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
  if (err?.name === "ZodError" || err?.issues) return reply.status(400).send({ error: "Données invalides." });
  app.log.error(err);
  return reply.status(500).send({ error: "Erreur du serveur." });
});

/** Limite simple : max 15 tentatives de connexion / création par minute et par adresse. */
const attempts = new Map<string, { count: number; reset: number }>();
function limitAuth(ip: string) {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || e.reset < now) {
    attempts.set(ip, { count: 1, reset: now + 60_000 });
    return;
  }
  if (++e.count > 15) throw new HttpError(429, "Trop d'essais, réessaie dans une minute.");
}

function bearer(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

async function requireUser(req: { headers: { authorization?: string } }): Promise<string> {
  const id = await userIdFromToken(bearer(req.headers.authorization));
  if (!id) throw new HttpError(401, "Connexion requise.");
  return id;
}

const usernameSchema = z
  .string()
  .trim()
  .min(3, "Pseudo trop court (3 caractères minimum).")
  .max(20, "Pseudo trop long (20 caractères maximum).")
  .regex(/^[\p{L}\p{N}_]+$/u, "Pseudo : lettres, chiffres et _ seulement.");
const passwordSchema = z.string().min(8, "Mot de passe trop court (8 caractères minimum).").max(200);

// ------------------------------------------------------------------ Comptes

app.get("/health", async () => ({ ok: true }));

app.post("/auth/register", async (req, reply) => {
  limitAuth(req.ip);
  const body = z.object({ username: usernameSchema, password: passwordSchema }).safeParse(req.body);
  if (!body.success) throw new HttpError(400, body.error.issues[0]?.message ?? "Données invalides.");
  const { username, password } = body.data;
  if (await svc.usernameTaken(username)) throw new HttpError(409, "Ce pseudo est déjà pris.");
  const user = await svc.createUser(username, password);
  await welcomeNewUser(user.id);
  await svc.giveWelcomeEgg(user.id); // pas de créature au départ : un œuf à ouvrir
  const token = await createSession(user.id);
  return reply.status(201).send({ token, user });
});

app.post("/auth/login", async (req) => {
  limitAuth(req.ip);
  const body = z.object({ username: z.string(), password: z.string() }).safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Données invalides.");
  const cred = await svc.getCredentials(body.data.username);
  // Même message si le pseudo n'existe pas ou si le mot de passe est faux.
  if (!cred || !(await verifyPassword(body.data.password, cred.password_hash))) {
    throw new HttpError(401, "Pseudo ou mot de passe incorrect.");
  }
  const token = await createSession(cred.id);
  return { token, user: { id: cred.id, username: cred.username, species: cred.species, color: cred.color } };
});

app.post("/auth/logout", async (req) => {
  await requireUser(req);
  const token = bearer(req.headers.authorization);
  if (token) await deleteSession(token);
  return { ok: true };
});

app.post("/auth/logout-all", async (req) => {
  const id = await requireUser(req);
  await deleteSessions(id);
  closeUser(id);
  return { ok: true };
});

app.post("/me/password", async (req) => {
  const id = await requireUser(req);
  limitAuth(req.ip);
  const body = z.object({ current: z.string(), next: passwordSchema }).safeParse(req.body);
  if (!body.success) throw new HttpError(400, body.error.issues[0]?.message ?? "Données invalides.");
  const hash = await svc.getPasswordHash(id);
  if (!hash || !(await verifyPassword(body.data.current, hash))) {
    throw new HttpError(401, "Mot de passe actuel incorrect.");
  }
  await svc.setPassword(id, body.data.next);
  // Les autres appareils / fenêtres connectés ailleurs sont déconnectés.
  await deleteSessions(id, bearer(req.headers.authorization));
  return { ok: true };
});

app.delete("/me", async (req) => {
  const id = await requireUser(req);
  limitAuth(req.ip);
  const body = z.object({ password: z.string() }).safeParse(req.body);
  if (!body.success) throw new HttpError(400, "Données invalides.");
  const hash = await svc.getPasswordHash(id);
  if (!hash || !(await verifyPassword(body.data.password, hash))) {
    throw new HttpError(401, "Mot de passe incorrect.");
  }
  const friends = await svc.friendIds(id);
  await svc.deleteUser(id);
  for (const f of friends) push(f, { type: "friend-removed", userId: id });
  closeUser(id);
  return { ok: true };
});

app.get("/me", async (req) => {
  const id = await requireUser(req);
  const user = await svc.getUser(id);
  if (!user) throw new HttpError(401, "Connexion requise.");
  return user;
});

app.patch("/me", async (req) => {
  const id = await requireUser(req);
  const body = z
    .object({ species: z.enum(SPECIES as [string, ...string[]]).optional(), color: z.enum(COLORS as [string, ...string[]]).optional() })
    .parse(req.body);
  const user = await svc.updateAppearance(id, body.species, body.color);
  // Mes amis voient mon apparence changer.
  for (const friend of await svc.friendIds(id)) push(friend, { type: "friend-updated", user });
  return user;
});

// -------------------------------------------------------------------- Amis

app.get("/users/search", async (req) => {
  const id = await requireUser(req);
  const { q } = z.object({ q: z.string().max(40) }).parse(req.query);
  return svc.searchUsers(q, id);
});

app.get("/friends", async (req) => {
  const id = await requireUser(req);
  const list = await svc.listFriends(id);
  return list.map((f) => ({ ...f, online: isOnline(f.id) }));
});

app.post("/friends", async (req, reply) => {
  const id = await requireUser(req);
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
  if (userId === id) throw new HttpError(400, "Tu ne peux pas t'ajouter toi-même.");
  const other = await svc.getUser(userId);
  if (!other) throw new HttpError(404, "Utilisateur introuvable.");
  await svc.addFriendship(id, userId);
  const me = await svc.getUser(id);
  push(userId, { type: "friend-added", user: { ...me, online: isOnline(id) } }); // l'autre me voit apparaître
  return reply.status(201).send({ ...other, online: isOnline(other.id) });
});

app.delete("/friends/:friendId", async (req) => {
  const id = await requireUser(req);
  const { friendId } = z.object({ friendId: z.string().uuid() }).parse(req.params);
  await svc.removeFriendship(id, friendId);
  push(friendId, { type: "friend-removed", userId: id });
  return { ok: true };
});

// ---------------------------------------------------------------- Messages

app.get("/messages/:friendId", async (req) => {
  const id = await requireUser(req);
  const { friendId } = z.object({ friendId: z.string().uuid() }).parse(req.params);
  const q = z
    .object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.coerce.number().int().optional() })
    .parse(req.query);
  if (!(await svc.areFriends(id, friendId))) throw new HttpError(403, "Vous n'êtes pas amis.");
  return svc.listMessages(id, friendId, q.limit, q.before);
});

app.post("/messages/:friendId", async (req, reply) => {
  const id = await requireUser(req);
  const { friendId } = z.object({ friendId: z.string().uuid() }).parse(req.params);
  const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
  if (!(await svc.areFriends(id, friendId))) throw new HttpError(403, "Vous n'êtes pas amis.");
  const message = await svc.insertMessage(id, friendId, text);
  push(friendId, { type: "message", message });
  push(id, { type: "message", message }); // mes autres fenêtres reçoivent aussi le message
  if (await svc.isBot(friendId)) botOnMessage(friendId, id);
  return reply.status(201).send(message);
});

app.post("/messages/:friendId/read", async (req) => {
  const id = await requireUser(req);
  const { friendId } = z.object({ friendId: z.string().uuid() }).parse(req.params);
  await svc.markRead(id, friendId);
  push(id, { type: "read", friendId }); // mes autres fenêtres effacent le point « non lu »
  push(friendId, { type: "seen", by: id, at: Date.now() }); // il voit son message marqué « vu »
  return { ok: true };
});

// ------------------------------------------------------- Œufs et créatures

app.get("/eggs", async (req) => {
  const id = await requireUser(req);
  return svc.listEggs(id);
});

app.post("/eggs/:eggId/open", async (req) => {
  const id = await requireUser(req);
  const { eggId } = z.object({ eggId: z.string().uuid() }).parse(req.params);
  const creature = await svc.openEgg(id, eggId);
  if (!creature) throw new HttpError(404, "Œuf introuvable.");
  const user = await svc.getUser(id);
  for (const friend of await svc.friendIds(id)) push(friend, { type: "friend-updated", user });
  return creature;
});

app.get("/creatures", async (req) => {
  const id = await requireUser(req);
  return svc.listCreatures(id);
});

app.post("/creatures/:creatureId/activate", async (req) => {
  const id = await requireUser(req);
  const { creatureId } = z.object({ creatureId: z.string().uuid() }).parse(req.params);
  const user = await svc.activateCreature(id, creatureId);
  if (!user) throw new HttpError(404, "Créature introuvable.");
  for (const friend of await svc.friendIds(id)) push(friend, { type: "friend-updated", user });
  return user;
});

// Offrir un œuf qu'on possède à un ami : transfert immédiat, pas de
// proposition à accepter — un cadeau, pas une fusion (voir décision produit).
app.post("/eggs/:eggId/gift", async (req) => {
  const id = await requireUser(req);
  const { eggId } = z.object({ eggId: z.string().uuid() }).parse(req.params);
  const { friendId } = z.object({ friendId: z.string().uuid() }).parse(req.body);
  if (friendId === id) throw new HttpError(400, "Tu ne peux pas te l'offrir à toi-même.");
  if (!(await svc.areFriends(id, friendId))) throw new HttpError(403, "Vous n'êtes pas amis.");
  const egg = await svc.giftEgg(id, eggId, friendId);
  if (!egg) throw new HttpError(404, "Œuf introuvable.");
  const from = await svc.getUser(id);
  push(friendId, { type: "egg-gift", egg, fromUsername: from?.username ?? "" });
  return egg;
});

// ------------------------------------------------------------------- Shop
//
// MAQUETTE : pas de paiement réel branché ici pour l'instant (voir
// service.ts : buyEggBox) — acheter une boîte l'offre directement.

app.get("/shop/eggs", async (req) => {
  await requireUser(req);
  return svc.EGG_BOXES;
});

app.post("/shop/eggs/:boxId", async (req) => {
  const id = await requireUser(req);
  const { boxId } = z.object({ boxId: z.string() }).parse(req.params);
  const count = await svc.buyEggBox(id, boxId);
  if (count === 0) throw new HttpError(404, "Boîte introuvable.");
  return { count };
});

app.get("/shop/skins", async (req) => {
  await requireUser(req);
  return svc.SKINS;
});

app.post("/shop/skins/:skinId", async (req) => {
  const id = await requireUser(req);
  const { skinId } = z.object({ skinId: z.string() }).parse(req.params);
  const creature = await svc.buySkin(id, skinId);
  if (!creature) throw new HttpError(409, "Skin introuvable ou déjà possédé.");
  if (creature.active) {
    // Devenu l'apparence active : mes amis le voient tout de suite.
    const user = await svc.getUser(id);
    for (const friend of await svc.friendIds(id)) push(friend, { type: "friend-updated", user });
  }
  return creature;
});

// ----------------------------------------------------------------- Salons
//
// Chaque personne a un seul salon (son id = celui de son compte). Ses amis
// peuvent y entrer et en sortir librement, sauf ceux qu'elle a bloqués. Qui
// est dedans en ce moment vit en mémoire (salons.ts) ; le nom choisi et la
// liste de blocage sont en base (service.ts).

/** Salon accessible à `id` : soit le sien, soit celui d'un ami non bloquant. */
async function assertSalonAccess(id: string, ownerId: string) {
  if (ownerId === id) return;
  if (!(await svc.areFriends(id, ownerId))) throw new HttpError(403, "Vous n'êtes pas amis.");
  if (await svc.isBlockedFromSalon(ownerId, id)) throw new HttpError(403, "Tu n'as pas accès à ce salon.");
}

/** Prévient tout le monde présent dans un salon que la liste vient de changer
 *  (avec les infos publiques de chacun, pas juste des identifiants : les
 *  personnes présentes ne sont pas forcément toutes amies entre elles). */
async function broadcastSalonPresence(salonId: string, presentIds: string[]) {
  const present = await svc.getUsersByIds(presentIds);
  for (const uid of presentIds) push(uid, { type: "salon-presence", salonId, present });
}

app.get("/salons", async (req) => {
  const id = await requireUser(req);
  const [mine, friends] = await Promise.all([svc.getSalon(id), svc.listFriendSalons(id)]);
  const counts = salonPresenceCounts();
  const withCount = (s: svc.Salon) => ({ ...s, present: counts.get(s.id) ?? 0 });
  return { mine: mine ? withCount(mine) : null, friends: friends.map(withCount) };
});

app.patch("/salons/me", async (req) => {
  const id = await requireUser(req);
  const { name } = z.object({ name: z.string().trim().min(1, "Nom trop court.").max(40, "Nom trop long.") }).parse(req.body);
  await svc.renameSalon(id, name);
  return svc.getSalon(id);
});

app.get("/salons/blocks", async (req) => {
  const id = await requireUser(req);
  return svc.listSalonBlocks(id);
});

app.post("/salons/blocks", async (req, reply) => {
  const id = await requireUser(req);
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
  if (userId === id) throw new HttpError(400, "Tu ne peux pas te bloquer toi-même.");
  await svc.blockFromSalon(id, userId);
  // Si la personne bloquée est actuellement dans mon salon, elle en sort tout de suite.
  const present = leaveSalon(id, userId);
  push(userId, { type: "salon-blocked", salonId: id });
  await broadcastSalonPresence(id, present);
  return reply.status(201).send({ ok: true });
});

app.delete("/salons/blocks/:userId", async (req) => {
  const id = await requireUser(req);
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
  await svc.unblockFromSalon(id, userId);
  return { ok: true };
});

app.get("/salons/:ownerId", async (req) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  const salon = await svc.getSalon(ownerId);
  if (!salon) throw new HttpError(404, "Salon introuvable.");
  await assertSalonAccess(id, ownerId);
  const presentIds = whoIsInSalon(ownerId);
  const present = await svc.getUsersByIds(presentIds);
  return { ...salon, present };
});

app.post("/salons/:ownerId/enter", async (req) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  await assertSalonAccess(id, ownerId);
  const present = enterSalon(ownerId, id);
  await broadcastSalonPresence(ownerId, present);
  return { present: await svc.getUsersByIds(present) };
});

app.post("/salons/:ownerId/leave", async (req) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  const present = leaveSalon(ownerId, id);
  await broadcastSalonPresence(ownerId, present);
  const stillPresent = await svc.getUsersByIds(present);
  push(id, { type: "salon-presence", salonId: ownerId, present: stillPresent }); // je vois aussi le salon se vider chez moi
  return { present: stillPresent };
});

// -------------------------------------------------------------- Temps réel

/** Qui voit réagir la créature « target » quand « sender » clique dessus ? */
async function relayInteraction(sender: string, target: string) {
  const recipients = new Set<string>();
  if (target === sender) {
    // Je clique sur ma créature : mes amis qui l'affichent la voient sauter.
    for (const f of await svc.friendIds(sender)) recipients.add(f);
  } else {
    // Je clique sur celle d'un ami : elle saute chez lui, et chez nos amis communs.
    if (!(await svc.areFriends(sender, target))) return;
    recipients.add(target);
    for (const f of await svc.mutualFriendIds(sender, target)) recipients.add(f);
    if (await svc.isBot(target)) botOnInteraction(target, sender);
  }
  recipients.delete(sender);
  for (const r of recipients) {
    push(r, { type: "interaction", from: sender, target, kind: "poke" });
  }
}

app.register(async (instance) => {
  instance.get("/ws", { websocket: true }, async (socket, req) => {
    const token = (req.query as { token?: string }).token;
    const userId = await userIdFromToken(token);
    if (!userId) {
      socket.close(4401, "Connexion requise");
      return;
    }
    const cameOnline = addConnection(userId, socket);
    socket.send(JSON.stringify({ type: "hello", userId }));
    if (cameOnline) {
      for (const f of await svc.friendIds(userId)) push(f, { type: "presence", userId, online: true });
    }

    let lastInteraction = 0;
    socket.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === "interact" && typeof msg.target === "string") {
          const now = Date.now();
          if (now - lastInteraction < 300) return; // anti-spam
          lastInteraction = now;
          await relayInteraction(userId, msg.target);
        } else if (msg?.type === "salon-message" && typeof msg.salonId === "string" && typeof msg.text === "string") {
          // Discussion de salon : uniquement en direct, rien n'est enregistré
          // en base. Il faut être présent dans le salon pour parler.
          const text = msg.text.trim().slice(0, 1000);
          if (!text) return;
          const present = whoIsInSalon(msg.salonId);
          if (!present.includes(userId)) return;
          const [from] = await svc.getUsersByIds([userId]);
          if (!from) return;
          const payload = { type: "salon-message", salonId: msg.salonId, from, text, at: Date.now() };
          for (const uid of present) push(uid, payload);
        }
      } catch {
        // message illisible : on l'ignore
      }
    });

    // Garde la connexion en vie (et détecte les fenêtres fermées).
    const timer = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 30_000);
    socket.on("close", async () => {
      clearInterval(timer);
      if (removeConnection(userId, socket)) {
        for (const f of await svc.friendIds(userId)) push(f, { type: "presence", userId, online: false });
        // Déconnecté : on le retire de tous les salons où il se trouvait, et
        // on prévient ceux qui y sont encore (présence).
        for (const salonId of leaveAllSalons(userId)) {
          const present = whoIsInSalon(salonId);
          await broadcastSalonPresence(salonId, present);
        }
      }
    });
  });
});

// ---------------------------------------------------------------- Démarrage

await app.listen({ port: config.port, host: config.host });
console.log(`Serveur Eggs prêt : http://${config.host}:${config.port}  (base : ${config.dataDir})`);
