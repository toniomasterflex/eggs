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
