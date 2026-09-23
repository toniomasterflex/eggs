// Base de données : PostgreSQL, sans rien à installer (PGlite tourne dans le
// serveur et écrit dans le dossier « data »).
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

    -- Une personne bloquée par le propriétaire d'un salon ne peut plus y
    -- entrer. salon_id = l'id du propriétaire (comme users.id, pas de table
    -- salons séparée).
    CREATE TABLE IF NOT EXISTS salon_blocks (
      salon_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (salon_id, blocked_id)
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
