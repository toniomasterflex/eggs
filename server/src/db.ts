// Base de données : PostgreSQL, sans rien à installer (PGlite tourne dans le
// serveur et écrit dans le cercle « data »).
//
// Toutes les requêtes passent par query() : plus tard, pour un vrai serveur,
// on remplacera seulement l'intérieur de ce fichier par le pilote « pg ».

import { PGlite } from "@electric-sql/pglite";
import { config } from "./config.js";

const pg = new PGlite(config.dataDir);

export type Row = Record<string, any>;

export async function query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pg.query<T>(sql, params as any[]);
  return res.rows;
}

export async function migrate(): Promise<void> {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username      TEXT NOT NULL,
      username_key  TEXT NOT NULL UNIQUE,      -- pseudo en minuscules (unicité)
      password_hash TEXT NOT NULL,
      species       TEXT NOT NULL DEFAULT 'egg', -- 'egg' = pas encore de créature active (œuf jamais ouvert)
      color         TEXT NOT NULL DEFAULT '',
      is_bot        BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Au cas où la table existait déjà avant ce réglage (comptes créés avant le
    -- système d'œufs) : le défaut ne s'applique qu'aux nouvelles lignes.
    ALTER TABLE users ALTER COLUMN species SET DEFAULT 'egg';
    -- Jusqu'où (quel lundi) les œufs hebdomadaires ont déjà été distribués à
    -- cette personne. NULL = pas encore initialisé (voir migration plus bas).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS eggs_granted_through DATE;
    -- Pseudos affichés sur le profil et dans le Répertoire (simple affichage,
    -- saisi à la main — pas d'import de liste d'amis, voir service.ts :
    -- updateProfileLinks pour le détail de la décision produit).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_handle TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_handle TEXT;

    -- Adresse email : demandée à l'inscription depuis le 27/09/2026 (avant :
    -- juste un pseudo + mot de passe, "comme toutes les apps" maintenant).
    -- Sert surtout de base pour un futur matching de contacts (import
    -- Steam/téléphone, voir claude/chat-de-groupe-conception.md). Les comptes
    -- créés avant cette date n'en ont pas et ne sont pas forcés à en ajouter
    -- un rétroactivement (email_key reste NULL pour eux).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_key_idx ON users (email_key) WHERE email_key IS NOT NULL;

    -- Vérification d'email (voir server/src/mail.ts, envoi via Resend) : un
    -- jeton à usage unique par email à confirmer, même principe que les
    -- sessions plus bas (on ne garde que son empreinte, jamais le jeton en
    -- clair — voir auth.ts). Expire au bout de 24h. Tant que RESEND_API_KEY
    -- n'est pas configuré (voir config.ts), le lien est juste affiché dans
    -- les logs du serveur au lieu d'être envoyé pour de vrai : email_verified
    -- reste FALSE pour tout le monde jusque-là, sans rien casser.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
    -- Statut « absent » activé à la main par la personne (façon Slack/Discord,
    -- demande d'Antoine du 21/09/2026) : distinct de la connexion WebSocket
    -- (voir hub.ts : online reste calculé en mémoire, jamais stocké ici) —
    -- celui-ci doit au contraire survivre à une reconnexion/redémarrage de
    -- l'appli, donc persisté en base. Le statut affiché aux autres (vert/
    -- orange/rouge) combine les deux : online=false -> rouge, online=true et
    -- away=true -> orange, online=true et away=false -> vert (voir service.ts
    -- PublicUser.away, et index.ts : PATCH /me/status).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS away BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS email_verifications (
      token_hash TEXT PRIMARY KEY,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS email_verifications_user_idx ON email_verifications (user_id);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,             -- on ne garde jamais le jeton lui-même
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Une amitié = deux lignes (dans les deux sens).
    CREATE TABLE IF NOT EXISTS friendships (
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, friend_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           BIGSERIAL PRIMARY KEY,
      sender_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text         TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS messages_pair_idx
      ON messages (LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), id);

    -- Groupe fermé à plusieurs (différent des Salons : ici on choisit qui en
    -- fait partie à la création, l'historique reste, voir index.ts : POST
    -- /groups). Affiché dans l'onglet Chats, à côté des discussions à deux.
    CREATE TABLE IF NOT EXISTS groups (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name       TEXT NOT NULL,
      created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id  UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, user_id)
    );

    -- Un seul read_at par message (voir messages.read_at) ne suffit plus dès
    -- qu'il y a plus de 2 personnes : ici, une date de dernière lecture par
    -- membre et par groupe (voir service.ts : markGroupRead / listGroups).
    CREATE TABLE IF NOT EXISTS group_reads (
      group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, user_id)
    );

    -- Un message de groupe n'a pas UN destinataire (recipient_id) : rendu
    -- optionnel, group_id le remplace dans ce cas (voir service.ts : exactement
    -- un des deux est renseigné selon insertMessage / insertGroupMessage).
    ALTER TABLE messages ALTER COLUMN recipient_id DROP NOT NULL;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES groups(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS messages_group_idx ON messages (group_id, id);

    -- Photo / vidéo / son partagé (voir POST /messages/:friendId/attachment) :
    -- le fichier lui-même vit sur disque (voir config.ts : uploadsDir), ces
    -- colonnes ne gardent qu'une référence. NULL = message texte classique.
    -- text reste '' (pas de légende pour l'instant) plutôt que NULL, pour ne
    -- pas avoir à gérer un texte optionnel partout où il est déjà utilisé.
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_url TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_kind TEXT; -- 'image' | 'video' | 'audio'
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name TEXT;

    -- Réaction façon iMessage/WhatsApp (tapback) sur un message : une seule
    -- réaction active par personne et par message — reposer une autre emoji
    -- la remplace (voir service.ts : setReaction, INSERT ... ON CONFLICT),
    -- reposer la même la retire (voir removeReaction). Pas de colonne à part
    -- dans messages : une conversation privée n'a que 2 participants, donc au
    -- plus 2 lignes ici par message.
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji      TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (message_id, user_id)
    );

    -- Chaque créature déjà éclose, possédée par quelqu'un. L'apparence est
    -- fixée pour toujours dès l'éclosion (voir service.ts : openEgg).
    CREATE TABLE IF NOT EXISTS creatures (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      species    TEXT NOT NULL,
      color      TEXT NOT NULL,
      active     BOOLEAN NOT NULL DEFAULT FALSE, -- une seule créature affichée à la fois
      partner_id UUID REFERENCES users(id) ON DELETE SET NULL, -- si née d'un œuf en duo : avec qui
      born_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS creatures_owner_idx ON creatures (owner_id, born_at);

    -- Les œufs pas encore ouverts. Ça s'accumule, pas de limite, pas de date
    -- d'expiration : rien ne pousse à venir les ouvrir.
    CREATE TABLE IF NOT EXISTS eggs (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source     TEXT NOT NULL DEFAULT 'weekly', -- 'welcome' | 'weekly' | 'gift' | 'shop'
      partner_id UUID REFERENCES users(id) ON DELETE SET NULL, -- pour 'gift' : qui te l'a offert
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS eggs_owner_idx ON eggs (owner_id, granted_at);

    -- Ancienne mécanique (proposition à deux de créer un œuf ensemble),
    -- remplacée par le cadeau d'œuf ci-dessus (service.ts : giftEgg) : un
    -- transfert immédiat d'un œuf qu'on possède déjà, pas une proposition à
    -- accepter. Les œufs déjà distribués en duo restent valables, juste
    -- relabellés (voir migration plus bas).
    DROP TABLE IF EXISTS egg_proposals;

    -- Chaque personne a un seul salon, qui lui est propre : pas de table à
    -- part pour le salon lui-même, son id est simplement celui de son
    -- propriétaire (users.id). Seul le nom choisi a besoin d'être stocké ici
    -- (NULL = pas encore choisi, un nom par défaut s'affiche à la place, voir
    -- service.ts : getSalon). La présence en direct (qui est dedans
    -- maintenant) n'est PAS stockée en base : voir salons.ts, en mémoire.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS salon_name TEXT;
    -- Mot de passe d'entrée du salon (NULL = pas de mot de passe). Ne
    -- s'applique qu'aux non-amis/non-modérateurs à l'entrée — voir
    -- index.ts : assertSalonEntry. Décision du 26/09/2026 : les salons
    -- s'ouvrent aux non-amis via un lien partageable (voir GET /join/:ownerId),
    -- ce mot de passe protège cette porte-là.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS salon_password_hash TEXT;

    -- Réglages d'accès et de modération du salon, écran "Modération du
    -- salon" (fenêtre entière, demande d'Antoine du 29/09/2026, inspirée
    -- d'une maquette). Fait évoluer la décision du 23/09/2026 qui excluait
    -- la chaîne "amis d'amis" — Antoine a choisi d'aller plus loin.
    --
    -- salon_access_level : qui peut entrer librement (en plus du
    -- propriétaire, des modérateurs et des membres explicites, voir
    -- salon_members plus bas, et du mot de passe ci-dessus qui reste une
    -- porte à part) :
    --   'private'          -- personne automatiquement, seulement les
    --                         membres explicites (invités ou approuvés)
    --   'friends'           -- les amis du propriétaire (comportement
    --                         historique, reste la valeur par défaut)
    --   'friends_of_friends' -- les amis, + les amis de ces amis
    --   'open'              -- n'importe quel compte
    ALTER TABLE users ADD COLUMN IF NOT EXISTS salon_access_level TEXT NOT NULL DEFAULT 'friends';

    -- salon_write_permission : qui peut écrire dans la discussion en direct
    -- du salon, indépendamment de qui a le droit d'y entrer (ex. un salon
    -- "Ouvert" où tout le monde peut venir observer, mais où seul le cercle
    -- de confiance écrit) — voir index.ts, vérifié à chaque message. Fusion
    -- volontaire de "qui peut publier" et "qui peut commenter/réagir" de la
    -- maquette : le salon n'a qu'un seul fil de discussion, pas de stickers
    -- séparés des réponses, donc un seul réglage suffit ici.
    --   'members'            -- le cercle de confiance (ami, modérateur,
    --                          propriétaire, ou membre explicite)
    --   'friends_of_friends' -- le cercle ci-dessus + les amis d'amis
    --   'everyone'           -- n'importe qui présent
    ALTER TABLE users ADD COLUMN IF NOT EXISTS salon_write_permission TEXT NOT NULL DEFAULT 'members';

    -- Approbation manuelle des nouvelles demandes : quand TRUE, une personne
    -- éligible par salon_access_level (ou qui demande l'accès à un salon
    -- 'private') doit d'abord envoyer une demande (salon_join_requests)
    -- qu'un modérateur ou le propriétaire approuve avant de pouvoir entrer
    -- pour de vrai — voir index.ts : assertSalonEntry. Une fois approuvée,
    -- la personne devient membre (salon_members) et entre librement ensuite.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS salon_require_approval BOOLEAN NOT NULL DEFAULT FALSE;

    -- Autoriser les membres (pas seulement le propriétaire/modérateurs) à
    -- inviter directement quelqu'un dans le salon (POST .../members) — sans
    -- effet si personne n'est jamais "membre" au sens strict (salons non
    -- 'private' où tout le monde d'éligible entre déjà librement).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS salon_allow_member_invites BOOLEAN NOT NULL DEFAULT TRUE;

    -- Membres explicites d'un salon : accès permanent indépendant de
    -- salon_access_level (utile pour un salon 'private', ou pour garder
    -- l'accès à quelqu'un après une approbation de demande, voir
    -- salon_join_requests). N'a aucun rapport avec l'amitié : quelqu'un peut
    -- être membre d'un salon sans être ami de son propriétaire.
    CREATE TABLE IF NOT EXISTS salon_members (
      salon_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      added_by   UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (salon_id, user_id)
    );

    -- Demandes d'entrée en attente : posées quand salon_require_approval est
    -- actif (ou toujours pour un salon 'private', seule porte d'entrée sans
    -- invitation directe) — voir index.ts : assertSalonEntry /
    -- POST .../requests. Une ligne disparaît dès qu'elle est traitée
    -- (approuvée -> devient une ligne salon_members ; refusée -> supprimée).
    CREATE TABLE IF NOT EXISTS salon_join_requests (
      salon_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (salon_id, user_id)
    );

    -- Liste de mots interdits par salon (filtre simple, sous-chaîne
    -- insensible à la casse — voir index.ts, vérifié à l'envoi de chaque
    -- message de salon). "word" est stocké déjà en minuscules.
    CREATE TABLE IF NOT EXISTS salon_banned_words (
      salon_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      word       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (salon_id, word)
    );

    -- Signalements de contenu dans un salon. La discussion elle-même n'est
    -- jamais enregistrée (voir plus haut) : on garde donc ici un instantané
    -- du texte signalé au moment du signalement, pas une référence vers un
    -- message qui n'existe déjà plus côté serveur. Visible par le
    -- propriétaire et les modérateurs (voir index.ts : assertSalonModeration),
    -- qui les traitent puis les suppriment (pas d'archive au-delà).
    CREATE TABLE IF NOT EXISTS salon_reports (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      salon_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reporter_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reported_id  UUID REFERENCES users(id) ON DELETE SET NULL,
      message_text TEXT NOT NULL,
      reason       TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS salon_reports_salon_idx ON salon_reports (salon_id, created_at);

    -- Une personne bannie par le propriétaire (ou un modérateur, voir
    -- salon_moderators) d'un salon ne peut plus y entrer. salon_id = l'id du
    -- propriétaire (comme users.id, pas de table salons séparée). Nom de
    -- table historique ("blocks") — présenté comme un "ban" côté produit.
    CREATE TABLE IF NOT EXISTS salon_blocks (
      salon_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (salon_id, blocked_id)
    );

    -- Modérateurs d'un salon : nommés par le propriétaire seul, peuvent
    -- bannir/débannir comme lui mais pas gérer d'autres modérateurs ni le mot
    -- de passe (voir service.ts pour le détail de la décision produit).
    CREATE TABLE IF NOT EXISTS salon_moderators (
      salon_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (salon_id, user_id)
    );

    -- Espaces pour organiser ses discussions (amis + groupes, la même
    -- liste que l'onglet Chats) — décision du 27/09/2026 (rebaptisés
    -- "espaces", initialement "cercles", le même jour) : chacun range SES
    -- discussions comme il veut, ce n'est jamais partagé (je peux ranger un
    -- ami dans un espace différent de celui où lui me range). Un chat dans
    -- un espace au plus (comme des cercles classiques, pas des
    -- étiquettes) : voir service.ts, chat_folder_items.
    CREATE TABLE IF NOT EXISTS chat_folders (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chat_folders_user_idx ON chat_folders (user_id, created_at);

    -- chat_id = l'id de l'ami (users.id) OU du groupe (groups.id) : même
    -- espace d'identifiants que "activeChat" côté client (voir
    -- ChatsScreen.tsx), donc pas de FK possible ici (deux tables selon le
    -- cas) — nettoyé à la main quand un ami ou un groupe disparaît (voir
    -- service.ts : removeFriendship, deleteGroup, leaveGroup).
    CREATE TABLE IF NOT EXISTS chat_folder_items (
      user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chat_id   UUID NOT NULL,
      folder_id UUID NOT NULL REFERENCES chat_folders(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, chat_id)
    );

    -- Même principe, système séparé, pour les salons (onglet Salons) — décidé
    -- volontairement distinct des espaces de chats ci-dessus (27/09/2026).
    CREATE TABLE IF NOT EXISTS salon_folders (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS salon_folders_user_idx ON salon_folders (user_id, created_at);

    -- salon_id = l'id du propriétaire du salon (comme partout ailleurs pour
    -- les salons) : contrairement à chat_id ci-dessus, une vraie FK est
    -- possible ici (toujours users.id).
    CREATE TABLE IF NOT EXISTS salon_folder_items (
      user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      salon_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_id UUID NOT NULL REFERENCES salon_folders(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, salon_id)
    );

    -- La discussion en direct d'un salon n'a PAS de table : comme la
    -- présence, elle vit en mémoire (salons.ts) et disparaît avec la session
    -- en cours (aucune pression à rattraper ce qu'on a manqué). Offrir un œuf
    -- à un ami se fait uniquement dans l'onglet Œufs (eggs.source = 'gift' ci-
    -- dessus) : le salon reste une zone de discussion, pas un deuxième
    -- endroit avec cette mécanique.

    -- D'anciens œufs distribués par l'ancienne mécanique à deux : relabellés
    -- 'gift' pour rester cohérents avec la nouvelle (sans effet une fois fait).
    UPDATE eggs SET source = 'gift' WHERE source = 'duo';

    -- Migration (ne s'applique qu'une fois, sans effet les fois suivantes) :
    -- les comptes créés avant le système d'œufs gardent leur créature actuelle
    -- comme première créature de leur collection, déjà active.
    INSERT INTO creatures (owner_id, species, color, active, born_at)
    SELECT id, species, color, TRUE, created_at
      FROM users
     WHERE is_bot = FALSE
       AND species <> 'egg'
       AND NOT EXISTS (SELECT 1 FROM creatures c WHERE c.owner_id = users.id);

    -- Ces comptes repartent avec le compteur hebdomadaire à jour à partir de
    -- maintenant (pas de rattrapage rétroactif depuis leur date de création).
    UPDATE users
       SET eggs_granted_through = to_char(date_trunc('week', now()), 'YYYY-MM-DD')::date
     WHERE eggs_granted_through IS NULL AND is_bot = FALSE;
  `);
}
