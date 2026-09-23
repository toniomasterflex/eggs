// Shop : achat de boîtes d'œufs et de skins rares. MAQUETTE pour l'instant —
// rien n'est débité, voir server/src/service.ts (EGG_BOXES/SKINS et
// buyEggBox/buySkin) pour la remarque complète sur le vrai paiement à
// brancher plus tard.
//
// Présentation façon vraie boutique : une mise en avant sur l'écran
// principal, puis des catégories accessibles via des boutons (certaines
// encore vides, « Bientôt disponible », en attendant du vrai contenu) —
// même principe que les sous-menus du Profil/Mon compte, plutôt qu'une
// rangée d'onglets horizontale qui ne tient pas dans la largeur du panneau.
// Toujours en euros (pas de fausse monnaie de jeu).

import { useEffect, useState } from "react";
import { api } from "../../data/api";
import type { ApiEggBox, ApiSkin } from "../../data/api";
import { buyEggBox, buySkin, useCollection } from "../../data/profile";

const SOON_SKINS = ["Créature dorée", "Créature de nuit", "Créature arc-en-ciel"];

type CategoryId =
  | "featured"
  | "characters"
  | "boxes"
  | "outfits"
  | "backpacks"
  | "accessories"
  | "emotes"
  | "bundles";

const CATEGORIES: { id: CategoryId; label: string; icon: string }[] = [
  { id: "characters", label: "Personnages", icon: "🐣" },
  { id: "boxes", label: "Œufs", icon: "🥚" },
  { id: "outfits", label: "Tenues", icon: "👕" },
  { id: "backpacks", label: "Sacs à dos", icon: "🎒" },
  { id: "accessories", label: "Accessoires", icon: "🧣" },
  { id: "emotes", label: "Émotes", icon: "🙂" },
  { id: "bundles", label: "Lots", icon: "🎁" },
];

type RowState = "idle" | "buying" | { done: true } | { done: number };

export default function ShopScreen() {
  const [category, setCategory] = useState<CategoryId>("featured");
  const [boxes, setBoxes] = useState<ApiEggBox[] | null>(null);
  const [skins, setSkins] = useState<ApiSkin[] | null>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const { creatures } = useCollection();
  const ownedSpecies = new Set<string>(creatures.map((c) => c.species));

  useEffect(() => {
    api
      .eggBoxes()
      .then(setBoxes)
      .catch(() => setBoxes([]));
    api
      .skins()
      .then(setSkins)
      .catch(() => setSkins([]));
  }, []);

  const clearRow = (id: string) => {
    setRowState((s) => {
      const next = { ...s };
      delete next[id];
      return next;
    });
  };

  const buyBox = async (box: ApiEggBox) => {
    setRowState((s) => ({ ...s, [box.id]: "buying" }));
    try {
      const count = await buyEggBox(box.id);
      setRowState((s) => ({ ...s, [box.id]: { done: count } }));
      window.setTimeout(() => clearRow(box.id), 2500);
    } catch {
      clearRow(box.id);
    }
  };

  const buySkinItem = async (skin: ApiSkin) => {
    setRowState((s) => ({ ...s, [skin.id]: "buying" }));
    try {
      await buySkin(skin.id);
      setRowState((s) => ({ ...s, [skin.id]: { done: true } }));
      window.setTimeout(() => clearRow(skin.id), 2500);
    } catch {
      clearRow(skin.id);
    }
  };

  const boxCard = (box: ApiEggBox) => {
    const state = rowState[box.id] ?? "idle";
    const done = typeof state === "object" && "done" in state && typeof state.done === "number";
    return (
      <li key={box.id} className="shop-card">
        <div className="shop-card-thumb shop-card-thumb-emoji" aria-hidden="true">
          🥚
        </div>
        <div className="shop-card-info">
          <span className="shop-card-label">{box.label}</span>
          <span className="shop-card-sub">{box.count} œufs</span>
        </div>
        {done ? (
          <span className="shop-card-done">+{(state as { done: number }).done} œufs !</span>
        ) : (
          <button className="shop-card-buy" disabled={state === "buying"} onClick={() => buyBox(box)}>
            {state === "buying" ? "…" : box.priceLabel}
          </button>
        )}
      </li>
    );
  };

  const skinCard = (skin: ApiSkin) => {
    const state = rowState[skin.id] ?? "idle";
    const owned = ownedSpecies.has(skin.id);
    const done = typeof state === "object" && "done" in state && state.done === true;
    return (
      <li key={skin.id} className={`shop-card${owned ? " owned" : ""}`}>
        {!owned && <span className="shop-card-tag">Nouveau</span>}
        <img className="shop-card-thumb" src={`/${skin.id}/idle.png`} alt="" />
        <div className="shop-card-info">
          <span className="shop-card-label">{skin.label}</span>
          <span className="shop-card-sub">Skin rare</span>
        </div>
        {owned ? (
          <span className="shop-card-done">Possédé ✓</span>
        ) : done ? (
          <span className="shop-card-done">Débloqué !</span>
        ) : (
          <button className="shop-card-buy" disabled={state === "buying"} onClick={() => buySkinItem(skin)}>
            {state === "buying" ? "…" : skin.priceLabel}
          </button>
        )}
      </li>
    );
  };

  const soonCard = (name: string) => (
    <li key={name} className="shop-card soon">
      <div className="shop-card-thumb shop-card-thumb-emoji" aria-hidden="true">
        ✨
      </div>
      <div className="shop-card-info">
        <span className="shop-card-label">{name}</span>
        <span className="shop-card-sub">Bientôt disponible</span>
      </div>
    </li>
  );

  const emptyCategory = (label: string, icon: string) => (
    <div className="shop-empty">
      <span className="shop-empty-icon" aria-hidden="true">
        {icon}
      </span>
      <p>
        <strong>{label}</strong> arrive bientôt dans le shop.
      </p>
    </div>
  );

  const heroSkin = skins?.[0];

  // Une catégorie est ouverte : sous-écran avec en-tête « retour », même
  // principe que les sous-menus de Mon compte.
  if (category !== "featured") {
    const current = CATEGORIES.find((c) => c.id === category);
    return (
      <section className="screen shop-screen">
        <header className="conv-header">
          <button className="back" onClick={() => setCategory("featured")} aria-label="Retour">
            &lsaquo;
          </button>
          <span className="conv-name">{current?.label}</span>
        </header>

        <div className="shop-body">
          {category === "characters" && (
            <ul className="shop-grid">
              {(skins ?? []).map(skinCard)}
              {SOON_SKINS.map(soonCard)}
            </ul>
          )}
          {category === "boxes" && <ul className="shop-grid">{(boxes ?? []).map(boxCard)}</ul>}
          {category === "outfits" && emptyCategory("Les tenues", "👕")}
          {category === "backpacks" && emptyCategory("Les sacs à dos", "🎒")}
          {category === "accessories" && emptyCategory("Les accessoires", "🧣")}
          {category === "emotes" && emptyCategory("Les émotes", "🙂")}
          {category === "bundles" && emptyCategory("Les lots", "🎁")}
        </div>
      </section>
    );
  }

  // Écran principal : mise en avant, puis les catégories en boutons (comme
  // dans le Profil) plutôt qu'en onglets sur une seule ligne.
  return (
    <section className="screen shop-screen">
      <div className="shop-head">
        <span className="screen-eyebrow">Extras</span>
        <h1>Shop</h1>
        <p className="shop-note">Maquette : rien n'est débité pour l'instant, c'est offert le temps de tester.</p>
      </div>

      <div className="shop-body">
        <div className="shop-banner">
          <div className="shop-banner-text">
            <span className="shop-banner-tag">À la une</span>
            <span className="shop-banner-title">{heroSkin ? heroSkin.label : "Bienvenue au Shop"}</span>
            <span className="shop-banner-sub">
              {heroSkin ? "Une créature rare à débloquer" : "De nouvelles créatures arrivent bientôt"}
            </span>
            <button className="shop-banner-btn" onClick={() => setCategory("characters")}>
              Découvrir →
            </button>
          </div>
          {heroSkin && <img className="shop-banner-img" src={`/${heroSkin.id}/idle.png`} alt="" />}
        </div>

        <h2 className="shop-subtitle">En vedette</h2>
        <ul className="shop-grid">
          {heroSkin && skinCard(heroSkin)}
          {(boxes ?? []).slice(0, 2).map(boxCard)}
        </ul>

        <h2 className="shop-subtitle">Catégories</h2>
        <nav className="shop-categories">
          {CATEGORIES.map((c) => (
            <button key={c.id} className="shop-cat-btn" onClick={() => setCategory(c.id)}>
              <span className="shop-cat-icon" aria-hidden="true">
                {c.icon}
              </span>
              <span className="shop-cat-label">{c.label}</span>
              <span className="shop-cat-arrow" aria-hidden="true">
                &rsaquo;
              </span>
            </button>
          ))}
        </nav>
      </div>
    </section>
  );
}
