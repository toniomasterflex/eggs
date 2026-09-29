// Appel de salon : voix + partage d'écran, en mesh direct pair-à-pair
// (WebRTC). Décisions du 27/09/2026 : pas de serveur de mixage (chaque
// participant se connecte directement à chaque autre, plafonné à
// MAX_CALL_SIZE côté serveur — voir server/src/calls.ts), et STUN public
// gratuit uniquement (pas de TURN) — ça suffit pour la grande majorité des
// réseaux, au prix d'un risque d'échec sur les plus restrictifs (accepté).
//
// Le serveur ne fait QUE relayer la signalisation (qui est dans l'appel, et
// les messages WebRTC bruts entre deux personnes précises) : la voix et
// l'image de l'écran partagé ne passent jamais par lui, uniquement en direct
// d'un appareil à l'autre — voir server/src/index.ts (call-join / call-leave
// / call-signal / call-media) et calls.ts.
//
// Négociation : chaque paire de participants utilise le patron « perfect
// negotiation » (voir MDN) plutôt qu'une logique fragile de qui-doit-appeler-
// qui : les deux côtés créent leur connexion et ajoutent leurs pistes locales
// dès qu'ils apprennent l'existence de l'autre (via call-presence), ce qui
// déclenche une offre automatiquement (onnegotiationneeded) ; en cas de
// collision (les deux envoient une offre en même temps, ou l'un ajoute son
// partage d'écran pendant que l'autre renégocie), celui dont l'identifiant
// est "poli" (le plus grand des deux, par comparaison de chaîne) laisse
// tomber sa propre offre et accepte celle de l'autre. Déterministe des deux
// côtés sans avoir besoin de se coordonner au préalable.
//
// Micro : simple appel à getUserMedia, comme dans n'importe quelle app web.
// Sur Windows, WebView2 affiche lui-même l'invite système (comme Edge) —
// rien à configurer côté Rust/Tauri pour ça (vérifié dans la doc Tauri/
// WebView2 avant d'écrire ce module).
//
// Partage d'écran : PAS getDisplayMedia. Son sélecteur natif WebView2 est
// cassé et non corrigé chez Microsoft dans une petite fenêtre transparente
// comme la nôtre (rendu à l'intérieur des limites du contrôle WebView2 —
// voir issues MicrosoftEdge/WebView2Feedback #2184, #5173, #1850 : sélecteur
// saccadé, "Écran entier" parfois inatteignable). Décision du 27/09/2026 :
// notre propre sélecteur (voir src-tauri/src/capture.rs), qui capture en
// continu côté Rust (crate windows-capture, session persistante — pas de
// clignotement du témoin de capture Windows contrairement à une capture
// "ponctuelle" répétée) et nous envoie chaque image en JPEG via un Channel
// Tauri. On la dessine sur un <canvas> caché puis canvas.captureStream()
// donne un vrai MediaStream vidéo, branché dans WebRTC exactement comme
// l'aurait fait getDisplayMedia.

import { invoke, Channel } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import type { ApiUser } from "./api";
import { realtime } from "./realtime";
import type { ServerEvent } from "./realtime";
import { getSession } from "./session";

/** Un écran ou une fenêtre proposé par notre sélecteur (voir capture.rs :
 *  list_capture_sources). `index` n'a de sens que jusqu'au prochain appel à
 *  list_capture_sources côté Rust — à utiliser tout de suite, pas à garder. */
export interface CaptureSourceInfo {
  kind: "monitor" | "window";
  index: number;
  name: string;
}

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export interface SalonCallState {
  salonId: string | null; // salon dont l'appel est actif, null si je ne suis dans aucun appel
  participants: ApiUser[]; // qui est dans l'appel, moi inclus (vient du serveur)
  micOn: boolean;
  screenSharing: boolean;
  mutedPeerIds: string[]; // qui a coupé son micro, d'après call-media
  screenSharingPeerIds: string[]; // qui partage son écran, d'après call-media
  remoteScreens: Record<string, MediaStream>; // flux vidéo de partage d'écran reçus, par personne
  screenSharePicker: CaptureSourceInfo[] | null; // notre sélecteur ouvert, avec sa liste (voir openScreenSharePicker)
  error: string; // message transitoire (micro refusé, appel complet...)
}

let state: SalonCallState = {
  salonId: null,
  participants: [],
  micOn: false,
  screenSharing: false,
  mutedPeerIds: [],
  screenSharingPeerIds: [],
  remoteScreens: {},
  screenSharePicker: null,
  error: "",
};

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function setState(patch: Partial<SalonCallState>) {
  state = { ...state, ...patch };
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hook React : renvoie l'état de l'appel en cours et se met à jour tout seul. */
export function useSalonCallStore(): SalonCallState {
  return useSyncExternalStore(subscribe, () => state);
}

// ------------------------------------------------------ État interne (WebRTC)
//
// Rien ici n'a besoin de faire re-rendre l'UI directement : les connexions et
// flux locaux sont un détail d'implémentation, seul ce qui est reflété dans
// `state` ci-dessus (participants, remoteScreens...) intéresse React.

let localMicStream: MediaStream | null = null;
let localScreenStream: MediaStream | null = null;
// Canvas caché où on dessine les images reçues de capture.rs (voir
// handleCaptureFrame) — jamais ajouté au DOM, captureStream() marche très
// bien sur un canvas détaché.
let screenCanvas: HTMLCanvasElement | null = null;
let screenCtx: CanvasRenderingContext2D | null = null;
const remoteAudioEls = new Map<string, HTMLAudioElement>(); // lecture du micro des autres (pas besoin d'être visible)
const peers = new Map<string, RTCPeerConnection>();
const makingOffer = new Map<string, boolean>();
const ignoringOffer = new Map<string, boolean>();

function myId(): string | null {
  return getSession()?.user.id ?? null;
}

/** Qui est « poli » dans cette paire (celui qui laisse tomber sa propre offre
 *  en cas de collision) — déterministe des deux côtés, sans coordination. */
function isPolite(peerId: string): boolean {
  const id = myId();
  return !!id && id > peerId;
}

function attachRemoteAudio(peerId: string, stream: MediaStream) {
  let el = remoteAudioEls.get(peerId);
  if (!el) {
    el = new Audio();
    el.autoplay = true;
    remoteAudioEls.set(peerId, el);
  }
  el.srcObject = stream;
  el.play().catch(() => {
    // lecture auto refusée par le navigateur : pas grave, elle reprendra
    // dès le prochain flux ou une interaction de l'utilisateur.
  });
}

function detachRemoteAudio(peerId: string) {
  const el = remoteAudioEls.get(peerId);
  if (!el) return;
  el.pause();
  el.srcObject = null;
  remoteAudioEls.delete(peerId);
}

function removeRemoteScreen(peerId: string) {
  if (!(peerId in state.remoteScreens)) return;
  const next = { ...state.remoteScreens };
  delete next[peerId];
  setState({ remoteScreens: next });
}

function closePeer(peerId: string) {
  const pc = peers.get(peerId);
  if (pc) {
    pc.onicecandidate = null;
    pc.onnegotiationneeded = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.close();
    peers.delete(peerId);
  }
  makingOffer.delete(peerId);
  ignoringOffer.delete(peerId);
  detachRemoteAudio(peerId);
  removeRemoteScreen(peerId);
}

function closeAllPeers() {
  for (const peerId of [...peers.keys()]) closePeer(peerId);
}

function currentSalonId(): string | null {
  return state.salonId;
}

/** Crée (si besoin) la connexion pair-à-pair vers quelqu'un, avec les pistes
 *  locales déjà actives (micro, écran) — leur ajout déclenche automatiquement
 *  une offre via onnegotiationneeded, des deux côtés à la fois si besoin
 *  (voir l'en-tête du fichier : patron "perfect negotiation"). */
function ensurePeer(peerId: string): RTCPeerConnection {
  const existing = peers.get(peerId);
  if (existing) return existing;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peers.set(peerId, pc);
  makingOffer.set(peerId, false);
  ignoringOffer.set(peerId, false);

  pc.onicecandidate = ({ candidate }) => {
    const salonId = currentSalonId();
    if (candidate && salonId) realtime.sendCallSignal(salonId, peerId, { candidate: candidate.toJSON() });
  };

  pc.onnegotiationneeded = async () => {
    const salonId = currentSalonId();
    if (!salonId) return;
    try {
      makingOffer.set(peerId, true);
      await pc.setLocalDescription();
      realtime.sendCallSignal(salonId, peerId, { description: pc.localDescription });
    } catch {
      // pas grave, une prochaine renégociation retentera
    } finally {
      makingOffer.set(peerId, false);
    }
  };

  pc.ontrack = ({ track, streams }) => {
    const stream = streams[0] ?? new MediaStream([track]);
    if (track.kind === "audio") {
      attachRemoteAudio(peerId, stream);
    } else if (track.kind === "video") {
      setState({ remoteScreens: { ...state.remoteScreens, [peerId]: stream } });
      track.addEventListener("ended", () => removeRemoteScreen(peerId));
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") closePeer(peerId);
  };

  if (localMicStream) for (const track of localMicStream.getTracks()) pc.addTrack(track, localMicStream);
  if (localScreenStream) for (const track of localScreenStream.getTracks()) pc.addTrack(track, localScreenStream);

  return pc;
}

/** Signalisation WebRTC reçue d'une personne du même appel — patron « perfect
 *  negotiation » : voir l'en-tête du fichier. */
async function handleSignal(
  fromPeerId: string,
  data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit },
) {
  const pc = ensurePeer(fromPeerId);
  try {
    if (data.description) {
      const isOffer = data.description.type === "offer";
      const collision = isOffer && (makingOffer.get(fromPeerId) === true || pc.signalingState !== "stable");
      const shouldIgnore = collision && !isPolite(fromPeerId);
      ignoringOffer.set(fromPeerId, shouldIgnore);
      if (shouldIgnore) return;

      if (collision) {
        await Promise.all([pc.setLocalDescription({ type: "rollback" }), pc.setRemoteDescription(data.description)]);
      } else {
        await pc.setRemoteDescription(data.description);
      }

      if (isOffer) {
        await pc.setLocalDescription();
        const salonId = currentSalonId();
        if (salonId) realtime.sendCallSignal(salonId, fromPeerId, { description: pc.localDescription });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!ignoringOffer.get(fromPeerId)) throw err;
      }
    }
  } catch {
    // signalisation ratée pour cette personne : pas grave pour le reste de l'appel
  }
}

function stopLocalMic() {
  if (!localMicStream) return;
  for (const track of localMicStream.getTracks()) track.stop();
  localMicStream = null;
  for (const pc of peers.values()) {
    for (const sender of pc.getSenders()) if (sender.track?.kind === "audio") pc.removeTrack(sender);
  }
}

function stopLocalScreen() {
  if (!localScreenStream) return;
  // Prévient capture.rs d'arrêter la session de capture (aucun effet si elle
  // est déjà terminée). Pas d'attente : autant laisser React continuer,
  // arrêter le flux local ci-dessous suffit à couper la vidéo envoyée.
  invoke("stop_screen_capture").catch(() => {});
  for (const track of localScreenStream.getTracks()) track.stop();
  localScreenStream = null;
  screenCanvas = null;
  screenCtx = null;
  for (const pc of peers.values()) {
    for (const sender of pc.getSenders()) if (sender.track?.kind === "video") pc.removeTrack(sender);
  }
}

/** Une image reçue de capture.rs (JPEG brut, voir le Channel dans
 *  startScreenShareFrom) : on la décode et on la dessine sur le canvas caché
 *  dont canvas.captureStream() alimente WebRTC. */
async function handleCaptureFrame(data: ArrayBuffer) {
  if (!screenCtx || !screenCanvas) return;
  try {
    const blob = new Blob([data], { type: "image/jpeg" });
    const bitmap = await createImageBitmap(blob);
    if (screenCanvas.width !== bitmap.width || screenCanvas.height !== bitmap.height) {
      screenCanvas.width = bitmap.width;
      screenCanvas.height = bitmap.height;
    }
    screenCtx.drawImage(bitmap, 0, 0);
    bitmap.close();
  } catch {
    // une image corrompue de temps en temps n'est pas grave, on l'ignore
  }
}

// ---------------------------------------------------------------- API publique

/** Rejoint l'appel du salon donné (faut déjà y être présent, par écrit). Le
 *  micro est demandé tout de suite : si refusé, on entre quand même dans
 *  l'appel, juste sans voix (on peut toujours écouter les autres). */
export async function joinCurrentCall(salonId: string) {
  if (state.salonId === salonId) return; // déjà dans cet appel
  if (state.salonId) leaveCurrentCall(); // un seul appel à la fois

  setState({
    salonId,
    participants: [],
    micOn: false,
    screenSharing: false,
    mutedPeerIds: [],
    screenSharingPeerIds: [],
    remoteScreens: {},
    screenSharePicker: null,
    error: "",
  });

  try {
    localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setState({ micOn: true });
  } catch {
    localMicStream = null;
    setState({ micOn: false, error: "Micro indisponible ou refusé — tu peux quand même écouter." });
  }

  realtime.joinCall(salonId);
}

/** Quitte l'appel en cours (aucun effet si on n'est dans aucun appel). Coupe
 *  aussi le micro et l'écran localement, comme raccrocher un vrai appel. */
export function leaveCurrentCall() {
  const salonId = state.salonId;
  closeAllPeers();
  stopLocalMic();
  stopLocalScreen();
  for (const el of remoteAudioEls.values()) {
    el.pause();
    el.srcObject = null;
  }
  remoteAudioEls.clear();
  if (salonId) realtime.leaveCall(salonId);
  setState({
    salonId: null,
    participants: [],
    micOn: false,
    screenSharing: false,
    mutedPeerIds: [],
    screenSharingPeerIds: [],
    remoteScreens: {},
    screenSharePicker: null,
    error: "",
  });
}

/** Coupe / réactive mon micro. Retire vraiment la piste (pas juste .enabled =
 *  false) pour que le témoin micro du système s'éteigne aussi, comme les
 *  autres apps de visio. */
export async function toggleCallMic() {
  const salonId = state.salonId;
  if (!salonId) return;
  if (localMicStream) {
    stopLocalMic();
    setState({ micOn: false });
  } else {
    try {
      localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const pc of peers.values()) {
        for (const track of localMicStream.getTracks()) pc.addTrack(track, localMicStream);
      }
      setState({ micOn: true, error: "" });
    } catch {
      setState({ error: "Micro indisponible ou refusé." });
      return;
    }
  }
  realtime.sendCallMedia(salonId, state.micOn, state.screenSharing);
}

/** Ouvre notre sélecteur d'écran/fenêtre (liste ramenée par capture.rs côté
 *  Rust — voir l'en-tête du fichier pour pourquoi ce n'est pas
 *  getDisplayMedia). Rien ne démarre encore : voir startScreenShareFrom. */
export async function openScreenSharePicker() {
  if (!state.salonId || state.screenSharing) return;
  try {
    const sources = await invoke<CaptureSourceInfo[]>("list_capture_sources");
    setState({ screenSharePicker: sources, error: "" });
  } catch {
    setState({ error: "Impossible de lister les écrans et fenêtres à partager." });
  }
}

/** Referme le sélecteur sans rien partager. */
export function closeScreenSharePicker() {
  setState({ screenSharePicker: null });
}

/** Démarre le partage de l'écran ou de la fenêtre choisi dans le sélecteur. */
export async function startScreenShareFrom(source: CaptureSourceInfo) {
  const salonId = state.salonId;
  if (!salonId) return;
  setState({ screenSharePicker: null });

  try {
    const canvas = document.createElement("canvas");
    // Taille de départ arbitraire (16:9) : la toute première image reçue la
    // corrige aussitôt, voir handleCaptureFrame — jamais montrée telle quelle.
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2D indisponible");
    screenCanvas = canvas;
    screenCtx = ctx;

    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (data) => {
      handleCaptureFrame(data);
    };

    await invoke("start_screen_capture", { kind: source.kind, index: source.index, onFrame: channel });

    const stream = canvas.captureStream(10);
    localScreenStream = stream;
    for (const pc of peers.values()) {
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
    }
    setState({ screenSharing: true, error: "" });
  } catch {
    screenCanvas = null;
    screenCtx = null;
    setState({ error: "Partage d'écran impossible." });
    return;
  }
  realtime.sendCallMedia(salonId, state.micOn, true);
}

/** Arrête le partage d'écran en cours (aucun effet si on ne partage rien). */
export function stopScreenShare() {
  const salonId = state.salonId;
  if (!localScreenStream) return;
  stopLocalScreen();
  setState({ screenSharing: false });
  if (salonId) realtime.sendCallMedia(salonId, state.micOn, false);
}

// ------------------------------------------------------------------ Temps réel

function onCallPresence(salonId: string, present: ApiUser[]) {
  if (state.salonId !== salonId) return; // pas mon appel en cours
  setState({ participants: present });
  const id = myId();
  const presentIds = new Set(present.map((u) => u.id));
  for (const u of present) if (u.id !== id && !peers.has(u.id)) ensurePeer(u.id);
  for (const peerId of [...peers.keys()]) if (!presentIds.has(peerId)) closePeer(peerId);
}

function onServerEvent(event: ServerEvent) {
  switch (event.type) {
    case "call-presence":
      onCallPresence(String(event.salonId), ((event.present as ApiUser[] | undefined) ?? []) as ApiUser[]);
      break;
    case "call-signal": {
      if (state.salonId !== String(event.salonId)) break;
      const from = String(event.from);
      handleSignal(from, event.data as { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit });
      break;
    }
    case "call-media": {
      if (state.salonId !== String(event.salonId)) break;
      const from = String(event.from);
      const micOn = !!event.micOn;
      const screenSharing = !!event.screenSharing;
      setState({
        mutedPeerIds: micOn ? state.mutedPeerIds.filter((id) => id !== from) : [...new Set([...state.mutedPeerIds, from])],
        screenSharingPeerIds: screenSharing
          ? [...new Set([...state.screenSharingPeerIds, from])]
          : state.screenSharingPeerIds.filter((id) => id !== from),
      });
      break;
    }
    case "call-full":
      if (state.salonId === String(event.salonId)) {
        closeAllPeers();
        stopLocalMic();
        stopLocalScreen();
        setState({
          salonId: null,
          participants: [],
          micOn: false,
          screenSharing: false,
          screenSharePicker: null,
          error: "Cet appel est déjà complet.",
        });
      }
      break;
    case "hello":
      // (Re)connexion : la présence côté serveur est repartie de zéro, il
      // faut rejoindre l'appel à nouveau si on y était.
      if (state.salonId) {
        const salonId = state.salonId;
        closeAllPeers();
        setState({ participants: [] });
        realtime.joinCall(salonId);
      }
      break;
    case "salon-blocked":
      // Banni du salon : forcément aussi sorti de son appel, voir
      // server/src/index.ts. On s'aligne localement tout de suite plutôt que
      // d'attendre une éventuelle relance de call-presence.
      if (state.salonId === String(event.salonId)) leaveCurrentCall();
      break;
  }
}

realtime.onEvent(onServerEvent);
