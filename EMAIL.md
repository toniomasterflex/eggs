# Vérification d'email (Resend)

Depuis le 27/09/2026, l'inscription demande un pseudo, un email et un mot de
passe (voir `claude/chat-de-groupe-conception.md` pour le contexte produit :
ça prépare aussi un futur matching de contacts). Un email de vérification est
envoyé à l'inscription via [Resend](https://resend.com) — gratuit jusqu'à
3000 emails/mois (100/jour).

**Rien à faire pour que ça marche dès maintenant en développement** : tant
que `RESEND_API_KEY` n'est pas défini, aucun email n'est réellement envoyé —
le lien de vérification s'affiche juste dans les logs du serveur
(`[mail] RESEND_API_KEY non configuré — lien de vérification pour ... : ...`).
Copie ce lien dans un navigateur pour tester le parcours complet sans rien
configurer. L'inscription et la connexion fonctionnent normalement dans ce
mode ; seul `emailVerified` reste à `false`.

Ce document explique la mise en place pour de vrais envois.

## Étape 1 — un domaine pour envoyer depuis

Resend exige d'envoyer depuis une adresse sur un domaine que tu contrôles
(pas depuis `gmail.com`, par exemple), pour prouver que tu es bien
l'expéditeur et éviter que les emails finissent en spam. Deux options :

- **Un petit domaine à toi** (recommandé si Eggs devient un vrai projet) :
  1 à 3 € la première année chez un registrar comme
  [Porkbun](https://porkbun.com) ou [Namecheap](https://namecheap.com)
  (le renouvellement ensuite est au tarif normal, plutôt 10-15 €/an). Tu en
  restes propriétaire, sans dépendre de personne.
- **Un sous-domaine gratuit via [is-a.dev](https://www.is-a-dev.com/)** :
  demande une "pull request" sur leur dépôt GitHub
  ([is-a-dev/register](https://github.com/is-a-dev/register)) pour un
  sous-domaine du genre `eggs.is-a.dev`, avec les enregistrements DNS que
  Resend te donnera à l'étape 2. Gratuit, mais pas instantané (un mainteneur
  bénévole doit valider la demande), et ce n'est qu'un sous-domaine, pas un
  vrai domaine à toi.

## Étape 2 — compte Resend + vérification du domaine

1. Crée un compte sur [resend.com](https://resend.com) (gratuit, pas de
   carte bancaire).
2. Dans le tableau de bord → **Domains** → **Add Domain**, entre ton domaine
   (ou sous-domaine).
3. Resend affiche 3-4 enregistrements DNS à ajouter (des `TXT` pour SPF/DKIM,
   parfois un `MX`) — copie-les chez ton registrar (ou dans la pull request
   is-a.dev). La propagation DNS prend de quelques minutes à quelques heures.
4. Une fois Resend affiche le domaine comme "Verified", passe à l'étape 3.

## Étape 3 — la clé API

Dans le tableau de bord Resend → **API Keys** → **Create API Key** (droits
d'envoi seuls suffisent). Copie la clé (elle ne sera plus jamais affichée en
entier après) — comme la clé de signature des mises à jour (voir
`UPDATING.md`), elle ne doit **jamais** être commitée dans le dépôt Git ni
collée dans le chat.

## Étape 4 — variables d'environnement du serveur

Là où tourne `server/` (voir `server/src/config.ts`) :

```powershell
$env:RESEND_API_KEY = "re_ta_cle_ici"
$env:MAIL_FROM = "Eggs <no-reply@tondomaine.xxx>"   # doit être sur le domaine vérifié à l'étape 2
$env:APP_URL = "https://adresse-publique-du-serveur"  # utilisée pour construire le lien de vérification
npm run dev   # ou npm start
```

Redémarre le serveur après avoir défini ces variables (elles ne sont lues
qu'au démarrage). Crée un compte de test : l'email doit arriver pour de vrai
au lieu d'apparaître dans les logs, et `[mail] RESEND_API_KEY non configuré`
ne doit plus jamais s'afficher.

## En cas de souci

- **L'email n'arrive jamais, pas d'erreur dans les logs** : vérifie le
  dossier spam, et que le domaine est bien "Verified" dans le tableau de bord
  Resend (pas juste "Pending").
- **`[mail] échec d'envoi à ... :` dans les logs** : le message d'erreur qui
  suit vient directement de Resend (clé invalide, domaine pas vérifié,
  domaine/adresse mal formés dans `MAIL_FROM`...) — voir
  [leur documentation des erreurs](https://resend.com/docs/api-reference/errors).
- **Le lien de vérification pointe vers la mauvaise adresse** (par exemple
  `127.0.0.1` alors que le serveur est en ligne) : `APP_URL` n'est pas
  configuré, voir étape 4.
- **Un compte créé avant le 27/09/2026 n'a pas d'email** : normal, pas de
  rattrapage forcé rétroactif (voir `server/src/db.ts`) — rien à vérifier
  pour ces comptes-là.
