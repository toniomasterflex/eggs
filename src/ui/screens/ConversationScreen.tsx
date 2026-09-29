import { Fragment, useEffect, useRef, useState } from "react";
import { readFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import Creature from "../Creature";
import GroupAvatar from "../GroupAvatar";
import {
  closeChat,
  deleteGroupForEveryone,
  leaveGroup,
  removeMessageReaction,
  sendAttachment,
  sendGroupAttachment,
  sendGroupMessage,
  sendMessage,
  setMessageReaction,
  useChatStore,
} from "../../data/store";
import { useSession } from "../../data/session";
import type { Friend, Group, Message, MessageAttachment } from "../../data/types";
import { presenceLabel, presenceStatus } from "../format";
import { MAX_ATTACHMENT_BYTES, kindFromMime, mimeFromPath } from "../../data/mediaKind";
import { SendIcon } from "../icons";

// Soit une discussion à deux, soit un groupe (voir data/types.ts : Group) —
// même écran pour les deux, seuls l'en-tête, l'envoi et le nom au-dessus des
// messages des autres changent (voir plus bas).
export type ConversationTarget = { kind: "friend"; friend: Friend } | { kind: "group"; group: Group };

// Les 6 réactions façon iMessage/WhatsApp — mêmes que celles de WhatsApp,
// pour rester dans un terrain connu (voir la demande d'origine : aussi
// facile à prendre en main que WhatsApp/WeChat).
const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// Sous quelle forme afficher l'heure d'un message.
function clockOf(ts: number) {
  return new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
function dividerOf(ts: number) {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) return clockOf(ts);
  return `${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })} ${clockOf(ts)}`;
}
// Un nouveau repère de date/heure au-dessus du premier message, puis dès
// qu'il s'écoule plus de 30 minutes entre deux messages.
const DIVIDER_GAP_MS = 30 * 60 * 1000;

const MAX_ATTACHMENT_MB = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));

// En dessous de cette durée, on considère que c'est un clic accidentel sur
// le micro plutôt qu'un vrai message vocal : on l'ignore sans l'envoyer.
const MIN_RECORD_MS = 500;

// Le format exact que MediaRecorder produit dépend du navigateur (ici la
// WebView de Windows, basée sur Chromium) : on demande de l'opus dans un
// conteneur webm/ogg si possible (bonne compression), et on retombe sur le
// choix par défaut du navigateur sinon.
function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
  return candidates.find((c) => MediaRecorder.isTypeSupported?.(c));
}

// Extension de fichier à partir du type MIME choisi par MediaRecorder (qui
// inclut souvent des paramètres, ex. "audio/webm;codecs=opus" -> "webm").
function extForMime(mime: string): string {
  const sub = mime.split(";")[0]?.split("/")[1] ?? "webm";
  return sub.replace(/[^a-z0-9]/gi, "") || "webm";
}

function formatRecordTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Une conversation privée n'a que 2 participants : au plus 2 pastilles par
// emoji (moi + l'ami). `mine` sert à mettre la pastille en avant, et à savoir
// si un clic dessus doit retirer ma réaction plutôt qu'en reposer une.
function groupReactions(message: Message, myId: string | undefined) {
  const order: string[] = [];
  const byEmoji = new Map<string, { count: number; mine: boolean }>();
  for (const r of message.reactions) {
    if (!byEmoji.has(r.emoji)) {
      byEmoji.set(r.emoji, { count: 0, mine: false });
      order.push(r.emoji);
    }
    const entry = byEmoji.get(r.emoji)!;
    entry.count += 1;
    if (r.userId === myId) entry.mine = true;
  }
  return order.map((emoji) => ({ emoji, ...byEmoji.get(emoji)! }));
}

// Photo, vidéo ou son : pas de lecteur en grand dans l'appli pour l'instant,
// un clic sur une photo l'ouvre juste dans la visionneuse par défaut de
// Windows (vidéo/son ont déjà leurs propres contrôles de lecture inline).
function AttachmentContent({ attachment }: { attachment: MessageAttachment }) {
  if (attachment.kind === "image") {
    return (
      <img
        className="msg-media"
        src={attachment.url}
        alt={attachment.name}
        onClick={() => void openUrl(attachment.url).catch(() => {})}
      />
    );
  }
  if (attachment.kind === "video") {
    return <video className="msg-media" src={attachment.url} controls />;
  }
  return <audio className="msg-media msg-media-audio" src={attachment.url} controls />;
}

export default function ConversationScreen({ target }: { target: ConversationTarget }) {
  const isGroup = target.kind === "group";
  const id = isGroup ? target.group.id : target.friend.id;
  const name = isGroup ? target.group.name : target.friend.name;
  const { messages } = useChatStore();
  const list = messages[id] ?? [];
  const myId = useSession()?.user.id;
  const [text, setText] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [recording, setRecording] = useState(false);
  const [recordMs, setRecordMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordTimerRef = useRef<number | undefined>(undefined);
  const recordStartRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Toujours la dernière version, pour ne pas avoir à relancer les effets
  // ci-dessous (glisser-déposer / coller) à chaque frappe.
  const idRef = useRef(id);
  idRef.current = id;

  // Nom à afficher au-dessus d'un message reçu dans un groupe (plusieurs
  // expéditeurs possibles, contrairement à une discussion à deux — voir
  // ConversationTarget). Pas de "vu" en groupe : un seul read_at ne suffit
  // plus dès qu'il y a plus de 2 personnes (voir server/db.ts : group_reads).
  const senderName = (fromId: string): string | undefined =>
    isGroup ? target.group.members.find((m) => m.id === fromId)?.name : undefined;

  // Mon dernier message a-t-il été lu ? (discussion à deux seulement)
  let lastMine: (typeof list)[number] | undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].mine) {
      lastMine = list[i];
      break;
    }
  }
  const friendReadAt = !isGroup ? target.friend.readAt : undefined;
  const seen = !isGroup && !!lastMine && friendReadAt !== undefined && lastMine.time <= friendReadAt;

  // Quitter (n'importe quel membre) ou supprimer (créateur seulement, voir
  // store.ts : leaveGroup / deleteGroupForEveryone) — même confirmation en
  // deux clics que pour retirer un ami (voir ui/screens/DirectoryScreen.tsx).
  const isOwner = isGroup && myId !== undefined && myId === target.group.createdBy;
  const [confirmLeave, setConfirmLeave] = useState(false);
  const confirmTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(confirmTimerRef.current), []);
  const handleLeaveOrDelete = () => {
    if (!confirmLeave) {
      setConfirmLeave(true);
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = window.setTimeout(() => setConfirmLeave(false), 3000);
      return;
    }
    window.clearTimeout(confirmTimerRef.current);
    setConfirmLeave(false);
    const action = isOwner ? deleteGroupForEveryone(id) : leaveGroup(id);
    action.then((err) => {
      if (err) setAttachError(err);
    });
  };

  // Descend automatiquement sur le dernier message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [list.length]);

  // Le message d'erreur d'envoi (fichier trop gros, type pas supporté…) se
  // referme tout seul, comme le reste des avis discrets de l'appli.
  useEffect(() => {
    if (!attachError) return;
    const timer = window.setTimeout(() => setAttachError(null), 4000);
    return () => window.clearTimeout(timer);
  }, [attachError]);

  // Envoi d'une photo / vidéo / son : même chemin pour le glisser-déposer et
  // le collé ci-dessous. Contrôle de taille/type ici (le serveur revérifie
  // de toute façon, mais autant prévenir tout de suite sans attendre l'aller-
  // retour réseau).
  const uploadBlob = (blob: Blob, filename: string) => {
    if (blob.size > MAX_ATTACHMENT_BYTES) {
      setAttachError(`Fichier trop volumineux (${MAX_ATTACHMENT_MB} Mo max).`);
      return;
    }
    if (!kindFromMime(blob.type)) {
      setAttachError("Photo, vidéo ou son seulement.");
      return;
    }
    setAttachError(null);
    const send = isGroup ? sendGroupAttachment : sendAttachment;
    send(idRef.current, blob, filename).then((err) => {
      if (err) setAttachError(err);
    });
  };

  // Message vocal : un bouton micro (au lieu d'envoyer, quand le champ texte
  // est vide) plutôt que de glisser/coller un fichier. On enregistre avec
  // l'API standard MediaRecorder (aucun plugin Tauri nécessaire) ; la
  // première fois, Windows affiche sa propre popup d'autorisation du micro.
  const startRecording = async () => {
    setAttachError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setAttachError("Micro indisponible ou accès refusé.");
      return;
    }
    streamRef.current = stream;
    const mime = pickRecorderMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const elapsed = Date.now() - recordStartRef.current;
      const chunks = chunksRef.current;
      chunksRef.current = [];
      recorderRef.current = null;
      if (elapsed < MIN_RECORD_MS || chunks.length === 0) return;
      const type = recorder.mimeType || mime || "audio/webm";
      const blob = new Blob(chunks, { type });
      uploadBlob(blob, `Message vocal.${extForMime(type)}`);
    };
    recorderRef.current = recorder;
    recordStartRef.current = Date.now();
    setRecordMs(0);
    setRecording(true);
    recorder.start();
    recordTimerRef.current = window.setInterval(() => setRecordMs(Date.now() - recordStartRef.current), 200);
  };

  // send = false : on jette l'enregistrement (bouton Annuler), la fonction
  // onstop ci-dessus ne fera alors que couper le micro, pas d'envoi.
  const stopRecording = (send: boolean) => {
    window.clearInterval(recordTimerRef.current);
    setRecording(false);
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (!send) {
      // On vide les morceaux déjà reçus AVANT d'arrêter, pour que onstop
      // (elapsed >= MIN_RECORD_MS malgré tout) ne trouve rien à envoyer.
      chunksRef.current = [];
      recordStartRef.current = Date.now(); // force elapsed ~0 -> onstop n'envoie rien
    }
    recorder.stop();
  };

  // La fenêtre se ferme / on change de conversation en plein enregistrement :
  // on coupe le micro plutôt que de le laisser ouvert en arrière-plan.
  useEffect(() => {
    return () => {
      window.clearInterval(recordTimerRef.current);
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Glisser-déposer un fichier depuis l'Explorateur : pas de <input type="file">
  // ni de bouton pour l'ouvrir, exprès (voir la demande d'origine). Tauri ne
  // donne qu'un CHEMIN (pas un vrai File comme sur le web) : il faut lire les
  // octets nous-mêmes (voir @tauri-apps/plugin-fs, et capabilities/default.json
  // pour la permission de lecture — un chemin déposé peut venir de n'importe
  // où sur le disque).
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          setDragOver(false);
          for (const path of event.payload.paths) {
            const mime = mimeFromPath(path);
            if (!mime) {
              setAttachError("Photo, vidéo ou son seulement.");
              continue;
            }
            readFile(path)
              .then((bytes) => {
                const name = path.split(/[\\/]/).pop() || "fichier";
                uploadBlob(new Blob([bytes], { type: mime }), name);
              })
              .catch(() => setAttachError("Impossible de lire ce fichier."));
          }
        } else {
          setDragOver(event.payload.type === "over");
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Coller une image (capture d'écran, image copiée depuis un navigateur…) :
  // l'API presse-papiers standard donne directement un vrai Blob, pas besoin
  // du plugin fs ici. Un fichier copié depuis l'Explorateur (vidéo, son) ne
  // passe en général pas par cette voie côté Windows — le glisser-déposer
  // ci-dessus reste le chemin fiable pour ceux-là.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (!file) continue;
        e.preventDefault();
        uploadBlob(file, file.name || "collé");
      }
    }
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // La rangée d'emojis se ferme si on clique ailleurs (voir pickerRef, posé
  // sur le message actuellement ouvert dans le JSX plus bas).
  useEffect(() => {
    if (!reactionPickerFor) return;
    const onDocClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setReactionPickerFor(null);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [reactionPickerFor]);

  // Réagir à un message : reposer la même réaction qu'on avait déjà dessus la
  // retire (tapback classique), sinon elle remplace l'éventuelle précédente
  // (une seule réaction par personne et par message, voir server/service.ts).
  const toggleReaction = (message: Message, emoji: string) => {
    setReactionPickerFor(null);
    const mine = message.reactions.find((r) => r.userId === myId);
    const action =
      mine?.emoji === emoji ? removeMessageReaction(message.id) : setMessageReaction(message.id, emoji);
    action.then((err) => {
      if (err) setAttachError(err);
    });
  };

  const send = () => {
    const sent = text;
    if (!sent.trim()) return;
    setText("");
    // Si l'envoi échoue, on remet le texte pour ne rien perdre.
    const doSend = isGroup ? sendGroupMessage : sendMessage;
    doSend(id, sent).then((ok) => {
      if (!ok) setText((current) => current || sent);
    });
  };

  return (
    <section className={`conversation ${dragOver ? "drag-over" : ""}`}>
      <header className="conv-header">
        <button className="back" onClick={closeChat} aria-label="Retour">
          &lsaquo;
        </button>
        {isGroup ? (
          <GroupAvatar members={target.group.members} size={20} />
        ) : (
          <Creature species={target.friend.species} color={target.friend.color} size={20} />
        )}
        <span className="conv-name">
          {name}
          {!isGroup &&
            (() => {
              const status = presenceStatus(target.friend.online, target.friend.away);
              return <span className={`presence-dot ${status}`} title={presenceLabel(status)} />;
            })()}
        </span>
      </header>

      <div className="messages" ref={scrollRef}>
        {list.map((m, i) => {
          const prev = list[i - 1];
          const showDivider = !prev || m.time - prev.time > DIVIDER_GAP_MS;
          const pickerOpen = reactionPickerFor === m.id;
          const pills = groupReactions(m, myId);
          // Dans un groupe, le nom de l'expéditeur au-dessus de son premier
          // message d'une série (pas répété à chaque message d'affilée, comme
          // dans WhatsApp) — jamais pour les miens, ni en discussion à deux.
          const showSender = isGroup && !m.mine && (showDivider || !prev || prev.from !== m.from);
          return (
            <Fragment key={m.id}>
              {showDivider && <div className="time-divider">{dividerOf(m.time)}</div>}
              <div className={`msg-row ${m.mine ? "mine" : "theirs"} ${pills.length > 0 ? "has-reactions" : ""}`}>
                {showSender && <div className="sender-name">{senderName(m.from) ?? ""}</div>}
                <div
                  className={`bubble-wrap ${pickerOpen ? "picker-open" : ""}`}
                  ref={pickerOpen ? pickerRef : undefined}
                >
                  <div className={`bubble ${m.mine ? "mine" : "theirs"} ${m.attachment ? "bubble-media" : ""}`}>
                    {m.attachment ? <AttachmentContent attachment={m.attachment} /> : m.text}
                  </div>
                  <button
                    type="button"
                    className="react-trigger"
                    aria-label="Réagir"
                    onClick={() => setReactionPickerFor(pickerOpen ? null : m.id)}
                  >
                    ☺
                  </button>
                  {pickerOpen && (
                    <div className="reaction-picker">
                      {REACTION_EMOJIS.map((emoji) => (
                        <button key={emoji} type="button" onClick={() => toggleReaction(m, emoji)}>
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* Badge qui chevauche le coin de la bulle, façon WhatsApp/iMessage
                      (voir bubble-wrap : position: relative) — pas une rangée à part
                      en dessous. */}
                  {pills.length > 0 && (
                    <div className="reaction-pills">
                      {pills.map(({ emoji, count, mine }) => (
                        <button
                          key={emoji}
                          type="button"
                          className={`reaction-pill ${mine ? "mine" : ""}`}
                          onClick={() => toggleReaction(m, emoji)}
                        >
                          {emoji}
                          {count > 1 ? ` ${count}` : ""}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </Fragment>
          );
        })}
        {seen && <div className="seen-mark">Vu</div>}
      </div>

      {dragOver && <div className="drop-hint">Dépose ici pour envoyer</div>}
      {attachError && <div className="attach-error">{attachError}</div>}

      {recording ? (
        <div className="composer recording-bar">
          <button
            type="button"
            className="record-cancel"
            aria-label="Annuler l'enregistrement"
            onClick={() => stopRecording(false)}
          >
            ✕
          </button>
          <span className="record-dot" />
          <span className="record-time">{formatRecordTime(recordMs)}</span>
          <button
            type="button"
            className="record-send"
            aria-label="Envoyer le message vocal"
            onClick={() => stopRecording(true)}
          >
            <SendIcon />
          </button>
        </div>
      ) : (
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Écrire, glisser ou coller une photo…"
          />
          {text.trim() ? (
            <button type="submit" aria-label="Envoyer">
              <SendIcon />
            </button>
          ) : (
            <button type="button" className="mic-btn" aria-label="Message vocal" onClick={startRecording}>
              ●
            </button>
          )}
        </form>
      )}

      {/* Bouton texte, pas une icône : un ✕ en haut à droite se confondait
          avec le bouton qui ferme tout le panneau Eggs (voir App.tsx :
          .panel-close, juste au-dessus dans le même coin) — même endroit et
          même style que « Sortir du salon » (voir SalonsScreen.tsx), pour
          rester cohérent avec l'autre écran où on quitte une discussion à
          plusieurs. */}
      {isGroup && (
        <button type="button" className={`salon-leave-btn ${confirmLeave ? "confirm" : ""}`} onClick={handleLeaveOrDelete}>
          {confirmLeave ? "Sûr ? Cliquer à nouveau pour confirmer" : isOwner ? "Supprimer le groupe" : "Quitter le groupe"}
        </button>
      )}
    </section>
  );
}
