// Réglages du serveur. Tout peut être changé avec des variables d'environnement.

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Écoute seulement sur ton ordinateur par défaut. Pour un vrai serveur en
  // ligne, on mettra HOST=0.0.0.0 (derrière HTTPS).
  host: process.env.HOST ?? "127.0.0.1",
  // Dossier de la base de données (sur ton disque).
  dataDir: process.env.DATA_DIR ?? "./data",
  // Photos / vidéos / sons partagés en conversation (voir index.ts :
  // POST /messages/:friendId/attachment) : un sous-dossier du même disque,
  // servi tel quel en lecture (voir @fastify/static, route /uploads).
  uploadsDir: process.env.UPLOADS_DIR ?? "./data/uploads",
  // Taille max d'une pièce jointe (25 Mo par défaut : large pour une photo
  // ou un son, correct pour une courte vidéo, sans pouvoir remplir le
  // disque avec un seul envoi).
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024),
  // Léa, Thomas et Lucas (des « robots ») comme amis de départ, pour tester
  // sans deuxième ordinateur. Désactivé par défaut (vraie utilisation).
  // Pour les réactiver temporairement : $env:SEED_BOTS='true'; npm run dev
  seedBots: (process.env.SEED_BOTS ?? "false") === "true",
  // Email de vérification à l'inscription (voir mail.ts, envoyé via Resend :
  // https://resend.com, gratuit jusqu'à 3000/mois). Tant que RESEND_API_KEY
  // n'est pas renseigné (pas encore de compte Resend / domaine vérifié), le
  // lien de vérification est juste affiché dans les logs au lieu d'être
  // envoyé — pratique pour développer sans rien configurer, et l'inscription
  // continue de marcher normalement (voir index.ts : jamais bloquante).
  resendApiKey: process.env.RESEND_API_KEY || null,
  // Doit être une adresse sur un domaine vérifié dans Resend une fois
  // configuré (voir EMAIL.md pour la mise en place complète).
  // "onboarding@resend.dev" ne marche que pour tester en développement,
  // jamais pour du vrai trafic.
  mailFrom: process.env.MAIL_FROM || "Eggs <onboarding@resend.dev>",
  // Pour construire le lien de vérification (GET /verify-email/:token) — à
  // remplacer par l'adresse publique du serveur une fois déployé.
  appUrl: process.env.APP_URL || `http://127.0.0.1:${process.env.PORT ?? 3000}`,
};
