// Supprime le compte d'un ami simulé créé avec `npm run ami` (Camille par
// défaut), avec tout ce qui va avec : l'amitié, les messages échangés, ses
// créatures et ses œufs. Rien de ce qui t'appartient à toi n'est touché.
//
// Le VRAI serveur doit tourner dans un autre terminal (npm run dev), parce
// que ce script lui parle comme le ferait l'appli.
//
//   npm run remove-ami                  (supprime « Camille »)
//   npm run remove-ami -- Julie         (supprime un autre nom d'ami simulé)

export {}; // fait de ce fichier un module (nécessaire pour le "await" en haut du fichier)

const BASE = process.env.SERVER_URL ?? "http://127.0.0.1:3000";
const name = process.argv[2] ?? "Camille";
const PASSWORD = "camille-test-2026";

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

const login = await api("POST", "/auth/login", { username: name, password: PASSWORD });
if (login.status !== 200) {
  console.log(
    `Impossible de se connecter en tant que « ${name} » (peut-être déjà supprimé, ou le serveur ne tourne pas) :`,
    login.data,
  );
  process.exit(1);
}
const token: string = login.data.token;

const del = await api("DELETE", "/me", { password: PASSWORD }, token);
if (del.status !== 200) {
  console.log("La suppression a échoué :", del.data);
  process.exit(1);
}

console.log(`Compte « ${name} » supprimé : amitié, messages et créatures avec lui aussi effacés.`);
