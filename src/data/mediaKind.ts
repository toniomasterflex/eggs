// Photo / vidéo / son partagés en conversation (voir ui/screens/ConversationScreen.tsx :
// glisser-déposer ou coller, pas de sélecteur de fichiers) — reconnaissance
// du type de fichier, côté client seulement (le serveur revérifie de son côté).

export type AttachmentKind = "image" | "video" | "audio";

// Doit correspondre à maxUploadBytes dans server/src/config.ts.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
};

/** Déduit un type MIME à partir de l'extension d'un chemin de fichier (glisser-déposer :
 *  Tauri ne donne qu'un chemin, pas de File avec son .type déjà connu). */
export function mimeFromPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  return (ext && EXT_MIME[ext]) || null;
}

export function kindFromMime(mime: string): AttachmentKind | null {
  const main = mime.split("/")[0];
  return main === "image" || main === "video" || main === "audio" ? (main as AttachmentKind) : null;
}

export function labelForKind(kind: AttachmentKind): string {
  if (kind === "image") return "Photo";
  if (kind === "video") return "Vidéo";
  return "Son";
}
