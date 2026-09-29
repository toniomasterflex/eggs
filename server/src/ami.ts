// Simule une deuxième personne, pour tester Eggs seul sur ton ordinateur.
//
//   npm run ami -- TonPseudo            (ami par défaut : « Camille »)
//   npm run ami -- TonPseudo Julie      (autre nom pour l'ami simulé)
//
// Camille se connecte (compte créé au besoin, mot de passe : camille-test-2026),
// t'ajoute en ami, puis tu lui parles depuis ce terminal :
//   texte + Entrée   -> lui envoie un message
//   /clic            -> clique sur TA créature (elle saute chez toi)
//   /moi             -> clique sur SA propre créature (elle saute chez toi si tu l'épingles)
//   /oeuf            -> t'offre un de ses œufs (il arrive directement dans
//                       ton onglet Œufs, comme un vrai cadeau d'ami)
//   /quitter         -> arrête
// Ce qu'il reçoit (messages, clics sur sa créature) s'affiche ici.

import readline from "node:readline";
import WebSocket from "ws";

const BASE = process.env.SERVER_URL ?? "http://127.0.0.1:3000";
const WS_BASE = BASE.replace(/^http/, "ws");
const target = process.argv[2];
const name = process.argv[3] ?? "Camille";
const PASSWORD = "camille-test-2026";

if (!target) {
  console.log("Usage : npm run ami -- TonPseudo [NomDeLAmi]");
  process.exit(1);
}

async function api(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as any;
  return { status: res.status, data };
}

let r = await api("POST", "/auth/login", { username: name, password: PASSWORD });
if (r.status !== 200) {
  // Email désormais demandé à l'inscription (voir index.ts) — un faux
  // suffit ici, ce compte de test n'a pas vocation à en recevoir.
  const email = `${name.toLowerCase().replace(/[^a-z0-9]/g, "") || "ami"}-test-2026@example.com`;
  r = await api("POST", "/auth/register", { username: name, email, password: PASSWORD });
  if (r.status !== 200 && r.status !== 201) {
    console.log("Impossible de créer/connecter l'ami :", r.data);
    process.exit(1);
  }
  // Une apparence différente de la tienne, pour le reconnaître.
  await api("PATCH", "/me", { species: "chick", color: "rose" }, r.data.token);
}
const token: string = r.data.token;
const myId: string = r.data.user.id;

const found = await api("GET", `/users/search?q=${encodeURIComponent(target)}`, undefined, token);
const you = (found.data as any[] | null)?.find(
  (u) => u.username.toLowerCase() === target.toLowerCase(),
);
if (!you) {
  console.log(`Le pseudo « ${target} » n'existe pas. Crée d'abord ton compte dans Eggs.`);
  process.exit(1);
}
if (!you.friend) await api("POST", "/friends", { userId: you.id }, token);

console.log(`${name} est connecté et ami avec ${you.username}.`);
console.log("Écris un message + Entrée, ou /clic, /moi, /oeuf, /quitter.\n");

const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
ws.on("message", (raw) => {
  const e = JSON.parse(raw.toString());
  if (e.type === "message" && e.message.from !== myId) {
    console.log(`\n${you.username} : ${e.message.text}`);
    api("POST", `/messages/${you.id}/read`, undefined, token).catch(() => {});
  } else if (e.type === "interaction") {
    console.log(e.target === myId ? "\n(tu as cliqué sur ma créature)" : "\n(une créature a été cliquée)");
  }
});
ws.on("close", () => {
  console.log("Connexion coupée.");
  process.exit(0);
});

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  if (text === "/quitter") process.exit(0);
  if (ws.readyState !== WebSocket.OPEN && text.startsWith("/")) {
    console.log("(connexion en cours, réessaie)");
    return;
  }
  if (text === "/clic") ws.send(JSON.stringify({ type: "interact", target: you.id, kind: "poke" }));
  else if (text === "/moi") ws.send(JSON.stringify({ type: "interact", target: myId, kind: "poke" }));
  else if (text === "/oeuf") {
    const mine = await api("GET", "/eggs", undefined, token);
    const egg = (mine.data as any[] | null)?.[0];
    if (!egg) {
      console.log(`(${name} n'a plus d'œuf à offrir pour l'instant)`);
    } else {
      const r = await api("POST", `/eggs/${egg.id}/gift`, { friendId: you.id }, token);
      if (r.status === 200) console.log(`(œuf offert à ${you.username} — va voir l'onglet Œufs)`);
      else console.log("(échec du cadeau :", r.data, ")");
    }
  } else await api("POST", `/messages/${you.id}`, { text }, token);
});
