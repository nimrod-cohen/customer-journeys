// The "Select Asset" modal — a full gallery manager (§11), modeled on the
// requested design: search, sort (created/name + direction), grid/list views,
// folder navigation with breadcrumbs, New Folder, Upload file (into the current
// folder) and pagination. Clicking an image selects it (commits + closes).
// Portaled to document.body (the app shell animates with a transform, which
// would otherwise hijack the fixed overlay).
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { JSX } from 'preact';
import { api } from '../store/session.js';
import { apiBaseUrl } from '../api/client.js';
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

export function AssetManager({ onSelect, onClose }: { onSelect: (url: string) => void; onClose: () => void }): JSX.Element {
  const [assets, setAssets] = useState<GalleryAsset[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [path, setPath] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'created' | 'name'>('created');
  const [sortDesc, setSortDesc] = useState(true);
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (): Promise<void> => {
    const r = await api.get<{ assets: GalleryAsset[]; folders: string[] }>('/assets');
    setAssets(r.assets);
    setFolders(r.folders);
  };
  useEffect(() => {
    void load();
  }, []);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    const name = prompt('New folder name:');
    if (!name?.trim()) return;
    const full = path ? `${path}/${name.trim()}` : name.trim();
    await api.post('/asset-folders', { body: { name: full } });
    await load();
    setPath(full); // step into the new folder so the next upload lands there
    setPage(0);
  };

  const upload = async (file: File): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const data_base64 = await fileToBase64(file);
      await api.post('/assets', { body: { filename: file.name, mime: file.type, data_base64, folder: path } });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  const crumbs = path ? path.split('/') : [];

  return createPortal(
    <div class="nm-am-overlay" onClick={onClose}>
      <div data-testid="asset-manager" class="nm-am" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div class="nm-am-header">
          <h2>Select Asset</h2>
          <button type="button" data-testid="am-close" class="nm-am-icon-btn" title="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

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
              <Upload size={15} /> {busy ? 'Uploading…' : 'Upload file'}
            </button>
            <input
              ref={fileRef}
              data-testid="am-file-input"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = (e.target as HTMLInputElement).files?.[0];
                if (file) void upload(file);
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
          {shown.length === 0 ? (
            <p class="nm-am-empty">{needle ? 'No images match your search.' : 'This folder is empty — upload a file.'}</p>
          ) : (
            shown.map((entry) =>
              entry.kind === 'folder' ? (
                <button
                  key={`f-${entry.folderPath}`}
                  type="button"
                  data-testid="am-folder-card"
                  class="nm-am-card nm-am-folder"
                  onClick={() => { setPath(entry.folderPath!); setPage(0); }}
                >
                  <span class="nm-am-thumb">
                    <Folder size={view === 'list' ? 20 : 56} />
                  </span>
                  <span class="nm-am-card-name">{entry.name}</span>
                  <span class="nm-am-card-meta">{entry.itemCount} item{entry.itemCount === 1 ? '' : 's'}</span>
                </button>
              ) : (
                <button
                  key={entry.asset!.id}
                  type="button"
                  data-testid="am-item"
                  class="nm-am-card"
                  title={entry.asset!.filename}
                  onClick={() => onSelect(`${apiBaseUrl()}${entry.asset!.path}`)}
                >
                  <span class="nm-am-thumb">
                    <img src={`${apiBaseUrl()}${entry.asset!.path}`} alt={entry.asset!.filename} loading="lazy" />
                  </span>
                  <span class="nm-am-card-name">{entry.asset!.filename}</span>
                  <span class="nm-am-card-meta">{fmtSize(entry.asset!.size_bytes)}</span>
                </button>
              ),
            )
          )}
        </div>
      </div>
    </div>,
    document.body,
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
