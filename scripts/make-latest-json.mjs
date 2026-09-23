// Fabrique latest.json à partir du résultat de `cargo tauri build`, pour la
// mise à jour automatique (voir UPDATING.md à la racine du projet).
//
// Usage, après un `cargo tauri build` réussi (avec TAURI_SIGNING_PRIVATE_KEY
// défini, voir UPDATING.md) :
//
//   node scripts/make-latest-json.mjs ["notes de version optionnelles"]
//
// Le fichier produit (src-tauri/target/release/bundle/nsis/latest.json) est
// le TROISIÈME fichier à joindre à la release GitHub, en plus de
// l'installeur .exe et de son .sig — voir UPDATING.md pour l'étape exacte.
//
// Le nom du dépôt GitHub est lu directement dans tauri.conf.json
// (plugins.updater.endpoints) pour ne jamais avoir à le retaper ici : si tu
// as bien remplacé REMPLACE_MOI par ton compte GitHub dans ce fichier (une
// seule fois, voir UPDATING.md), ce script suit automatiquement.

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const confPath = path.join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));

const version = conf.version;
if (!version) {
  console.error("Impossible de lire la version dans src-tauri/tauri.conf.json");
  process.exit(1);
}

const endpoint = conf.plugins?.updater?.endpoints?.[0];
const match = endpoint && endpoint.match(/github\.com\/([^/]+)\/([^/]+)\//);
if (!match) {
  console.error(
    "src-tauri/tauri.conf.json: plugins.updater.endpoints ne pointe pas vers " +
      "un dépôt GitHub reconnaissable (as-tu remplacé REMPLACE_MOI ? voir UPDATING.md).",
  );
  process.exit(1);
}
const [, owner, repo] = match;
if (owner === "REMPLACE_MOI") {
  console.error(
    "src-tauri/tauri.conf.json: remplace d'abord REMPLACE_MOI (dans " +
      "plugins.updater.endpoints) par ton compte GitHub réel — voir UPDATING.md, étape 1.",
  );
  process.exit(1);
}

const bundleDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
let files;
try {
  files = readdirSync(bundleDir);
} catch {
  console.error(
    `Dossier introuvable : ${bundleDir}\n` +
      "As-tu bien lancé `cargo tauri build` avant ce script ?",
  );
  process.exit(1);
}

const sigFile = files.find((f) => f.endsWith(".exe.sig"));
if (!sigFile) {
  console.error(
    `Aucun fichier .exe.sig dans ${bundleDir}.\n` +
      "Vérifie que TAURI_SIGNING_PRIVATE_KEY était bien défini pendant `cargo tauri build`\n" +
      '(et que "createUpdaterArtifacts": true est présent dans src-tauri/tauri.conf.json) — voir UPDATING.md.',
  );
  process.exit(1);
}
const installerFile = sigFile.slice(0, -".sig".length);
const signature = readFileSync(path.join(bundleDir, sigFile), "utf8").trim();

const notes = process.argv[2] || `Version ${version}`;
const tag = `v${version}`;
const downloadUrl = `https://github.com/${owner}/${repo}/releases/download/${tag}/${encodeURIComponent(installerFile)}`;

const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": { signature, url: downloadUrl },
  },
};

const outPath = path.join(bundleDir, "latest.json");
writeFileSync(outPath, JSON.stringify(latest, null, 2));

console.log(`Écrit : ${outPath}`);
console.log(`  version      : ${version}`);
console.log(`  tag attendu  : ${tag}  (crée bien la release GitHub sous ce tag exact)`);
console.log(`  installeur   : ${installerFile}`);
console.log(`  url générée  : ${downloadUrl}`);
console.log("");
console.log("Prochaine étape : crée la release GitHub sous ce tag et joins ces 3 fichiers :");
console.log(`  - ${installerFile}`);
console.log(`  - ${sigFile}`);
console.log("  - latest.json");
