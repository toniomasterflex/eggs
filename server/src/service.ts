// La logique : utilisateurs, amis, messages. Le seul endroit qui parle à la base.

import { hashPassword } from "./auth.js";
import { config } from "./config.js";
import { query } from "./db.js";

export interface PublicUser {
  id: string;
  username: string;
  species: string;
  color: string;
}

// Espèces et couleurs valides pour une créature (tirage au sort à l'éclosion).
export const SPECIES = ["chick", "cat", "fox", "penguin", "rabbit", "panda", "frog", "owl"];
export const COLORS = ["sun", "rose", "sky", "mint", "lilac", "peach", "cloud"];

export interface Message {
  id: number;
  from: string;
  to: string;
  text: string;
  at: number; // millisecondes
}

const USER_COLS = "id, username, species, color";
const MSG_COLS = `id::int AS id, sender_id AS "from", recipient_id AS "to", text,
  (extract(epoch from created_at) * 1000)::float8 AS at`;

// ---------------------------------------------------------------- Utilisateurs

export const usernameKey = (username: string) => username.trim().toLowerCase();

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

export async function createUser(
  username: string,
  password: string | null,
  opts: { species?: string; color?: string; bot?: boolean } = {},
): Promise<PublicUser> {
  const hash = password === null ? "disabled" : await hashPassword(password);
  const rows = await query<PublicUser>(
    `INSERT INTO users (username, username_key, password_hash, species, color, is_bot)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${USER_COLS}`,
    // Un vrai compte démarre sans créature ("egg") : sa première créature vient
    // de l'œuf de bienvenue (voir giveWelcomeEgg). Seuls les robots (bots.ts)
    // passent une espèce/couleur explicite ici.
    [username.trim(), usernameKey(username), hash, opts.species ?? "egg", opts.color ?? "", opts.bot ?? false],
  );
  return rows[0];
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
}

export async function listFriends(userId: string) {
  return query<PublicUser & { unread: number; lastAt: number | null; readAt: number | null }>(
    `SELECT u.id, u.username, u.species, u.color,
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
  const rows = await query<Message>(
    `SELECT ${MSG_COLS} FROM messages
      WHERE ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1))
        AND ($3::int IS NULL OR id < $3::int)
      ORDER BY id DESC
      LIMIT $4`,
    [userId, friendId, beforeId ?? null, limit],
  );
  return rows.reverse();
}

export async function insertMessage(from: string, to: string, text: string): Promise<Message> {
  const rows = await query<Message>(
    `INSERT INTO messages (sender_id, recipient_id, text) VALUES ($1, $2, $3)
     RETURNING ${MSG_COLS}`,
    [from, to, text],
  );
  return rows[0];
}

export async function markRead(userId: string, friendId: string) {
  await query(
    `UPDATE messages SET read_at = now()
      WHERE recipient_id = $1 AND sender_id = $2 AND read_at IS NULL`,
    [userId, friendId],
  );
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

export interface Salon {
  id: string; // = l'id du propriétaire
  name: string;
  owner: PublicUser;
}

function defaultSalonName(username: string): string {
  return `Salon de ${username}`;
}

function toSalon(row: PublicUser & { salon_name: string | null }): Salon {
  const { salon_name, ...owner } = row;
  return { id: owner.id, name: salon_name || defaultSalonName(owner.username), owner };
}

/** Le salon de quelqu'un (toujours défini, même sans nom choisi : un nom par
 *  défaut s'affiche à la place). Renvoie null si cette personne n'existe pas. */
export async function getSalon(ownerId: string): Promise<Salon | null> {
  const rows = await query<PublicUser & { salon_name: string | null }>(
    `SELECT ${USER_COLS}, salon_name FROM users WHERE id = $1`,
    [ownerId],
  );
  return rows[0] ? toSalon(rows[0]) : null;
}

/** Les salons de mes amis (pour l'onglet Salons — le mien s'affiche à part,
 *  voir GET /salons). */
export async function listFriendSalons(userId: string): Promise<Salon[]> {
  const rows = await query<PublicUser & { salon_name: string | null }>(
    `SELECT u.id, u.username, u.species, u.color, u.salon_name
       FROM friendships f
       JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = $1
      ORDER BY u.username_key`,
    [userId],
  );
  return rows.map(toSalon);
}

export async function renameSalon(userId: string, name: string) {
  await query("UPDATE users SET salon_name = $2 WHERE id = $1", [userId, name]);
}

/** Plusieurs comptes par id d'un coup (ex. : qui est présent dans un salon). */
export async function getUsersByIds(ids: string[]): Promise<PublicUser[]> {
  if (ids.length === 0) return [];
  return query<PublicUser>(`SELECT ${USER_COLS} FROM users WHERE id = ANY($1::uuid[])`, [ids]);
}

// ---- Blocage (par salon) ----

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
