// The "Select Asset" modal — a full gallery manager (§11), modeled on the
// requested design: search, sort (created/name + direction), grid/list views,
// folder navigation with breadcrumbs, New Folder, Upload file (into the current
// folder) and pagination. Clicking an image selects it (commits + closes).
// Portaled to document.body (the app shell animates with a transform, which
// would otherwise hijack the fixed overlay).
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { JSX } from 'preact';
// The nm-am-* styles live in the designer stylesheet; import it here too so the
// panel is styled when embedded outside the designer (Asset-management tab).
import './email-designer.css';
import { api } from '../store/session.js';
import { apiBaseUrl } from '../api/client.js';
import { askText, askConfirm } from '../ui/dialog.tsx';
import {
  X,
  Search,
  FolderPlus,
  Upload,
  Folder,
  LayoutGrid as GridIcon,
  ListIcon,
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Pencil,
  Trash2,
  FolderUp,
} from './manager-icons.ts';

interface GalleryAsset {
  readonly id: string;
  readonly filename: string;
  readonly mime: string;
  readonly folder: string;
  readonly created_at: string;
  readonly size_bytes: number;
  readonly path: string;
}

interface Entry {
  readonly kind: 'folder' | 'asset';
  readonly name: string;
  readonly folderPath?: string;
  readonly itemCount?: number;
  readonly asset?: GalleryAsset;
}

const PAGE_SIZE = 24;

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

/** The modal wrapper: overlay + "Select Asset" header around the panel. */
export function AssetManager({ onSelect, onClose }: { onSelect: (url: string) => void; onClose: () => void }): JSX.Element {
  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div class="nm-am-overlay" onClick={onClose}>
      <div data-testid="asset-manager" class="nm-am" onClick={(e) => e.stopPropagation()}>
        <div class="nm-am-header">
          <h2>Select Asset</h2>
          <button type="button" data-testid="am-close" class="nm-am-icon-btn" title="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <AssetManagerPanel onSelect={onSelect} />
      </div>
    </div>,
    document.body,
  );
}

/**
 * The gallery manager PANEL — reusable: inside the Select-Asset modal (with
 * onSelect: clicking an image picks it) and embedded as the Image-gallery tab of
 * the Asset-management screen (no onSelect: pure management).
 */
export function AssetManagerPanel({ onSelect }: { onSelect?: (url: string) => void }): JSX.Element {
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [path, setPath] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'created' | 'name'>('created');
  const [sortDesc, setSortDesc] = useState(true);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(''); // "2/5" while a batch uploads
  const [error, setError] = useState('');
  /** The asset being dragged (moving = drop it on a folder card or [..]). */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (): Promise<void> => {
    const r = await api.get<{ assets: GalleryAsset[]; folders: string[] }>('/assets');
    setAssets(r.assets);
    setFolders(r.folders);
  };
  useEffect(() => {
    void load();
  }, []);

  const needle = search.trim().toLowerCase();

  // Immediate child folders of the current path.
  const childFolders = [...new Set(
    folders
      .filter((f) => (path ? f.startsWith(`${path}/`) : f !== ''))
      .map((f) => (path ? f.slice(path.length + 1) : f).split('/')[0]!)
      .filter(Boolean),
  )].sort();

  const folderEntries: Entry[] = needle
    ? [] // searching looks at files across ALL folders
    : childFolders.map((name) => {
        const full = path ? `${path}/${name}` : name;
        const itemCount = assets.filter((a) => a.folder === full || a.folder.startsWith(`${full}/`)).length;
        return { kind: 'folder', name, folderPath: full, itemCount };
      });

  const files = assets
    .filter((a) => (needle ? a.filename.toLowerCase().includes(needle) : a.folder === path))
    .sort((a, b) => {
      const cmp =
        sortBy === 'name'
          ? a.filename.localeCompare(b.filename)
          : a.created_at.localeCompare(b.created_at);
      return sortDesc ? -cmp : cmp;
    });

  const entries: Entry[] = [...folderEntries, ...files.map((a) => ({ kind: 'asset' as const, name: a.filename, asset: a }))];
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const shown = entries.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const rangeStart = entries.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const rangeEnd = Math.min(entries.length, (safePage + 1) * PAGE_SIZE);

  const newFolder = async (): Promise<void> => {
    const name = await askText({ title: 'New folder', placeholder: 'e.g. logos', confirmLabel: 'Create' });
    if (!name) return;
    const full = path ? `${path}/${name}` : name;
    await api.post('/asset-folders', { body: { name: full } });
    await load();
    setPath(full); // step into the new folder so the next upload lands there
    setPage(0);
  };

  // ── Management actions ──
  const renameAsset = async (a: GalleryAsset): Promise<void> => {
    const filename = await askText({ title: 'Rename image', initial: a.filename, confirmLabel: 'Rename' });
    if (!filename || filename === a.filename) return;
    await api.patch(`/assets/${a.id}`, { body: { filename } });
    await load();
  };
  /** Move an asset into a folder ('' = All files) — the drop handler. */
  const moveAssetTo = async (assetId: string, folder: string): Promise<void> => {
    await api.patch(`/assets/${assetId}`, { body: { folder } });
    setDraggingId(null);
    setDropTarget(null);
    await load();
  };
  const deleteAsset = async (a: GalleryAsset): Promise<void> => {
    const ok = await askConfirm({
      title: 'Delete image',
      message: `Delete "${a.filename}"? Emails already using this image will lose it.`,
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await api.del(`/assets/${a.id}`);
    await load();
  };
  const renameFolder = async (full: string): Promise<void> => {
    const seg = full.split('/').pop()!;
    const name = await askText({ title: 'Rename folder', initial: seg, confirmLabel: 'Rename' });
    if (!name || name === seg) return;
    const to = full.includes('/') ? `${full.slice(0, full.lastIndexOf('/'))}/${name}` : name;
    await api.patch('/asset-folders', { body: { from: full, to } });
    await load();
  };
  const deleteFolder = async (full: string): Promise<void> => {
    const ok = await askConfirm({
      title: 'Delete folder',
      message: `Delete folder "${full}"? Its images move to the parent folder (they are not deleted).`,
      danger: true,
      confirmLabel: 'Delete folder',
    });
    if (!ok) return;
    await api.del('/asset-folders', { body: { name: full } });
    await load();
    if (path === full || path.startsWith(`${full}/`)) setPath('');
  };

  /** Upload one or many files into the current folder (sequential, with progress). */
  const upload = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    setBusy(true);
    setError('');
    const failures: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      setProgress(files.length > 1 ? `${i + 1}/${files.length}` : '');
      try {
        const data_base64 = await fileToBase64(file);
        await api.post('/assets', { body: { filename: file.name, mime: file.type, data_base64, folder: path } });
      } catch (e) {
        failures.push(`${file.name}: ${e instanceof Error ? e.message : 'upload failed'}`);
      }
    }
    setProgress('');
    setBusy(false);
    if (failures.length) setError(failures.join(' · '));
    await load();
  };

  const crumbs = path ? path.split('/') : [];

  return (
    <div data-testid="asset-manager-panel" class="nm-am-panel">
        {/* Toolbar */}
        <div class="nm-am-toolbar">
          <label class="nm-am-search">
            <Search size={15} />
            <input
              data-testid="am-search"
              type="search"
              placeholder="Search"
              value={search}
              onInput={(e) => {
                setSearch((e.target as HTMLInputElement).value);
                setPage(0);
              }}
            />
          </label>
          <div class="nm-am-toolbar-right">
            <select
              class="nm-am-select"
              title="Sort by"
              value={sortBy}
              onChange={(e) => setSortBy((e.target as HTMLSelectElement).value as 'created' | 'name')}
            >
              <option value="created">Created</option>
              <option value="name">Name</option>
            </select>
            <button type="button" class="nm-am-icon-btn" title="Sort direction" onClick={() => setSortDesc((v) => !v)}>
              <ArrowDownUp size={15} />
            </button>
            <div class="nm-am-view-toggle">
              <button type="button" class={`nm-am-icon-btn ${view === 'grid' ? 'nm-active' : ''}`} title="Grid view" onClick={() => setView('grid')}>
                <GridIcon size={15} />
              </button>
              <button type="button" class={`nm-am-icon-btn ${view === 'list' ? 'nm-active' : ''}`} title="List view" onClick={() => setView('list')}>
                <ListIcon size={15} />
              </button>
            </div>
            <button type="button" data-testid="am-new-folder" class="nm-am-btn" onClick={() => void newFolder()}>
              <FolderPlus size={15} /> New Folder
            </button>
            <button type="button" data-testid="am-upload" class="nm-am-btn nm-am-primary" disabled={busy} onClick={() => fileRef.current?.click()}>
              <Upload size={15} /> {busy ? `Uploading${progress ? ` ${progress}` : ''}…` : 'Upload files'}
            </button>
            <input
              ref={fileRef}
              data-testid="am-file-input"
              type="file"
              multiple
              accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
              style={{ display: 'none' }}
              onChange={(e) => {
                const files = [...((e.target as HTMLInputElement).files ?? [])];
                if (files.length) void upload(files);
                (e.target as HTMLInputElement).value = '';
              }}
            />
          </div>
        </div>

        {/* Breadcrumbs + pagination */}
        <div class="nm-am-subbar">
          <div data-testid="am-breadcrumb" class="nm-am-crumbs">
            <button type="button" class={`nm-am-crumb ${path === '' ? 'nm-current' : ''}`} onClick={() => { setPath(''); setPage(0); }}>
              All files
            </button>
            {crumbs.map((seg, i) => (
              <span key={i}>
                <span class="nm-am-crumb-sep">/</span>
                <button
                  type="button"
                  class={`nm-am-crumb ${i === crumbs.length - 1 ? 'nm-current' : ''}`}
                  onClick={() => { setPath(crumbs.slice(0, i + 1).join('/')); setPage(0); }}
                >
                  {seg}
                </button>
              </span>
            ))}
          </div>
          <div class="nm-am-pagination">
            <span data-testid="am-count">
              {rangeStart}–{rangeEnd} of {entries.length}
            </span>
            <button type="button" class="nm-am-icon-btn" disabled={safePage === 0} onClick={() => setPage(0)} title="First page">
              <ChevronsLeft size={15} />
            </button>
            <button type="button" class="nm-am-icon-btn" disabled={safePage === 0} onClick={() => setPage(safePage - 1)} title="Previous page">
              <ChevronLeft size={15} />
            </button>
            <button type="button" class="nm-am-icon-btn" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)} title="Next page">
              <ChevronRight size={15} />
            </button>
            <button type="button" class="nm-am-icon-btn" disabled={safePage >= pages - 1} onClick={() => setPage(pages - 1)} title="Last page">
              <ChevronsRight size={15} />
            </button>
          </div>
        </div>

        {error ? <p class="nm-props-error nm-am-error">{error}</p> : null}

        {/* Content */}
        <div class={`nm-am-content ${view === 'list' ? 'nm-am-listview' : ''}`}>
          {path && !needle ? (
            <div
              data-testid="am-up-card"
              class={`nm-am-card nm-am-folder nm-am-up ${dropTarget === '..' ? 'nm-am-droptarget' : ''}`}
              role="button"
              tabIndex={0}
              title="Up to the parent folder — drop an image here to move it out"
              onClick={() => { setPath(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''); setPage(0); }}
              onDragOver={(e) => {
                if (!draggingId) return;
                e.preventDefault();
                setDropTarget('..');
              }}
              onDragLeave={() => setDropTarget((t) => (t === '..' ? null : t))}
              onDrop={(e) => {
                e.preventDefault();
                if (draggingId) void moveAssetTo(draggingId, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
              }}
            >
              <span class="nm-am-thumb">
                <FolderUp size={view === 'list' ? 20 : 56} />
              </span>
              <span class="nm-am-card-name">[..]</span>
              <span class="nm-am-card-meta">parent folder</span>
            </div>
          ) : null}
          {shown.length === 0 && !path ? (
            <p class="nm-am-empty">{needle ? 'No images match your search.' : 'This folder is empty — upload a file.'}</p>
          ) : (
            shown.map((entry) =>
              entry.kind === 'folder' ? (
                <div
                  key={`f-${entry.folderPath}`}
                  data-testid="am-folder-card"
                  class={`nm-am-card nm-am-folder ${dropTarget === entry.folderPath ? 'nm-am-droptarget' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => { setPath(entry.folderPath!); setPage(0); }}
                  onDragOver={(e) => {
                    if (!draggingId) return;
                    e.preventDefault();
                    setDropTarget(entry.folderPath!);
                  }}
                  onDragLeave={() => setDropTarget((t) => (t === entry.folderPath ? null : t))}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (draggingId) void moveAssetTo(draggingId, entry.folderPath!);
                  }}
                >
                  <span class="nm-am-actions" onClick={(e) => e.stopPropagation()}>
                    <button type="button" data-testid="am-folder-rename" class="nm-am-action" title="Rename folder" onClick={() => void renameFolder(entry.folderPath!)}>
                      <Pencil size={13} />
                    </button>
                    <button type="button" data-testid="am-folder-delete" class="nm-am-action nm-danger" title="Delete folder (images move to parent)" onClick={() => void deleteFolder(entry.folderPath!)}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                  <span class="nm-am-thumb">
                    <Folder size={view === 'list' ? 20 : 56} />
                  </span>
                  <span class="nm-am-card-name">{entry.name}</span>
                  <span class="nm-am-card-meta">{entry.itemCount} item{entry.itemCount === 1 ? '' : 's'}</span>
                </div>
              ) : (
                <div
                  key={entry.asset!.id}
                  data-testid="am-item"
                  class={`nm-am-card ${draggingId === entry.asset!.id ? 'nm-am-dragging' : ''}`}
                  role="button"
                  tabIndex={0}
                  title={entry.asset!.filename}
                  draggable
                  onDragStart={(e) => {
                    setDraggingId(entry.asset!.id);
                    e.dataTransfer?.setData('text/plain', entry.asset!.id);
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDropTarget(null);
                  }}
                  onClick={onSelect ? () => onSelect(`${apiBaseUrl()}${entry.asset!.path}`) : undefined}
                >
                  <span class="nm-am-actions" onClick={(e) => e.stopPropagation()}>
                    <button type="button" data-testid="am-item-rename" class="nm-am-action" title="Rename" onClick={() => void renameAsset(entry.asset!)}>
                      <Pencil size={13} />
                    </button>
                    <button type="button" data-testid="am-item-delete" class="nm-am-action nm-danger" title="Delete image" onClick={() => void deleteAsset(entry.asset!)}>
                      <Trash2 size={13} />
                    </button>
                  </span>
                  <span class="nm-am-thumb">
                    {/* draggable={false}: otherwise grabbing the thumbnail starts
                        a native IMAGE drag and the card's own drag never fires. */}
                    <img src={`${apiBaseUrl()}${entry.asset!.path}`} alt={entry.asset!.filename} loading="lazy" draggable={false} />
                  </span>
                  <span class="nm-am-card-name">{entry.asset!.filename}</span>
                  <span class="nm-am-card-meta">{fmtSize(entry.asset!.size_bytes)}</span>
                </div>
              ),
            )
          )}
        </div>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? '');
      resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : s);
    };
    reader.onerror = () => reject(new Error('could not read file'));
    reader.readAsDataURL(file);
  });
}
