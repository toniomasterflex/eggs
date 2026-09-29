// Mots de passe et jetons de session, avec les outils intégrés à Node
// (aucune bibliothèque à compiler).

import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { query } from "./db.js";

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Mot de passe -> « scrypt$sel$empreinte » (on ne stocke jamais le mot de passe). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, saltHex, keyHex] = stored.split("$");
  if (kind !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Crée une session : renvoie le jeton (à garder côté application). */
export async function createSession(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await query("INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)", [sha256(token), userId]);
  return token;
}

export async function userIdFromToken(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const rows = await query<{ user_id: string }>(
    "SELECT user_id FROM sessions WHERE token_hash = $1",
    [sha256(token)],
  );
  return rows[0]?.user_id ?? null;
}

export async function deleteSession(token: string): Promise<void> {
  await query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
}

/** Supprime toutes les sessions d'un utilisateur, sauf éventuellement celle-ci. */
export async function deleteSessions(userId: string, exceptToken?: string): Promise<void> {
  if (exceptToken) {
    await query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [userId, sha256(exceptToken)]);
  } else {
    await query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  }
}

// --------------------------------------------- Vérification d'email
//
// Même principe que les sessions ci-dessus (jeton aléatoire, seule son
// empreinte est gardée en base) mais à usage unique et de courte durée — voir
// db.ts : email_verifications, mail.ts pour l'envoi, index.ts pour les
// routes GET /verify-email/:token et POST /me/resend-verification.

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export async function createEmailVerificationToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
  await query("INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES ($1, $2, $3)", [
    sha256(token),
    userId,
    expiresAt.toISOString(),
  ]);
  return token;
}

/** À usage unique : le jeton est supprimé qu'il soit valide ou non. Renvoie
 *  l'utilisateur concerné, ou null si le jeton est inconnu ou expiré. */
export async function consumeEmailVerificationToken(token: string): Promise<string | null> {
  const rows = await query<{ user_id: string; expires_at: string }>(
    "DELETE FROM email_verifications WHERE token_hash = $1 RETURNING user_id, expires_at",
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row.user_id;
}

/** Invalide les jetons déjà émis pour cette personne avant d'en renvoyer un
 *  nouveau (voir POST /me/resend-verification) : un seul lien valide à la
 *  fois, le précédent ne doit plus marcher. */
export async function clearEmailVerificationTokens(userId: string): Promise<void> {
  await query("DELETE FROM email_verifications WHERE user_id = $1", [userId]);
}
