# Mises à jour automatiques

Depuis cette mise en place, Eggs se vérifie tout seul au démarrage (et via
« Vérifier les mises à jour » dans le menu de l'icône, en bas à droite de
l'écran) : s'il existe une version plus récente sur GitHub, il la télécharge,
l'installe, puis redémarre dessus — sans repasser par un `.exe` envoyé à la
main.

Ça repose sur GitHub Releases : chaque nouvelle version est publiée là-bas,
avec un petit fichier `latest.json` qui dit « voici la dernière version, et
voici comment vérifier qu'elle vient bien de toi » (grâce à une signature).

## Étape 1 — mise en place (une seule fois)

1. **Crée un dépôt GitHub pour ce projet**, s'il n'existe pas déjà :
   sur github.com, "New repository" → nom `eggs` (ou ce que tu veux) →
   **public** (obligatoire avec cette mise en place simple : un dépôt privé
   empêcherait l'appli de télécharger les mises à jour toute seule, voir
   note en bas). Puis pousse le code de `C:\Dev\eggs` dedans (`git init`,
   `git add .`, `git commit`, `git remote add origin ...`, `git push`) —
   le `.gitignore` déjà présent exclut `node_modules`, `dist`, etc.

2. **Génère ta clé de signature** (elle garantit que seules TES mises à
   jour, signées par toi, sont installées — sans elle n'importe qui pourrait
   en théorie en glisser une fausse) :

   ```powershell
   cd C:\Dev\eggs
   mkdir $env:USERPROFILE\.tauri -ErrorAction SilentlyContinue
   npx tauri signer generate -w "$env:USERPROFILE\.tauri\eggs.key"
   ```

   Ça te demande un mot de passe pour protéger la clé (choisis-en un, garde-le
   quelque part — un gestionnaire de mots de passe par exemple) puis affiche
   ta **clé publique**. Copie-la.

   ⚠️ Le fichier `eggs.key` (clé privée) et son mot de passe ne doivent
   JAMAIS être commités dans le dépôt Git, ni partagés, ni collés dans le
   chat — c'est ce qui empêche quelqu'un d'autre de publier une fausse mise
   à jour en se faisant passer pour toi. Le `.gitignore` du projet ne
   référence pas ce fichier car il vit hors du dossier (dans ton profil
   Windows) — ne le déplace pas dans `C:\Dev\eggs`.

3. **Renseigne deux choses dans `src-tauri/tauri.conf.json`** (section
   `plugins.updater`) :
   - remplace `REMPLACE_MOI` (dans `endpoints`) par ton compte GitHub —
     par exemple `"https://github.com/antoine123/eggs/releases/latest/download/latest.json"`.
   - remplace `REMPLACE_MOI_PAR_TA_CLE_PUBLIQUE` par la clé publique copiée
     à l'étape 2.

4. **Premier build signé.** Avant `npm run tauri build`, il faut que la clé
   privée soit accessible via deux variables d'environnement (elles ne sont
   utiles qu'au moment du build, pas ensuite) :

   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\eggs.key" -Raw
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "le mot de passe choisi à l'étape 2"
   npm run tauri build
   ```

   (`npm run tauri build` plutôt que `cargo tauri build` : ce poste n'a pas
   l'outil Tauri installé globalement pour Cargo, mais il est déjà présent
   via npm — voir `package.json`, script `tauri`. Les deux font exactement
   la même chose ; si `cargo tauri build` fonctionne un jour chez toi, les
   deux formes restent interchangeables.)

   En plus de l'installeur habituel, ça produit maintenant un fichier
   `.exe.sig` à côté (dans `src-tauri\target\release\bundle\nsis\`).

5. **Fabrique `latest.json`** :

   ```powershell
   node scripts/make-latest-json.mjs "Première version avec mise à jour automatique"
   ```

6. **Crée la release GitHub.** Sur ton dépôt → Releases → "Draft a new
   release" → tag `v0.1.0` (doit correspondre exactement à `version` dans
   `tauri.conf.json`, avec un `v` devant — le script te le rappelle) → joins
   les 3 fichiers présents dans `src-tauri\target\release\bundle\nsis\` :
   l'installeur `.exe`, son `.exe.sig`, et `latest.json` → Publish.

7. **Ton ami réinstalle une dernière fois à la main** cette version (son
   installation actuelle ne connaît pas encore le système de mise à jour).
   À partir de là, les prochaines versions lui arriveront toutes seules.

## Étape 2 — à chaque nouvelle version, ensuite

1. Monte le numéro de version (les DEUX doivent rester identiques) :
   - `src-tauri/tauri.conf.json` → `"version"`
   - `package.json` → `"version"`
2. Build signé (mêmes deux variables d'environnement qu'à l'étape 1.4,
   dans le même terminal PowerShell — si tu en ouvres un nouveau, refais
   les deux lignes `$env:...`) :
   ```powershell
   npm run tauri build
   ```
3. `node scripts/make-latest-json.mjs "ce qui a changé, en une phrase"`
4. Nouvelle release GitHub, tag `vX.Y.Z` correspondant, avec les 3 mêmes
   fichiers (installeur, `.sig`, `latest.json`).
5. C'est tout : toi et ton ami la recevrez automatiquement au prochain
   lancement d'Eggs (ou tout de suite via « Vérifier les mises à jour »
   dans le menu de l'icône).

## Pourquoi le dépôt doit être public

L'appli va chercher `latest.json` toute seule, sans mot de passe ni jeton
d'accès. Sur un dépôt privé, GitHub lui répondrait "accès refusé" et la
vérification échouerait silencieusement. Si un jour le code doit devenir
privé, il faudra changer d'hébergement pour les releases (un petit serveur à
toi, par exemple) — pas urgent tant que ce n'est que vous deux.

## En cas de souci

- **`npm run tauri build` n'affiche pas d'erreur mais il n'y a pas de
  `.exe.sig`** : `TAURI_SIGNING_PRIVATE_KEY` n'était probablement pas défini
  dans CE terminal avant la commande (voir étape 1.4/2.2).
- **L'appli ne se met jamais à jour toute seule** : vérifie que la release
  GitHub est bien publiée (pas en "Draft"), que le tag est exactement
  `vX.Y.Z` (le `v` compte), et que les 3 fichiers sont bien dessus.
- **Erreur de compilation du genre « no method named `restart` found »**
  dans `check_for_update` (`src-tauri/src/lib.rs`) : ajoute
  `use tauri_plugin_process::ProcessExt;` en haut du fichier, à côté des
  autres `use` — un détail de version du plugin que je n'ai pas pu vérifier
  par compilation directe de mon côté (je n'ai pas Rust sous la main ici).
