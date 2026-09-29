use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_updater::UpdaterExt;
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};

// Partage d'écran des appels de salon (voir capture.rs : notre propre
// sélecteur, en remplacement de celui de WebView2).
mod capture;
use capture::{list_capture_sources, start_screen_capture, stop_screen_capture};

// ---- Réglages de détection (en pixels physiques) ----
const POLL_MS: u64 = 60; // fréquence de lecture de la souris
const TRIGGER_EDGE_PX: f64 = 6.0; // largeur de la zone de déclenchement au bord
const TRIGGER_EXTRA_TOP_PX: f64 = 40.0; // la zone dépasse un peu de chaque côté du pet
const STAY_WIDTH_PX: f64 = 300.0; // distance à laquelle le pet repart
const STAY_MARGIN_PX: f64 = 150.0; // marge le long du bord avant qu'il reparte

// ---- Mon pet et les pets d'amis épinglés (pixels logiques) ----
// Fenêtre carrée de chaque pet, y compris la mienne (doit correspondre à
// WIN dans PinnedWindow.tsx et App.tsx, et à la taille de la fenêtre
// « main » dans tauri.conf.json).
// Plus grande que la taille d'origine (440), pour laisser la place au
// panneau Eggs agrandi (PW/PH dans App.tsx et PinnedWindow.tsx) SANS qu'il
// dépasse du haut de cette fenêtre invisible quand le pet est tout en bas de
// l'écran (voir openPanel : le calcul qui garde le panneau visible à l'écran
// peut alors demander une position plus haute que ce que contient la
// fenêtre). Doit rester alignée avec "width"/"height" de la fenêtre "main"
// dans tauri.conf.json.
const WIN_PIN: f64 = 800.0;
const MIN_SIZE: f64 = 40.0;
const MAX_SIZE: f64 = 200.0;
const CORNER_PAD: f64 = 8.0;

// ---- Balade sur l'herbe (pets d'amis posés au sol) ----
const WANDER_SPEED_PX_S: f64 = 32.0; // vitesse de marche (px logiques / s)
const WANDER_PAUSE_MIN_S: f64 = 2.0; // pause mini entre deux balades
const WANDER_PAUSE_MAX_S: f64 = 6.0; // pause maxi entre deux balades
const WANDER_STEP_MIN_PX: f64 = 80.0; // distance mini d'une balade
const WANDER_STEP_MAX_PX: f64 = 320.0; // distance maxi d'une balade

// ---- Chute vers l'herbe (créature lâchée plus haut que le gazon) ----
const FALL_SPEED_PX_S: f64 = 900.0; // vitesse verticale moyenne de la chute
const FALL_MIN_DURATION_S: f64 = 0.18; // même une petite chute reste visible
const FALL_MIN_DISTANCE_PX: f64 = 6.0; // en dessous, pas la peine d'animer

// ---- Réglages (case à cocher dans Personnaliser > Réglages) ----
// Montrer l'herbe sur la barre des tâches.
static SHOW_GROUND: AtomicBool = AtomicBool::new(true);
// Mode réunion : tout masquer d'un coup, à la demande. Repart toujours à
// « non » au démarrage de l'app (jamais mémorisé), et peut aussi se couper
// depuis l'icône de la zone de notification (voir MEETING_ITEM) : comme ça
// masque ma créature elle-même, il faut toujours un moyen de le désactiver
// qui ne dépende pas de pouvoir cliquer dessus.
static MEETING_MODE: AtomicBool = AtomicBool::new(false);
// Me masquer tout seul (moi + les amis épinglés + l'herbe) pendant qu'une
// vidéo ou une appli est en plein écran. Repart toujours à « non » au
// démarrage de l'app (jamais mémorisé), et peut aussi se couper depuis
// l'icône de la zone de notification (voir AUTO_HIDE_ITEM) : comme la
// détection peut se tromper, il faut toujours un moyen sûr de la couper
// même si elle a caché ma créature (et donc le panneau Réglages) par erreur.
static AUTO_HIDE_FULLSCREEN: AtomicBool = AtomicBool::new(false);
// Ma créature PRINCIPALE (fenêtre "main", pas un extra épinglé depuis « Ma
// collection ») est-elle actuellement à l'écran ? Elle ne passe pas par le
// système pin_pet/PINNED (elle vit toujours dans la fenêtre "main", voir
// place_me), donc pas de vraie entrée pour elle dans PINNED : App.tsx
// appelait déjà pin_set_active("main", …) sans effet (aucune entrée "main"
// dans la table) — on lui donne enfin un état, utilisé par self_pin_active.
static MAIN_PET_ACTIVE: AtomicBool = AtomicBool::new(false);
// Est-ce qu'une appli est actuellement détectée en plein écran (état déduit,
// pas un réglage) ? Sert à savoir si on doit se remontrer.
static FULLSCREEN_NOW: AtomicBool = AtomicBool::new(false);

// ------------------------------------------------------------ Géométrie

/// Zone de travail de l'écran principal (en pixels physiques). Change quand
/// la barre des tâches change de taille, s'auto-masque, ou disparaît sous
/// une vidéo plein écran : on la relit en continu (voir start_area_watcher)
/// plutôt que de la figer une fois pour toutes au démarrage.
#[derive(Clone, Copy, PartialEq)]
struct Area {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
    scale: f64, // échelle d'affichage Windows (100 %, 125 %, 150 %...)
    // Coin haut gauche du MONITEUR entier (pas la zone de travail, qui
    // exclut la barre des tâches) — ajoutés le 29/09/2026 pour la fenêtre
    // partagée "pets" (voir setup_pets) : elle couvre tout le moniteur (pour
    // pouvoir glisser une créature n'importe où, pas seulement sur la zone
    // de travail), donc les coordonnées locales envoyées à React doivent
    // être relatives à CE coin-là, pas à celui de la zone de travail.
    mon_left: f64,
    mon_top: f64,
}

static AREA: OnceLock<Mutex<Area>> = OnceLock::new();

/// Zone de travail actuelle (toujours à jour).
fn area_now() -> Option<Area> {
    AREA.get().and_then(|m| m.lock().ok()).map(|g| *g)
}

fn area_set(a: Area) {
    if let Some(m) = AREA.get() {
        if let Ok(mut g) = m.lock() {
            *g = a;
        }
    }
}

/// Calcule la zone de travail (hors barre des tâches) d'un écran.
fn compute_area(mon: &tauri::Monitor, scale: f64) -> Area {
    let work = mon.work_area();
    let pos = mon.position();
    Area {
        left: work.position.x as f64,
        top: work.position.y as f64,
        right: (work.position.x + work.size.width as i32) as f64,
        bottom: (work.position.y + work.size.height as i32) as f64,
        scale,
        mon_left: pos.x as f64,
        mon_top: pos.y as f64,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

impl Edge {
    fn parse(s: &str) -> Edge {
        match s {
            "left" => Edge::Left,
            "top" => Edge::Top,
            "bottom" => Edge::Bottom,
            _ => Edge::Right,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Edge::Left => "left",
            Edge::Right => "right",
            Edge::Top => "top",
            Edge::Bottom => "bottom",
        }
    }
}

/// Un pet d'ami épinglé : où il vit et son état.
#[derive(Clone)]
struct Pinned {
    edge: Edge,
    offset: f64, // 0 à 1 le long du bord
    size: f64,   // taille du pet (pixels logiques)
    active: bool, // à l'écran (pas caché) ?
    dragging: bool,
    drag_since: Instant,
    panel_open: bool,
    rects: Vec<(f64, f64, f64, f64)>,
    // Vrai seulement pour mon pet : il ne peut vivre que sur le bord gauche
    // ou droit (pas en haut / en bas).
    side_only: bool,
    // Vrai pour les pets d'amis : ils vivent toujours sur l'herbe (bord bas),
    // où qu'on les dépose — voir snap() — et s'y baladent tout seuls
    // (tick_wander) au lieu de rester immobiles.
    ground_only: bool,
    wander_target: Option<f64>, // offset (0 à 1) vers lequel il marche
    wander_resume_at: Instant,  // pause : instant où il repart
    walking: bool,              // dernier état envoyé à l'interface (évite le bruit)
    walk_left: bool,            // dernier sens envoyé à l'interface
    // Chute vers l'herbe après un lâcher plus haut sur l'écran (voir
    // finish_drag/tick_fall) : l'horizontale (fall_x) est déjà la bonne, fixée
    // au moment du lâcher — seule la verticale s'anime, de fall_from_y (où on
    // l'a lâchée) à fall_target_y (le gazon).
    falling: bool,
    fall_from_y: f64,
    fall_target_y: f64,
    fall_x: f64,
    fall_start: Instant,
    // Position (coin haut gauche, pixels physiques — même repère que
    // window_pos) pendant un glissement : pour "main", inutilisés (on lit
    // encore la vraie fenêtre OS, voir finish_drag) ; pour un pet de l'herbe
    // (ami ou créature à moi), plus de fenêtre à lui tout seul depuis le
    // 29/09/2026 (voir la fenêtre partagée "pets"), donc c'est React qui
    // nous les envoie en direct pendant le glissement (voir pin_drag_at),
    // et finish_drag les lit d'ici au lieu de win.outer_position().
    drag_x: f64,
    drag_y: f64,
}

static PINNED: LazyLock<Mutex<HashMap<String, Pinned>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Petit générateur pseudo-aléatoire maison (pas besoin d'une dépendance de
/// plus juste pour choisir une pause ou une distance de balade) : mélange le
/// temps courant en nanosecondes avec un xorshift.
fn rand_f64() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut x = nanos ^ 0x9E3779B97F4A7C15;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    (x % 1_000_000) as f64 / 1_000_000.0
}

fn rand_range(lo: f64, hi: f64) -> f64 {
    lo + rand_f64() * (hi - lo)
}

// Case à cocher du menu de la zone de notification (pour rester synchronisée
// avec la case « Démarrer avec Windows » côté interface).
static AUTOSTART_ITEM: OnceLock<CheckMenuItem<tauri::Wry>> = OnceLock::new();

// Case « Mode réunion » du menu de la zone de notification : toujours
// accessible pour désactiver le mode réunion même quand ma créature (et
// donc le panneau Réglages) est cachée.
static MEETING_ITEM: OnceLock<CheckMenuItem<tauri::Wry>> = OnceLock::new();

// Case « Masquer auto en plein écran » du menu de la zone de notification :
// même filet de sécurité que MEETING_ITEM.
static AUTO_HIDE_ITEM: OnceLock<CheckMenuItem<tauri::Wry>> = OnceLock::new();

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if hi < lo {
        lo
    } else {
        v.max(lo).min(hi)
    }
}

/// Coin haut gauche (physique) de la fenêtre carrée d'un pet épinglé.
fn window_pos(a: &Area, p: &Pinned) -> (f64, f64) {
    let s = a.scale;
    let w = WIN_PIN * s;
    let half = p.size * s / 2.0;
    let pad = CORNER_PAD * s;
    match p.edge {
        Edge::Left | Edge::Right => {
            let cy = clamp(
                a.top + p.offset * (a.bottom - a.top),
                a.top + half + pad,
                a.bottom - half - pad,
            );
            let x = if p.edge == Edge::Right { a.right - w } else { a.left };
            (x, cy - w / 2.0)
        }
        Edge::Top | Edge::Bottom => {
            let cx = clamp(
                a.left + p.offset * (a.right - a.left),
                a.left + half + pad,
                a.right - half - pad,
            );
            let y = if p.edge == Edge::Top { a.top } else { a.bottom - w };
            (cx - w / 2.0, y)
        }
    }
}

/// Rectangle occupé par le pet quand il est visible (gauche, haut, droite, bas).
fn pet_rect(a: &Area, p: &Pinned) -> (f64, f64, f64, f64) {
    let s = a.scale;
    let (wx, wy) = window_pos(a, p);
    let w = WIN_PIN * s;
    let z = p.size * s;
    // Sur l'herbe (bord bas), tous les pets touchent exactement la même
    // ligne de sol, quelle que soit leur taille — une marge FIXE (le même
    // petit coussin que la position la plus basse atteignable par mon
    // propre pet sur le bord latéral, voir window_pos/CORNER_PAD), pas
    // proportionnelle à la taille (voir aussi PinnedWindow.tsx : petBox,
    // marginFor — doit rester identique ici).
    let m = if p.edge == Edge::Bottom {
        CORNER_PAD * s
    } else {
        p.size / 3.0 * s // marge entre le pet et son bord
    };
    match p.edge {
        Edge::Right => (wx + w - m - z, wy + (w - z) / 2.0, wx + w - m, wy + (w + z) / 2.0),
        Edge::Left => (wx + m, wy + (w - z) / 2.0, wx + m + z, wy + (w + z) / 2.0),
        Edge::Top => (wx + (w - z) / 2.0, wy + m, wx + (w + z) / 2.0, wy + m + z),
        Edge::Bottom => (wx + (w - z) / 2.0, wy + w - m - z, wx + (w + z) / 2.0, wy + w - m),
    }
}

/// La souris est-elle près du bord du pet ? (« depth » = distance au bord,
/// « margin » = tolérance le long du bord)
fn near_edge(
    a: &Area,
    edge: Edge,
    r: (f64, f64, f64, f64),
    x: f64,
    y: f64,
    depth: f64,
    margin: f64,
) -> bool {
    let (l, t, rr, b) = r;
    match edge {
        Edge::Right => x >= a.right - depth && y >= t - margin && y <= b + margin,
        Edge::Left => x <= a.left + depth && y >= t - margin && y <= b + margin,
        Edge::Top => y <= a.top + depth && x >= l - margin && x <= rr + margin,
        Edge::Bottom => y >= a.bottom - depth && x >= l - margin && x <= rr + margin,
    }
}

/// Après un glissement : bord le plus proche du pet, et position le long de ce bord.
fn snap(a: &Area, p: &Pinned, win_x: f64, win_y: f64) -> (Edge, f64) {
    let s = a.scale;
    let w = WIN_PIN * s;
    let z = p.size * s;
    let m = p.size / 3.0 * s;
    // Le pet n'est pas au centre de sa fenêtre : pendant tout le glissement,
    // l'affichage utilise encore l'ancien bord (p.edge), donc c'est bien lui
    // qui donne le vrai centre actuel du pet, quel que soit le bord sur
    // lequel on va finalement le lâcher.
    let shift = w / 2.0 - m - z / 2.0;
    let mut cx = win_x + w / 2.0;
    let mut cy = win_y + w / 2.0;
    match p.edge {
        Edge::Right => cx += shift,
        Edge::Left => cx -= shift,
        Edge::Top => cy -= shift,
        Edge::Bottom => cy += shift,
    }

    let dl = cx - a.left;
    let dr = a.right - cx;

    let edge = if p.side_only {
        // Mon pet : seulement gauche ou droite, jamais en haut / en bas.
        if dr <= dl {
            Edge::Right
        } else {
            Edge::Left
        }
    } else if p.ground_only {
        // Un ami posé sur l'herbe : on peut le glisser n'importe où sur
        // l'écran, il retombe toujours sur le gazon (bord bas) — juste à
        // l'horizontale où on l'a lâché. C'est une limite basse, pas un bord
        // parmi d'autres.
        Edge::Bottom
    } else {
        let dt = cy - a.top;
        let db = a.bottom - cy;
        let min = dl.min(dr).min(dt).min(db);
        if min == dr {
            Edge::Right
        } else if min == dl {
            Edge::Left
        } else if min == dt {
            Edge::Top
        } else {
            Edge::Bottom
        }
    };
    let raw = match edge {
        Edge::Left | Edge::Right => (cy - a.top) / (a.bottom - a.top),
        Edge::Top | Edge::Bottom => (cx - a.left) / (a.right - a.left),
    };
    (edge, raw.max(0.0).min(1.0))
}

/// La souris est-elle sur le bouton ou le chat d'un pet épinglé ?
fn over_rects(a: &Area, p: &Pinned, x: f64, y: f64) -> bool {
    let s = a.scale;
    let (wx, wy) = window_pos(a, p);
    p.rects
        .iter()
        .any(|r| x >= wx + r.0 * s && x < wx + r.2 * s && y >= wy + r.1 * s && y < wy + r.3 * s)
}

/// La souris est-elle dans la fenêtre du pet (avec une marge) ?
fn in_window(a: &Area, p: &Pinned, x: f64, y: f64, pad: f64) -> bool {
    let (wx, wy) = window_pos(a, p);
    let w = WIN_PIN * a.scale;
    x >= wx - pad && x < wx + w + pad && y >= wy - pad && y < wy + w + pad
}

fn place_window(win: &tauri::WebviewWindow, a: &Area, p: &Pinned) {
    let (x, y) = window_pos(a, p);
    let _ = win.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

/// Le bouton gauche de la souris est-il enfoncé ?
#[cfg(windows)]
fn left_button_down() -> bool {
    unsafe {
        (windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(0x01) as u16 & 0x8000)
            != 0
    }
}
#[cfg(not(windows))]
fn left_button_down() -> bool {
    false
}

// ---------------------------------------------------- Surveillance souris

/// Convertit une position physique (repère Area/window_pos/snap...) en
/// position logique relative au coin haut gauche du MONITEUR — le repère
/// qu'utilise React dans la fenêtre partagée "pets" (voir setup_pets : elle
/// est positionnée exactement à ce coin-là, à l'échelle du moniteur entier).
fn local_xy(a: &Area, x: f64, y: f64) -> (f64, f64) {
    ((x - a.mon_left) / a.scale, (y - a.mon_top) / a.scale)
}

/// Fin d'un glissement : le pet se colle au bord le plus proche — sauf une
/// créature de l'herbe lâchée plus haut sur l'écran, qui y tombe au lieu de
/// s'y téléporter (voir tick_fall : l'herbe est la limite basse de ses
/// pieds, « on a décidé qu'elles sont toutes à la même hauteur »).
///
/// "main" garde sa propre fenêtre (voir place_me) : on lit sa position
/// réelle (win.outer_position()), comme avant le 29/09/2026. Un pet de
/// l'herbe (ami ou créature à moi) n'a plus de fenêtre à lui depuis ce
/// jour-là (voir pin_pet, fenêtre partagée "pets") : on utilise la dernière
/// position que React nous a envoyée pendant le glissement (p.drag_x/
/// drag_y, voir pin_drag_at) à la place de win.outer_position().
fn finish_drag(app: &tauri::AppHandle, label: &str, p: &Pinned, a: &Area) {
    let is_main = label == "main";
    let win = if is_main { app.get_webview_window(label) } else { None };
    let (drop_x, drop_y) = if is_main {
        let Some(win) = &win else { return };
        let Ok(pos) = win.outer_position() else { return };
        (pos.x as f64, pos.y as f64)
    } else {
        (p.drag_x, p.drag_y)
    };

    let (edge, offset) = snap(a, p, drop_x, drop_y);
    let placed = Pinned {
        edge,
        offset,
        dragging: false,
        ..p.clone()
    };
    let (fx, fy) = window_pos(a, &placed);
    let start_fall = p.ground_only && (fy - drop_y) > FALL_MIN_DISTANCE_PX;

    if let Ok(mut map) = PINNED.lock() {
        if let Some(entry) = map.get_mut(label) {
            entry.edge = edge;
            entry.offset = offset;
            entry.dragging = false;
            if start_fall {
                entry.falling = true;
                entry.fall_from_y = drop_y;
                entry.fall_target_y = fy;
                entry.fall_x = fx;
                entry.fall_start = Instant::now();
            } else if entry.ground_only {
                // Reprend ses esprits un instant avant de repartir se balader.
                entry.wander_target = None;
                entry.wander_resume_at =
                    Instant::now() + Duration::from_secs_f64(rand_range(WANDER_PAUSE_MIN_S, WANDER_PAUSE_MAX_S));
            }
        }
    }

    if is_main {
        if let Some(win) = &win {
            if start_fall {
                let _ = win.set_position(tauri::PhysicalPosition::new(fx.round() as i32, drop_y.round() as i32));
            } else {
                place_window(win, a, &placed);
            }
        }
        let _ = app.emit_to(
            label,
            "pet-placed",
            serde_json::json!({
                "edge": edge.as_str(),
                "offset": offset,
                "size": p.size,
                "dragged": true
            }),
        );
    } else {
        // On prévient tout de suite la fenêtre partagée (au lieu d'attendre
        // jusqu'à 60ms le prochain "pets-tick") : React suivait sa propre
        // position pendant le glissement (voir pin_drag_at) et doit recaler
        // pile sur le point de chute que Rust a choisi (accroché au bord +
        // marge, voir snap/window_pos), sans saut visible.
        let (imm_x, imm_y) = if start_fall { (fx, drop_y) } else { (fx, fy) };
        let (lx, ly) = local_xy(a, imm_x, imm_y);
        // "offset" en plus de x/y : React n'a besoin que d'une position à
        // l'écran pour l'affichage, mais mémorise le placement (voir
        // savePlacement côté React) sous la forme edge/offset/size, comme
        // pour "main" — pour rester compatible avec getPlacement au
        // prochain lancement d'Eggs (offset le long du bord bas), pas de
        // conversion x→offset à réinventer côté React.
        let _ = app.emit_to(
            "pets",
            "pet-placed",
            serde_json::json!({
                "id": label, "x": lx, "y": ly, "size": p.size, "offset": offset, "falling": start_fall
            }),
        );
    }
}

/// Zone de détection et clics pour mon pet ("main") et pour chaque pet de
/// l'herbe (ami épinglé, ou une de mes créatures posées). Depuis le
/// 29/09/2026 (fenêtre partagée "pets", voir pin_pet/setup_pets), seule
/// "main" garde une vraie fenêtre OS à soi ; pour tous les autres, cette
/// fonction ne fait plus que calculer où ils en sont et regrouper le tout
/// dans UN SEUL événement ("pets-tick") envoyé à la fenêtre partagée, au
/// lieu de déplacer autant de fenêtres que de créatures.
fn tick_pinned(
    app: &tauri::AppHandle,
    a: &Area,
    runtime: &mut HashMap<String, (bool, Option<bool>)>,
    x: f64,
    y: f64,
) {
    let s = a.scale;
    let snapshot: Vec<(String, Pinned)> = match PINNED.lock() {
        Ok(map) => map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        Err(_) => return,
    };
    // Seules "main" (sa vraie fenêtre) et "pets" (la fenêtre partagée, voir
    // plus bas) ont encore un état de survol à retenir d'un tick à l'autre.
    runtime.retain(|k, _| k == "main" || k == "pets");

    // Vrai dès que la souris survole N'IMPORTE LEQUEL des pets de l'herbe
    // actifs : la fenêtre partagée n'a qu'un seul état cliquable possible
    // (contrairement à avant, où chaque pet avait sa propre fenêtre à
    // basculer individuellement).
    let mut ground_over = false;
    let mut ground_pets: Vec<serde_json::Value> = Vec::new();

    for (label, mut p) in snapshot {
        let is_main = label == "main";

        // En cours de glissement : on attend que la souris soit relâchée.
        if p.dragging {
            if p.drag_since.elapsed() > Duration::from_millis(200) && !left_button_down() {
                finish_drag(app, &label, &p, a);
            }
            continue;
        }

        // En train de tomber jusqu'à l'herbe (voir finish_drag) : pas la
        // peine de faire le reste (clics, balade...) tant qu'elle n'est pas
        // posée.
        if p.falling {
            tick_fall(&mut p);
            if let Ok(mut map) = PINNED.lock() {
                if let Some(entry) = map.get_mut(&label) {
                    entry.falling = p.falling;
                    entry.wander_target = p.wander_target;
                    entry.wander_resume_at = p.wander_resume_at;
                }
            }
            let (fx, fy) = fall_position(&p);
            if is_main {
                if let Some(win) = app.get_webview_window(&label) {
                    let _ = win.set_position(tauri::PhysicalPosition::new(fx.round() as i32, fy.round() as i32));
                }
            } else {
                let (lx, ly) = local_xy(a, fx, fy);
                ground_pets.push(serde_json::json!({
                    "id": label, "x": lx, "y": ly, "size": p.size, "walking": false
                }));
            }
            continue;
        }

        // Balade autonome sur l'herbe (chat fermé) : fait avancer p.offset.
        if p.ground_only && !p.panel_open {
            let (was_walking, was_left) = (p.walking, p.walk_left);
            tick_wander(&mut p, a);
            if let Ok(mut map) = PINNED.lock() {
                if let Some(entry) = map.get_mut(&label) {
                    entry.offset = p.offset;
                    entry.wander_target = p.wander_target;
                    entry.wander_resume_at = p.wander_resume_at;
                    entry.walking = p.walking;
                    entry.walk_left = p.walk_left;
                }
            }
            // "main" prévient sa fenêtre par un événement dédié, comme avant
            // (voir App.tsx : "pet-walk") — les pets de l'herbe, eux, portent
            // déjà walking/walkLeft dans le "pets-tick" envoyé plus bas, pas
            // besoin d'un événement séparé.
            if is_main && (p.walking != was_walking || p.walk_left != was_left) {
                let _ = app.emit_to(
                    label.as_str(),
                    "pet-walk",
                    serde_json::json!({ "walking": p.walking, "dir": if p.walk_left { "left" } else { "right" } }),
                );
            }
        }

        let r = pet_rect(a, &p);
        let over = p.active && ((x >= r.0 && x < r.2 && y >= r.1 && y < r.3) || over_rects(a, &p, x, y));

        if is_main {
            let entry = runtime.entry(label.clone()).or_insert((false, None));
            // Le pet apparaît quand la souris touche son bord, repart quand
            // elle s'éloigne — sauf sur l'herbe, où il vit sa vie en
            // permanence, sans attendre la souris.
            let next = if p.ground_only {
                true
            } else if entry.0 {
                near_edge(a, p.edge, r, x, y, STAY_WIDTH_PX * s, STAY_MARGIN_PX * s)
                    || (p.panel_open && in_window(a, &p, x, y, 60.0 * s))
            } else {
                near_edge(a, p.edge, r, x, y, TRIGGER_EDGE_PX * s, TRIGGER_EXTRA_TOP_PX * s)
            };
            if next != entry.0 {
                entry.0 = next;
                let _ = app.emit_to(label.as_str(), "zone-changed", next);
            }
            let want_ignore = !over;
            if entry.1 != Some(want_ignore) {
                if let Some(w) = app.get_webview_window(&label) {
                    let _ = w.set_ignore_cursor_events(want_ignore);
                }
                entry.1 = Some(want_ignore);
            }
            if let Some(win) = app.get_webview_window(&label) {
                place_window(&win, a, &p);
            }
        } else {
            // Toujours visible (voir ci-dessus) : rien à surveiller côté
            // zone, juste sa position et si le clic doit passer ou pas —
            // React se déclare lui-même "dans la zone" dès qu'il monte
            // (voir pet/GroundPet.tsx), comme déjà le cas avant le
            // 29/09/2026 pour les mêmes raisons (voir ce fichier).
            if over {
                ground_over = true;
            }
            let (wx, wy) = window_pos(a, &p);
            let (lx, ly) = local_xy(a, wx, wy);
            ground_pets.push(serde_json::json!({
                "id": label, "x": lx, "y": ly, "size": p.size,
                "walking": p.walking, "walkLeft": p.walk_left
            }));
        }
    }

    // Une seule bascule pour toute la fenêtre partagée (au lieu d'une par
    // pet avant le 29/09/2026) : cliquable dès que la souris survole
    // n'importe lequel des pets de l'herbe, traversée par les clics sinon.
    let want_ignore = !ground_over;
    let ground_entry = runtime.entry("pets".to_string()).or_insert((false, None));
    if ground_entry.1 != Some(want_ignore) {
        if let Some(w) = app.get_webview_window("pets") {
            let _ = w.set_ignore_cursor_events(want_ignore);
        }
        ground_entry.1 = Some(want_ignore);
    }

    let _ = app.emit_to("pets", "pets-tick", serde_json::json!({ "pets": ground_pets }));
}

/// Fait avancer un pet de l'herbe (ami ou créature à moi) vers une
/// destination choisie au hasard, marche jusqu'à l'atteindre, s'arrête un
/// moment, puis repart — pour qu'il ait vraiment l'air de vivre sa vie sur
/// la bande de gazon. Pure mise à jour d'état depuis le 29/09/2026 (juste
/// p.offset/walking/walk_left) : ne touche plus aucune fenêtre elle-même,
/// c'est tick_pinned qui s'en charge après coup (pour "main" comme pour un
/// pet de l'herbe, chacun à sa façon).
fn tick_wander(p: &mut Pinned, a: &Area) {
    let now = Instant::now();
    let width = (a.right - a.left).max(1.0);

    let target = match p.wander_target {
        Some(t) => t,
        None => {
            if now < p.wander_resume_at {
                p.walking = false;
                return; // encore en pause
            }
            // Repart : une nouvelle destination, pas trop loin, sans sortir
            // de l'écran.
            let step_px = rand_range(WANDER_STEP_MIN_PX, WANDER_STEP_MAX_PX);
            let dir = if rand_f64() < 0.5 { -1.0 } else { 1.0 };
            let t = clamp(p.offset + dir * step_px / width, 0.0, 1.0);
            p.wander_target = Some(t);
            t
        }
    };

    let dir_left = target < p.offset;
    let step = WANDER_SPEED_PX_S * (POLL_MS as f64 / 1000.0) / width;

    if (target - p.offset).abs() <= step {
        p.offset = target;
        p.wander_target = None;
        p.wander_resume_at =
            now + Duration::from_secs_f64(rand_range(WANDER_PAUSE_MIN_S, WANDER_PAUSE_MAX_S));
        p.walking = false;
    } else {
        p.offset = if dir_left { p.offset - step } else { p.offset + step };
        p.walk_left = dir_left;
        p.walking = true;
    }
}

/// Avance l'horloge d'une chute (voir finish_drag) et bascule p.falling à
/// false une fois arrivée — pure mise à jour d'état depuis le 29/09/2026,
/// voir fall_position juste après pour la position physique correspondante
/// à un instant donné (utilisée séparément par tick_pinned).
fn tick_fall(p: &mut Pinned) {
    let elapsed = p.fall_start.elapsed().as_secs_f64();
    let dist = (p.fall_target_y - p.fall_from_y).abs();
    let duration = (dist / FALL_SPEED_PX_S).max(FALL_MIN_DURATION_S);
    let t = (elapsed / duration).min(1.0);
    if t >= 1.0 {
        p.falling = false;
        p.wander_target = None;
        // Reprend ses esprits un instant avant de repartir se balader —
        // comme après un dépôt sans chute (voir finish_drag).
        p.wander_resume_at =
            Instant::now() + Duration::from_secs_f64(rand_range(WANDER_PAUSE_MIN_S, WANDER_PAUSE_MAX_S));
    }
}

/// Position physique d'une créature en train de tomber (voir tick_fall),
/// pour l'instant présent : ease-in entre fall_from_y et fall_target_y,
/// l'horizontale (fall_x) ne bouge pas. Accélère comme une vraie chute
/// plutôt qu'une vitesse constante.
fn fall_position(p: &Pinned) -> (f64, f64) {
    let elapsed = p.fall_start.elapsed().as_secs_f64();
    let dist = (p.fall_target_y - p.fall_from_y).abs();
    let duration = (dist / FALL_SPEED_PX_S).max(FALL_MIN_DURATION_S);
    let t = (elapsed / duration).min(1.0);
    let eased = t * t;
    let y = p.fall_from_y + (p.fall_target_y - p.fall_from_y) * eased;
    (p.fall_x, y)
}

/// Surveille la souris pour mon pet et pour la fenêtre partagée des pets de
/// l'herbe : prévient quand elle entre / sort de la zone de "main", et rend
/// cliquable seulement ce qu'il faut (le pet et son panneau pour "main",
/// n'importe lequel des pets de l'herbe pour la fenêtre "pets").
fn start_cursor_watcher(app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut runtime: HashMap<String, (bool, Option<bool>)> = HashMap::new();

        loop {
            // On relit la zone de travail à chaque tour : si la barre des
            // tâches a changé pendant ce temps (voir start_area_watcher),
            // les clics/survols restent alignés sur la nouvelle position.
            if let (Ok(pos), Some(area)) = (app.cursor_position(), area_now()) {
                tick_pinned(&app, &area, &mut runtime, pos.x, pos.y);
            }
            thread::sleep(Duration::from_millis(POLL_MS));
        }
    });
}

// ------------------------------------------------------------ Commandes

/// Corrige la position de MA fenêtre selon l'emplacement mémorisé par
/// l'interface (data/placements.ts, identifiant « me » ou « me-ground »).
/// Appelée juste après le montage de l'interface, et de nouveau chaque fois
/// que « Épingler sur le bureau » (Profil) change d'état — la fenêtre
/// « main » existe déjà (créée par Tauri au démarrage avec une position de
/// départ), donc on rejoint ici le même système générique que les pets
/// épinglés au lieu d'en recréer une.
///
/// « ground » vient de ce réglage : à false (par défaut), mon pet se comporte
/// comme avant, collé à un bord latéral (side_only), caché quand la souris
/// s'éloigne. À true, il se comporte exactement comme un ami épinglé ou une
/// de mes créatures posées sur l'herbe (ground_only) : bloqué sur le gazon
/// (bord bas), et il s'y balade tout seul (voir tick_wander, déjà générique
/// sur toute la table PINNED — aucun changement à faire là-bas).
#[tauri::command]
fn place_me(app: tauri::AppHandle, edge: String, offset: f64, size: f64, ground: bool) {
    let Some(a) = area_now() else {
        return;
    };
    let placed = {
        let Ok(mut map) = PINNED.lock() else {
            return;
        };
        let entry = map.entry("main".to_string()).or_insert_with(|| Pinned {
            edge: Edge::Right,
            offset: 0.9,
            size: 96.0,
            active: false,
            dragging: false,
            drag_since: Instant::now(),
            panel_open: false,
            rects: Vec::new(),
            side_only: true,
            ground_only: false,
            wander_target: None,
            wander_resume_at: Instant::now(),
            walking: false,
            walk_left: true,
            falling: false,
            fall_from_y: 0.0,
            fall_target_y: 0.0,
            fall_x: 0.0,
            fall_start: Instant::now(),
            drag_x: 0.0,
            drag_y: 0.0,
        });
        entry.side_only = !ground;
        entry.ground_only = ground;
        if ground {
            // Sur l'herbe, quel que soit ce que l'interface a envoyé : une
            // seule limite basse, pas un bord parmi d'autres (voir snap()).
            entry.edge = Edge::Bottom;
        } else {
            // Bord latéral seulement : une valeur en haut/bas (mémorisée
            // avant ce réglage, ou invalide) retombe à droite.
            let parsed = Edge::parse(&edge);
            entry.edge = match parsed {
                Edge::Left | Edge::Right => parsed,
                Edge::Top | Edge::Bottom => Edge::Right,
            };
        }
        entry.offset = clamp(offset, 0.0, 1.0);
        entry.size = clamp(size, MIN_SIZE, MAX_SIZE);
        // Repart du bon pied : pas en pleine balade juste après un
        // changement de mode, et pas de marche affichée tant qu'il n'a pas
        // redécidé où aller (tick_wander s'en charge au prochain tick).
        entry.wander_target = None;
        entry.wander_resume_at = Instant::now();
        entry.clone()
    };
    if let Some(win) = app.get_webview_window("main") {
        place_window(&win, &a, &placed);
    }
}

/// Ajoute un pet à l'herbe (ami épinglé, ou une de mes créatures posée
/// depuis « Ma collection ») : une entrée dans PINNED, plus rien d'autre.
///
/// Avant le 29/09/2026, chaque pet posé sur l'herbe (amis ET mes propres
/// créatures) avait sa propre fenêtre Windows/WebView2 — jusqu'à 3 de
/// chaque, plafond fixé pour rester raisonnable en mémoire. Antoine a
/// demandé de lever cette limite (49 créatures dehors en même temps, voire
/// plus) : impossible de continuer avec une vraie fenêtre par créature (49
/// fenêtres WebView2, ce serait des gigaoctets de RAM et un bureau qui rame).
/// Toutes les créatures de l'herbe (amis + collection, PAS ma créature
/// principale "main" : elle garde sa propre fenêtre, une seule, pas de souci
/// d'échelle) vivent donc maintenant dans UNE SEULE fenêtre partagée,
/// "pets" (voir setup_pets), créée une fois pour toutes au démarrage. Cette
/// fonction n'a donc plus qu'à ajouter une entrée dans la table PINNED —
/// c'est tick_pinned qui, à chaque tick, calcule la position de chaque
/// créature et l'envoie à React (voir emit_pets_tick) pour que la fenêtre
/// partagée la dessine au bon endroit.
#[tauri::command]
fn pin_pet(id: String, offset: f64, size: f64) {
    let label = format!("pin-{id}");
    if let Ok(mut map) = PINNED.lock() {
        if map.contains_key(&label) {
            return; // déjà là (ex: React qui republie après une reconnexion)
        }
        map.insert(
            label.clone(),
            Pinned {
                edge: Edge::Bottom,
                offset: clamp(offset, 0.0, 1.0),
                size: clamp(size, MIN_SIZE, MAX_SIZE),
                active: false,
                dragging: false,
                drag_since: Instant::now(),
                panel_open: false,
                rects: Vec::new(),
                side_only: false,
                ground_only: true,
                wander_target: None,
                // Petit délai avant de commencer à se balader, pour ne pas voir
                // tous les amis se mettre en marche exactement en même temps.
                wander_resume_at: Instant::now() + Duration::from_secs_f64(rand_range(0.5, 3.0)),
                walking: false,
                walk_left: true,
                falling: false,
                fall_from_y: 0.0,
                fall_target_y: 0.0,
                fall_x: 0.0,
                fall_start: Instant::now(),
                drag_x: 0.0,
                drag_y: 0.0,
            },
        );
    }
}

/// Retire un pet de l'herbe (ami détaché, ou une de mes créatures rangée) :
/// juste une entrée en moins dans PINNED — plus de fenêtre à fermer depuis
/// le 29/09/2026 (voir pin_pet), la fenêtre partagée "pets" ne disparaît
/// jamais elle-même, elle arrête simplement de dessiner cette créature au
/// prochain tick.
#[tauri::command]
fn unpin_pet(id: String) {
    let label = format!("pin-{id}");
    if let Ok(mut map) = PINNED.lock() {
        map.remove(&label);
    }
}

/// Un pet épinglé est à l'écran ou caché. Appelé aussi par la fenêtre
/// "main" avec label = "main" pour MA créature principale : elle A bien
/// une entrée dans PINNED (créée par place_me), c'est même p.active qui
/// décide si SA fenêtre accepte les clics du tout (voir la boucle de tick
/// plus bas, "over = p.active && …") — il ne faut donc surtout pas
/// s'arrêter après avoir mis à jour MAIN_PET_ACTIVE (utilisé, lui,
/// seulement par self_pin_active pour la bulle "vient d'écrire") sous
/// peine de rendre le bouton définitivement incliquable.
#[tauri::command]
fn pin_set_active(label: String, active: bool) {
    if label == "main" {
        MAIN_PET_ACTIVE.store(active, Ordering::Relaxed);
    }
    if let Ok(mut map) = PINNED.lock() {
        if let Some(p) = map.get_mut(&label) {
            p.active = active;
        }
    }
}

/// Le pet épinglé de cet ami est-il actuellement à l'écran (pas caché,
/// pas en mode réunion / plein écran) ? Utilisé par la fenêtre "toast" pour
/// ne pas doubler sa bulle de dialogue (voir notifications.ts côté React) :
/// si on la voit déjà sur son pet, pas besoin de la carte "nouveau message"
/// en plus. `false` aussi si son pet n'est pas épinglé du tout.
#[tauri::command]
fn pin_is_active(friend_id: String) -> bool {
    let label = format!("pin-{friend_id}");
    PINNED
        .lock()
        .ok()
        .and_then(|map| map.get(&label).map(|p| p.active))
        .unwrap_or(false)
}

/// Une de MES PROPRES créatures est-elle actuellement à l'écran ? Soit ma
/// créature principale (fenêtre "main", voir MAIN_PET_ACTIVE), soit un
/// extra épinglé depuis « Ma collection » (voir selfPinId côté React : ces
/// fenêtres ont toujours un label "pin-self-…"). Même idée que
/// pin_is_active mais pour moi plutôt que pour un ami : si une de mes
/// créatures est déjà visible, c'est elle qui porte la bulle "vient
/// d'écrire" à la place de la carte.
#[tauri::command]
fn self_pin_active() -> bool {
    if MAIN_PET_ACTIVE.load(Ordering::Relaxed) {
        return true;
    }
    PINNED
        .lock()
        .map(|map| map.iter().any(|(label, p)| label.starts_with("pin-self-") && p.active))
        .unwrap_or(false)
}

/// Début d'un glissement (déplacement) d'un pet épinglé.
#[tauri::command]
fn pin_drag_start(label: String) {
    if let Ok(mut map) = PINNED.lock() {
        if let Some(p) = map.get_mut(&label) {
            p.dragging = true;
            p.drag_since = Instant::now();
        }
    }
}

/// Position d'un pet de l'herbe PENDANT un glissement (ami ou créature à
/// moi) : depuis le 29/09/2026 (fenêtre partagée "pets", voir pin_pet), il
/// n'y a plus de vraie fenêtre OS à faire suivre la souris — c'est React qui
/// déplace lui-même l'élément à l'écran (voir pet/GroundPet.tsx) pour un
/// retour instantané, et nous informe en direct (à chaque pointermove) pour
/// que finish_drag (tick_pinned, une fois le bouton relâché) sache où le
/// poser. `x`/`y` : coin haut gauche de la boîte 800×800 du pet (même repère
/// que window_pos), en pixels LOGIQUES relatifs au coin haut gauche du
/// moniteur (voir Area.mon_left/mon_top) — on les convertit ici en pixels
/// physiques, seul repère utilisé côté Rust (Area, snap, pet_rect...).
/// Ignoré pour "main" : elle garde son vrai glissement de fenêtre natif
/// (voir App.tsx : onPress appelle encore startDragging()), jamais cette
/// commande.
#[tauri::command]
fn pin_drag_at(label: String, x: f64, y: f64) {
    let Some(a) = area_now() else {
        return;
    };
    if let Ok(mut map) = PINNED.lock() {
        if let Some(p) = map.get_mut(&label) {
            p.drag_x = a.mon_left + x * a.scale;
            p.drag_y = a.mon_top + y * a.scale;
        }
    }
}

/// Zones cliquables d'un pet épinglé : le bouton et le chat (pixels logiques).
#[tauri::command]
fn pin_set_ui(label: String, panel_open: bool, rects: Vec<[f64; 4]>) {
    if let Ok(mut map) = PINNED.lock() {
        if let Some(p) = map.get_mut(&label) {
            p.panel_open = panel_open;
            p.rects = rects.into_iter().map(|r| (r[0], r[1], r[2], r[3])).collect();
        }
    }
}

/// Change la taille d'un pet épinglé (molette sur le pet).
#[tauri::command]
fn pin_resize(app: tauri::AppHandle, label: String, size: f64) {
    let is_main = label == "main";
    let Some(a) = area_now() else {
        return;
    };
    let placed = {
        let Ok(mut map) = PINNED.lock() else {
            return;
        };
        match map.get_mut(&label) {
            Some(p) => {
                p.size = clamp(size, MIN_SIZE, MAX_SIZE);
                p.clone()
            }
            None => return,
        }
    };
    // "main" garde sa propre fenêtre (voir place_me) : on la redimensionne
    // et on prévient l'interface tout de suite. Un pet de l'herbe (ami ou
    // créature à moi), lui, n'a plus de fenêtre à lui depuis le 29/09/2026
    // (voir pin_pet) — inutile de rien renvoyer, React connaît déjà la
    // nouvelle taille (mise à jour optimiste, voir PinnedWindow.tsx : elle
    // ne fait qu'informer Rust pour que la physique (bord, chute...) reste
    // cohérente) et le prochain tick (pets-tick) suffit à tout resynchroniser.
    if is_main {
        if let Some(win) = app.get_webview_window(&label) {
            place_window(&win, &a, &placed);
        }
        let _ = app.emit_to(
            label.as_str(),
            "pet-placed",
            serde_json::json!({
                "edge": placed.edge.as_str(),
                "offset": placed.offset,
                "size": placed.size
            }),
        );
    }
}

/// Montrer ou cacher l'herbe (réglage « Afficher le sol »).
#[tauri::command]
fn set_show_ground(app: tauri::AppHandle, on: bool) {
    SHOW_GROUND.store(on, Ordering::Relaxed);
    apply_visibility(&app);
}

/// État actuel du mode réunion (jamais mémorisé : toujours « non » à chaque
/// lancement de l'app).
#[tauri::command]
fn get_meeting_mode() -> bool {
    MEETING_MODE.load(Ordering::Relaxed)
}

/// Mode réunion : tout cacher d'un coup (créature, amis épinglés, herbe).
#[tauri::command]
fn set_meeting_mode(app: tauri::AppHandle, on: bool) {
    MEETING_MODE.store(on, Ordering::Relaxed);
    apply_visibility(&app);
    if let Some(item) = MEETING_ITEM.get() {
        let _ = item.set_checked(on);
    }
}

/// État actuel du masquage automatique en plein écran (jamais mémorisé :
/// toujours « non » à chaque lancement de l'app).
#[tauri::command]
fn get_auto_hide_fullscreen() -> bool {
    AUTO_HIDE_FULLSCREEN.load(Ordering::Relaxed)
}

/// Active ou désactive le masquage automatique en plein écran (et garde la
/// case du menu de la zone de notification synchronisée).
#[tauri::command]
fn set_auto_hide_fullscreen(app: tauri::AppHandle, on: bool) {
    AUTO_HIDE_FULLSCREEN.store(on, Ordering::Relaxed);
    if !on {
        // On arrête de suivre le plein écran : on se remontre tout de suite
        // plutôt que d'attendre le prochain passage du minuteur.
        FULLSCREEN_NOW.store(false, Ordering::Relaxed);
        apply_visibility(&app);
    }
    if let Some(item) = AUTO_HIDE_ITEM.get() {
        let _ = item.set_checked(on);
    }
}

/// État actuel du démarrage automatique avec Windows.
#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Active ou désactive le démarrage automatique avec Windows (et garde la
/// case du menu de la zone de notification synchronisée).
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, on: bool) {
    let auto = app.autolaunch();
    if on {
        let _ = auto.enable();
    } else {
        let _ = auto.disable();
    }
    if let Some(item) = AUTOSTART_ITEM.get() {
        let _ = item.set_checked(on);
    }
}

// Hauteur (pixels logiques) de la bande d'herbe posée sur la barre des tâches.
const GROUND_H: f64 = 12.0;

// ---- Petite carte de notification maison (nouveaux messages) ----
// Taille et marge de coin pour la fenêtre "toast" (voir setup_toast /
// src/pet/ToastWindow.tsx) : posée en bas-droite de la zone de travail,
// comme une notification, mais dessinée par nous plutôt que par Windows.
const TOAST_W: f64 = 168.0;
const TOAST_H: f64 = 34.0;
const TOAST_MARGIN: f64 = 16.0;

/// Crée la bande d'herbe : une fenêtre décorative, sans interaction, posée
/// sur toute la largeur de l'écran, collée juste au-dessus de la barre des
/// tâches (et si possible par-dessus).
fn setup_ground(app: &tauri::App, mon: &tauri::Monitor, area: &Area) -> tauri::Result<()> {
    let scale = mon.scale_factor();
    let size = mon.size();

    let win = WebviewWindowBuilder::new(app, "ground", WebviewUrl::App("index.html".into()))
        .title("Egg")
        .inner_size(size.width as f64 / scale, GROUND_H)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .build()?;

    place_ground(&win, mon, area);
    // Purement décoratif : les clics traversent toujours cette fenêtre.
    win.set_ignore_cursor_events(true)?;
    win.show()?;
    // Windows redonne régulièrement le dessus à la barre des tâches, même sur
    // une fenêtre "toujours au premier plan" : on réaffirme donc notre bande
    // d'herbe par-dessus à intervalle régulier pour qu'elle reste visible.
    keep_ground_on_top(win);
    Ok(())
}

/// Repositionne la bande d'herbe : toute la largeur de l'écran, collée juste
/// au-dessus de la barre des tâches (area.bottom = haut de la zone de
/// travail, donc juste au-dessus de la barre — pas le bas physique de
/// l'écran, qui serait sous la barre des tâches).
fn place_ground(win: &tauri::WebviewWindow, mon: &tauri::Monitor, area: &Area) {
    let scale = mon.scale_factor();
    let pos = mon.position();
    let size = mon.size();
    let h = (GROUND_H * scale).round().max(1.0) as i32;
    let y = (area.bottom - h as f64).round() as i32;
    let _ = win.set_position(tauri::PhysicalPosition::new(pos.x, y));
    let _ = win.set_size(tauri::PhysicalSize::new(size.width, h as u32));
}

/// Réaffirme périodiquement que la fenêtre d'herbe est au premier plan, pour
/// gagner le bras de fer avec la barre des tâches de Windows.
fn keep_ground_on_top(win: tauri::WebviewWindow) {
    thread::spawn(move || loop {
        let _ = win.set_always_on_top(true);
        thread::sleep(Duration::from_millis(500));
    });
}

/// Fenêtre UNIQUE et PARTAGÉE pour toutes les créatures posées sur l'herbe
/// (amis épinglés, créatures de ma collection) — depuis le 29/09/2026,
/// remplace l'ancien système d'une fenêtre WebviewWindow par créature (voir
/// l'historique de pin_pet), qui plafonnait le nombre de créatures affichées
/// (chaque fenêtre coûte en RAM/CPU/composition GPU côté WebView2). Couvre
/// le moniteur entier, en coordonnées PHYSIQUES à partir de son coin
/// haut-gauche (mon.position()) — c'est ce repère que local_xy() utilise
/// pour convertir la position "monde" de chaque créature (calculée par les
/// fonctions géométriques pures, inchangées) en position LOCALE à cette
/// fenêtre, celle que React utilise pour du CSS position:absolute (voir
/// pet/GroundPet.tsx). Cliquable à travers par défaut ; tick_pinned bascule
/// set_ignore_cursor_events une seule fois par tick pour toute la fenêtre,
/// selon qu'une créature quelconque est survolée (ground_over) — plus un
/// bouton par créature à surveiller individuellement.
fn setup_pets(app: &tauri::App, mon: &tauri::Monitor, _area: &Area) -> tauri::Result<()> {
    // NOTE (29/09/2026) : la fenêtre "pets" doit être listée dans
    // src-tauri/capabilities/default.json ("windows": [...]), sinon Tauri lui
    // refuse silencieusement tout invoke()/listen() (aucune erreur visible,
    // juste rien qui se passe). Si tu vois ce commentaire recompiler, c'est
    // qu'un simple changement JSON dans capabilities/ ne suffit PAS à lui
    // seul à déclencher un `cargo build` (generate_context!() lit ce fichier
    // à la compilation, mais Cargo ne surveille pas son contenu comme une
    // dépendance) : il faut toucher un fichier .rs pour forcer la recompilation.
    let scale = mon.scale_factor();
    let size = mon.size();

    let win = WebviewWindowBuilder::new(app, "pets", WebviewUrl::App("index.html".into()))
        .title("Egg")
        .inner_size(size.width as f64 / scale, size.height as f64 / scale)
        .decorations(false)
        .transparent(true)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .build()?;

    place_pets(&win, mon);
    // Comme pour l'herbe : rien n'est cliquable tant qu'aucune créature n'est
    // survolée, voir tick_pinned qui rebascule ça à chaque tick.
    win.set_ignore_cursor_events(true)?;
    win.show()?;
    Ok(())
}

/// Replace/redimensionne la fenêtre partagée "pets" sur le moniteur entier
/// (coin haut-gauche PHYSIQUE du moniteur, pas la zone de travail — les
/// créatures peuvent se déplacer n'importe où au sol, y compris sous la
/// barre des tâches visuellement si besoin ; seule leur position verticale
/// au repos est contrainte par area.bottom, comme avant).
fn place_pets(win: &tauri::WebviewWindow, mon: &tauri::Monitor) {
    let pos = mon.position();
    let size = mon.size();
    let _ = win.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
    let _ = win.set_size(tauri::PhysicalSize::new(size.width, size.height));
}

/// Petite fenêtre dédiée à la carte "nouveau message" (voir
/// src/pet/ToastWindow.tsx) : posée une fois pour toutes en bas-droite de
/// l'écran, transparente et cliquable à travers, dans son propre esprit
/// plutôt qu'une notification Windows classique. Comme pour les pets
/// épinglés, la fenêtre reste "affichée" en permanence côté Rust — c'est le
/// CSS, côté React, qui la montre ou la cache (transition douce, voir
/// toast.css), pas Rust.
fn setup_toast(app: &tauri::App, mon: &tauri::Monitor, area: &Area) -> tauri::Result<()> {
    let win = WebviewWindowBuilder::new(app, "toast", WebviewUrl::App("index.html".into()))
        .title("Egg")
        .inner_size(TOAST_W, TOAST_H)
        .decorations(false)
        .transparent(true)
        // Sans ça, Windows/WebView2 peint la fenêtre en noir opaque derrière
        // la carte (on ne voit alors que le contour rectangulaire de la
        // fenêtre) au lieu de vraiment laisser voir le bureau à travers.
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .visible(false)
        .build()?;

    place_toast(&win, mon, area);
    win.set_ignore_cursor_events(true)?;
    win.show()?;
    Ok(())
}

/// Coin bas-droit de la zone de travail (hors barre des tâches), avec une
/// petite marge — l'emplacement habituel d'une notification.
fn place_toast(win: &tauri::WebviewWindow, mon: &tauri::Monitor, area: &Area) {
    let scale = mon.scale_factor();
    let w = (TOAST_W * scale).round() as i32;
    let h = (TOAST_H * scale).round() as i32;
    let margin = (TOAST_MARGIN * scale).round() as i32;
    let x = area.right as i32 - w - margin;
    let y = area.bottom as i32 - h - margin;
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
}

/// La fenêtre au premier plan couvre-t-elle tout l'écran (vidéo plein écran,
/// jeu...) ? Comparée aux bords physiques du moniteur (pas la zone de
/// travail, qui exclut déjà la barre des tâches).
#[cfg(windows)]
fn is_fullscreen(mon: &tauri::Monitor) -> bool {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetShellWindow, GetWindowRect,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() || hwnd == GetShellWindow() {
            return false;
        }

        // Exclut le bureau lui-même (Progman/WorkerW) et la barre des
        // tâches : leur fenêtre peut, elle aussi, techniquement couvrir tout
        // l'écran (ex : quand rien n'a le focus).
        let mut class = [0u16; 32];
        let len = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
        if len > 0 {
            let name = String::from_utf16_lossy(&class[..len as usize]);
            if matches!(name.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd" | "Button") {
                return false;
            }
        }

        let mut r: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut r) == 0 {
            return false;
        }
        let pos = mon.position();
        let size = mon.size();
        // Petite tolérance : certaines fenêtres « plein écran » débordent
        // d'un pixel ou deux selon l'appli.
        const TOL: i32 = 2;
        (r.left - pos.x).abs() <= TOL
            && (r.top - pos.y).abs() <= TOL
            && (r.right - (pos.x + size.width as i32)).abs() <= TOL
            && (r.bottom - (pos.y + size.height as i32)).abs() <= TOL
    }
}
#[cfg(not(windows))]
fn is_fullscreen(_mon: &tauri::Monitor) -> bool {
    false
}

/// Applique l'état de visibilité actuel (réglages) à toutes les fenêtres :
/// mon pet, les pets épinglés des amis, et l'herbe.
fn apply_visibility(app: &tauri::AppHandle) {
    let hide_all = MEETING_MODE.load(Ordering::Relaxed) || FULLSCREEN_NOW.load(Ordering::Relaxed);
    let ground_visible = SHOW_GROUND.load(Ordering::Relaxed) && !hide_all;

    if let Some(w) = app.get_webview_window("ground") {
        let _ = if ground_visible { w.show() } else { w.hide() };
    }

    // Mon pet ("main") garde sa propre fenêtre : inchangé.
    if let Some(w) = app.get_webview_window("main") {
        let _ = if hide_all { w.hide() } else { w.show() };
    }

    // Depuis le 29/09/2026, toutes les créatures posées sur l'herbe (amies ou
    // à moi) vivent dans la fenêtre partagée "pets" (voir pin_pet/setup_pets)
    // : un seul show/hide pour toutes, plus besoin d'itérer les entrées de
    // PINNED une par une (elles n'ont plus de fenêtre individuelle).
    if let Some(w) = app.get_webview_window("pets") {
        let _ = if hide_all { w.hide() } else { w.show() };
    }
}

/// Surveille la zone de travail de l'écran et replace tout (mon pet, les
/// pets épinglés des amis, l'herbe) dès qu'elle change : barre des tâches
/// redimensionnée, masquée automatiquement, ou temporairement cachée sous
/// une vidéo plein écran (ex : barre réduite à son minimum → l'herbe vient
/// se coller au bord bas de l'écran, comme s'il n'y avait plus de barre).
/// Surveille aussi le plein écran (si activé dans les réglages) pour se
/// masquer/remontrer tout seul.
fn start_area_watcher(app: tauri::AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));

        let Some(win) = app.get_webview_window("main") else {
            continue;
        };
        let Ok(Some(mon)) = win.primary_monitor() else {
            continue;
        };
        let Ok(scale) = win.scale_factor() else {
            continue;
        };

        // Plein écran : je m'efface pour ne jamais gêner une vidéo.
        if AUTO_HIDE_FULLSCREEN.load(Ordering::Relaxed) {
            let now = is_fullscreen(&mon);
            if FULLSCREEN_NOW.swap(now, Ordering::Relaxed) != now {
                apply_visibility(&app);
            }
        } else if FULLSCREEN_NOW.swap(false, Ordering::Relaxed) {
            apply_visibility(&app);
        }

        let new_area = compute_area(&mon, scale);

        let changed = area_now().map(|a| a != new_area).unwrap_or(true);
        if !changed {
            continue;
        }
        area_set(new_area);

        // Replace mon pet ("main", seul à garder une vraie fenêtre OS à lui),
        // sauf s'il est justement en train d'être glissé (pour ne pas gêner
        // l'utilisateur). Les créatures posées sur l'herbe n'ont plus de
        // fenêtre individuelle depuis le 29/09/2026 (voir pin_pet/
        // setup_pets) : rien à faire pour elles ici, tick_pinned leur envoie
        // déjà leur position à chaque tick via local_xy, qui se recalcule
        // tout seul dès que area_now() change.
        if let Ok(map) = PINNED.lock() {
            if let Some(p) = map.get("main") {
                if !p.dragging {
                    if let Some(w) = app.get_webview_window("main") {
                        place_window(&w, &new_area, p);
                    }
                }
            }
        }

        // Replace la bande d'herbe.
        if let Some(ground) = app.get_webview_window("ground") {
            place_ground(&ground, &mon, &new_area);
        }

        // Replace la carte de notification (coin bas-droit).
        if let Some(toast) = app.get_webview_window("toast") {
            place_toast(&toast, &mon, &new_area);
        }

        // Replace/redimensionne la fenêtre partagée des créatures de l'herbe
        // sur le moniteur entier (voir setup_pets) : utile si la résolution
        // ou l'agencement des moniteurs change en cours de route.
        if let Some(pets) = app.get_webview_window("pets") {
            place_pets(&pets, &mon);
        }
    });
}

/// Va voir sur GitHub (voir tauri.conf.json : plugins.updater.endpoints) s'il
/// existe une version plus récente ; si oui, la télécharge, l'installe, puis
/// relance l'appli dessus. Silencieux : pas de fenêtre ni de notification
/// pour l'instant (juste Antoine et un ami à tenir à jour) — voir
/// UPDATING.md à la racine du projet pour la mise en place et le mode
/// d'emploi de chaque nouvelle version.
async fn check_for_update(app: tauri::AppHandle) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            eprintln!("updater indisponible : {e}");
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            println!("mise à jour {} disponible, téléchargement…", update.version);
            // Deux fonctions de progression séparées (une par « tick », une à la
            // fin) : elles ne peuvent pas se partager une même variable classique
            // (l'une l'incrémenterait pendant que l'autre la lit, refusé par le
            // compilateur) — on se contente donc d'annoncer chaque paquet reçu,
            // sans total cumulé.
            let result = update
                .download_and_install(
                    |chunk, _total| {
                        println!("… {chunk} octets reçus");
                    },
                    || {
                        println!("téléchargement terminé");
                    },
                )
                .await;
            match result {
                Ok(()) => {
                    println!("mise à jour installée, redémarrage…");
                    app.restart();
                }
                Err(e) => eprintln!("échec de l'installation de la mise à jour : {e}"),
            }
        }
        Ok(None) => println!("déjà à jour"),
        Err(e) => eprintln!("vérification de mise à jour impossible : {e}"),
    }
}

/// Icône dans la zone de notification, avec un menu « Quitter ».
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, "quit", "Quitter Egg", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Lancer avec Windows",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let _ = AUTOSTART_ITEM.set(autostart.clone());
    // Toujours accessible ici, même si ma créature est cachée par le mode
    // réunion lui-même (voir le commentaire sur MEETING_ITEM).
    let meeting = CheckMenuItem::with_id(
        app,
        "meeting",
        "Mode réunion",
        true,
        false,
        None::<&str>,
    )?;
    let _ = MEETING_ITEM.set(meeting.clone());
    // Idem : la détection peut se tromper, donc toujours accessible ici même
    // si elle a caché ma créature par erreur (voir le commentaire sur
    // AUTO_HIDE_FULLSCREEN). Repart décochée à chaque lancement.
    let auto_hide = CheckMenuItem::with_id(
        app,
        "autohide",
        "Masquer auto en plein écran",
        true,
        false,
        None::<&str>,
    )?;
    let _ = AUTO_HIDE_ITEM.set(auto_hide.clone());
    let check_update = MenuItem::with_id(
        app,
        "check_update",
        "Vérifier les mises à jour",
        true,
        None::<&str>,
    )?;
    let menu = Menu::with_items(
        app,
        &[&autostart, &meeting, &auto_hide, &check_update, &quit],
    )?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("Egg")
        .menu(&menu)
        .on_menu_event(|app, event| {
            if event.id.as_ref() == "autostart" {
                let auto = app.autolaunch();
                let now_enabled = if auto.is_enabled().unwrap_or(false) {
                    let _ = auto.disable();
                    false
                } else {
                    let _ = auto.enable();
                    true
                };
                if let Some(item) = AUTOSTART_ITEM.get() {
                    let _ = item.set_checked(now_enabled);
                }
            }
            if event.id.as_ref() == "meeting" {
                let now_on = !MEETING_MODE.load(Ordering::Relaxed);
                MEETING_MODE.store(now_on, Ordering::Relaxed);
                apply_visibility(app);
                if let Some(item) = MEETING_ITEM.get() {
                    let _ = item.set_checked(now_on);
                }
            }
            if event.id.as_ref() == "autohide" {
                let now_on = !AUTO_HIDE_FULLSCREEN.load(Ordering::Relaxed);
                AUTO_HIDE_FULLSCREEN.store(now_on, Ordering::Relaxed);
                if !now_on {
                    FULLSCREEN_NOW.store(false, Ordering::Relaxed);
                    apply_visibility(app);
                }
                if let Some(item) = AUTO_HIDE_ITEM.get() {
                    let _ = item.set_checked(now_on);
                }
            }
            if event.id.as_ref() == "check_update" {
                // Même vérification qu'au démarrage (voir check_for_update),
                // mais déclenchée à la demande depuis le menu.
                let handle = app.clone();
                tauri::async_runtime::spawn(check_for_update(handle));
            }
            if event.id.as_ref() == "quit" {
                app.exit(0);
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {
            // Eggs tourne déjà : on ne fait rien (pas de deuxième poussin).
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        // Lien de salon partageable (eggs://salon/<id>) : voir Cargo.toml et
        // tauri.conf.json (plugins.deep-link). La navigation réelle (aperçu
        // du salon) se fait côté React (App.tsx, via @tauri-apps/plugin-deep-link) ;
        // ici on se contente de remettre la fenêtre au premier plan (voir
        // plus bas, .setup()) si Eggs tournait déjà en arrière-plan.
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            place_me,
            pin_pet,
            unpin_pet,
            pin_set_active,
            pin_is_active,
            self_pin_active,
            pin_drag_start,
            pin_drag_at,
            pin_resize,
            pin_set_ui,
            set_show_ground,
            get_meeting_mode,
            set_meeting_mode,
            get_auto_hide_fullscreen,
            set_auto_hide_fullscreen,
            get_autostart,
            set_autostart,
            list_capture_sources,
            start_screen_capture,
            stop_screen_capture
        ])
        .setup(|app| {
            let win = app
                .get_webview_window("main")
                .expect("fenêtre main introuvable");
            let mon = win.primary_monitor()?.expect("aucun écran trouvé");
            let scale = win.scale_factor()?;

            // Zone de travail de l'écran (pour mon pet et les pets épinglés).
            let area = compute_area(&mon, scale);
            let _ = AREA.set(Mutex::new(area));

            // Mon pet rejoint le même système que les pets épinglés : position
            // de départ dans le coin bas droit, corrigée ensuite par l'interface
            // (commande place_me) selon l'emplacement mémorisé sur cet ordinateur.
            let me = Pinned {
                edge: Edge::Right,
                offset: 0.9,
                size: 96.0,
                active: false,
                dragging: false,
                drag_since: Instant::now(),
                panel_open: false,
                rects: Vec::new(),
                side_only: true,
                ground_only: false,
                wander_target: None,
                wander_resume_at: Instant::now(),
                walking: false,
                walk_left: true,
                falling: false,
                fall_from_y: 0.0,
                fall_target_y: 0.0,
                fall_x: 0.0,
                fall_start: Instant::now(),
                drag_x: 0.0,
                drag_y: 0.0,
            };
            place_window(&win, &area, &me);
            if let Ok(mut map) = PINNED.lock() {
                map.insert("main".to_string(), me);
            }

            // Au départ les clics traversent la fenêtre.
            win.set_ignore_cursor_events(true)?;

            setup_ground(app, &mon, &area)?;
            setup_toast(app, &mon, &area)?;
            setup_pets(app, &mon, &area)?;

            start_cursor_watcher(app.handle().clone());
            start_area_watcher(app.handle().clone());

            setup_tray(app)?;

            // Lien de salon partageable (eggs://salon/<id>, voir Cargo.toml
            // et tauri.conf.json). Le lien peut arriver alors qu'Eggs tourne
            // déjà en arrière-plan (fenêtre "main" cachée, pas de pet visible
            // à l'écran) : on la remet au premier plan ici. La navigation
            // (aperçu du salon) est gérée côté React (App.tsx), qui écoute le
            // même événement via @tauri-apps/plugin-deep-link — rien d'autre
            // à faire ici.
            {
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |_event| {
                    if let Some(win) = handle.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                });
            }

            // Vérifie une mise à jour au lancement, en tâche de fond (voir
            // check_for_update et UPDATING.md) — n'empêche pas l'appli de
            // démarrer normalement pendant ce temps.
            tauri::async_runtime::spawn(check_for_update(app.handle().clone()));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}