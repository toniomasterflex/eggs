// Réglages du serveur. Tout peut être changé avec des variables d'environnement.

export const config = {
  port: Number(process.env.PORT ?? 3000),
  // Écoute seulement sur ton ordinateur par défaut. Pour un vrai serveur en
  // ligne, on mettra HOST=0.0.0.0 (derrière HTTPS).
  host: process.env.HOST ?? "127.0.0.1",
  // Dossier de la base de données (sur ton disque).
  dataDir: process.env.DATA_DIR ?? "./data",
  // Léa, Thomas et Lucas (des « robots ») comme amis de départ, pour tester
  // sans deuxième ordinateur. Désactivé par défaut (vraie utilisation).
  // Pour les réactiver temporairement : $env:SEED_BOTS='true'; npm run dev
  seedBots: (process.env.SEED_BOTS ?? "false") === "true",
};
