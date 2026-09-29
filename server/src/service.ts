// La logique : utilisateurs, amis, messages. Le seul endroit qui parle à la base.

import { hashPassword, verifyPassword } from "./auth.js";
import { config } from "./config.js";
import { query } from "./db.js";
import type { Row } from "./db.js";

export interface PublicUser {
  id: string;
  username: string;
  species: string;
  color: string;
  discord: string | null;
  steam: string | null;
  // Statut « absent » réglé à la main par la personne elle-même (voir
  // setAwayStatus plus bas) — distinct de sa connexion (voir hub.ts) :
  // index.ts combine les deux pour décider vert/orange/rouge côté client.
  away: boolean;
}

// Espèces et couleurs valides pour une créature (tirage au sort à l'éclosion).
export const SPECIES = ["chick", "cat", "fox", "penguin", "rabbit", "panda", "frog", "owl"];
export const COLORS = ["sun", "rose", "sky", "mint", "lilac", "peach", "cloud"];

// 'image' | 'video' | 'audio' — voir index.ts : POST /messages/:friendId/attachment.
export type AttachmentKind = "image" | "video" | "audio";

export interface Attachment {
  url: string;
  kind: AttachmentKind;
  name: string;
}

// Réaction façon iMessage/WhatsApp (tapback) sur un message — voir
// setReaction/removeReaction plus bas.
export interface Reaction {
  userId: string;
  emoji: string;
}

// `to` est null pour un message de groupe (voir groupId à la place) —
// exactement un des deux est renseigné, jamais les deux, jamais aucun.
export interface Message {
  id: number;
  from: string;
  to: string | null;
  groupId: string | null;
  text: string;
  at: number; // millisecondes
  attachment: Attachment | null;
  reactions: Reaction[];
}

const USER_COLS = "id, username, species, color, discord_handle AS discord, steam_handle AS steam, away";
const MSG_COLS = `id::int AS id, sender_id AS "from", recipient_id AS "to", group_id AS "groupId", text,
  (extract(epoch from created_at) * 1000)::float8 AS at,
  attachment_url, attachment_kind, attachment_name,
  (SELECT jsonb_agg(jsonb_build_object('userId', r.user_id, 'emoji', r.emoji) ORDER BY r.created_at)
     FROM message_reactions r WHERE r.message_id = messages.id) AS reactions`;

// Les colonnes attachment_* ci-dessus arrivent à plat (une requête SQL ne
// renvoie pas d'objet imbriqué) : on les regroupe ici en un seul champ
// `attachment`, tel qu'attendu par le client (voir data/api.ts : ApiMessage).
// `reactions` arrive déjà en JSON agrégé (voir MSG_COLS) — NULL quand
// personne n'a réagi (jsonb_agg d'un ensemble vide), remplacé par [].
function rowToMessage(row: Row): Message {
  const { attachment_url, attachment_kind, attachment_name, reactions, ...rest } = row;
  const attachment: Attachment | null = attachment_url
    ? { url: attachment_url, kind: attachment_kind, name: attachment_name }
    : null;
  return { ...(rest as Omit<Message, "attachment" | "reactions">), attachment, reactions: reactions ?? [] };
}

// ---------------------------------------------------------------- Utilisateurs

export const usernameKey = (username: string) => username.trim().toLowerCase();
export const emailKey = (email: string) => email.trim().toLowerCase();

export async function getUser(id: string): Promise<PublicUser | null> {
  const rows = await query<PublicUser>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getCredentials(username: string) {
  const rows = await query<PublicUser & { password_hash: string }>(
    `SELECT ${USER_COLS}, password_hash FROM users WHERE username_key = $1 AND is_bot = FALSE`,
    [usernameKey(username)],
  );
  return rows[0] ?? null;
}

export async function usernameTaken(username: string): Promise<boolean> {
  const rows = await query("SELECT 1 FROM users WHERE username_key = $1", [usernameKey(username)]);
  return rows.length > 0;
}

/** Un compte (encore) sans email (créé avant le 27/09/2026) n'entre jamais
 *  en collision : email_key reste NULL pour lui, exclu par l'index partiel
 *  (voir db.ts). */
export async function emailTaken(email: string): Promise<boolean> {
  const rows = await query("SELECT 1 FROM users WHERE email_key = $1", [emailKey(email)]);
  return rows.length > 0;
}

export async function createUser(
  username: string,
  password: string | null,
  // email optionnel (et non dans les paramètres positionnels) pour ne pas
  // casser bots.ts : les robots n'en ont pas et n'en ont pas besoin.
  opts: { species?: string; color?: string; bot?: boolean; email?: string | null } = {},
): Promise<PublicUser> {
  const hash = password === null ? "disabled" : await hashPassword(password);
  const email = opts.email?.trim().toLowerCase() ?? null;
  const rows = await query<PublicUser>(
    `INSERT INTO users (username, username_key, email, email_key, password_hash, species, color, is_bot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${USER_COLS}`,
    // Un vrai compte démarre sans créature ("egg") : sa première créature vient
    // de l'œuf de bienvenue (voir giveWelcomeEgg). Seuls les robots (bots.ts)
    // passent une espèce/couleur explicite ici (et jamais d'email).
    [
      username.trim(),
      usernameKey(username),
      email,
      email ? emailKey(email) : null,
      hash,
      opts.species ?? "egg",
      opts.color ?? "",
      opts.bot ?? false,
    ],
  );
  return rows[0];
}

// Email et son état de vérification (voir mail.ts, auth.ts) : jamais dans
// USER_COLS/PublicUser ci-dessus, qui sert aussi à afficher le profil DES
// AUTRES (recherche, amis, membres de groupe...) — l'email reste privé,
// consulté seulement pour son propre compte (GET /me).

export async function getEmailStatus(userId: string): Promise<{ email: string | null; emailVerified: boolean } | null> {
  const rows = await query<{ email: string | null; email_verified: boolean }>(
    "SELECT email, email_verified FROM users WHERE id = $1",
    [userId],
  );
  if (!rows[0]) return null;
  return { email: rows[0].email, emailVerified: rows[0].email_verified };
}

export async function markEmailVerified(userId: string): Promise<void> {
  await query("UPDATE users SET email_verified = TRUE WHERE id = $1", [userId]);
}

/** Statut « absent » réglé à la main (façon Slack/Discord, voir PublicUser.away
 *  et PATCH /me/status dans index.ts) — persisté en base pour survivre à une
 *  reconnexion, contrairement à `online` (calculé en mémoire, voir hub.ts). */
export async function setAwayStatus(id: string, away: boolean): Promise<PublicUser | null> {
  await query("UPDATE users SET away = $2 WHERE id = $1", [id, away]);
  return getUser(id);
}

/** Change l'apparence publique (users.species/color). Encore utilisée par
 *  PATCH /me (l'ancien choix libre, pas encore retiré côté app) ET, en
 *  interne, pour refléter la créature active après une éclosion ou un
 *  changement de créature (voir openEgg / activateCreature) — dans ce
 *  second cas, species ET color sont toujours fournis ensemble. */
export async function updateAppearance(id: string, species?: string, color?: string) {
  await query(
    "UPDATE users SET species = COALESCE($2, species), color = COALESCE($3, color) WHERE id = $1",
    [id, species ?? null, color ?? null],
  );
  return getUser(id);
}

/** Met à jour les pseudos Discord/Steam affichés sur le profil et le
 *  Répertoire — simple affichage saisi à la main, PAS d'import de la liste
 *  d'amis (le scope Discord relationships.read demande une validation
 *  externe via le programme « Social SDK », incertaine et hors scope pour
 *  l'instant, voir décision du 26/09/2026). `undefined` laisse le pseudo
 *  actuel inchangé ; une chaîne vide l'efface (NULL en base). */
export async function updateProfileLinks(id: string, discord?: string, steam?: string) {
  await query(
    `UPDATE users SET
       discord_handle = CASE WHEN $2::text IS NULL THEN discord_handle WHEN $2 = '' THEN NULL ELSE $2 END,
       steam_handle   = CASE WHEN $3::text IS NULL THEN steam_handle   WHEN $3 = '' THEN NULL ELSE $3 END
     WHERE id = $1`,
    [id, discord ?? null, steam ?? null],
  );
  return getUser(id);
}

export async function isBot(id: string): Promise<boolean> {
  const rows = await query<{ is_bot: boolean }>("SELECT is_bot FROM users WHERE id = $1", [id]);
  return rows[0]?.is_bot === true;
}

/** Cherche des utilisateurs par pseudo (début ou milieu du pseudo). */
export async function searchUsers(q: string, selfId: string) {
  const key = usernameKey(q).replace(/[\\%_]/g, (c) => "\\" + c);
  if (!key) return [];
  return query<PublicUser & { friend: boolean }>(
    `SELECT ${USER_COLS},
            EXISTS (SELECT 1 FROM friendships f WHERE f.user_id = $2 AND f.friend_id = users.id) AS friend
       FROM users
      WHERE username_key LIKE $1 AND id <> $2
      ORDER BY (username_key LIKE $3) DESC, username_key
      LIMIT 20`,
    [`%${key}%`, selfId, `${key}%`],
  );
}

// ----------------------------------------------------------------------- Amis

export async function areFriends(a: string, b: string): Promise<boolean> {
  const rows = await query("SELECT 1 FROM friendships WHERE user_id = $1 AND friend_id = $2", [a, b]);
  return rows.length > 0;
}

export async function addFriendship(a: string, b: string) {
  await query(
    `INSERT INTO friendships (user_id, friend_id) VALUES ($1, $2), ($2, $1)
     ON CONFLICT DO NOTHING`,
    [a, b],
  );
}

export async function removeFriendship(a: string, b: string) {
  await query(
    `DELETE FROM friendships
      WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
    [a, b],
  );
  // L'espace où CHACUN avait rangé l'autre (des deux côtés, indépendants
  // l'un de l'autre) ne veut plus rien dire une fois qu'on n'est plus amis —
  // voir chat_folder_items : pas de FK vers friendships pour ça, nettoyage
  // explicite ici.
  await query(
    `DELETE FROM chat_folder_items
      WHERE (user_id = $1 AND chat_id = $2) OR (user_id = $2 AND chat_id = $1)`,
    [a, b],
  );
}

export async function listFriends(userId: string) {
  return query<PublicUser & { unread: number; lastAt: number | null; readAt: number | null }>(
    `SELECT u.id, u.username, u.species, u.color, u.discord_handle AS discord, u.steam_handle AS steam, u.away,
            (SELECT (extract(epoch from max(m.created_at)) * 1000)::float8 FROM messages m
              WHERE (m.sender_id = u.id AND m.recipient_id = $1)
                 OR (m.sender_id = $1 AND m.recipient_id = u.id)) AS "lastAt",
            (SELECT count(*)::int FROM messages m
              WHERE m.sender_id = u.id AND m.recipient_id = $1 AND m.read_at IS NULL) AS unread,
            (SELECT (extract(epoch from max(m.created_at)) * 1000)::float8 FROM messages m
              WHERE m.sender_id = $1 AND m.recipient_id = u.id AND m.read_at IS NOT NULL) AS "readAt"
       FROM friendships f
       JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = $1
      ORDER BY u.username_key`,
    [userId],
  );
}

/** Amis communs de deux personnes (pour savoir qui voit une interaction). */
export async function mutualFriendIds(a: string, b: string): Promise<string[]> {
  const rows = await query<{ friend_id: string }>(
    `SELECT f1.friend_id
       FROM friendships f1
       JOIN friendships f2 ON f2.user_id = $2 AND f2.friend_id = f1.friend_id
      WHERE f1.user_id = $1`,
    [a, b],
  );
  return rows.map((r) => r.friend_id);
}

export async function friendIds(userId: string): Promise<string[]> {
  const rows = await query<{ friend_id: string }>(
    "SELECT friend_id FROM friendships WHERE user_id = $1",
    [userId],
  );
  return rows.map((r) => r.friend_id);
}

// ------------------------------------------------------------------- Messages

export async function listMessages(userId: string, friendId: string, limit: number, beforeId?: number) {
  const rows = await query<Row>(
    `SELECT ${MSG_COLS} FROM messages
      WHERE ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1))
        AND ($3::int IS NULL OR id < $3::int)
      ORDER BY id DESC
      LIMIT $4`,
    [userId, friendId, beforeId ?? null, limit],
  );
  return rows.reverse().map(rowToMessage);
}

export async function insertMessage(from: string, to: string, text: string): Promise<Message> {
  const rows = await query<Row>(
    `INSERT INTO messages (sender_id, recipient_id, text) VALUES ($1, $2, $3)
     RETURNING ${MSG_COLS}`,
    [from, to, text],
  );
  return rowToMessage(rows[0]);
}

// Photo / vidéo / son (voir index.ts : POST /messages/:friendId/attachment).
// Le fichier est déjà sur disque à cet appel (voir uploadsDir) : ici on ne
// fait qu'enregistrer la référence.
export async function insertAttachmentMessage(
  from: string,
  to: string,
  attachment: Attachment,
): Promise<Message> {
  const rows = await query<Row>(
    `INSERT INTO messages (sender_id, recipient_id, text, attachment_url, attachment_kind, attachment_name)
     VALUES ($1, $2, '', $3, $4, $5)
     RETURNING ${MSG_COLS}`,
    [from, to, attachment.url, attachment.kind, attachment.name],
  );
  return rowToMessage(rows[0]);
}

export async function markRead(userId: string, friendId: string) {
  await query(
    `UPDATE messages SET read_at = now()
      WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL`,
    [userId, friendId],
  );
}

// -------------------------------------------------------------- Réactions
//
// Une seule réaction par personne et par message (voir migration : PRIMARY
// KEY (message_id, user_id)) — en poser une nouvelle remplace l'ancienne.
// Marche pareil pour un message de groupe (voir messageParticipant plus bas).

/** `userId` fait-il partie de cette conversation (donc a le droit d'y
 *  réagir) ? Expéditeur/destinataire pour un message à deux, ou membre du
 *  groupe pour un message de groupe. */
async function messageParticipant(messageId: number, userId: string): Promise<boolean> {
  const rows = await query<{ sender_id: string; recipient_id: string | null; group_id: string | null }>(
    "SELECT sender_id, recipient_id, group_id FROM messages WHERE id = $1",
    [messageId],
  );
  const m = rows[0];
  if (!m) return false;
  if (m.sender_id === userId || m.recipient_id === userId) return true;
  if (m.group_id) return isGroupMember(m.group_id, userId);
  return false;
}

async function getMessage(messageId: number): Promise<Message | null> {
  const rows = await query<Row>(`SELECT ${MSG_COLS} FROM messages WHERE id = $1`, [messageId]);
  return rows[0] ? rowToMessage(rows[0]) : null;
}

/** Pose ou change SA réaction sur un message. Renvoie le message à jour
 *  (avec toutes ses réactions), ou null si ce message n'existe pas ou si
 *  `userId` n'est ni l'expéditeur ni le destinataire. */
export async function setReaction(messageId: number, userId: string, emoji: string): Promise<Message | null> {
  if (!(await messageParticipant(messageId, userId))) return null;
  await query(
    `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
     ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, created_at = now()`,
    [messageId, userId, emoji],
  );
  return getMessage(messageId);
}

/** Retire SA réaction sur un message (retaper le même emoji, côté client).
 *  Même règles d'accès que setReaction. */
export async function removeReaction(messageId: number, userId: string): Promise<Message | null> {
  if (!(await messageParticipant(messageId, userId))) return null;
  await query("DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2", [messageId, userId]);
  return getMessage(messageId);
}

// ------------------------------------------------------------------ Groupes
//
// Différent des Salons (une pièce ouverte par personne, sans historique,
// voir plus bas) : ici on choisit qui en fait partie à la création, comme un
// groupe WhatsApp classique. L'historique reste, affiché dans l'onglet Chats
// à côté des discussions à deux (voir ConversationScreen.tsx côté client).

export interface Group {
  id: string;
  name: string;
  createdBy: string;
  members: PublicUser[];
}

export interface GroupSummary extends Group {
  lastAt: number | null;
  unread: number;
}

async function membersOf(groupId: string): Promise<PublicUser[]> {
  return query<PublicUser>(
    `SELECT ${USER_COLS} FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = $1 ORDER BY u.username_key`,
    [groupId],
  );
}

export async function isGroupMember(groupId: string, userId: string): Promise<boolean> {
  const rows = await query("SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2", [groupId, userId]);
  return rows.length > 0;
}

/** Qui prévenir en temps réel d'un nouveau message / d'une réaction dans ce
 *  groupe (voir index.ts : push). */
export async function groupMemberIds(groupId: string): Promise<string[]> {
  const rows = await query<{ user_id: string }>("SELECT user_id FROM group_members WHERE group_id = $1", [groupId]);
  return rows.map((r) => r.user_id);
}

/** Crée le groupe, avec le créateur ET les membres choisis dedans dès le
 *  départ (pas d'invitation à accepter, comme pour l'ajout d'ami — décision
 *  produit : on ne peut choisir que des amis, voir index.ts : POST /groups). */
export async function createGroup(creatorId: string, name: string, memberIds: string[]): Promise<Group> {
  const rows = await query<{ id: string; name: string; created_by: string }>(
    "INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id, name, created_by",
    [name, creatorId],
  );
  const group = rows[0];
  const allIds = Array.from(new Set([creatorId, ...memberIds]));
  for (const uid of allIds) {
    await query("INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      group.id,
      uid,
    ]);
  }
  return { id: group.id, name: group.name, createdBy: group.created_by, members: await membersOf(group.id) };
}

export async function getGroup(groupId: string): Promise<Group | null> {
  const rows = await query<{ id: string; name: string; created_by: string }>(
    "SELECT id, name, created_by FROM groups WHERE id = $1",
    [groupId],
  );
  const g = rows[0];
  if (!g) return null;
  return { id: g.id, name: g.name, createdBy: g.created_by, members: await membersOf(g.id) };
}

/** Mes groupes, le plus récent message en premier (comme listFriends pour
 *  les discussions à deux) — voir group_reads pour le calcul du non-lu. */
export async function listGroups(userId: string): Promise<GroupSummary[]> {
  const rows = await query<{ id: string; name: string; createdBy: string; lastAt: number | null; unread: number }>(
    `SELECT g.id, g.name, g.created_by AS "createdBy",
            (SELECT (extract(epoch from max(m.created_at)) * 1000)::float8 FROM messages m
              WHERE m.group_id = g.id) AS "lastAt",
            (SELECT count(*)::int FROM messages m
              WHERE m.group_id = g.id AND m.sender_id <> $1
                AND m.created_at > COALESCE(
                  (SELECT read_at FROM group_reads WHERE group_id = g.id AND user_id = $1), 'epoch'::timestamptz)
            ) AS unread
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = $1
      ORDER BY g.created_at`,
    [userId],
  );
  const out: GroupSummary[] = [];
  for (const r of rows) out.push({ ...r, members: await membersOf(r.id) });
  return out;
}

export async function markGroupRead(groupId: string, userId: string) {
  await query(
    `INSERT INTO group_reads (group_id, user_id, read_at) VALUES ($1, $2, now())
     ON CONFLICT (group_id, user_id) DO UPDATE SET read_at = now()`,
    [groupId, userId],
  );
}

export async function leaveGroup(groupId: string, userId: string) {
  await query("DELETE FROM group_members WHERE group_id = $1 AND user_id = $2", [groupId, userId]);
  // Je pars : ce groupe sort de MON classement (les autres membres gardent
  // le leur, voir chat_folder_items).
  await query("DELETE FROM chat_folder_items WHERE user_id = $1 AND chat_id = $2", [userId, groupId]);
}

// Supprimer (créateur seulement) est différent de quitter : le groupe
// disparaît aussi chez TOUS les autres membres, pas seulement chez moi (voir
// index.ts : DELETE /groups/:groupId, qui prévient tout le monde avant
// l'appel ci-dessous). La suppression de la ligne `groups` entraîne en
// cascade group_members, group_reads et les messages du groupe (voir
// db.ts : ON DELETE CASCADE sur ces tables).
export async function deleteGroup(groupId: string, userId: string): Promise<"ok" | "not-found" | "forbidden"> {
  const rows = await query<{ created_by: string }>("SELECT created_by FROM groups WHERE id = $1", [groupId]);
  const g = rows[0];
  if (!g) return "not-found";
  if (g.created_by !== userId) return "forbidden";
  await query("DELETE FROM groups WHERE id = $1", [groupId]);
  // Le groupe disparaît pour tout le monde : le retirer du classement de
  // CHAQUE membre, pas seulement du mien (voir chat_folder_items, pas de FK
  // possible vers groups pour un nettoyage en cascade automatique).
  await query("DELETE FROM chat_folder_items WHERE chat_id = $1", [groupId]);
  return "ok";
}

export async function listGroupMessages(groupId: string, limit: number, beforeId?: number) {
  const rows = await query<Row>(
    `SELECT ${MSG_COLS} FROM messages
      WHERE group_id = $1 AND ($2::int IS NULL OR id < $2::int)
      ORDER BY id DESC
      LIMIT $3`,
    [groupId, beforeId ?? null, limit],
  );
  return rows.reverse().map(rowToMessage);
}

export async function insertGroupMessage(from: string, groupId: string, text: string): Promise<Message> {
  const rows = await query<Row>(
    `INSERT INTO messages (sender_id, group_id, text) VALUES ($1, $2, $3)
     RETURNING ${MSG_COLS}`,
    [from, groupId, text],
  );
  return rowToMessage(rows[0]);
}

export async function insertGroupAttachmentMessage(
  from: string,
  groupId: string,
  attachment: Attachment,
): Promise<Message> {
  const rows = await query<Row>(
    `INSERT INTO messages (sender_id, group_id, text, attachment_url, attachment_kind, attachment_name)
     VALUES ($1, $2, '', $3, $4, $5)
     RETURNING ${MSG_COLS}`,
    [from, groupId, attachment.url, attachment.kind, attachment.name],
  );
  return rowToMessage(rows[0]);
}

// ----------------------------------------------------------- Amis de départ

/** En développement : un nouveau compte reçoit les robots comme amis. */
export async function giveStarterFriends(userId: string, botIds: string[]) {
  if (!config.seedBots) return;
  for (const botId of botIds) await addFriendship(userId, botId);
}

export async function getPasswordHash(id: string): Promise<string | null> {
  const rows = await query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = $1 AND is_bot = FALSE",
    [id],
  );
  return rows[0]?.password_hash ?? null;
}

export async function setPassword(id: string, password: string) {
  await query("UPDATE users SET password_hash = $2 WHERE id = $1", [id, await hashPassword(password)]);
}

/** Supprime le compte, ses sessions, ses amitiés et ses messages (cascade). */
export async function deleteUser(id: string) {
  await query("DELETE FROM users WHERE id = $1 AND is_bot = FALSE", [id]);
}

// ------------------------------------------------------- Œufs et créatures

export interface Creature {
  id: string;
  species: string;
  color: string;
  active: boolean;
  partnerId: string | null;
  bornAt: number;
}

export interface Egg {
  id: string;
  source: "welcome" | "weekly" | "gift" | "shop";
  partnerId: string | null;
  grantedAt: number;
}

const CREATURE_COLS = `id, species, color, active,
  partner_id AS "partnerId", (extract(epoch from born_at) * 1000)::float8 AS "bornAt"`;
const EGG_COLS = `id, source, partner_id AS "partnerId",
  (extract(epoch from granted_at) * 1000)::float8 AS "grantedAt"`;

/** Le lundi (AAAA-MM-JJ) de la semaine en cours, en UTC. */
function currentMonday(): string {
  const d = new Date();
  const day = d.getUTCDay(); // 0 = dimanche .. 6 = samedi
  const diff = day === 0 ? 6 : day - 1; // jours écoulés depuis lundi
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return monday.toISOString().slice(0, 10);
}

/** À la création d'un vrai compte : 3 œufs, immédiatement. */
export async function giveWelcomeEgg(userId: string) {
  for (let i = 0; i < 3; i++) {
    await query("INSERT INTO eggs (owner_id, source) VALUES ($1, 'welcome')", [userId]);
  }
  await query("UPDATE users SET eggs_granted_through = $2 WHERE id = $1", [userId, currentMonday()]);
}

// --------------------------------------------------------------------- Shop
//
// MAQUETTE pour l'instant : le catalogue et les prix sont juste pour
// l'affichage (voir src/ui/screens/ShopScreen.tsx côté client) — aucun
// paiement réel n'est encore branché ici, acheter une boîte l'offre
// directement. Le jour où un vrai moyen de paiement est intégré, c'est ici
// (et dans la route POST /shop/eggs/:boxId d'index.ts) qu'il faudra vérifier
// le paiement avant d'appeler buyEggBox.

export interface EggBox {
  id: string;
  count: number;
  label: string;
  priceLabel: string; // affichage seulement, voir remarque ci-dessus
}

export const EGG_BOXES: EggBox[] = [
  { id: "small", count: 3, label: "Petite boîte", priceLabel: "2,99 €" },
  { id: "medium", count: 10, label: "Boîte moyenne", priceLabel: "7,99 €" },
  { id: "large", count: 25, label: "Grande boîte", priceLabel: "14,99 €" },
];

/** Achète une boîte d'œufs (source 'shop'). Renvoie le nombre d'œufs
 *  ajoutés, ou 0 si la boîte n'existe pas. */
export async function buyEggBox(userId: string, boxId: string): Promise<number> {
  const box = EGG_BOXES.find((b) => b.id === boxId);
  if (!box) return 0;
  for (let i = 0; i < box.count; i++) {
    await query("INSERT INTO eggs (owner_id, source) VALUES ($1, 'shop')", [userId]);
  }
  return box.count;
}

// Skins rares : contrairement aux œufs, un skin acheté donne directement une
// créature de cette espèce (pas d'œuf à ouvrir) — un seul exemplaire par
// personne. « id » sert aussi de valeur pour creatures.species.
export interface Skin {
  id: string;
  label: string;
  priceLabel: string; // affichage seulement, voir remarque en tête de section
}
export const SKINS: Skin[] = [
  { id: "explorer", label: "Aventurier", priceLabel: "4,99 €" },
  { id: "cricket", label: "L'Éclaireur", priceLabel: "4,99 €" },
];

/** Achète un skin rare : ajoute une créature de cette espèce à la collection,
 *  active si c'est la toute première. Renvoie null si le skin n'existe pas,
 *  ou si cette personne le possède déjà (un seul exemplaire par skin). */
export async function buySkin(userId: string, skinId: string): Promise<Creature | null> {
  const skin = SKINS.find((s) => s.id === skinId);
  if (!skin) return null;
  const owned = await query("SELECT 1 FROM creatures WHERE owner_id = $1 AND species = $2", [userId, skinId]);
  if (owned.length > 0) return null;
  const hasActive = (await query("SELECT 1 FROM creatures WHERE owner_id = $1 AND active", [userId])).length > 0;
  const created = await query<Creature>(
    `INSERT INTO creatures (owner_id, species, color, active)
     VALUES ($1, $2, '', $3) RETURNING ${CREATURE_COLS}`,
    [userId, skinId, !hasActive],
  );
  if (!hasActive) await updateAppearance(userId, skinId, "");
  return created[0];
}

/** Rattrape les œufs hebdomadaires manqués depuis la dernière visite (aucune
 *  limite : ça s'accumule). À appeler avant de lister les œufs de quelqu'un. */
export async function grantWeeklyEggs(userId: string): Promise<number> {
  const rows = await query<{ eggs_granted_through: string | null; is_bot: boolean }>(
    "SELECT eggs_granted_through, is_bot FROM users WHERE id = $1",
    [userId],
  );
  const row = rows[0];
  if (!row || row.is_bot) return 0;
  const monday = currentMonday();
  if (row.eggs_granted_through === monday) return 0;
  let weeks = 1;
  if (row.eggs_granted_through) {
    const last = new Date(row.eggs_granted_through + "T00:00:00Z").getTime();
    const now = new Date(monday + "T00:00:00Z").getTime();
    weeks = Math.round((now - last) / (7 * 24 * 3600 * 1000));
  }
  if (weeks <= 0) return 0;
  for (let i = 0; i < weeks; i++) {
    await query("INSERT INTO eggs (owner_id, source) VALUES ($1, 'weekly')", [userId]);
  }
  await query("UPDATE users SET eggs_granted_through = $2 WHERE id = $1", [userId, monday]);
  return weeks;
}

export async function listEggs(userId: string): Promise<Egg[]> {
  await grantWeeklyEggs(userId);
  return query<Egg>(`SELECT ${EGG_COLS} FROM eggs WHERE owner_id = $1 ORDER BY granted_at`, [userId]);
}

export async function listCreatures(userId: string): Promise<Creature[]> {
  return query<Creature>(`SELECT ${CREATURE_COLS} FROM creatures WHERE owner_id = $1 ORDER BY born_at`, [userId]);
}

function randomAppearance(): { species: string; color: string } {
  return {
    // Pendant la période de test : seul le poussin a un vrai dessin (les
    // autres espèces sont encore des silhouettes provisoires en CSS), donc on
    // limite le tirage au poussin pour l'instant. Pour élargir plus tard aux
    // autres espèces, remettre : SPECIES[Math.floor(Math.random() * SPECIES.length)]
    species: "chick",
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  };
}

/** Ouvre un œuf : tirage au sort (jamais côté client), fixé pour toujours.
 *  Renvoie null si l'œuf n'existe pas ou n'appartient pas à cette personne. */
export async function openEgg(userId: string, eggId: string): Promise<Creature | null> {
  const rows = await query<{ id: string; partner_id: string | null }>(
    "SELECT id, partner_id FROM eggs WHERE id = $1 AND owner_id = $2",
    [eggId, userId],
  );
  const egg = rows[0];
  if (!egg) return null;

  const hasActive = (await query("SELECT 1 FROM creatures WHERE owner_id = $1 AND active", [userId])).length > 0;
  const { species, color } = randomAppearance();

  const created = await query<Creature>(
    `INSERT INTO creatures (owner_id, species, color, active, partner_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${CREATURE_COLS}`,
    [userId, species, color, !hasActive, egg.partner_id],
  );
  await query("DELETE FROM eggs WHERE id = $1", [eggId]);
  if (!hasActive) await updateAppearance(userId, species, color);
  return created[0];
}

/** Change la créature active (flèches gauche/droite du Profil, effet immédiat).
 *  Renvoie null si cette créature n'existe pas ou n'appartient pas à cette personne. */
export async function activateCreature(userId: string, creatureId: string): Promise<PublicUser | null> {
  const rows = await query<{ id: string; species: string; color: string }>(
    "SELECT id, species, color FROM creatures WHERE id = $1 AND owner_id = $2",
    [creatureId, userId],
  );
  const creature = rows[0];
  if (!creature) return null;
  await query("UPDATE creatures SET active = FALSE WHERE owner_id = $1", [userId]);
  await query("UPDATE creatures SET active = TRUE WHERE id = $1", [creatureId]);
  return updateAppearance(userId, creature.species, creature.color);
}

// ------------------------------------------------------------- Œufs cadeaux

/** Offre un œuf qu'on possède à un ami : il change simplement de
 *  propriétaire, tout de suite — un cadeau, pas une proposition à accepter
 *  (voir décision produit : plus ambigu de « fusionner » un œuf à deux).
 *  Renvoie l'œuf offert (tel qu'il apparaît maintenant chez le destinataire),
 *  ou null s'il n'existe pas ou ne nous appartenait pas. */
export async function giftEgg(fromId: string, eggId: string, toId: string): Promise<Egg | null> {
  const rows = await query<Egg>(
    `UPDATE eggs SET owner_id = $3, source = 'gift', partner_id = $1
      WHERE id = $2 AND owner_id = $1 RETURNING ${EGG_COLS}`,
    [fromId, eggId, toId],
  );
  return rows[0] ?? null;
}

// ------------------------------------------------------------------ Salons
//
// Chaque personne a un seul salon, qui lui est propre : pas de table à part,
// l'id du salon est simplement l'id de son propriétaire. Ses amis peuvent y
// entrer et en sortir librement, sauf ceux qu'elle a bloqués. La présence en
// direct (qui est dedans maintenant) vit dans salons.ts, en mémoire — ici,
// uniquement ce qui doit survivre : le nom choisi et la liste de blocage.

// Niveaux d'accès et réglages d'écriture — voir db.ts pour le détail de
// chaque valeur (colonnes salon_access_level / salon_write_permission).
export type SalonAccessLevel = "private" | "friends" | "friends_of_friends" | "open";
export type SalonWritePermission = "members" | "friends_of_friends" | "everyone";

export interface Salon {
  id: string; // = l'id du propriétaire
  name: string;
  owner: PublicUser;
  hasPassword: boolean; // un mot de passe protège l'entrée pour les non-amis (voir checkSalonPassword)
  moderatorIds: string[];
  accessLevel: SalonAccessLevel;
  writePermission: SalonWritePermission;
  requireApproval: boolean;
  allowMemberInvites: boolean;
}

function defaultSalonName(username: string): string {
  return `Salon de ${username}`;
}

type SalonRow = PublicUser & {
  salon_name: string | null;
  salon_password_hash: string | null;
  salon_access_level: string;
  salon_write_permission: string;
  salon_require_approval: boolean;
  salon_allow_member_invites: boolean;
};

const SALON_COLS =
  "salon_name, salon_password_hash, salon_access_level, salon_write_permission, salon_require_approval, salon_allow_member_invites";

async function toSalon(row: SalonRow): Promise<Salon> {
  const {
    salon_name,
    salon_password_hash,
    salon_access_level,
    salon_write_permission,
    salon_require_approval,
    salon_allow_member_invites,
    ...owner
  } = row;
  return {
    id: owner.id,
    name: salon_name || defaultSalonName(owner.username),
    owner,
    hasPassword: salon_password_hash !== null,
    moderatorIds: await getSalonModeratorIds(owner.id),
    accessLevel: salon_access_level as SalonAccessLevel,
    writePermission: salon_write_permission as SalonWritePermission,
    requireApproval: salon_require_approval,
    allowMemberInvites: salon_allow_member_invites,
  };
}

/** Le salon de quelqu'un (toujours défini, même sans nom choisi : un nom par
 *  défaut s'affiche à la place). Renvoie null si cette personne n'existe pas. */
export async function getSalon(ownerId: string): Promise<Salon | null> {
  const rows = await query<SalonRow>(`SELECT ${USER_COLS}, ${SALON_COLS} FROM users WHERE id = $1`, [ownerId]);
  return rows[0] ? await toSalon(rows[0]) : null;
}

/** Les salons de mes amis (pour l'onglet Salons — le mien s'affiche à part,
 *  voir GET /salons). */
export async function listFriendSalons(userId: string): Promise<Salon[]> {
  const rows = await query<SalonRow>(
    `SELECT u.id, u.username, u.species, u.color, u.discord_handle AS discord, u.steam_handle AS steam,
            u.salon_name, u.salon_password_hash, u.salon_access_level, u.salon_write_permission,
            u.salon_require_approval, u.salon_allow_member_invites
       FROM friendships f
       JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = $1
      ORDER BY u.username_key`,
    [userId],
  );
  return Promise.all(rows.map(toSalon));
}

/** Change les réglages d'accès/modération d'un salon d'un coup — un seul
 *  bouton "Enregistrer les paramètres" côté client (voir
 *  SalonModerationScreen.tsx), plutôt qu'un réglage par appel. */
export async function updateSalonSettings(
  ownerId: string,
  patch: {
    accessLevel: SalonAccessLevel;
    writePermission: SalonWritePermission;
    requireApproval: boolean;
    allowMemberInvites: boolean;
  },
) {
  await query(
    `UPDATE users
        SET salon_access_level = $2, salon_write_permission = $3,
            salon_require_approval = $4, salon_allow_member_invites = $5
      WHERE id = $1`,
    [ownerId, patch.accessLevel, patch.writePermission, patch.requireApproval, patch.allowMemberInvites],
  );
}

export async function renameSalon(userId: string, name: string) {
  await query("UPDATE users SET salon_name = $2 WHERE id = $1", [userId, name]);
}

/** Change (ou retire, si `passwordHash` est null) le mot de passe d'entrée du
 *  salon. Ne concerne que les non-amis/non-modérateurs : voir assertSalonEntry
 *  dans index.ts, les amis et modérateurs entrent toujours librement. */
export async function setSalonPasswordHash(ownerId: string, passwordHash: string | null) {
  await query("UPDATE users SET salon_password_hash = $2 WHERE id = $1", [ownerId, passwordHash]);
}

/** Vérifie le mot de passe d'un salon : toujours vrai si le salon n'en a pas. */
export async function checkSalonPassword(ownerId: string, password?: string): Promise<boolean> {
  const rows = await query<{ salon_password_hash: string | null }>(
    "SELECT salon_password_hash FROM users WHERE id = $1",
    [ownerId],
  );
  const hash = rows[0]?.salon_password_hash ?? null;
  if (hash === null) return true;
  if (!password) return false;
  return verifyPassword(password, hash);
}

/** Plusieurs comptes par id d'un coup (ex. : qui est présent dans un salon). */
export async function getUsersByIds(ids: string[]): Promise<PublicUser[]> {
  if (ids.length === 0) return [];
  return query<PublicUser>(`SELECT ${USER_COLS} FROM users WHERE id = ANY($1::uuid[])`, [ids]);
}

// ---- Bannissement (par salon) — appelé "blocage" en base (nom historique),
// mais présenté comme un « ban » côté produit depuis l'ouverture des salons
// aux non-amis (voir index.ts : assertSalonEntry). Ces fonctions prennent déjà
// un salonId explicite, donc utilisables aussi bien par le propriétaire que
// par un modérateur (la restriction "qui a le droit" vit dans index.ts). ----

export async function isBlockedFromSalon(salonId: string, userId: string): Promise<boolean> {
  const rows = await query("SELECT 1 FROM salon_blocks WHERE salon_id = $1 AND blocked_id = $2", [salonId, userId]);
  return rows.length > 0;
}

export async function blockFromSalon(salonId: string, blockedId: string) {
  await query(
    "INSERT INTO salon_blocks (salon_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [salonId, blockedId],
  );
}

export async function unblockFromSalon(salonId: string, blockedId: string) {
  await query("DELETE FROM salon_blocks WHERE salon_id = $1 AND blocked_id = $2", [salonId, blockedId]);
}

export async function listSalonBlocks(salonId: string): Promise<PublicUser[]> {
  return query<PublicUser>(
    `SELECT ${USER_COLS} FROM salon_blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.salon_id = $1 ORDER BY u.username_key`,
    [salonId],
  );
}

// ---- Modérateurs (par salon) ----
//
// Nommés uniquement par le propriétaire (voir index.ts : réservé au
// propriétaire, contrairement au ban). Un modérateur peut bannir/débannir
// comme le propriétaire, mais ne peut ni nommer/retirer d'autres modérateurs,
// ni changer le mot de passe, ni supprimer le salon (décision produit du
// 26/09/2026 : "kick + ban, pas de gestion des modos").

export async function isSalonModerator(salonId: string, userId: string): Promise<boolean> {
  const rows = await query("SELECT 1 FROM salon_moderators WHERE salon_id = $1 AND user_id = $2", [salonId, userId]);
  return rows.length > 0;
}

export async function getSalonModeratorIds(salonId: string): Promise<string[]> {
  const rows = await query<{ user_id: string }>("SELECT user_id FROM salon_moderators WHERE salon_id = $1", [
    salonId,
  ]);
  return rows.map((r) => r.user_id);
}

export async function addSalonModerator(salonId: string, userId: string) {
  await query(
    "INSERT INTO salon_moderators (salon_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [salonId, userId],
  );
}

export async function removeSalonModerator(salonId: string, userId: string) {
  await query("DELETE FROM salon_moderators WHERE salon_id = $1 AND user_id = $2", [salonId, userId]);
}

/** Est-ce que `b` est un ami d'un des amis de `a` (peu importe si `b` est
 *  aussi un ami direct de `a` — pas testé ici, voir salon_access_level
 *  'friends_of_friends' dans index.ts : assertSalonEntry, qui vérifie déjà
 *  l'amitié directe séparément). Une seule requête (jointure), pas de
 *  boucle sur la liste d'amis. */
export async function isFriendOfFriend(a: string, b: string): Promise<boolean> {
  const rows = await query(
    `SELECT 1 FROM friendships f1
       JOIN friendships f2 ON f2.user_id = f1.friend_id
      WHERE f1.user_id = $1 AND f2.friend_id = $2
      LIMIT 1`,
    [a, b],
  );
  return rows.length > 0;
}

// ---- Membres explicites (par salon) — voir db.ts : salon_members. Accès
// permanent indépendant de salon_access_level (utile pour un salon
// 'private', ou pour garder l'accès à quelqu'un après une demande
// approuvée, voir salon_join_requests plus bas). ----

export async function isSalonMember(salonId: string, userId: string): Promise<boolean> {
  const rows = await query("SELECT 1 FROM salon_members WHERE salon_id = $1 AND user_id = $2", [salonId, userId]);
  return rows.length > 0;
}

export async function addSalonMember(salonId: string, userId: string, addedBy: string) {
  await query(
    "INSERT INTO salon_members (salon_id, user_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [salonId, userId, addedBy],
  );
}

export async function removeSalonMember(salonId: string, userId: string) {
  await query("DELETE FROM salon_members WHERE salon_id = $1 AND user_id = $2", [salonId, userId]);
}

export async function listSalonMembers(salonId: string): Promise<PublicUser[]> {
  return query<PublicUser>(
    `SELECT ${USER_COLS} FROM salon_members m JOIN users u ON u.id = m.user_id
      WHERE m.salon_id = $1 ORDER BY u.username_key`,
    [salonId],
  );
}

// ---- Demandes d'entrée (par salon) — voir db.ts : salon_join_requests.
// Posées quand salon_require_approval est actif (ou toujours pour un salon
// 'private', voir index.ts : assertSalonEntry), traitées par le
// propriétaire ou un modérateur (approuver -> devient membre, refuser ->
// disparaît simplement). ----

export async function hasSalonJoinRequest(salonId: string, userId: string): Promise<boolean> {
  const rows = await query("SELECT 1 FROM salon_join_requests WHERE salon_id = $1 AND user_id = $2", [
    salonId,
    userId,
  ]);
  return rows.length > 0;
}

export async function createSalonJoinRequest(salonId: string, userId: string) {
  await query(
    "INSERT INTO salon_join_requests (salon_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    [salonId, userId],
  );
}

export async function listSalonJoinRequests(salonId: string): Promise<PublicUser[]> {
  return query<PublicUser>(
    `SELECT ${USER_COLS} FROM salon_join_requests r JOIN users u ON u.id = r.user_id
      WHERE r.salon_id = $1 ORDER BY r.created_at`,
    [salonId],
  );
}

/** Accepte une demande : elle disparaît, la personne devient membre pour de
 *  bon (entrera librement ensuite, sans redemander). */
export async function approveSalonJoinRequest(salonId: string, userId: string, approvedBy: string) {
  await addSalonMember(salonId, userId, approvedBy);
  await query("DELETE FROM salon_join_requests WHERE salon_id = $1 AND user_id = $2", [salonId, userId]);
}

/** Refuse une demande : elle disparaît simplement, rien n'empêche d'en
 *  reposer une autre plus tard (pas de liste de refus permanente). */
export async function declineSalonJoinRequest(salonId: string, userId: string) {
  await query("DELETE FROM salon_join_requests WHERE salon_id = $1 AND user_id = $2", [salonId, userId]);
}

// ---- Mots interdits (par salon) — voir db.ts : salon_banned_words. Filtre
// simple par sous-chaîne, insensible à la casse, vérifié à l'envoi de
// chaque message de salon (voir index.ts, handler WS "salon-message"). ----

export async function listSalonBannedWords(salonId: string): Promise<string[]> {
  const rows = await query<{ word: string }>(
    "SELECT word FROM salon_banned_words WHERE salon_id = $1 ORDER BY word",
    [salonId],
  );
  return rows.map((r) => r.word);
}

export async function addSalonBannedWord(salonId: string, word: string) {
  const clean = word.trim().toLowerCase();
  if (!clean) return;
  await query("INSERT INTO salon_banned_words (salon_id, word) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    salonId,
    clean,
  ]);
}

export async function removeSalonBannedWord(salonId: string, word: string) {
  await query("DELETE FROM salon_banned_words WHERE salon_id = $1 AND word = $2", [salonId, word.trim().toLowerCase()]);
}

/** Est-ce que ce texte contient un des mots interdits de ce salon ? Simple
 *  recherche de sous-chaîne (pas de gestion des pluriels/variantes). */
export async function salonMessageContainsBannedWord(salonId: string, text: string): Promise<boolean> {
  const words = await listSalonBannedWords(salonId);
  if (words.length === 0) return false;
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w));
}

// ---- Signalements (par salon) — voir db.ts : salon_reports. La discussion
// n'étant jamais enregistrée, on garde un instantané du texte signalé au
// moment du signalement. Visibles par le propriétaire et les modérateurs,
// qui les traitent puis les suppriment (pas d'archive au-delà). ----

export interface SalonReport {
  id: string;
  reporter: PublicUser;
  reported: PublicUser | null;
  messageText: string;
  reason: string;
  createdAt: string;
}

export async function createSalonReport(
  salonId: string,
  reporterId: string,
  reportedId: string | null,
  messageText: string,
  reason: string,
) {
  await query(
    `INSERT INTO salon_reports (salon_id, reporter_id, reported_id, message_text, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [salonId, reporterId, reportedId, messageText.slice(0, 1000), reason.slice(0, 200)],
  );
}

export async function listSalonReports(salonId: string): Promise<SalonReport[]> {
  const rows = await query<{
    id: string;
    message_text: string;
    reason: string;
    created_at: string;
    reporter_id: string;
    reported_id: string | null;
  }>(
    `SELECT id, message_text, reason, created_at, reporter_id, reported_id
       FROM salon_reports WHERE salon_id = $1 ORDER BY created_at DESC`,
    [salonId],
  );
  const ids = [...new Set(rows.flatMap((r) => [r.reporter_id, r.reported_id]).filter((v): v is string => !!v))];
  const users = await getUsersByIds(ids);
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => ({
    id: r.id,
    reporter: byId.get(r.reporter_id) ?? {
      id: r.reporter_id,
      username: "?",
      species: "egg",
      color: "",
      discord: null,
      steam: null,
      away: false,
    },
    reported: r.reported_id ? byId.get(r.reported_id) ?? null : null,
    messageText: r.message_text,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}

export async function dismissSalonReport(salonId: string, reportId: string) {
  await query("DELETE FROM salon_reports WHERE salon_id = $1 AND id = $2", [salonId, reportId]);
}

// ---- Espaces (chats) ----
//
// Range ses discussions (amis + groupes, la même liste que l'onglet Chats,
// voir chat_id : même espace d'identifiants que "activeChat" côté client)
// dans des espaces personnels (rebaptisés "espaces", initialement "cercles",
// le 27/09/2026). Système séparé de celui des salons plus bas (décision
// produit du même jour) ; un chat dans un espace au plus.

export interface ChatFolder {
  id: string;
  name: string;
  chatIds: string[];
}

/** Mes espaces de chats, avec ce qu'ils contiennent (un seul aller-retour,
 *  plutôt qu'un appel par espace côté client). */
export async function listChatFolders(userId: string): Promise<ChatFolder[]> {
  const folders = await query<{ id: string; name: string }>(
    "SELECT id, name FROM chat_folders WHERE user_id = $1 ORDER BY created_at",
    [userId],
  );
  const items = await query<{ folder_id: string; chat_id: string }>(
    "SELECT folder_id, chat_id FROM chat_folder_items WHERE user_id = $1",
    [userId],
  );
  const byFolder = new Map<string, string[]>();
  for (const it of items) {
    const arr = byFolder.get(it.folder_id);
    if (arr) arr.push(it.chat_id);
    else byFolder.set(it.folder_id, [it.chat_id]);
  }
  return folders.map((f) => ({ id: f.id, name: f.name, chatIds: byFolder.get(f.id) ?? [] }));
}

export async function createChatFolder(userId: string, name: string): Promise<ChatFolder> {
  const rows = await query<{ id: string; name: string }>(
    "INSERT INTO chat_folders (user_id, name) VALUES ($1, $2) RETURNING id, name",
    [userId, name],
  );
  return { id: rows[0].id, name: rows[0].name, chatIds: [] };
}

/** Renomme un de mes espaces. Renvoie false s'il n'existe pas (ou n'est pas
 *  à moi — même chose du point de vue de qui demande). */
export async function renameChatFolder(userId: string, folderId: string, name: string): Promise<boolean> {
  const rows = await query("UPDATE chat_folders SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING id", [
    folderId,
    userId,
    name,
  ]);
  return rows.length > 0;
}

/** Supprime un de mes espaces : ce qu'il contenait redevient "non classé"
 *  (voir chat_folder_items, ON DELETE CASCADE — pas une suppression des
 *  discussions elles-mêmes, juste du classement). */
export async function deleteChatFolder(userId: string, folderId: string): Promise<boolean> {
  const rows = await query("DELETE FROM chat_folders WHERE id = $1 AND user_id = $2 RETURNING id", [
    folderId,
    userId,
  ]);
  return rows.length > 0;
}

export async function chatFolderBelongsTo(userId: string, folderId: string): Promise<boolean> {
  const rows = await query("SELECT 1 FROM chat_folders WHERE id = $1 AND user_id = $2", [folderId, userId]);
  return rows.length > 0;
}

/** Range ce chat dans cet espace (`folderId` null = le retire, redevient
 *  non classé) — un seul espace à la fois : remplace le précédent. */
export async function setChatFolder(userId: string, chatId: string, folderId: string | null) {
  if (folderId === null) {
    await query("DELETE FROM chat_folder_items WHERE user_id = $1 AND chat_id = $2", [userId, chatId]);
    return;
  }
  await query(
    `INSERT INTO chat_folder_items (user_id, chat_id, folder_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, chat_id) DO UPDATE SET folder_id = $3`,
    [userId, chatId, folderId],
  );
}

// ---- Espaces (salons) ----
//
// Même principe que ci-dessus, système volontairement séparé (décision du
// 27/09/2026) : mes espaces de chats et mes espaces de salons ne se
// mélangent pas. salon_id = l'id du propriétaire du salon, comme partout
// ailleurs pour les salons.

export interface SalonFolder {
  id: string;
  name: string;
  salonIds: string[];
}

export async function listSalonFolders(userId: string): Promise<SalonFolder[]> {
  const folders = await query<{ id: string; name: string }>(
    "SELECT id, name FROM salon_folders WHERE user_id = $1 ORDER BY created_at",
    [userId],
  );
  const items = await query<{ folder_id: string; salon_id: string }>(
    "SELECT folder_id, salon_id FROM salon_folder_items WHERE user_id = $1",
    [userId],
  );
  const byFolder = new Map<string, string[]>();
  for (const it of items) {
    const arr = byFolder.get(it.folder_id);
    if (arr) arr.push(it.salon_id);
    else byFolder.set(it.folder_id, [it.salon_id]);
  }
  return folders.map((f) => ({ id: f.id, name: f.name, salonIds: byFolder.get(f.id) ?? [] }));
}

export async function createSalonFolder(userId: string, name: string): Promise<SalonFolder> {
  const rows = await query<{ id: string; name: string }>(
    "INSERT INTO salon_folders (user_id, name) VALUES ($1, $2) RETURNING id, name",
    [userId, name],
  );
  return { id: rows[0].id, name: rows[0].name, salonIds: [] };
}

export async function renameSalonFolder(userId: string, folderId: string, name: string): Promise<boolean> {
  const rows = await query("UPDATE salon_folders SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING id", [
    folderId,
    userId,
    name,
  ]);
  return rows.length > 0;
}

export async function deleteSalonFolder(userId: string, folderId: string): Promise<boolean> {
  const rows = await query("DELETE FROM salon_folders WHERE id = $1 AND user_id = $2 RETURNING id", [
    folderId,
    userId,
  ]);
  return rows.length > 0;
}

export async function salonFolderBelongsTo(userId: string, folderId: string): Promise<boolean> {
  const rows = await query("SELECT 1 FROM salon_folders WHERE id = $1 AND user_id = $2", [folderId, userId]);
  return rows.length > 0;
}

export async function setSalonFolder(userId: string, salonId: string, folderId: string | null) {
  if (folderId === null) {
    await query("DELETE FROM salon_folder_items WHERE user_id = $1 AND salon_id = $2", [userId, salonId]);
    return;
  }
  await query(
    `INSERT INTO salon_folder_items (user_id, salon_id, folder_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, salon_id) DO UPDATE SET folder_id = $3`,
    [userId, salonId, folderId],
  );
}
