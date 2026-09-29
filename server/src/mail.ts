// Envoi de l'email de vérification d'adresse, via Resend
// (https://resend.com — gratuit jusqu'à 3000 emails/mois, 100/jour). Voir
// config.ts pour RESEND_API_KEY / MAIL_FROM / APP_URL, et EMAIL.md pour la
// mise en place complète (compte Resend + domaine vérifié).
//
// Règle importante : un souci d'envoi (clé absente ou invalide, domaine pas
// vérifié, panne de Resend...) ne doit JAMAIS empêcher quelqu'un de créer son
// compte ou de se connecter. Toutes les fonctions d'ici sont donc protégées
// en interne et ne lancent jamais d'exception — au pire, rien n'est envoyé et
// c'est juste noté dans les logs (la personne peut redemander un email plus
// tard, voir index.ts : POST /me/resend-verification).

import { Resend } from "resend";
import { config } from "./config.js";

let client: Resend | null = null;

function getClient(): Resend | null {
  if (!config.resendApiKey) return null;
  if (!client) client = new Resend(config.resendApiKey);
  return client;
}

function verificationLink(token: string): string {
  return `${config.appUrl.replace(/\/+$/, "")}/verify-email/${token}`;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

function verificationEmailHtml(username: string, link: string): string {
  const safeName = escapeHtml(username);
  const safeLink = escapeHtml(link);
  return `<!doctype html>
<html>
  <body style="font-family: -apple-system, sans-serif; background: #f6f4fb; padding: 24px; color: #2a2438; margin: 0;">
    <div style="max-width: 420px; margin: 0 auto; background: #ffffff; border-radius: 16px; padding: 28px;">
      <h1 style="font-size: 18px; margin: 0 0 12px;">Salut ${safeName} 👋</h1>
      <p style="margin: 0 0 20px; line-height: 1.5;">Confirme ton adresse email pour ton compte Eggs :</p>
      <p style="text-align: center; margin: 0 0 20px;">
        <a href="${safeLink}" style="background: #ffd84d; color: #2a2438; text-decoration: none; padding: 12px 24px; border-radius: 10px; font-weight: 600; display: inline-block;">
          Confirmer mon email
        </a>
      </p>
      <p style="font-size: 12px; color: #8a8398; line-height: 1.5; word-break: break-all;">
        Si le bouton ne marche pas, copie ce lien dans ton navigateur :<br>${safeLink}
      </p>
      <p style="font-size: 12px; color: #8a8398; margin-top: 20px;">Ce lien expire dans 24h.</p>
    </div>
  </body>
</html>`;
}

function verificationEmailText(username: string, link: string): string {
  return `Salut ${username},\n\nConfirme ton adresse email pour ton compte Eggs en ouvrant ce lien (valable 24h) :\n${link}\n`;
}

/** Envoie l'email de vérification. Ne lance jamais d'exception (voir
 *  l'en-tête de ce fichier) : appelable sans précaution particulière depuis
 *  index.ts. */
export async function sendVerificationEmail(to: string, username: string, token: string): Promise<void> {
  const link = verificationLink(token);
  const resend = getClient();
  if (!resend) {
    // RESEND_API_KEY absent (voir config.ts) : mode développement, on
    // affiche le lien au lieu de l'envoyer pour de vrai.
    console.log(`[mail] RESEND_API_KEY non configuré — lien de vérification pour ${to} :\n  ${link}`);
    return;
  }
  try {
    const { error } = await resend.emails.send({
      from: config.mailFrom,
      to,
      subject: "Confirme ton adresse email — Eggs",
      html: verificationEmailHtml(username, link),
      text: verificationEmailText(username, link),
    });
    if (error) console.error(`[mail] échec d'envoi à ${to} :`, error);
  } catch (err) {
    console.error(`[mail] échec d'envoi à ${to} :`, err);
  }
}
