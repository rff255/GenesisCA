import { useEffect, useRef, useState } from 'react';
import styles from './CaptureReviewDialog.module.css';

/** What kind of bytes the review is holding. Drives the preview element AND
 *  which dispositions are offered — only a PNG can go on the clipboard as an
 *  image, so the Copy button is HIDDEN (not disabled) for a recording. */
export type CaptureKind = 'png' | 'webm' | 'gif';

export interface CaptureReviewData {
  blob: Blob;
  /** The name the save would use — shown so the user knows what they get. */
  filename: string;
  kind: CaptureKind;
  /** Frames actually encoded (recordings only). Free: the recorder counted them. */
  frames?: number;
}

interface Props {
  capture: CaptureReviewData;
  /** Routes through the app's own save helper (a real native Save As in the
   *  Tauri shell, a blob download on the web) and reports what happened, so a
   *  CANCELLED OS dialog can keep the review open instead of throwing the only
   *  copy of the bytes away. A FAILURE is toasted by the caller. */
  onSave: (blob: Blob, filename: string) => Promise<'saved' | 'cancelled' | 'failed'>;
  /** PNG only; absent for a recording. Resolves true on a successful clipboard
   *  write — every failure is toasted by the caller, never silent. */
  onCopy?: (blob: Blob) => Promise<boolean>;
  /** The user discarded the capture. */
  onCancel: () => void;
  /** Saved or copied — just close, the disposition already spoke for itself. */
  onFinished: () => void;
}

const KIND_LABEL: Record<CaptureKind, string> = { png: 'PNG', webm: 'WebM', gif: 'GIF' };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

/** Review a finished capture before anything is written.
 *
 *  LIFETIME: the object URL is created and revoked by ONE effect keyed on the
 *  blob, so every exit path — Save, Copy, Cancel, Escape, a model load, an
 *  unmount — releases it through the same cleanup. A recording blob can be
 *  hundreds of MB, so nothing here may hold it past the dialog. */
export function CaptureReviewDialog({ capture, onSave, onCopy, onCancel, onFinished }: Props) {
  const { blob, filename, kind, frames } = capture;
  const [url, setUrl] = useState<string | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const saveBtnRef = useRef<HTMLButtonElement>(null);
  // The handlers are read by a capture-phase listener registered once, so they
  // ride a ref rather than re-registering (and re-racing) on every render.
  const busyRef = useRef(false);
  busyRef.current = busy;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    setDims(null);
    setDuration(null);
    setNote(null);
    return () => URL.revokeObjectURL(u);
  }, [blob]);

  // Escape closes the DIALOG and nothing else. Capture phase + stopPropagation
  // so it can never reach the simulator's own document-level Esc = Reset
  // handler (which bubbles) — resetting the simulation while dismissing a
  // review would be the worst possible surprise.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      if (!busyRef.current) cancelRef.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => { saveBtnRef.current?.focus(); }, [url]);

  const doSave = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const result = await onSave(blob, filename);
    setBusy(false);
    if (result === 'saved') { onFinished(); return; }
    // Cancelled / failed: the bytes are still here, so stay put and say so
    // rather than silently discarding what the user just asked to keep.
    setNote(result === 'cancelled'
      ? 'Save was cancelled — the capture is still here.'
      : 'Save failed — the capture is still here, try again.');
  };

  const doCopy = async () => {
    if (busy || !onCopy) return;
    setBusy(true);
    setNote(null);
    const ok = await onCopy(blob);
    setBusy(false);
    if (ok) { onFinished(); return; }
    setNote('Copy failed — the capture is still here; use Save instead.');
  };

  const isVideo = kind === 'webm';
  const title = kind === 'png' ? 'Screenshot' : `Recording (${KIND_LABEL[kind]})`;

  return (
    // Deliberately NO backdrop-click dismissal: a recording's bytes are gone
    // the moment this closes, and a stray click outside is not a decision.
    <div className={styles.backdrop}>
      <div className={styles.dialog}>
        <div className={styles.title}>{title}</div>
        <div className={styles.body}>
          <div className={styles.preview}>
            {url && (isVideo ? (
              <video
                className={styles.media}
                src={url}
                controls
                autoPlay
                loop
                muted
                playsInline
                onLoadedMetadata={e => {
                  const v = e.currentTarget;
                  setDims({ w: v.videoWidth, h: v.videoHeight });
                  if (Number.isFinite(v.duration)) setDuration(v.duration);
                }}
              />
            ) : (
              // An animated GIF plays natively in an <img> — no player needed.
              <img
                className={styles.media}
                src={url}
                alt={kind === 'png' ? 'Screenshot preview' : 'Recording preview'}
                onLoad={e => setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              />
            ))}
          </div>
          <div className={styles.meta}>
            <span className={styles.metaItem}><span className={styles.metaKey}>Format</span>{KIND_LABEL[kind]}</span>
            {dims && <span className={styles.metaItem}><span className={styles.metaKey}>Size</span>{dims.w} &times; {dims.h}</span>}
            <span className={styles.metaItem}><span className={styles.metaKey}>File</span>{formatBytes(blob.size)}</span>
            {frames != null && <span className={styles.metaItem}><span className={styles.metaKey}>Frames</span>{frames}</span>}
            {duration != null && duration > 0 && (
              <span className={styles.metaItem}><span className={styles.metaKey}>Length</span>{duration.toFixed(2)} s</span>
            )}
          </div>
          <div className={styles.hint}>
            Nothing has been written yet. <strong>Save</strong> opens the usual file dialog
            {kind === 'png' ? ', or copy the image straight to the clipboard' : ''}.
            {kind !== 'png' && ' Cancelling discards the recording — it cannot be recovered.'}
          </div>
          {note && <div className={styles.note}>{note}</div>}
        </div>
        <div className={styles.actions}>
          <button className={styles.btnSecondary} disabled={busy} onClick={onCancel}>Cancel</button>
          <div className={styles.spacer} />
          {onCopy && (
            <button className={styles.btnSecondary} disabled={busy} onClick={() => void doCopy()}>
              Copy to clipboard
            </button>
          )}
          <button ref={saveBtnRef} className={styles.btnPrimary} disabled={busy} onClick={() => void doSave()}>
            {busy ? 'Saving…' : 'Save…'}
          </button>
        </div>
      </div>
    </div>
  );
}
