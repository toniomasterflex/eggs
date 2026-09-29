// Serveur d'Eggs : API (comptes, amis, messages) + WebSocket (temps réel).
//
// Ce qui passe par le temps réel (interactions entre créatures) n'est JAMAIS
// enregistré. Le serveur ne connaît pas la position de la souris : le client
// n'envoie qu'un « j'ai cliqué sur telle créature ».

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { z } from "zod";
import {
  clearEmailVerificationTokens,
  consumeEmailVerificationToken,
  createEmailVerificationToken,
  createSession,
  deleteSession,
  deleteSessions,
  hashPassword,
  userIdFromToken,
  verifyPassword,
} from "./auth.js";
import { botOnInteraction, botOnMessage, ensureBots, welcomeNewUser } from "./bots.js";
import { config } from "./config.js";
import { migrate } from "./db.js";
import { sendVerificationEmail } from "./mail.js";
import { addConnection, closeUser, isOnline, push, removeConnection } from "./hub.js";
import { enterSalon, leaveAllSalons, leaveSalon, salonPresenceCounts, whoIsInSalon } from "./salons.js";
import { joinCall, leaveAllCalls, leaveCall, MAX_CALL_SIZE, whoIsInCall } from "./calls.js";
import * as svc from "./service.js";
import type { AttachmentKind } from "./service.js";

const SPECIES = ["chick", "cat", "fox", "penguin", "rabbit", "panda", "frog", "owl"];
const COLORS = ["sun", "rose", "sky", "mint", "lilac", "peach", "cloud"];

const app = Fastify({ logger: { level: "warn" } });
// PUT ajouté pour poser une réaction (voir plus bas : PUT /messages/:messageId/reaction) —
// oublié au premier passage, ce qui bloquait silencieusement la requête côté
// navigateur (erreur CORS, jamais envoyée au serveur, vue comme "serveur
// injoignable" côté app).
await app.register(cors, { origin: true, allowedHeaders: ["Content-Type", "Authorization"], methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] });
await app.register(websocket);
// Photos / vidéos / sons partagés en conversation (voir plus bas :
// POST /messages/:friendId/attachment). Un seul fichier à la fois, taille
// plafonnée (voir config.ts) : le client n'a de toute façon qu'un fichier
// glissé/collé à envoyer à la fois pour l'instant.
await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
await mkdir(config.uploadsDir, { recursive: true });
await app.register(fastifyStatic, { root: path.resolve(config.uploadsDir), prefix: "/uploads/" });

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

/** Limite simple : max 25 tentatives de connexion / création par minute et par
 *  adresse. Relevée de 15 à 25 le 27/09/2026 (ajout de l'email à
 *  l'inscription, voir /auth/register) : le scénario complet de
 *  smoke.ts enchaîne les tentatives plus vite qu'un vrai attaquant ne serait
 *  freiné par le coût de scrypt (voir auth.ts), donc la marge ne réduit pas
 *  la protection réelle. */
const attempts = new Map<string, { count: number; reset: number }>();
function limitAuth(ip: string) {
  const now = Date.now();
  const e = attempts.get(ip);
  if (!e || e.reset < now) {
    attempts.set(ip, { count: 1, reset: now + 60_000 });
    return;
  }
  if (++e.count > 25) throw new HttpError(429, "Trop d'essais, réessaie dans une minute.");
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
// Demandée à l'inscription depuis le 27/09/2026 ("comme toutes les apps") —
// voir db.ts pour ce qu'elle sert (pas encore vérifiée, base pour un futur
// matching de contacts).
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Adresse email invalide.")
  .max(200, "Adresse email trop longue.");

// ------------------------------------------------------------------ Comptes

app.get("/health", async () => ({ ok: true }));

app.post("/auth/register", async (req, reply) => {
  limitAuth(req.ip);
  const body = z
    .object({ username: usernameSchema, email: emailSchema, password: passwordSchema })
    .safeParse(req.body);
  if (!body.success) throw new HttpError(400, body.error.issues[0]?.message ?? "Données invalides.");
  const { username, email, password } = body.data;
  if (await svc.usernameTaken(username)) throw new HttpError(409, "Ce pseudo est déjà pris.");
  if (await svc.emailTaken(email)) throw new HttpError(409, "Cette adresse email est déjà utilisée.");
  const user = await svc.createUser(username, password, { email });
  await welcomeNewUser(user.id);
  await svc.giveWelcomeEgg(user.id); // pas de créature au départ : un œuf à ouvrir
  const token = await createSession(user.id);
  // Email de vérification (voir mail.ts) : jamais bloquant, une erreur
  // d'envoi ne doit pas empêcher la création du compte (voir l'en-tête de
  // mail.ts — sendVerificationEmail ne lance jamais d'exception).
  const verificationToken = await createEmailVerificationToken(user.id);
  await sendVerificationEmail(email, username, verificationToken);
  return reply.status(201).send({
    token,
    user,
    // Uniquement quand RESEND_API_KEY n'est pas configuré (voir config.ts) :
    // aucun email n'est réellement envoyé, ce jeton permet de quand même
    // tester GET /verify-email/:token en développement (voir smoke.ts). Ce
    // champ disparaît tout seul dès qu'un vrai envoi est configuré.
    ...(config.resendApiKey ? {} : { devVerificationToken: verificationToken }),
  });
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
  // email/emailVerified : jamais dans svc.getUser (voir service.ts, partagé
  // avec le profil DES AUTRES) — ajoutés ici seulement, pour mon propre compte.
  const emailStatus = await svc.getEmailStatus(id);
  return { ...user, email: emailStatus?.email ?? null, emailVerified: emailStatus?.emailVerified ?? false };
});

// Renvoie un nouvel email de vérification (voir mail.ts) : utile si le
// premier n'est jamais arrivé, ou si son lien (24h) a expiré. Un seul jeton
// valide à la fois (clearEmailVerificationTokens avant d'en créer un autre).
app.post("/me/resend-verification", async (req, reply) => {
  const id = await requireUser(req);
  limitAuth(req.ip);
  const status = await svc.getEmailStatus(id);
  if (!status?.email) throw new HttpError(400, "Aucune adresse email sur ce compte.");
  if (status.emailVerified) return { ok: true, alreadyVerified: true };
  const user = await svc.getUser(id);
  await clearEmailVerificationTokens(id);
  const verificationToken = await createEmailVerificationToken(id);
  await sendVerificationEmail(status.email, user?.username ?? "", verificationToken);
  return reply.send({
    ok: true,
    ...(config.resendApiKey ? {} : { devVerificationToken: verificationToken }),
  });
});

// Lien cliqué depuis l'email de vérification (voir mail.ts). Toujours 200 :
// que ce soit réussi ou non, c'est une page pour un humain, pas une réponse
// d'API à interpréter par du code (voir verifyEmailPageHtml plus bas).
app.get("/verify-email/:token", async (req, reply) => {
  const parsed = z.object({ token: z.string().min(1) }).safeParse(req.params);
  const userId = parsed.success ? await consumeEmailVerificationToken(parsed.data.token) : null;
  if (userId) await svc.markEmailVerified(userId);
  reply.type("text/html").send(verifyEmailPageHtml(!!userId));
});

app.patch("/me", async (req) => {
  const id = await requireUser(req);
  const body = z
    .object({
      species: z.enum(SPECIES as [string, ...string[]]).optional(),
      color: z.enum(COLORS as [string, ...string[]]).optional(),
      // Pseudos affichés sur le profil/Répertoire (voir svc.updateProfileLinks) :
      // chaîne vide = effacer, absent = ne pas toucher.
      discord: z.string().trim().max(40).optional(),
      steam: z.string().trim().max(40).optional(),
    })
    .parse(req.body);
  await svc.updateAppearance(id, body.species, body.color);
  const user = await svc.updateProfileLinks(id, body.discord, body.steam);
  if (!user) throw new HttpError(401, "Connexion requise.");
  // Mes amis voient mon apparence/mes pseudos changer.
  for (const friend of await svc.friendIds(id)) push(friend, { type: "friend-updated", user });
  return user;
});

// Statut « absent » réglé à la main (façon Slack/Discord, demande d'Antoine
// du 21/09/2026) — distinct de la connexion elle-même (voir isOnline/hub.ts) :
// combiné aux deux, ça donne le point vert/orange/rouge côté client (voir
// service.ts : setAwayStatus, et ApiUser.away côté app). On repousse le même
// événement "friend-updated" que PATCH /me ci-dessus, pour que mes amis me
// voient passer absent/de retour en direct, sans event dédié à inventer.
app.patch("/me/status", async (req) => {
  const id = await requireUser(req);
  const { away } = z.object({ away: z.boolean() }).parse(req.body);
  const user = await svc.setAwayStatus(id, away);
  if (!user) throw new HttpError(401, "Connexion requise.");
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

// Photo, vidéo ou son glissé/collé en conversation (voir ConversationScreen.tsx
// côté client : pas de sélecteur de fichiers, juste glisser-déposer ou coller).
// Un seul fichier par requête. Le type est déduit du Content-Type envoyé par
// le client (voir data/api.ts : sendAttachment) plutôt que de l'extension.
const ATTACHMENT_KIND_OF: Record<string, AttachmentKind> = { image: "image", video: "video", audio: "audio" };

function extFromMime(mime: string): string {
  // Le navigateur peut envoyer des paramètres après le type de base (ex.
  // "audio/webm;codecs=opus" pour un enregistrement micro via MediaRecorder,
  // voir ConversationScreen.tsx) : on les ignore, sinon "codecsopus" finit
  // dans l'extension du fichier.
  const base = mime.split(";")[0] ?? mime;
  const sub = base.split("/")[1] ?? "bin";
  const clean = sub.replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return clean || "bin";
}

app.post("/messages/:friendId/attachment", async (req, reply) => {
  const id = await requireUser(req);
  const { friendId } = z.object({ friendId: z.string().uuid() }).parse(req.params);
  if (!(await svc.areFriends(id, friendId))) throw new HttpError(403, "Vous n'êtes pas amis.");

  const data = await req.file();
  if (!data) throw new HttpError(400, "Aucun fichier reçu.");

  const kind = ATTACHMENT_KIND_OF[data.mimetype.split("/")[0]];
  if (!kind) throw new HttpError(415, "Photo, vidéo ou son seulement.");

  // toBuffer() lève une erreur si le fichier dépasse limits.fileSize (voir
  // l'enregistrement du plugin plus haut) — pas de flag à revérifier après coup.
  let buffer: Buffer;
  try {
    buffer = await data.toBuffer();
  } catch (err) {
    app.log.warn(err, "pièce jointe refusée");
    const mb = Math.round(config.maxUploadBytes / (1024 * 1024));
    throw new HttpError(413, `Fichier trop volumineux (${mb} Mo max).`);
  }

  const filename = `${randomUUID()}.${extFromMime(data.mimetype)}`;
  await writeFile(path.join(config.uploadsDir, filename), buffer);

  // URL relative (pas d'hôte/protocole ici) : le client la complète avec
  // l'adresse du serveur qu'il utilise déjà (voir data/api.ts : SERVER_URL) —
  // évite tout risque de mauvais hôte deviné depuis la requête (proxy, etc.).
  const message = await svc.insertAttachmentMessage(id, friendId, {
    url: `/uploads/${filename}`,
    kind,
    name: data.filename || filename,
  });
  push(friendId, { type: "message", message });
  push(id, { type: "message", message });
  if (await svc.isBot(friendId)) botOnMessage(friendId, id);
  return reply.status(201).send(message);
});

// Réaction façon iMessage/WhatsApp sur un message (voir ConversationScreen.tsx
// côté client : survoler un message fait apparaître un bouton qui ouvre une
// rangée de 6 emojis). Marche aussi sur un message de groupe (voir
// reactionRecipients ci-dessous) : pas besoin de connaître friendId/groupId
// dans l'URL, le message renvoyé porte déjà from/to/groupId.
const reactionParams = z.object({ messageId: z.coerce.number().int().positive() });
const reactionBody = z.object({ emoji: z.string().trim().min(1).max(16) });

/** À qui pousser la mise à jour d'une réaction : les deux participants pour
 *  un message à deux, tous les membres du groupe pour un message de groupe. */
async function reactionRecipients(message: svc.Message): Promise<string[]> {
  if (message.groupId) return svc.groupMemberIds(message.groupId);
  return message.to ? [message.from, message.to] : [message.from];
}

app.put("/messages/:messageId/reaction", async (req, reply) => {
  const id = await requireUser(req);
  const { messageId } = reactionParams.parse(req.params);
  const { emoji } = reactionBody.parse(req.body);
  const message = await svc.setReaction(messageId, id, emoji);
  if (!message) throw new HttpError(404, "Message introuvable.");
  for (const uid of await reactionRecipients(message)) push(uid, { type: "reaction", message });
  return reply.status(200).send(message);
});

app.delete("/messages/:messageId/reaction", async (req, reply) => {
  const id = await requireUser(req);
  const { messageId } = reactionParams.parse(req.params);
  const message = await svc.removeReaction(messageId, id);
  if (!message) throw new HttpError(404, "Message introuvable.");
  for (const uid of await reactionRecipients(message)) push(uid, { type: "reaction", message });
  return reply.status(200).send(message);
});

app.post("/messages/:friendId/read", async (req) => {
  const id = await requireUser(req);
  const { friendId } = z.object({ friendId: z.string().uuid() }).parse(req.params);
  await svc.markRead(id, friendId);
  push(id, { type: "read", friendId }); // mes autres fenêtres effacent le point « non lu »
  push(friendId, { type: "seen", by: id, at: Date.now() }); // il voit son message marqué « vu »
  return { ok: true };
});

// ----------------------------------------------------------------- Groupes
//
// Différent des Salons (une pièce ouverte, sans historique, plus bas) : un
// groupe fermé façon WhatsApp, affiché dans l'onglet Chats à côté des
// discussions à deux (voir ConversationScreen.tsx côté client).

const groupIdParams = z.object({ groupId: z.string().uuid() });

/** Vérifie que `id` fait partie de ce groupe (sinon 403 — pas de groupe
 *  ouvert à qui le demande, contrairement aux salons). */
async function assertGroupMember(id: string, groupId: string) {
  if (!(await svc.isGroupMember(groupId, id))) throw new HttpError(403, "Tu ne fais pas partie de ce groupe.");
}

app.post("/groups", async (req, reply) => {
  const id = await requireUser(req);
  const { name, memberIds } = z
    .object({
      name: z.string().trim().min(1, "Nom trop court.").max(60, "Nom trop long."),
      // Au moins 2 amis (donc 3 personnes en tout, créateur inclus) : à 2
      // personnes ce serait juste un doublon du chat 1-1 déjà existant avec
      // cet ami (voir la discussion produit du 26/09/2026 — un seul chat par
      // paire, imposé ici plutôt qu'au niveau du chat 1-1 qui n'a de toute
      // façon pas de création explicite, voir data/store.ts : threadIdOf).
      memberIds: z.array(z.string().uuid()).min(2, "Choisis au moins 2 amis (à 2, utilise plutôt le chat direct)."),
    })
    .parse(req.body);
  // On ne peut ajouter que des amis directement à la création (comme pour un
  // œuf offert) : pas d'invitation à un inconnu.
  for (const uid of memberIds) {
    if (!(await svc.areFriends(id, uid))) throw new HttpError(400, "Tu ne peux ajouter que des amis.");
  }
  const group = await svc.createGroup(id, name, memberIds);
  // Le créateur voit le groupe tout de suite via la réponse HTTP ; les autres
  // membres (et mes propres autres fenêtres) l'apprennent par ici.
  for (const uid of memberIds) push(uid, { type: "group-created", group });
  push(id, { type: "group-created", group });
  return reply.status(201).send(group);
});

app.get("/groups", async (req) => {
  const id = await requireUser(req);
  return svc.listGroups(id);
});

app.get("/groups/:groupId", async (req) => {
  const id = await requireUser(req);
  const { groupId } = groupIdParams.parse(req.params);
  await assertGroupMember(id, groupId);
  const group = await svc.getGroup(groupId);
  if (!group) throw new HttpError(404, "Groupe introuvable.");
  return group;
});

app.get("/groups/:groupId/messages", async (req) => {
  const id = await requireUser(req);
  const { groupId } = groupIdParams.parse(req.params);
  await assertGroupMember(id, groupId);
  const q = z
    .object({ limit: z.coerce.number().int().min(1).max(100).default(50), before: z.coerce.number().int().optional() })
    .parse(req.query);
  return svc.listGroupMessages(groupId, q.limit, q.before);
});

app.post("/groups/:groupId/messages", async (req, reply) => {
  const id = await requireUser(req);
  const { groupId } = groupIdParams.parse(req.params);
  await assertGroupMember(id, groupId);
  const { text } = z.object({ text: z.string().trim().min(1).max(2000) }).parse(req.body);
  const message = await svc.insertGroupMessage(id, groupId, text);
  for (const uid of await svc.groupMemberIds(groupId)) push(uid, { type: "message", message });
  return reply.status(201).send(message);
});

app.post("/groups/:groupId/messages/attachment", async (req, reply) => {
  const id = await requireUser(req);
  const { groupId } = groupIdParams.parse(req.params);
  await assertGroupMember(id, groupId);

  const data = await req.file();
  if (!data) throw new HttpError(400, "Aucun fichier reçu.");
  const kind = ATTACHMENT_KIND_OF[data.mimetype.split("/")[0]];
  if (!kind) throw new HttpError(415, "Photo, vidéo ou son seulement.");

  let buffer: Buffer;
  try {
    buffer = await data.toBuffer();
  } catch (err) {
    app.log.warn(err, "pièce jointe refusée");
    const mb = Math.round(config.maxUploadBytes / (1024 * 1024));
    throw new HttpError(413, `Fichier trop volumineux (${mb} Mo max).`);
  }

  const filename = `${randomUUID()}.${extFromMime(data.mimetype)}`;
  await writeFile(path.join(config.uploadsDir, filename), buffer);

  const message = await svc.insertGroupAttachmentMessage(id, groupId, {
    url: `/uploads/${filename}`,
    kind,
    name: data.filename || filename,
  });
  for (const uid of await svc.groupMemberIds(groupId)) push(uid, { type: "message", message });
  return reply.status(201).send(message);
});

app.post("/groups/:groupId/read", async (req) => {
  const id = await requireUser(req);
  const { groupId } = groupIdParams.parse(req.params);
  await assertGroupMember(id, groupId);
  await svc.markGroupRead(groupId, id);
  return { ok: true };
});

// Quitter, pas supprimer : le groupe continue d'exister pour les autres
// membres (voir décision produit pour les salons/amis, même logique ici).
app.post("/groups/:groupId/leave", async (req) => {
  const id = await requireUser(req);
  const { groupId } = groupIdParams.parse(req.params);
  await assertGroupMember(id, groupId);
  await svc.leaveGroup(groupId, id);
  push(id, { type: "group-left", groupId }); // mes autres fenêtres le retirent aussi
  const group = await svc.getGroup(groupId);
  if (group) for (const uid of await svc.groupMemberIds(groupId)) push(uid, { type: "group-updated", group });
  return { ok: true };
});

// Supprimer : réservé au créateur, contrairement à quitter ci-dessus — le
// groupe disparaît alors pour TOUT LE MONDE (voir svc.deleteGroup).
app.delete("/groups/:groupId", async (req) => {
  const id = await requireUser(req);
  const { groupId } = groupIdParams.parse(req.params);
  await assertGroupMember(id, groupId);
  // Capturés AVANT la suppression : plus aucun moyen de savoir qui était
  // dedans une fois la ligne `groups` effacée (voir svc.deleteGroup).
  const memberIds = await svc.groupMemberIds(groupId);
  const result = await svc.deleteGroup(groupId, id);
  if (result === "not-found") throw new HttpError(404, "Groupe introuvable.");
  if (result === "forbidden") throw new HttpError(403, "Seul le créateur peut supprimer ce groupe.");
  for (const uid of memberIds) push(uid, { type: "group-deleted", groupId });
  return { ok: true };
});

// -------------------------------------------------- Espaces (chats)
//
// Organise ses discussions (amis + groupes, la même liste que l'onglet
// Chats) dans des espaces personnels (rebaptisés "espaces", initialement
// "cercles", le 27/09/2026) — jamais partagé (je range comme je veux, ça ne
// change rien pour la personne en face). Un chat dans un espace au plus
// (décision produit du même jour). Système séparé de celui des salons, voir
// plus bas.

app.get("/chat-folders", async (req) => {
  const id = await requireUser(req);
  return svc.listChatFolders(id);
});

app.post("/chat-folders", async (req, reply) => {
  const id = await requireUser(req);
  const { name } = z
    .object({ name: z.string().trim().min(1, "Nom trop court.").max(30, "Nom trop long.") })
    .parse(req.body);
  const folder = await svc.createChatFolder(id, name);
  return reply.status(201).send(folder);
});

app.patch("/chat-folders/:folderId", async (req) => {
  const id = await requireUser(req);
  const { folderId } = z.object({ folderId: z.string().uuid() }).parse(req.params);
  const { name } = z
    .object({ name: z.string().trim().min(1, "Nom trop court.").max(30, "Nom trop long.") })
    .parse(req.body);
  if (!(await svc.renameChatFolder(id, folderId, name))) throw new HttpError(404, "Espace introuvable.");
  return { ok: true };
});

app.delete("/chat-folders/:folderId", async (req) => {
  const id = await requireUser(req);
  const { folderId } = z.object({ folderId: z.string().uuid() }).parse(req.params);
  if (!(await svc.deleteChatFolder(id, folderId))) throw new HttpError(404, "Espace introuvable.");
  return { ok: true };
});

// Range (folderId fourni) ou retire (folderId null) un chat d'un espace.
app.put("/chat-folders/items/:chatId", async (req) => {
  const id = await requireUser(req);
  const { chatId } = z.object({ chatId: z.string().uuid() }).parse(req.params);
  const { folderId } = z.object({ folderId: z.string().uuid().nullable() }).parse(req.body);
  // Le chat visé doit vraiment être un des miens : un ami, ou un groupe dont
  // je fais partie (même vérification que si j'ouvrais la conversation).
  const isFriend = await svc.areFriends(id, chatId);
  if (!isFriend && !(await svc.isGroupMember(chatId, id))) throw new HttpError(404, "Discussion introuvable.");
  if (folderId !== null && !(await svc.chatFolderBelongsTo(id, folderId))) {
    throw new HttpError(404, "Espace introuvable.");
  }
  await svc.setChatFolder(id, chatId, folderId);
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
// Chaque personne a un seul salon (son id = celui de son compte). Depuis le
// 26/09/2026, un salon n'est plus réservé aux amis : n'importe qui peut le
// rejoindre via son lien partageable (voir GET /join/:ownerId), avec un mot
// de passe optionnel pour les non-amis (les amis et modérateurs entrent
// toujours librement — cercle de confiance existant). Un banni n'entre
// jamais. Qui est dedans en ce moment vit en mémoire (salons.ts) ; le nom
// choisi, le mot de passe, la liste de bannis et les modérateurs sont en
// base (service.ts).

/** Un banni ne peut jamais entrer ni voir l'aperçu, quel que soit le cas. */
async function assertSalonNotBanned(id: string, ownerId: string) {
  if (ownerId === id) return;
  if (await svc.isBlockedFromSalon(ownerId, id)) throw new HttpError(403, "Tu as été banni de ce salon.");
}

/** Suis-je automatiquement éligible pour entrer, d'après le niveau d'accès
 *  du salon (indépendamment du mot de passe et des membres explicites, voir
 *  assertSalonEntry ci-dessous) ? 'private' n'a jamais de cercle automatique
 *  (traité à part). */
async function isEligibleByAccessLevel(id: string, ownerId: string, level: svc.SalonAccessLevel): Promise<boolean> {
  if (level === "open") return true;
  if (level === "friends_of_friends") {
    return (await svc.areFriends(id, ownerId)) || (await svc.isFriendOfFriend(id, ownerId));
  }
  if (level === "friends") return svc.areFriends(id, ownerId);
  return false; // 'private'
}

/** Droit d'ENTRER (et parler) dans un salon — voir claude/chat-de-groupe-
 *  conception.md et la maquette "Modération du salon" du 29/09/2026 :
 *  propriétaire et modérateurs toujours ; un membre explicite (invité ou
 *  déjà approuvé, voir salon_members) toujours ; le bon mot de passe fait
 *  toujours entrer tout de suite, quel que soit le niveau. Sinon : dépend du
 *  niveau d'accès du salon (friends / friends_of_friends / open / private) —
 *  pas de mot de passe défini = porte restée ouverte pour tout le monde côté
 *  historique (sauf 'private', jamais ouvert par défaut). Si le salon exige
 *  une approbation manuelle (ou s'il est 'private', qui l'exige toujours),
 *  on pose une demande au lieu d'entrer directement : `pending: true`. */
async function assertSalonEntry(id: string, ownerId: string, password?: string): Promise<{ pending: boolean }> {
  await assertSalonNotBanned(id, ownerId);
  if (ownerId === id) return { pending: false };
  if (await svc.isSalonModerator(ownerId, id)) return { pending: false };
  if (await svc.isSalonMember(ownerId, id)) return { pending: false };

  const salon = await svc.getSalon(ownerId);
  if (salon?.hasPassword && password && (await svc.checkSalonPassword(ownerId, password))) {
    return { pending: false };
  }

  const level = salon?.accessLevel ?? "friends";
  const eligible = level !== "private" && (await isEligibleByAccessLevel(id, ownerId, level));

  if (!eligible) {
    if (level === "private") {
      if (!(await svc.hasSalonJoinRequest(ownerId, id))) await svc.createSalonJoinRequest(ownerId, id);
      return { pending: true };
    }
    if (!salon?.hasPassword) return { pending: false }; // comportement historique : porte ouverte sans mot de passe
    throw new HttpError(403, "Mot de passe du salon incorrect.");
  }

  if (salon?.requireApproval) {
    if (!(await svc.hasSalonJoinRequest(ownerId, id))) await svc.createSalonJoinRequest(ownerId, id);
    return { pending: true };
  }
  return { pending: false };
}

/** Droit de modération (bannir/débannir, voir les demandes/signalements/mots
 *  interdits plus bas) : propriétaire ou modérateur. Pas de gestion des
 *  modérateurs/du mot de passe/des réglages pour ces derniers (réservé au
 *  propriétaire, voir assertSalonOwner). */
async function assertSalonModeration(id: string, ownerId: string) {
  if (ownerId === id) return;
  if (await svc.isSalonModerator(ownerId, id)) return;
  throw new HttpError(403, "Réservé au propriétaire ou aux modérateurs de ce salon.");
}

function assertSalonOwner(id: string, ownerId: string) {
  if (ownerId !== id) throw new HttpError(403, "Réservé au propriétaire du salon.");
}

/** Droit d'inviter directement quelqu'un (POST .../members, sans passer par
 *  une demande) : propriétaire et modérateurs toujours ; un membre déjà là
 *  seulement si le propriétaire l'autorise (salon_allow_member_invites). */
async function assertSalonInvite(id: string, ownerId: string) {
  if (ownerId === id) return;
  if (await svc.isSalonModerator(ownerId, id)) return;
  const salon = await svc.getSalon(ownerId);
  if (salon?.allowMemberInvites && (await svc.isSalonMember(ownerId, id))) return;
  throw new HttpError(403, "Tu ne peux pas inviter dans ce salon.");
}

/** Qui peut écrire dans la discussion en direct, indépendamment de qui a le
 *  droit d'y entrer (voir salon_write_permission dans db.ts) — vérifié à
 *  chaque message (handler WS "salon-message" plus bas). */
async function canWriteInSalon(salonId: string, userId: string): Promise<boolean> {
  if (salonId === userId) return true;
  if (await svc.isSalonModerator(salonId, userId)) return true;
  const salon = await svc.getSalon(salonId);
  const perm = salon?.writePermission ?? "members";
  if (perm === "everyone") return true;
  const trusted = (await svc.areFriends(userId, salonId)) || (await svc.isSalonMember(salonId, userId));
  if (trusted) return true;
  if (perm === "friends_of_friends") return svc.isFriendOfFriend(userId, salonId);
  return false;
}

/** Prévient tout le monde présent dans un salon que la liste vient de changer
 *  (avec les infos publiques de chacun, pas juste des identifiants : les
 *  personnes présentes ne sont pas forcément toutes amies entre elles). */
async function broadcastSalonPresence(salonId: string, presentIds: string[]) {
  const present = await svc.getUsersByIds(presentIds);
  for (const uid of presentIds) push(uid, { type: "salon-presence", salonId, present });
}

/** Prévient tout le monde présent dans un salon (pas seulement les gens en
 *  appel) que la liste des participants à l'appel vient de changer — pour
 *  que ceux qui discutent par écrit voient qu'un appel est en cours et
 *  puissent le rejoindre. Voir calls.ts pour la présence d'appel elle-même. */
async function broadcastCallPresence(salonId: string) {
  const present = await svc.getUsersByIds(whoIsInCall(salonId));
  for (const uid of whoIsInSalon(salonId)) push(uid, { type: "call-presence", salonId, present });
}

/** Prévient le propriétaire du salon et ses amis — pas seulement les gens
 *  déjà présents par écrit dedans, contrairement à broadcastCallPresence —
 *  qu'un appel vient de démarrer ou de s'arrêter dans ce salon. Sert
 *  uniquement à afficher "En vocal" dans la liste (GET /salons, onglet
 *  Salons) sans avoir à ouvrir le salon pour le savoir. Ajouté le
 *  28/09/2026. */
async function broadcastSalonCallStatus(salonId: string) {
  const inCall = whoIsInCall(salonId).length > 0;
  const recipients = new Set<string>([salonId, ...(await svc.friendIds(salonId))]);
  for (const uid of recipients) push(uid, { type: "salon-call-status", salonId, inCall });
}

/** Prévient le propriétaire et tous les modérateurs d'un salon (utilisé pour
 *  les demandes d'entrée, voir POST .../enter et .../requests plus bas) —
 *  pour que leur écran de modération, s'il est ouvert, se mette à jour sans
 *  qu'ils aient à rafraîchir. */
async function notifySalonStaff(ownerId: string, event: unknown) {
  const modIds = await svc.getSalonModeratorIds(ownerId);
  for (const uid of new Set([ownerId, ...modIds])) push(uid, event);
}

app.get("/salons", async (req) => {
  const id = await requireUser(req);
  const [mine, friends] = await Promise.all([svc.getSalon(id), svc.listFriendSalons(id)]);
  const counts = salonPresenceCounts();
  const withCount = (s: svc.Salon) => ({
    ...s,
    present: counts.get(s.id) ?? 0,
    inCall: whoIsInCall(s.id).length > 0,
  });
  return { mine: mine ? withCount(mine) : null, friends: friends.map(withCount) };
});

app.patch("/salons/me", async (req) => {
  const id = await requireUser(req);
  const { name } = z.object({ name: z.string().trim().min(1, "Nom trop court.").max(40, "Nom trop long.") }).parse(req.body);
  await svc.renameSalon(id, name);
  return svc.getSalon(id);
});

// Mot de passe d'entrée (voir assertSalonEntry) : chaîne vide = le retirer.
app.patch("/salons/me/password", async (req) => {
  const id = await requireUser(req);
  const { password } = z.object({ password: z.string().max(60) }).parse(req.body);
  const hash = password.trim() === "" ? null : await hashPassword(password.trim());
  await svc.setSalonPasswordHash(id, hash);
  return svc.getSalon(id);
});

// Réglages d'accès et de modération (écran "Modération du salon" du
// 29/09/2026) : tous ensemble, un seul bouton "Enregistrer les paramètres"
// côté client plutôt qu'un appel par réglage — voir svc.updateSalonSettings.
const SALON_SETTINGS_SCHEMA = z.object({
  accessLevel: z.enum(["private", "friends", "friends_of_friends", "open"]),
  writePermission: z.enum(["members", "friends_of_friends", "everyone"]),
  requireApproval: z.boolean(),
  allowMemberInvites: z.boolean(),
});
app.patch("/salons/me/settings", async (req) => {
  const id = await requireUser(req);
  const patch = SALON_SETTINGS_SCHEMA.parse(req.body);
  await svc.updateSalonSettings(id, patch);
  return svc.getSalon(id);
});

app.get("/salons/:ownerId/bans", async (req) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  await assertSalonModeration(id, ownerId);
  return svc.listSalonBlocks(ownerId);
});

app.post("/salons/:ownerId/bans", async (req, reply) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  await assertSalonModeration(id, ownerId);
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
  if (userId === ownerId) throw new HttpError(400, "Le propriétaire ne peut pas être banni.");
  await svc.blockFromSalon(ownerId, userId);
  // Banni : il sort tout de suite s'il était présent (et de l'appel en cours
  // s'il y était), perd son statut de modérateur, son statut de membre
  // explicite et toute demande d'entrée en attente (sinon elle resterait
  // affichée sans qu'on puisse jamais l'accepter).
  await svc.removeSalonModerator(ownerId, userId);
  await svc.removeSalonMember(ownerId, userId);
  await svc.declineSalonJoinRequest(ownerId, userId);
  const present = leaveSalon(ownerId, userId);
  leaveCall(ownerId, userId);
  push(userId, { type: "salon-blocked", salonId: ownerId });
  await broadcastSalonPresence(ownerId, present);
  await broadcastCallPresence(ownerId);
  await broadcastSalonCallStatus(ownerId);
  return reply.status(201).send({ ok: true });
});

app.delete("/salons/:ownerId/bans/:userId", async (req) => {
  const id = await requireUser(req);
  const { ownerId, userId } = z.object({ ownerId: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);
  await assertSalonModeration(id, ownerId);
  await svc.unblockFromSalon(ownerId, userId);
  return { ok: true };
});

// Modérateurs : réservé au propriétaire (contrairement aux bans ci-dessus) —
// voir assertSalonModeration vs assertSalonOwner.
app.get("/salons/:ownerId/moderators", async (req) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  await assertSalonModeration(id, ownerId); // visible au propriétaire ET aux modérateurs
  return svc.getUsersByIds(await svc.getSalonModeratorIds(ownerId));
});

app.post("/salons/:ownerId/moderators", async (req, reply) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  assertSalonOwner(id, ownerId);
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
  if (userId === ownerId) throw new HttpError(400, "Le propriétaire est déjà aux commandes de son salon.");
  if (await svc.isBlockedFromSalon(ownerId, userId)) throw new HttpError(400, "Cette personne est bannie de ce salon.");
  await svc.addSalonModerator(ownerId, userId);
  return reply.status(201).send({ ok: true });
});

app.delete("/salons/:ownerId/moderators/:userId", async (req) => {
  const id = await requireUser(req);
  const { ownerId, userId } = z.object({ ownerId: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);
  assertSalonOwner(id, ownerId);
  await svc.removeSalonModerator(ownerId, userId);
  return { ok: true };
});

app.get("/salons/:ownerId", async (req) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  const salon = await svc.getSalon(ownerId);
  if (!salon) throw new HttpError(404, "Salon introuvable.");
  // Aperçu public (comme une invitation Discord) : pas de mot de passe requis
  // juste pour voir qui est dedans, seulement pour vraiment entrer (plus bas).
  await assertSalonNotBanned(id, ownerId);
  const presentIds = whoIsInSalon(ownerId);
  const present = await svc.getUsersByIds(presentIds);
  return { ...salon, present };
});

app.post("/salons/:ownerId/enter", async (req) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  const { password } = z.object({ password: z.string().optional() }).parse(req.body ?? {});
  const { pending } = await assertSalonEntry(id, ownerId, password);
  if (pending) {
    // Salon 'private', ou approbation manuelle active : une demande vient
    // d'être posée (ou existait déjà) au lieu d'entrer pour de vrai — voir
    // assertSalonEntry. Le propriétaire/les modérateurs sont prévenus en
    // direct pour ne pas avoir à rafraîchir leur écran de modération.
    const [from] = await svc.getUsersByIds([id]);
    if (from) await notifySalonStaff(ownerId, { type: "salon-join-request", salonId: ownerId, from });
    return { pending: true };
  }
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
  // Sortir du salon, c'est aussi sortir de l'appel en cours s'il y était.
  leaveCall(ownerId, id);
  await broadcastCallPresence(ownerId);
  await broadcastSalonCallStatus(ownerId);
  return { present: stillPresent };
});

// ---- Membres explicites (voir db.ts : salon_members) : accès permanent,
// indépendant du niveau d'accès — utile pour un salon 'private', ou pour
// garder l'accès à quelqu'un après une demande approuvée (voir plus bas). ----

app.get("/salons/:ownerId/members", async (req) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  await assertSalonModeration(id, ownerId);
  return svc.listSalonMembers(ownerId);
});

// Invitation directe (sans passer par une demande) — propriétaire et
// modérateurs toujours, les autres membres seulement si le propriétaire l'a
// autorisé (voir assertSalonInvite / salon_allow_member_invites).
app.post("/salons/:ownerId/members", async (req, reply) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  await assertSalonInvite(id, ownerId);
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
  if (userId === ownerId) throw new HttpError(400, "Le propriétaire fait déjà partie de son salon.");
  if (await svc.isBlockedFromSalon(ownerId, userId)) throw new HttpError(400, "Cette personne est bannie de ce salon.");
  await svc.addSalonMember(ownerId, userId, id);
  push(userId, { type: "salon-join-approved", salonId: ownerId }); // même signal qu'une demande acceptée : accès accordé
  return reply.status(201).send({ ok: true });
});

app.delete("/salons/:ownerId/members/:userId", async (req) => {
  const id = await requireUser(req);
  const { ownerId, userId } = z.object({ ownerId: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);
  await assertSalonModeration(id, ownerId);
  await svc.removeSalonMember(ownerId, userId);
  return { ok: true };
});

// ---- Demandes d'entrée (voir db.ts : salon_join_requests) — posées par
// assertSalonEntry quand le salon est 'private' ou exige une approbation
// manuelle. Traitées par le propriétaire ou un modérateur. ----

app.get("/salons/:ownerId/requests", async (req) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  await assertSalonModeration(id, ownerId);
  return svc.listSalonJoinRequests(ownerId);
});

app.post("/salons/:ownerId/requests/:userId/approve", async (req, reply) => {
  const id = await requireUser(req);
  const { ownerId, userId } = z.object({ ownerId: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);
  await assertSalonModeration(id, ownerId);
  await svc.approveSalonJoinRequest(ownerId, userId, id);
  // Prévient la personne tout de suite : son écran peut réessayer d'entrer
  // sans qu'elle ait à y repenser elle-même.
  push(userId, { type: "salon-join-approved", salonId: ownerId });
  return reply.status(201).send({ ok: true });
});

app.delete("/salons/:ownerId/requests/:userId", async (req) => {
  const id = await requireUser(req);
  const { ownerId, userId } = z.object({ ownerId: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);
  await assertSalonModeration(id, ownerId);
  await svc.declineSalonJoinRequest(ownerId, userId);
  push(userId, { type: "salon-join-declined", salonId: ownerId });
  return { ok: true };
});

// ---- Mots interdits (voir db.ts : salon_banned_words) — filtre simple,
// vérifié à l'envoi de chaque message (voir le handler WS "salon-message"
// plus bas). ----

app.get("/salons/:ownerId/banned-words", async (req) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  await assertSalonModeration(id, ownerId);
  return svc.listSalonBannedWords(ownerId);
});

app.post("/salons/:ownerId/banned-words", async (req, reply) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  await assertSalonModeration(id, ownerId);
  const { word } = z.object({ word: z.string().trim().min(1).max(40) }).parse(req.body);
  await svc.addSalonBannedWord(ownerId, word);
  return reply.status(201).send(await svc.listSalonBannedWords(ownerId));
});

app.delete("/salons/:ownerId/banned-words/:word", async (req) => {
  const id = await requireUser(req);
  const { ownerId, word } = z.object({ ownerId: z.string().uuid(), word: z.string() }).parse(req.params);
  await assertSalonModeration(id, ownerId);
  await svc.removeSalonBannedWord(ownerId, decodeURIComponent(word));
  return { ok: true };
});

// ---- Signalements (voir db.ts : salon_reports) — la discussion n'étant
// jamais enregistrée, le client envoie un instantané du message signalé. ----

app.get("/salons/:ownerId/reports", async (req) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  await assertSalonModeration(id, ownerId);
  return svc.listSalonReports(ownerId);
});

// N'importe qui (présent ou pas au moment où ça se traite) peut signaler —
// pas besoin d'être ami ni présent dans le salon en ce moment même.
app.post("/salons/:ownerId/reports", async (req, reply) => {
  const id = await requireUser(req);
  const { ownerId } = z.object({ ownerId: z.string().uuid() }).parse(req.params);
  const { reportedUserId, messageText, reason } = z
    .object({
      reportedUserId: z.string().uuid().optional(),
      messageText: z.string().trim().min(1).max(1000),
      reason: z.string().trim().max(200).default(""),
    })
    .parse(req.body);
  await svc.createSalonReport(ownerId, id, reportedUserId ?? null, messageText, reason);
  await notifySalonStaff(ownerId, { type: "salon-report", salonId: ownerId });
  return reply.status(201).send({ ok: true });
});

app.delete("/salons/:ownerId/reports/:reportId", async (req) => {
  const id = await requireUser(req);
  const { ownerId, reportId } = z.object({ ownerId: z.string().uuid(), reportId: z.string().uuid() }).parse(req.params);
  await assertSalonModeration(id, ownerId);
  await svc.dismissSalonReport(ownerId, reportId);
  return { ok: true };
});

// Là où télécharger Eggs si l'app n'est pas installée (voir joinPageHtml
// ci-dessous) — même dépôt que UPDATING.md / make-latest-json.mjs.
const EGGS_RELEASES_URL = "https://github.com/toniomasterflex/eggs/releases/latest";

/** Page relais pour le lien de salon partageable (voir UI : bouton "Copier le
 *  lien"). Ouverte dans un VRAI navigateur (pas dans l'app, donc pas de jeton
 *  de connexion disponible ici) : elle ne fait qu'essayer d'ouvrir l'app via
 *  le protocole eggs://, avec un lien de secours si elle n'est pas installée.
 *  L'aperçu réel (nom, qui est dedans...) se fait dans l'app, après
 *  ouverture, via GET /salons/:ownerId (authentifié, voir plus haut). */
function joinPageHtml(ownerId: string | null): string {
  if (!ownerId) {
    return `<!doctype html><html lang="fr"><meta charset="utf-8"><title>Lien invalide</title>
<body style="font-family:system-ui;background:#14121a;color:#eee;display:grid;min-height:100vh;place-items:center;margin:0">
<p>Ce lien de salon n'est pas valide.</p>
</body></html>`;
  }
  const deepLink = `eggs://salon/${ownerId}`;
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rejoindre un salon Eggs</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #14121a; color: #f2eef7;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    text-align: center; padding: 24px;
  }
  .card { max-width: 360px; }
  .egg { font-size: 48px; margin-bottom: 8px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: #b8aecb; margin: 0 0 20px; }
  a.btn {
    display: inline-block; padding: 12px 20px; border-radius: 999px;
    background: #7c5cff; color: white; text-decoration: none; font-weight: 600;
    margin: 6px;
  }
  a.btn.secondary { background: transparent; border: 1px solid #4a4460; color: #f2eef7; }
  #fallback { display: none; margin-top: 18px; }
</style>
</head>
<body>
  <div class="card">
    <div class="egg" aria-hidden="true">🥚</div>
    <h1>Ouverture du salon dans Eggs…</h1>
    <p>Si rien ne se passe, clique ci-dessous.</p>
    <a class="btn" href="${deepLink}">Ouvrir dans Eggs</a>
    <div id="fallback">
      <p>L'app ne s'est pas ouverte ? Elle n'est peut-être pas installée sur cet appareil.</p>
      <a class="btn secondary" href="${EGGS_RELEASES_URL}">Télécharger Eggs</a>
    </div>
  </div>
  <script>
    location.href = ${JSON.stringify(deepLink)};
    setTimeout(function () {
      document.getElementById('fallback').style.display = 'block';
    }, 1500);
  </script>
</body>
</html>`;
}

/** Page affichée quand on clique sur le lien de vérification reçu par email
 *  (voir GET /verify-email/:token, mail.ts) — même palette que joinPageHtml
 *  ci-dessus pour rester cohérent, mais pas de deep-link ici : la
 *  vérification est déjà faite côté serveur au moment où cette page
 *  s'affiche, rien de plus à faire dans l'app. */
function verifyEmailPageHtml(ok: boolean): string {
  const title = ok ? "Email confirmé" : "Lien invalide ou expiré";
  const message = ok
    ? "Ton adresse email est confirmée. Tu peux fermer cette page et retourner dans Eggs."
    : "Ce lien de vérification n'est plus valable (déjà utilisé, ou expiré au bout de 24h). Redemande un email depuis Eggs, dans Compte.";
  const icon = ok ? "✅" : "🥚";
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — Eggs</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #14121a; color: #f2eef7;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    text-align: center; padding: 24px;
  }
  .card { max-width: 360px; }
  .icon { font-size: 48px; margin-bottom: 8px; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { color: #b8aecb; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon" aria-hidden="true">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

app.get("/join/:ownerId", async (req, reply) => {
  const parsed = z.object({ ownerId: z.string().uuid() }).safeParse(req.params);
  if (!parsed.success) return reply.status(400).type("text/html").send(joinPageHtml(null));
  reply.type("text/html").send(joinPageHtml(parsed.data.ownerId));
});

// -------------------------------------------------- Espaces (salons)
//
// Même principe que les espaces de chats plus haut, système séparé
// (décision du 27/09/2026) : organise l'onglet Salons (le mien + ceux de mes
// amis) sans toucher aux espaces de chats.

app.get("/salon-folders", async (req) => {
  const id = await requireUser(req);
  return svc.listSalonFolders(id);
});

app.post("/salon-folders", async (req, reply) => {
  const id = await requireUser(req);
  const { name } = z
    .object({ name: z.string().trim().min(1, "Nom trop court.").max(30, "Nom trop long.") })
    .parse(req.body);
  const folder = await svc.createSalonFolder(id, name);
  return reply.status(201).send(folder);
});

app.patch("/salon-folders/:folderId", async (req) => {
  const id = await requireUser(req);
  const { folderId } = z.object({ folderId: z.string().uuid() }).parse(req.params);
  const { name } = z
    .object({ name: z.string().trim().min(1, "Nom trop court.").max(30, "Nom trop long.") })
    .parse(req.body);
  if (!(await svc.renameSalonFolder(id, folderId, name))) throw new HttpError(404, "Espace introuvable.");
  return { ok: true };
});

app.delete("/salon-folders/:folderId", async (req) => {
  const id = await requireUser(req);
  const { folderId } = z.object({ folderId: z.string().uuid() }).parse(req.params);
  if (!(await svc.deleteSalonFolder(id, folderId))) throw new HttpError(404, "Espace introuvable.");
  return { ok: true };
});

app.put("/salon-folders/items/:salonId", async (req) => {
  const id = await requireUser(req);
  const { salonId } = z.object({ salonId: z.string().uuid() }).parse(req.params);
  const { folderId } = z.object({ folderId: z.string().uuid().nullable() }).parse(req.body);
  // Le salon visé doit être le mien ou celui d'un ami — même liste que
  // GET /salons (mine + friends) : pas de classement pour un salon rejoint
  // via un lien sans être ami, il ne serait de toute façon visible nulle
  // part ensuite.
  if (salonId !== id && !(await svc.areFriends(id, salonId))) throw new HttpError(404, "Salon introuvable.");
  if (folderId !== null && !(await svc.salonFolderBelongsTo(id, folderId))) {
    throw new HttpError(404, "Espace introuvable.");
  }
  await svc.setSalonFolder(id, salonId, folderId);
  return { ok: true };
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
          // en base. Il faut être présent dans le salon pour parler, avoir le
          // droit d'y écrire (salon_write_permission) et ne pas déclencher le
          // filtre de mots interdits (voir db.ts, ajoutés le 29/09/2026).
          const text = msg.text.trim().slice(0, 1000);
          if (!text) return;
          const present = whoIsInSalon(msg.salonId);
          if (!present.includes(userId)) return;
          if (!(await canWriteInSalon(msg.salonId, userId))) {
            push(userId, { type: "salon-write-denied", salonId: msg.salonId, reason: "permission" });
            return;
          }
          if (await svc.salonMessageContainsBannedWord(msg.salonId, text)) {
            push(userId, { type: "salon-write-denied", salonId: msg.salonId, reason: "banned-word" });
            return;
          }
          const [from] = await svc.getUsersByIds([userId]);
          if (!from) return;
          const payload = { type: "salon-message", salonId: msg.salonId, from, text, at: Date.now() };
          for (const uid of present) push(uid, payload);
        } else if (msg?.type === "call-join" && typeof msg.salonId === "string") {
          // Rejoindre l'appel suppose déjà d'être présent (par écrit) dans le
          // salon — voir salons.ts. Le serveur tranche, pas le client.
          const salonId = msg.salonId;
          if (!whoIsInSalon(salonId).includes(userId)) return;
          const result = joinCall(salonId, userId);
          if (result === null) {
            socket.send(JSON.stringify({ type: "call-full", salonId, max: MAX_CALL_SIZE }));
            return;
          }
          await broadcastCallPresence(salonId);
          await broadcastSalonCallStatus(salonId);
        } else if (msg?.type === "call-leave" && typeof msg.salonId === "string") {
          leaveCall(msg.salonId, userId);
          await broadcastCallPresence(msg.salonId);
          await broadcastSalonCallStatus(msg.salonId);
        } else if (
          msg?.type === "call-signal" &&
          typeof msg.salonId === "string" &&
          typeof msg.to === "string" &&
          msg.data !== undefined
        ) {
          // Relais aveugle d'un message de signalisation WebRTC (offre/réponse
          // SDP, candidat ICE) entre deux personnes du même appel — le serveur
          // ne comprend pas le contenu, il vérifie juste que les deux y sont.
          const salonId = msg.salonId;
          const inCall = whoIsInCall(salonId);
          if (!inCall.includes(userId) || !inCall.includes(msg.to)) return;
          push(msg.to, { type: "call-signal", salonId, from: userId, data: msg.data });
        } else if (msg?.type === "call-media" && typeof msg.salonId === "string") {
          // État léger (micro coupé, partage d'écran actif) pour l'affichage
          // chez les autres — jamais de contenu média, juste deux booléens.
          const salonId = msg.salonId;
          if (!whoIsInCall(salonId).includes(userId)) return;
          const payload = {
            type: "call-media",
            salonId,
            from: userId,
            micOn: !!msg.micOn,
            screenSharing: !!msg.screenSharing,
          };
          for (const uid of whoIsInCall(salonId)) if (uid !== userId) push(uid, payload);
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
        for (const salonId of leaveAllCalls(userId)) {
          await broadcastCallPresence(salonId);
          await broadcastSalonCallStatus(salonId);
        }
      }
    });
  });
});

// ---------------------------------------------------------------- Démarrage

await app.listen({ port: config.port, host: config.host });
console.log(`Serveur Eggs prêt : http://${config.host}:${config.port}  (base : ${config.dataDir})`);
