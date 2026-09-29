// Partage d'écran pour les appels de salon (voir src/data/salonCall.ts côté
// client) : notre propre sélecteur d'écran/fenêtre, plutôt que celui de
// WebView2.
//
// Pourquoi : le sélecteur natif que Windows/WebView2 affiche pour
// getDisplayMedia() a un bug connu et non corrigé chez Microsoft — il est
// rendu À L'INTÉRIEUR des limites du contrôle WebView2 plutôt qu'au niveau
// de la fenêtre Windows, ce qui le rend saccadé et rend certains onglets
// (dont « Écran entier ») inatteignables dans une petite fenêtre comme la
// nôtre (issues MicrosoftEdge/WebView2Feedback #2184, #5173, #1850).
// Décision du 27/09/2026 : on contourne complètement ce sélecteur cassé.
//
// Principe : côté Rust (ce fichier), la crate `windows-capture` capture en
// continu l'écran ou la fenêtre choisie — une session persistante pilotée
// par Windows.Graphics.Capture, jamais recréée à chaque image (contrairement
// à des crates orientées "screenshot ponctuel" comme xcap, qui provoquent
// sinon un clignotement du témoin de capture Windows et une charge CPU
// inutile à chaque image — voir nashaofu/xcap#287). Chaque image est réduite
// et encodée en JPEG, puis envoyée côté React via un Channel Tauri en RAW
// (pas de JSON/base64, voir InvokeResponseBody::Raw — bien plus efficace
// pour un flux d'images qu'un événement classique). React dessine chaque
// image reçue sur un <canvas> caché, puis canvas.captureStream() donne un
// vrai MediaStream vidéo qu'on branche dans WebRTC exactement comme l'aurait
// fait getDisplayMedia (voir salonCall.ts).
//
// Compromis pris pour rester raisonnablement sûr à écrire sans pouvoir
// compiler ici : pas de vignettes dans le sélecteur (juste les noms), et
// Windows uniquement (comme le reste de l'app).

use image::{imageops::FilterType, DynamicImage};
use serde::Serialize;
use std::io::Cursor;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

const TARGET_FPS: u64 = 10;
const FRAME_INTERVAL: Duration = Duration::from_millis(1000 / TARGET_FPS);
const MAX_WIDTH: u32 = 1280; // au-delà, on réduit avant d'encoder (CPU + IPC)
const JPEG_QUALITY: u8 = 65;

// Un compteur de génération plutôt qu'un simple booléen : démarrer un
// nouveau partage invalide automatiquement toute session de capture encore
// active (elle se voit dépassée et s'arrête toute seule à la prochaine
// image, voir on_frame_arrived), sans avoir besoin de garder un handle de
// thread à rejoindre.
static CAPTURE_EPOCH: AtomicU64 = AtomicU64::new(0);

// windows-capture n'expose pas d'identifiant stable pour un écran/une
// fenêtre : on mémorise la liste obtenue au dernier list_capture_sources()
// pour pouvoir démarrer la capture par simple index juste après, sans avoir
// à ré-identifier quoi que ce soit.
static STORED_MONITORS: Mutex<Option<Vec<Monitor>>> = Mutex::new(None);
static STORED_WINDOWS: Mutex<Option<Vec<Window>>> = Mutex::new(None);

#[derive(Serialize, Clone)]
pub struct CaptureSourceInfo {
    kind: String, // "monitor" | "window"
    index: usize,
    name: String,
}

/// Liste les écrans et fenêtres qu'on peut partager, pour notre propre
/// sélecteur (voir l'en-tête du fichier). À appeler juste avant d'afficher
/// le sélecteur : la liste mémorisée ici sert ensuite à start_screen_capture.
#[tauri::command]
pub fn list_capture_sources() -> Result<Vec<CaptureSourceInfo>, String> {
    let monitors = Monitor::enumerate().map_err(|e| e.to_string())?;
    let mut out: Vec<CaptureSourceInfo> = monitors
        .iter()
        .enumerate()
        .map(|(i, m)| CaptureSourceInfo {
            kind: "monitor".to_string(),
            index: i,
            name: m.name().unwrap_or_else(|_| format!("Écran {}", i + 1)),
        })
        .collect();

    let all_windows = Window::enumerate().map_err(|e| e.to_string())?;
    let mut kept_windows = Vec::new();
    for w in all_windows {
        if !w.is_valid() {
            continue;
        }
        let Ok(title) = w.title() else { continue };
        let title = title.trim().to_string();
        // Fenêtres sans titre (barres système...) ou la nôtre (transparente,
        // rien d'utile à partager) : pas proposées.
        if title.is_empty() || title == "Egg" {
            continue;
        }
        kept_windows.push((title, w));
    }
    for (i, (title, _)) in kept_windows.iter().enumerate() {
        out.push(CaptureSourceInfo {
            kind: "window".to_string(),
            index: i,
            name: title.clone(),
        });
    }

    *STORED_MONITORS.lock().map_err(|_| "État interne indisponible.".to_string())? = Some(monitors);
    *STORED_WINDOWS.lock().map_err(|_| "État interne indisponible.".to_string())? =
        Some(kept_windows.into_iter().map(|(_, w)| w).collect());

    Ok(out)
}

/// Réduit (si besoin) puis encode une image en JPEG, en mémoire.
fn encode_jpeg(img: &DynamicImage) -> Option<Vec<u8>> {
    let resized = if img.width() > MAX_WIDTH {
        img.resize(MAX_WIDTH, u32::MAX, FilterType::Triangle)
    } else {
        img.clone()
    };
    let mut bytes: Vec<u8> = Vec::new();
    let mut cursor = Cursor::new(&mut bytes);
    resized.write_to(&mut cursor, image::ImageFormat::Jpeg).ok()?;
    Some(bytes)
}

struct CaptureFlags {
    on_frame: Channel<InvokeResponseBody>,
    epoch: u64,
}

struct ScreenCaptureHandler {
    on_frame: Channel<InvokeResponseBody>,
    epoch: u64,
    last_sent: Instant,
}

impl GraphicsCaptureApiHandler for ScreenCaptureHandler {
    type Flags = CaptureFlags;
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            on_frame: ctx.flags.on_frame,
            epoch: ctx.flags.epoch,
            // - FRAME_INTERVAL : pour envoyer la toute première image tout de suite.
            last_sent: Instant::now() - FRAME_INTERVAL,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if CAPTURE_EPOCH.load(Ordering::SeqCst) != self.epoch {
            // Un nouveau partage a démarré, ou stop_screen_capture a été appelé.
            capture_control.stop();
            return Ok(());
        }

        let now = Instant::now();
        if now.duration_since(self.last_sent) < FRAME_INTERVAL {
            // Windows nous donne les images bien plus vite qu'il n'en faut
            // (le taux de rafraîchissement de l'écran, pas notre cible) —
            // on ignore celle-ci plutôt que de tout encoder/envoyer pour rien.
            return Ok(());
        }

        let width = frame.width();
        let height = frame.height();
        let mut buffer = frame.buffer().map_err(|e| e.to_string())?;
        let mut packed = Vec::new();
        let packed = buffer.as_nopadding_buffer(&mut packed).to_vec();

        let Some(rgba) = image::RgbaImage::from_raw(width, height, packed) else {
            return Ok(()); // taille incohérente : on saute cette image plutôt que de planter
        };

        if let Some(jpeg) = encode_jpeg(&DynamicImage::ImageRgba8(rgba)) {
            if self.on_frame.send(InvokeResponseBody::Raw(jpeg)).is_err() {
                // Le front a fermé le canal (partage arrêté côté React) : on
                // arrête la capture ici aussi, inutile de continuer.
                capture_control.stop();
                return Ok(());
            }
            self.last_sent = now;
        }

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

/// Démarre la capture en continu de l'écran ou la fenêtre choisie (voir
/// list_capture_sources) et envoie chaque image au front via `on_frame`
/// (JPEG brut, voir l'en-tête du fichier). Démarrer un nouvel appel arrête
/// automatiquement une capture précédente encore en cours.
#[tauri::command]
pub fn start_screen_capture(kind: String, index: usize, on_frame: Channel<InvokeResponseBody>) -> Result<(), String> {
    let epoch = CAPTURE_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    let flags = CaptureFlags { on_frame, epoch };

    match kind.as_str() {
        "monitor" => {
            let monitor = {
                let mut guard = STORED_MONITORS.lock().map_err(|_| "État interne indisponible.".to_string())?;
                let monitors = guard.take().ok_or_else(|| "Liste d'écrans expirée, réessaie.".to_string())?;
                monitors
                    .into_iter()
                    .nth(index)
                    .ok_or_else(|| "Écran introuvable.".to_string())?
            };
            let settings = Settings::new(
                monitor,
                CursorCaptureSettings::Default,
                DrawBorderSettings::Default,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Rgba8,
                flags,
            );
            thread::spawn(move || {
                // ScreenCaptureHandler::start bloque ce thread jusqu'à ce que
                // capture_control.stop() soit appelé (voir on_frame_arrived) —
                // jamais dans celui de Tauri.
                let _ = ScreenCaptureHandler::start(settings);
            });
        }
        "window" => {
            let window = {
                let mut guard = STORED_WINDOWS.lock().map_err(|_| "État interne indisponible.".to_string())?;
                let windows = guard.take().ok_or_else(|| "Liste de fenêtres expirée, réessaie.".to_string())?;
                windows
                    .into_iter()
                    .nth(index)
                    .ok_or_else(|| "Fenêtre introuvable.".to_string())?
            };
            let settings = Settings::new(
                window,
                CursorCaptureSettings::Default,
                DrawBorderSettings::Default,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Rgba8,
                flags,
            );
            thread::spawn(move || {
                let _ = ScreenCaptureHandler::start(settings);
            });
        }
        _ => return Err("Type de source invalide.".to_string()),
    }

    Ok(())
}

/// Arrête la capture en cours (aucun effet s'il n'y en a pas).
#[tauri::command]
pub fn stop_screen_capture() {
    CAPTURE_EPOCH.fetch_add(1, Ordering::SeqCst);
}
