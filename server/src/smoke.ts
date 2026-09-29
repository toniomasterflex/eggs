// Test automatique du serveur : « npm run smoke » (le serveur doit tourner).
// Crée deux comptes de test et vérifie tout : comptes, amis, messages, temps réel.

import WebSocket from "ws";

const BASE = process.env.SERVER_URL ?? "http://127.0.0.1:3000";
const WS_BASE = BASE.replace(/^http/, "ws");
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${name}`);
  else {
    failures++;
    console.log(`  ECHEC ${name}`, detail ?? "");
  }
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
  const data = await res.json().catch(() => null);
  return { status: res.status, data: data as any };
}

/** Pour les routes qui répondent en HTML, pas en JSON (voir GET
 *  /verify-email/:token) — on vérifie juste le texte affiché. */
async function apiRaw(method: string, path: string) {
  const res = await fetch(BASE + path, { method });
  return { status: res.status, text: await res.text() };
}

function connect(token: string): Promise<{ ws: WebSocket; events: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
    const events: any[] = [];
    ws.on("message", (raw) => events.push(JSON.parse(raw.toString())));
    ws.on("open", () => resolve({ ws, events }));
    ws.on("error", reject);
  });
}

async function waitFor(events: any[], pred: (e: any) => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = events.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

const suffix = Math.random().toString(36).slice(2, 7);
const aliceName = `alice_${suffix}`;
const bobName = `bob_${suffix}`;
// Email demandé à l'inscription depuis le 27/09/2026 (voir index.ts /
// db.ts) — pas encore vérifié, juste collecté et unique.
const aliceEmail = `alice_${suffix}@example.com`;
const bobEmail = `bob_${suffix}@example.com`;

console.log("Serveur :", BASE);

console.log("\nComptes");
let r = await api("GET", "/health");
check("le serveur répond", r.status === 200);

r = await api("POST", "/auth/register", { username: aliceName, email: aliceEmail, password: "court" });
check("mot de passe trop court refusé", r.status === 400, r);

r = await api("POST", "/auth/register", { username: aliceName, email: "pas-un-email", password: "motdepasse1" });
check("email invalide refusé", r.status === 400, r);

r = await api("POST", "/auth/register", { username: aliceName, email: aliceEmail, password: "motdepasse1" });
check("création du compte Alice", r.status === 201 && !!r.data?.token, r);
const alice = r.data;

r = await api("POST", "/auth/register", { username: aliceName.toUpperCase(), email: bobEmail, password: "motdepasse1" });
check("pseudo déjà pris refusé (même en majuscules)", r.status === 409, r);

r = await api("POST", "/auth/register", { username: bobName, email: aliceEmail.toUpperCase(), password: "motdepasse2" });
check("email déjà utilisé refusé (même en majuscules)", r.status === 409, r);

r = await api("POST", "/auth/register", { username: bobName, email: bobEmail, password: "motdepasse2" });
check("création du compte Bob", r.status === 201, r);
const bob = r.data;

console.log("\nEmail (vérification)");
// Pas de RESEND_API_KEY dans cet environnement de test : /auth/register
// renvoie le jeton directement (voir index.ts) plutôt que de l'envoyer pour
// de vrai, exprès pour permettre ce genre de test automatique.
check("Alice a un jeton de vérification (mode développement)", !!alice.devVerificationToken, alice);

let raw = await apiRaw("GET", "/verify-email/un-jeton-qui-n-existe-pas");
check("jeton de vérification inconnu : page d'erreur", raw.status === 200 && raw.text.includes("invalide"), raw.text);

raw = await apiRaw("GET", `/verify-email/${alice.devVerificationToken}`);
check("vérification de l'email d'Alice : page de confirmation", raw.status === 200 && raw.text.includes("confirmé"), raw.text);

r = await api("GET", "/me", undefined, alice.token);
check("email d'Alice marqué vérifié", r.data?.emailVerified === true, r.data);

raw = await apiRaw("GET", `/verify-email/${alice.devVerificationToken}`);
check("un jeton déjà utilisé ne remarche pas", raw.status === 200 && raw.text.includes("invalide"), raw.text);

r = await api("POST", "/me/resend-verification", undefined, bob.token);
check("renvoi de l'email de vérification pour Bob", r.status === 200 && !!r.data?.devVerificationToken, r);

raw = await apiRaw("GET", `/verify-email/${r.data.devVerificationToken}`);
check("vérification de l'email de Bob", raw.status === 200 && raw.text.includes("confirmé"), raw.text);

r = await api("POST", "/me/resend-verification", undefined, bob.token);
check("renvoi refusé une fois déjà vérifié", r.status === 200 && r.data?.alreadyVerified === true, r);

r = await api("POST", "/auth/login", { username: aliceName, password: "mauvais-mot-de-passe" });
check("mauvais mot de passe refusé", r.status === 401, r);

r = await api("POST", "/auth/login", { username: aliceName, password: "motdepasse1" });
check("connexion d'Alice", r.status === 200 && !!r.data?.token, r);

r = await api("GET", "/me");
check("accès sans connexion refusé", r.status === 401, r);

r = await api("GET", "/me", undefined, alice.token);
check("/me renvoie Alice", r.data?.username === aliceName, r);

r = await api("PATCH", "/me", { species: "cat", color: "rose" }, alice.token);
check("apparence modifiée", r.data?.species === "cat" && r.data?.color === "rose", r);
r = await api("PATCH", "/me", { species: "dragon" }, alice.token);
check("espèce inconnue refusée", r.status === 400, r);

console.log("\nAmis");
r = await api("GET", "/friends", undefined, alice.token);
check("Alice a Léa, Thomas et Lucas comme amis de départ", r.data?.length === 3, r.data);
check("Léa : dernier message daté", typeof r.data?.find((f: any) => f.username === "Léa")?.lastAt === "number", r.data);
check("Léa a laissé un message non lu", r.data?.find((f: any) => f.username === "Léa")?.unread === 1, r.data);

r = await api("GET", `/users/search?q=${bobName.slice(0, 6)}`, undefined, alice.token);
check("recherche de Bob par pseudo", r.data?.some((u: any) => u.id === bob.user.id), r.data);

const aliceWs = await connect(alice.token);
const bobWs = await connect(bob.token);
await waitFor(aliceWs.events, (e) => e.type === "hello");
check("connexion temps réel", true);

r = await api("POST", "/friends", { userId: bob.user.id }, alice.token);
check("Alice ajoute Bob", r.status === 201, r);
check("Bob est prévenu en direct", !!(await waitFor(bobWs.events, (e) => e.type === "friend-added" && e.user.id === alice.user.id)));

console.log("\nMessages");
r = await api("POST", `/messages/${bob.user.id}`, { text: "Salut Bob !" }, alice.token);
check("Alice écrit à Bob", r.status === 201 && r.data?.text === "Salut Bob !", r);
check(
  "Bob reçoit le message en direct",
  !!(await waitFor(bobWs.events, (e) => e.type === "message" && e.message.text === "Salut Bob !")),
);
r = await api("GET", "/friends", undefined, bob.token);
check("Bob voit 1 message non lu d'Alice", r.data?.find((f: any) => f.id === alice.user.id)?.unread === 1, r.data);
r = await api("POST", `/messages/${alice.user.id}/read`, undefined, bob.token);
check("marquer comme lu", r.status === 200, r);
r = await api("GET", "/friends", undefined, bob.token);
check("après lecture : plus de non lu", r.data?.find((f: any) => f.id === alice.user.id)?.unread === 0, r.data);
r = await api("GET", `/messages/${alice.user.id}`, undefined, bob.token);
check("historique de la conversation", r.data?.length === 1, r.data);

check(
  "Alice reçoit un accusé de lecture",
  !!(await waitFor(aliceWs.events, (e) => e.type === "seen" && e.by === bob.user.id)),
);
r = await api("GET", "/friends", undefined, alice.token);
const bobRow = r.data?.find((f: any) => f.id === bob.user.id);
check("le message d'Alice apparaît comme lu par Bob", typeof bobRow?.readAt === "number", r.data);
check("Bob apparaît en ligne pour Alice", bobRow?.online === true, r.data);

console.log("\nŒufs");
r = await api("GET", "/eggs", undefined, alice.token);
check("Alice a un œuf de bienvenue", r.data?.some((e: any) => e.source === "welcome"), r.data);
const welcomeEgg = r.data?.find((e: any) => e.source === "welcome");

r = await api("POST", `/eggs/${welcomeEgg?.id}/open`, undefined, alice.token);
check("ouverture de l'œuf : une créature apparaît, active", r.status === 200 && !!r.data?.species && r.data?.active === true, r);
const firstCreature = r.data;

r = await api("GET", "/eggs", undefined, alice.token);
check("l'œuf ouvert n'est plus dans la liste", !r.data?.some((e: any) => e.id === welcomeEgg?.id), r.data);

r = await api("GET", "/creatures", undefined, alice.token);
check("la créature éclose apparaît dans la collection", r.data?.some((c: any) => c.id === firstCreature?.id), r.data);

r = await api("GET", "/me", undefined, alice.token);
check(
  "l'apparence d'Alice reflète sa créature active",
  r.data?.species === firstCreature?.species && r.data?.color === firstCreature?.color,
  r,
);

r = await api("GET", "/eggs", undefined, alice.token);
const eggToGift = r.data?.find((e: any) => e.source === "welcome");
check("Alice a encore un œuf à offrir", !!eggToGift, r.data);
const giftedEggId = eggToGift?.id;

r = await api("POST", `/eggs/${giftedEggId}/gift`, { friendId: bob.user.id }, alice.token);
check("Alice offre un œuf à Bob", r.status === 200 && r.data?.source === "gift", r);
check(
  "Bob est prévenu en direct du cadeau",
  !!(await waitFor(bobWs.events, (e) => e.type === "egg-gift" && e.egg?.id === giftedEggId)),
);

r = await api("GET", "/eggs", undefined, alice.token);
check("l'œuf offert n'est plus chez Alice", !r.data?.some((e: any) => e.id === giftedEggId), r.data);
r = await api("GET", "/eggs", undefined, bob.token);
check("l'œuf offert est bien chez Bob", r.data?.some((e: any) => e.id === giftedEggId), r.data);

r = await api("POST", `/eggs/${giftedEggId}/gift`, { friendId: bob.user.id }, alice.token);
check("offrir un œuf qu'on ne possède plus (déjà offert) est refusé", r.status === 404, r);

const lea = (await api("GET", "/friends", undefined, alice.token)).data.find((f: any) => f.username === "Léa");
await api("POST", `/messages/${lea.id}`, { text: "Tu es là ?" }, alice.token);
check("Léa (robot) répond", !!(await waitFor(aliceWs.events, (e) => e.type === "message" && e.message.from === lea.id && e.message.text !== "Salut !")));

r = await api("POST", `/messages/${bob.user.id}`, { text: "x" }, "jeton-invalide");
check("message avec un faux jeton refusé", r.status === 401);

console.log("\nInteractions en temps réel");
aliceWs.ws.send(JSON.stringify({ type: "interact", target: alice.user.id }));
check(
  "Alice clique sur sa créature : Bob la voit sauter",
  !!(await waitFor(bobWs.events, (e) => e.type === "interaction" && e.from === alice.user.id && e.target === alice.user.id)),
);
await new Promise((r) => setTimeout(r, 400));
bobWs.ws.send(JSON.stringify({ type: "interact", target: alice.user.id }));
check(
  "Bob clique sur la créature d'Alice : Alice la voit sauter",
  !!(await waitFor(aliceWs.events, (e) => e.type === "interaction" && e.from === bob.user.id && e.target === alice.user.id)),
);
await new Promise((r) => setTimeout(r, 400));
aliceWs.ws.send(JSON.stringify({ type: "interact", target: lea.id }));
check(
  "Alice clique sur Léa : Léa clique sur la créature d'Alice (3 s plus tard)",
  !!(await waitFor(aliceWs.events, (e) => e.type === "interaction" && e.from === lea.id && e.target === alice.user.id, 6000)),
);
r = await api("GET", `/messages/${bob.user.id}`, undefined, alice.token);
check("les interactions ne sont pas enregistrées", r.data?.length === 1, r.data);

console.log("\nAmis (retirer)");
r = await api("DELETE", `/friends/${bob.user.id}`, undefined, alice.token);
check("Alice retire Bob de ses amis", r.status === 200, r);
check(
  "Bob est prévenu en direct",
  !!(await waitFor(bobWs.events, (e) => e.type === "friend-removed" && e.userId === alice.user.id)),
);
r = await api("GET", "/friends", undefined, alice.token);
check("Bob n'est plus dans les amis d'Alice", !r.data?.some((f: any) => f.id === bob.user.id), r.data);
r = await api("POST", `/messages/${bob.user.id}`, { text: "toujours là ?" }, alice.token);
check("écrire à un non-ami est refusé", r.status === 403, r);
r = await api("POST", "/friends", { userId: bob.user.id }, alice.token);
check("Alice réajoute Bob (pour la suite)", r.status === 201, r);

console.log("\nCompte");
r = await api("POST", "/me/password", { current: "faux", next: "nouveaumdp1" }, bob.token);
check("changement de mot de passe refusé si l'actuel est faux", r.status === 401, r);
r = await api("POST", "/me/password", { current: "motdepasse2", next: "court" }, bob.token);
check("nouveau mot de passe trop court refusé", r.status === 400, r);
r = await api("POST", "/me/password", { current: "motdepasse2", next: "nouveaumdp2" }, bob.token);
check("mot de passe changé", r.status === 200, r);
r = await api("POST", "/auth/login", { username: bobName, password: "motdepasse2" });
check("l'ancien mot de passe ne marche plus", r.status === 401, r);
r = await api("POST", "/auth/login", { username: bobName, password: "nouveaumdp2" });
check("le nouveau mot de passe marche", r.status === 200 && !!r.data?.token, r);
const bob2 = r.data;
r = await api("DELETE", "/me", { password: "faux" }, bob2.token);
check("suppression refusée avec un mauvais mot de passe", r.status === 401, r);
r = await api("POST", "/auth/logout-all", undefined, bob2.token);
check("déconnexion de partout", r.status === 200, r);
r = await api("GET", "/me", undefined, bob2.token);
check("le jeton ne marche plus après la déconnexion de partout", r.status === 401, r);
r = await api("POST", "/auth/login", { username: bobName, password: "nouveaumdp2" });
const bob3 = r.data;
r = await api("DELETE", "/me", { password: "nouveaumdp2" }, bob3.token);
check("compte supprimé", r.status === 200, r);
r = await api("POST", "/auth/login", { username: bobName, password: "nouveaumdp2" });
check("le compte supprimé ne peut plus se connecter", r.status === 401, r);
r = await api("GET", "/friends", undefined, alice.token);
check("Bob a disparu des amis d'Alice", !r.data?.some((f: any) => f.id === bob.user.id), r.data);

aliceWs.ws.close();
bobWs.ws.close();

console.log(failures === 0 ? "\nTout est bon." : `\n${failures} test(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);
