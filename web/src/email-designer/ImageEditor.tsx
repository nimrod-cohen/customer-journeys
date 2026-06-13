// Image editor (§11) — crop, resize and an optional circle mask, applied to an
// image element. The edit is BAKED into a brand-new asset (drawn on a canvas,
// uploaded via POST /assets) so the email just references a normal cropped
// <img> — no client-specific CSS crop, and a circle is a real transparent-corner
// PNG (round in every client, even Outlook). The crop rect is kept in NATURAL
// image pixels; the stage scales it for display. Portaled to document.body (a
// transformed app-shell ancestor would otherwise hijack the fixed overlay).
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { JSX } from 'preact';
import { api } from '../store/session.js';
import { apiBaseUrl } from '../api/client.js';
import { X, Crop, Circle, Square } from 'lucide-preact';
import './email-designer.css';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Aspect presets; `null` = free. Circle forces 1:1. */
const ASPECTS: ReadonlyArray<readonly [string, number | null]> = [
  ['Free', null],
  ['1:1', 1],
  ['4:3', 4 / 3],
  ['16:9', 16 / 9],
  ['3:4', 3 / 4],
];

const STAGE_MAX_W = 560;
const STAGE_MAX_H = 420;
const MIN_CROP = 24; // min crop side in natural px
const MAX_OUT = 1200; // cap output width to keep upload < ~2MB

type Corner = 'nw' | 'ne' | 'sw' | 'se';
type DragMode = 'move' | Corner;

interface Drag {
  mode: DragMode;
  startX: number; // pointer clientX at grab
  startY: number;
  orig: Rect;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Recompute the crop rect for a corner drag, honoring an optional aspect ratio. */
function resizeRect(orig: Rect, corner: Corner, dxN: number, dyN: number, ratio: number | null, nW: number, nH: number): Rect {
  const right = orig.x + orig.w;
  const bottom = orig.y + orig.h;
  let { x, y, w, h } = orig;
  if (corner.includes('e')) w = orig.w + dxN;
  if (corner.includes('w')) {
    x = orig.x + dxN;
    w = right - x;
  }
  if (corner.includes('s')) h = orig.h + dyN;
  if (corner.includes('n')) {
    y = orig.y + dyN;
    h = bottom - y;
  }
  w = Math.max(MIN_CROP, w);
  h = Math.max(MIN_CROP, h);
  if (ratio) {
    h = w / ratio;
    if (corner.includes('n')) y = bottom - h;
    if (corner.includes('w')) x = right - w;
  }
  // Keep inside the image; re-fit the ratio after clamping.
  x = clamp(x, 0, nW - MIN_CROP);
  y = clamp(y, 0, nH - MIN_CROP);
  w = Math.min(w, nW - x);
  h = Math.min(h, nH - y);
  if (ratio) {
    if (w / h > ratio) w = h * ratio;
    else h = w / ratio;
    w = Math.min(w, nW - x);
    h = Math.min(h, nH - y);
  }
  return { x, y, w, h };
}

/** A centered crop of the given ratio (or full image when ratio is null). */
function centeredCrop(nW: number, nH: number, ratio: number | null): Rect {
  if (!ratio) return { x: 0, y: 0, w: nW, h: nH };
  let w = nW;
  let h = w / ratio;
  if (h > nH) {
    h = nH;
    w = h * ratio;
  }
  return { x: (nW - w) / 2, y: (nH - h) / 2, w, h };
}

export function ImageEditor({
  src,
  onApply,
  onClose,
}: {
  src: string;
  onApply: (newSrc: string, outWidth: number) => void;
  onClose: () => void;
}): JSX.Element {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [crop, setCrop] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const [ratio, setRatio] = useState<number | null>(null);
  const [circle, setCircle] = useState(false);
  const [outWidth, setOutWidth] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dragRef = useRef<Drag | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  // Load the source (crossOrigin so the canvas isn't tainted — our asset
  // endpoint sends permissive CORS).
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imgRef.current = img;
      setNat({ w: img.naturalWidth, h: img.naturalHeight });
      const c = centeredCrop(img.naturalWidth, img.naturalHeight, null);
      setCrop(c);
      setOutWidth(Math.min(Math.round(c.w), MAX_OUT));
    };
    img.onerror = () => setError('Could not load this image for editing.');
    img.src = src;
  }, [src]);

  // Display scale: fit the natural image inside the stage box.
  const scale = nat ? Math.min(STAGE_MAX_W / nat.w, STAGE_MAX_H / nat.h, 1) : 1;
  const dispW = nat ? nat.w * scale : 0;
  const dispH = nat ? nat.h * scale : 0;
  const effRatio = circle ? 1 : ratio;

  const chooseAspect = (r: number | null): void => {
    setCircle(false);
    setRatio(r);
    if (nat && r) {
      const c = centeredCrop(nat.w, nat.h, r);
      setCrop(c);
      setOutWidth(Math.min(Math.round(c.w), MAX_OUT));
    }
  };

  const toggleCircle = (): void => {
    const next = !circle;
    setCircle(next);
    if (next && nat) {
      setRatio(1);
      const side = Math.min(crop.w, crop.h);
      // Keep the current crop center, snap to a square that fits.
      const cx = crop.x + crop.w / 2;
      const cy = crop.y + crop.h / 2;
      const s = Math.min(side, nat.w, nat.h);
      const c: Rect = {
        x: clamp(cx - s / 2, 0, nat.w - s),
        y: clamp(cy - s / 2, 0, nat.h - s),
        w: s,
        h: s,
      };
      setCrop(c);
      setOutWidth(Math.min(Math.round(c.w), MAX_OUT));
    }
  };

  // Pointer drag (move / corner resize), tracked on the window so the drag
  // continues even when the pointer leaves the handle.
  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = dragRef.current;
      if (!d || !nat) return;
      const dxN = (e.clientX - d.startX) / scale;
      const dyN = (e.clientY - d.startY) / scale;
      if (d.mode === 'move') {
        setCrop({
          ...d.orig,
          x: clamp(d.orig.x + dxN, 0, nat.w - d.orig.w),
          y: clamp(d.orig.y + dyN, 0, nat.h - d.orig.h),
        });
      } else {
        setCrop(resizeRect(d.orig, d.mode, dxN, dyN, effRatio, nat.w, nat.h));
      }
    };
    const onUp = (): void => {
      if (dragRef.current) {
        dragRef.current = null;
        setOutWidth((w) => Math.min(w || Math.round(crop.w), MAX_OUT));
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [nat, scale, effRatio, crop.w]);

  const startDrag = (mode: DragMode) => (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, orig: crop };
  };

  const outHeight = circle ? outWidth : Math.round((outWidth * crop.h) / crop.w) || 0;

  const apply = async (): Promise<void> => {
    const img = imgRef.current;
    if (!img || !nat) return;
    setBusy(true);
    setError('');
    try {
      const outW = clamp(Math.round(outWidth || crop.w), 1, MAX_OUT);
      const outH = circle ? outW : Math.max(1, Math.round((outW * crop.h) / crop.w));
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas unavailable');
      ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, outW, outH);
      if (circle) {
        // Punch a circular alpha mask — transparent corners = a real circle.
        ctx.globalCompositeOperation = 'destination-in';
        ctx.beginPath();
        ctx.arc(outW / 2, outH / 2, Math.min(outW, outH) / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.fill();
      }
      const mime = circle ? 'image/png' : 'image/jpeg';
      let dataUrl: string;
      try {
        dataUrl = canvas.toDataURL(mime, 0.9);
      } catch {
        setError('This image can’t be edited here (cross-origin). Upload it to the gallery first.');
        setBusy(false);
        return;
      }
      const data_base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const ext = circle ? 'png' : 'jpg';
      const r = await api.post<{ path: string }>('/assets', {
        body: { filename: `edited-${Date.now()}.${ext}`, mime, data_base64, folder: 'edited' },
      });
      onApply(`${apiBaseUrl()}${r.path}`, outW);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the edited image.');
      setBusy(false);
    }
  };

  return createPortal(
    <div class="nm-am-overlay" onClick={onClose}>
      <div data-testid="image-editor" class="nm-imgedit" onClick={(e) => e.stopPropagation()}>
        <div class="nm-am-header">
          <h2>Edit image</h2>
          <button type="button" data-testid="imgedit-close" class="nm-am-icon-btn" title="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div class="nm-imgedit-body">
          {/* Stage with the image + crop overlay */}
          <div
            ref={stageRef}
            class="nm-imgedit-stage"
            style={{ width: `${dispW}px`, height: `${dispH}px` }}
          >
            {src ? <img class="nm-imgedit-img" src={src} alt="" crossOrigin="anonymous" draggable={false} /> : null}
            {nat ? (
              <>
                {/* Dim mask outside the crop (a big translucent box clipped to the
                    crop hole via four overlays would be heavier; a ring shadow
                    on the crop box is simpler and reads well). */}
                <div
                  data-testid="imgedit-crop"
                  class={`nm-imgedit-cropbox ${circle ? 'nm-circle' : ''}`}
                  style={{
                    left: `${crop.x * scale}px`,
                    top: `${crop.y * scale}px`,
                    width: `${crop.w * scale}px`,
                    height: `${crop.h * scale}px`,
                  }}
                  onPointerDown={startDrag('move')}
                >
                  <span class="nm-imgedit-handle nm-nw" onPointerDown={startDrag('nw')} />
                  <span class="nm-imgedit-handle nm-ne" onPointerDown={startDrag('ne')} />
                  <span class="nm-imgedit-handle nm-sw" onPointerDown={startDrag('sw')} />
                  <span class="nm-imgedit-handle nm-se" onPointerDown={startDrag('se')} />
                </div>
              </>
            ) : (
              <div class="nm-imgedit-loading">Loading…</div>
            )}
          </div>

          {/* Controls */}
          <div class="nm-imgedit-controls">
            <div class="nm-imgedit-group">
              <span class="nm-prop-label">Aspect ratio</span>
              <div class="nm-imgedit-aspects">
                {ASPECTS.map(([label, r]) => (
                  <button
                    key={label}
                    type="button"
                    data-testid={`imgedit-aspect-${label.replace(':', '-')}`}
                    class={`nm-am-btn ${!circle && ratio === r ? 'nm-active' : ''}`}
                    onClick={() => chooseAspect(r)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div class="nm-imgedit-group">
              <button
                type="button"
                data-testid="imgedit-circle"
                class={`nm-am-btn ${circle ? 'nm-active' : ''}`}
                onClick={toggleCircle}
                title="Crop to a circle (transparent corners)"
              >
                {circle ? <Circle size={14} /> : <Square size={14} />} Circle
              </button>
            </div>

            <div class="nm-imgedit-group">
              <label class="nm-prop-label" for="nm-imgedit-w">
                Output width (px)
              </label>
              <input
                id="nm-imgedit-w"
                data-testid="imgedit-width"
                class="nm-prop-input"
                type="number"
                min={1}
                max={MAX_OUT}
                value={outWidth || ''}
                onInput={(e) => setOutWidth(clamp(Number((e.target as HTMLInputElement).value) || 0, 0, MAX_OUT))}
              />
              <span class="nm-props-hint">
                {nat ? `${Math.round(crop.w)}×${Math.round(crop.h)} crop → ${outWidth || 0}×${outHeight}px` : ''}
              </span>
            </div>

            {error ? <p class="nm-props-error">{error}</p> : null}

            <div class="nm-imgedit-actions">
              <button type="button" data-testid="imgedit-cancel" class="nm-am-btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                data-testid="imgedit-apply"
                class="nm-am-btn nm-am-primary"
                onClick={() => void apply()}
                disabled={busy || !nat}
              >
                <Crop size={14} /> {busy ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
