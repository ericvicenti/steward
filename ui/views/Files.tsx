import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, post, rawUrl, navigate, fmtBytes, fmtAgo, fmtMode, fmtOctal, ApiError } from "../lib/api";
import { ChevronRight, ChevronDown, DotsIcon, FolderIcon } from "../lib/icons";

type Entry = {
  name: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  ino: number;
  hidden: boolean;
  target: string | null;
  targetType: "dir" | "file" | "missing" | null;
};
type Listing = {
  path: string;
  parent: string | null;
  home: string;
  entries: Entry[];
  users: Record<number, string>;
  groups: Record<number, string>;
};
type Clipboard = { mode: "copy" | "cut"; paths: string[] } | null;
type Dialog =
  | { kind: "newFile" | "newFolder" }
  | { kind: "rename"; entry: Entry }
  | { kind: "chmod"; entry: Entry }
  | { kind: "info"; entry: Entry }
  | { kind: "link"; linkKind: "symlink" | "hard"; entry: Entry }
  | { kind: "delete"; names: string[] }
  | null;

const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

function icon(e: Entry): string {
  if (e.type === "symlink") return e.targetType === "dir" ? "📂" : e.targetType === "missing" ? "🚫" : "📄";
  if (e.type === "dir") return "📁";
  const ext = e.name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif"].includes(ext)) return "🖼️";
  if (["mp4", "webm", "mov", "mkv"].includes(ext)) return "🎬";
  if (["mp3", "wav", "m4a", "flac"].includes(ext)) return "🎵";
  if (["zip", "gz", "tar", "dmg", "7z"].includes(ext)) return "📦";
  if (["ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "c", "h", "cpp", "sh", "swift"].includes(ext)) return "📜";
  return "📄";
}

// ---------- small building blocks ----------

function Modal(props: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60" onMouseDown={props.onClose}>
      <div
        className={`${props.wide ? "w-[540px]" : "w-[420px]"} rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-sm font-semibold text-zinc-100">{props.title}</h3>
        {props.children}
      </div>
    </div>
  );
}

function NameDialog(props: { title: string; initial: string; action: string; onSubmit: (v: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(props.initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) props.onSubmit(value.trim());
        }}
      >
        <input
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-zinc-500"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={props.onClose} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800">
            Cancel
          </button>
          <button type="submit" className="rounded-lg bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white">
            {props.action}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ChmodDialog(props: { entry: Entry; path: string; onDone: () => void; onClose: () => void; toast: (s: string) => void }) {
  const [mode, setMode] = useState(props.entry.mode & 0o777);
  const [recursive, setRecursive] = useState(false);
  const groupsDef = [
    { label: "Owner", shift: 6 },
    { label: "Group", shift: 3 },
    { label: "Others", shift: 0 },
  ];
  const bits = [
    { label: "read", bit: 4 },
    { label: "write", bit: 2 },
    { label: "execute", bit: 1 },
  ];
  return (
    <Modal title={`Permissions — ${props.entry.name}`} onClose={props.onClose}>
      <table className="w-full text-sm text-zinc-300">
        <thead>
          <tr className="text-xs uppercase tracking-wider text-zinc-500">
            <th className="py-1 text-left font-medium"></th>
            {bits.map((b) => (
              <th key={b.label} className="py-1 font-medium">{b.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groupsDef.map((g) => (
            <tr key={g.label}>
              <td className="py-1.5">{g.label}</td>
              {bits.map((b) => {
                const on = ((mode >> g.shift) & b.bit) !== 0;
                return (
                  <td key={b.label} className="py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setMode(on ? mode & ~(b.bit << g.shift) : mode | (b.bit << g.shift))}
                      className="h-4 w-4 accent-emerald-500"
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 flex items-center gap-4">
        <div className="font-mono text-sm text-zinc-100">
          {fmtMode(mode)} <span className="text-zinc-500">({mode.toString(8).padStart(3, "0")})</span>
        </div>
        {props.entry.type === "dir" && (
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} className="accent-emerald-500" />
            apply recursively
          </label>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={props.onClose} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800">
          Cancel
        </button>
        <button
          onClick={async () => {
            try {
              await post("/api/fs/chmod", { path: joinPath(props.path, props.entry.name), mode: mode.toString(8).padStart(3, "0"), recursive });
              props.onDone();
            } catch (err) {
              props.toast(String(err instanceof Error ? err.message : err));
            }
          }}
          className="rounded-lg bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white"
        >
          Apply
        </button>
      </div>
    </Modal>
  );
}

function InfoDialog(props: { entry: Entry; path: string; listing: Listing; onClose: () => void }) {
  const e = props.entry;
  const rows: [string, string][] = [
    ["Path", joinPath(props.path, e.name)],
    ["Type", e.type === "symlink" ? `symlink → ${e.target ?? "?"} (${e.targetType})` : e.type],
    ["Size", `${fmtBytes(e.size)} (${e.size.toLocaleString()} bytes)`],
    ["Modified", new Date(e.mtime).toLocaleString()],
    ["Permissions", `${e.type === "dir" ? "d" : e.type === "symlink" ? "l" : "-"}${fmtMode(e.mode)} (${fmtOctal(e.mode)})`],
    ["Owner", `${props.listing.users[e.uid] ?? e.uid} : ${props.listing.groups[e.gid] ?? e.gid}`],
    ["Hard links", String(e.nlink) + (e.type === "file" && e.nlink > 1 ? " ⚠ shared content" : "")],
    ["Inode", String(e.ino)],
  ];
  return (
    <Modal title={`Info — ${e.name}`} onClose={props.onClose} wide>
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} className="border-b border-zinc-800/60 last:border-0">
              <td className="py-1.5 pr-4 align-top text-zinc-500">{k}</td>
              <td className="break-all py-1.5 font-mono text-[13px] text-zinc-200">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

// ---------- directory tree (desktop sidebar) ----------

function TreeNode(props: {
  path: string;
  name: string;
  depth: number;
  current: string;
  onNavigate: (p: string) => void;
}) {
  const [open, setOpen] = useState(props.depth === 0);
  const [children, setChildren] = useState<{ name: string; path: string }[] | null>(null);
  const isCurrent = props.current === props.path;

  useEffect(() => {
    if (!open || children) return;
    api<Listing>(`/api/fs/list?path=${encodeURIComponent(props.path)}`)
      .then((res) =>
        setChildren(
          res.entries
            .filter((e) => !e.hidden && (e.type === "dir" || (e.type === "symlink" && e.targetType === "dir")))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((e) => ({ name: e.name, path: joinPath(res.path, e.name) }))
        )
      )
      .catch(() => setChildren([]));
  }, [open]);

  return (
    <div>
      <div
        className={`flex cursor-pointer items-center gap-1 rounded px-1 py-[3px] text-[12px] ${
          isCurrent ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
        }`}
        style={{ paddingLeft: 4 + props.depth * 12 }}
        onClick={() => {
          setOpen(true);
          props.onNavigate(props.path);
        }}
      >
        <button
          className="shrink-0 text-zinc-600 hover:text-zinc-300"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <FolderIcon size={13} className={isCurrent ? "text-emerald-400" : "text-zinc-600"} />
        <span className="truncate">{props.name}</span>
      </div>
      {open &&
        children?.map((c) => (
          <TreeNode key={c.path} path={c.path} name={c.name} depth={props.depth + 1} current={props.current} onNavigate={props.onNavigate} />
        ))}
    </div>
  );
}

// ---------- the view ----------

export function Files({ params, onLocked }: { params: URLSearchParams; onLocked: () => void }) {
  const path = params.get("path") ?? "~";
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [sortKey, setSortKey] = useState<"name" | "size" | "mtime">("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [clip, setClip] = useState<Clipboard>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; entry: Entry | null } | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [filter, setFilter] = useState("");
  const [deepResults, setDeepResults] = useState<string[] | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [pathEdit, setPathEdit] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 4000);
  }, []);

  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await api<Listing>(`/api/fs/list?path=${encodeURIComponent(path)}`);
      setListing(res);
      setSel(new Set());
      setDeepResults(null);
      setFilter("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onLocked();
      setError(String(err instanceof Error ? err.message : err));
    }
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  const go = (p: string) => navigate("files", { path: p });

  const visible = useMemo(() => {
    if (!listing) return [];
    const q = filter.toLowerCase();
    const dirFirst = (e: Entry) => (e.type === "dir" || (e.type === "symlink" && e.targetType === "dir") ? 0 : 1);
    return listing.entries
      .filter((e) => (showHidden || !e.hidden) && (!q || e.name.toLowerCase().includes(q)))
      .sort((a, b) => {
        if (dirFirst(a) !== dirFirst(b)) return dirFirst(a) - dirFirst(b);
        if (sortKey === "name") return sortDir * a.name.localeCompare(b.name, undefined, { numeric: true });
        return sortDir * ((a as any)[sortKey] - (b as any)[sortKey]);
      });
  }, [listing, showHidden, filter, sortKey, sortDir]);

  const selPaths = useMemo(() => [...sel].map((n) => joinPath(listing?.path ?? path, n)), [sel, listing, path]);

  // ----- actions -----
  const doOpen = (e: Entry) => {
    const full = joinPath(listing!.path, e.name);
    if (e.type === "dir" || (e.type === "symlink" && e.targetType === "dir")) go(full);
    else navigate("edit", { path: full });
  };

  const doDelete = async (names: string[], permanent: boolean) => {
    try {
      const res = await post<{ trashed: boolean }>("/api/fs/delete", {
        paths: names.map((n) => joinPath(listing!.path, n)),
        permanent,
      });
      toast(res.trashed ? `Moved ${names.length} item${names.length > 1 ? "s" : ""} to Trash` : "Deleted");
      setDialog(null);
      load();
    } catch (err) {
      toast(String(err instanceof Error ? err.message : err));
    }
  };

  const doPaste = async (destDir: string) => {
    if (!clip) return;
    try {
      for (const src of clip.paths) {
        const name = src.split("/").pop()!;
        const dst = joinPath(destDir, name);
        if (clip.mode === "copy") await post("/api/fs/copy", { from: src, to: dst });
        else if (src !== dst) await post("/api/fs/rename", { from: src, to: dst });
      }
      if (clip.mode === "cut") setClip(null);
      load();
    } catch (err) {
      toast(String(err instanceof Error ? err.message : err));
    }
  };

  const doMove = async (sources: string[], destDir: string) => {
    try {
      for (const src of sources) {
        const dst = joinPath(destDir, src.split("/").pop()!);
        if (src !== dst) await post("/api/fs/rename", { from: src, to: dst });
      }
      load();
    } catch (err) {
      toast(String(err instanceof Error ? err.message : err));
    }
  };

  const doUpload = async (files: FileList | File[]) => {
    const fd = new FormData();
    // webkitRelativePath preserves folder structure for directory uploads.
    for (const f of files) fd.append("files", f, (f as any).webkitRelativePath || f.name);
    try {
      await api(`/api/fs/upload?dir=${encodeURIComponent(listing!.path)}`, { method: "POST", body: fd });
      toast(`Uploaded ${files.length} file${files.length > 1 ? "s" : ""}`);
      load();
    } catch (err) {
      toast(String(err instanceof Error ? err.message : err));
    }
  };

  const doDownload = (entries: Entry[]) => {
    for (const e of entries) {
      const full = joinPath(listing!.path, e.name);
      const url =
        e.type === "dir" || (e.type === "symlink" && e.targetType === "dir")
          ? rawUrl("/api/fs/download", { path: full })
          : rawUrl("/api/fs/read", { path: full, download: "1" });
      const a = document.createElement("a");
      a.href = url;
      a.download = e.name;
      a.click();
    }
  };

  const doDeepSearch = async () => {
    try {
      const res = await api<{ results: string[] }>(
        `/api/fs/search?dir=${encodeURIComponent(listing!.path)}&q=${encodeURIComponent(filter)}`
      );
      setDeepResults(res.results);
    } catch (err) {
      toast(String(err instanceof Error ? err.message : err));
    }
  };

  // ----- selection -----
  const clickRow = (e: Entry, ev: React.MouseEvent) => {
    ev.stopPropagation();
    const names = visible.map((v) => v.name);
    if (ev.shiftKey && anchor) {
      const a = names.indexOf(anchor);
      const b = names.indexOf(e.name);
      if (a >= 0 && b >= 0) {
        setSel(new Set(names.slice(Math.min(a, b), Math.max(a, b) + 1)));
        return;
      }
    }
    if (ev.metaKey || ev.ctrlKey) {
      const next = new Set(sel);
      next.has(e.name) ? next.delete(e.name) : next.add(e.name);
      setSel(next);
    } else {
      setSel(new Set([e.name]));
    }
    setAnchor(e.name);
  };

  // ----- keyboard -----
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const inField = (ev.target as HTMLElement)?.tagName?.match(/INPUT|TEXTAREA|SELECT/);
      if (inField || dialog) return;
      const mod = ev.metaKey || ev.ctrlKey;
      if (mod && ev.key === "a") {
        ev.preventDefault();
        setSel(new Set(visible.map((v) => v.name)));
      } else if (mod && ev.key === "c" && sel.size) {
        setClip({ mode: "copy", paths: selPaths });
        toast(`Copied ${sel.size}`);
      } else if (mod && ev.key === "x" && sel.size) {
        setClip({ mode: "cut", paths: selPaths });
        toast(`Cut ${sel.size}`);
      } else if (mod && ev.key === "v" && clip) {
        doPaste(listing!.path);
      } else if ((ev.key === "Delete" || (mod && ev.key === "Backspace")) && sel.size) {
        setDialog({ kind: "delete", names: [...sel] });
      } else if (ev.key === "Enter" && sel.size === 1) {
        const e = visible.find((v) => v.name === [...sel][0]);
        if (e) doOpen(e);
      } else if (ev.key === "Escape") {
        setSel(new Set());
        setCtx(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, sel, clip, listing, dialog, selPaths]);

  useEffect(() => {
    const close = () => setCtx(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  // ----- breadcrumbs -----
  const crumbs = useMemo(() => {
    if (!listing) return [];
    const home = listing.home;
    const rel = listing.path === home ? "" : listing.path.slice(home.length + 1);
    const parts = rel ? rel.split("/") : [];
    const acc: { label: string; path: string }[] = [{ label: "~", path: home }];
    let cur = home;
    for (const p of parts) {
      cur = joinPath(cur, p);
      acc.push({ label: p, path: cur });
    }
    return acc;
  }, [listing]);

  const ctxEntry = ctx?.entry ?? null;
  const ctxTargets = ctxEntry ? (sel.has(ctxEntry.name) ? [...sel] : [ctxEntry.name]) : [...sel];

  type MenuItem = { sep?: true; label?: string; run?: () => void };
  const buildMenu = (): MenuItem[] => {
    if (!listing) return [];
    const items: MenuItem[] = [];
    const entry = ctxEntry;
    const isDirLike = !!entry && (entry.type === "dir" || entry.targetType === "dir");
    if (entry) {
      items.push({ label: "Open", run: () => doOpen(entry) });
      if (isDirLike)
        items.push({ label: "Open terminal here", run: () => navigate("term", { cwd: joinPath(listing.path, entry.name) }) });
      items.push({ label: "Download", run: () => doDownload(visible.filter((v) => ctxTargets.includes(v.name))) });
      items.push({ sep: true });
    }
    if (ctxTargets.length > 0) {
      items.push({ label: "Copy", run: () => setClip({ mode: "copy", paths: ctxTargets.map((n) => joinPath(listing.path, n)) }) });
      items.push({ label: "Cut", run: () => setClip({ mode: "cut", paths: ctxTargets.map((n) => joinPath(listing.path, n)) }) });
    }
    if (clip) {
      items.push({
        label: `Paste ${clip.paths.length} ${isDirLike ? "into folder" : "here"}`,
        run: () => doPaste(isDirLike && entry ? joinPath(listing.path, entry.name) : listing.path),
      });
    }
    if (entry) {
      items.push({
        label: "Duplicate",
        run: async () => {
          const p = joinPath(listing.path, entry.name);
          await post("/api/fs/copy", { from: p, to: p }).catch((err) => toast(String(err?.message ?? err)));
          load();
        },
      });
      items.push({ label: "Rename…", run: () => setDialog({ kind: "rename", entry }) });
      items.push({ sep: true });
      items.push({ label: "Permissions…", run: () => setDialog({ kind: "chmod", entry }) });
      items.push({ label: "New symlink to this…", run: () => setDialog({ kind: "link", linkKind: "symlink", entry }) });
      if (entry.type === "file")
        items.push({ label: "New hard link to this…", run: () => setDialog({ kind: "link", linkKind: "hard", entry }) });
      items.push({ label: "Get info", run: () => setDialog({ kind: "info", entry }) });
    }
    if (ctxTargets.length > 0) {
      items.push({ sep: true });
      items.push({ label: "Delete (Trash)", run: () => setDialog({ kind: "delete", names: ctxTargets }) });
      items.push({ label: "Delete permanently", run: () => doDelete(ctxTargets, true) });
    }
    return items;
  };

  return (
    <div
      className="flex h-full flex-col"
      data-testid="files-view"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          setDragOver(false);
          doUpload(e.dataTransfer.files);
        }
      }}
      onClick={() => setSel(new Set())}
    >
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2" onClick={(e) => e.stopPropagation()}>
        <div className="flex min-w-0 flex-1 items-center gap-1 text-sm">
          {pathEdit === null ? (
            <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap" data-testid="breadcrumbs">
              {crumbs.map((c, i) => (
                <span key={c.path} className="flex items-center gap-1">
                  {i > 0 && <span className="text-zinc-600">/</span>}
                  <button
                    className="rounded px-1 py-0.5 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                    onClick={() => go(c.path)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      const data = e.dataTransfer.getData("application/x-steward-paths");
                      if (data) {
                        e.preventDefault();
                        e.stopPropagation();
                        doMove(JSON.parse(data), c.path);
                      }
                    }}
                  >
                    {c.label}
                  </button>
                </span>
              ))}
              <button title="Edit path" className="ml-1 text-xs text-zinc-600 hover:text-zinc-300" onClick={() => setPathEdit(listing?.path ?? path)}>
                ✏️
              </button>
            </div>
          ) : (
            <form
              className="flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                setPathEdit(null);
                go(pathEdit);
              }}
            >
              <input
                autoFocus
                value={pathEdit}
                onChange={(e) => setPathEdit(e.target.value)}
                onBlur={() => setPathEdit(null)}
                onKeyDown={(e) => e.key === "Escape" && setPathEdit(null)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-100 outline-none focus:border-zinc-500"
              />
            </form>
          )}
        </div>

        <div className="flex items-center gap-2">
          <input
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setDeepResults(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && filter && doDeepSearch()}
            placeholder="filter · Enter = deep search"
            className="w-32 rounded-lg border border-zinc-800 sm:w-52 bg-zinc-900 px-3 py-1.5 text-xs outline-none focus:border-zinc-600"
            data-testid="files-filter"
          />
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} className="accent-emerald-500" data-testid="toggle-hidden" />
            hidden
          </label>
          <button onClick={() => setDialog({ kind: "newFolder" })} className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800" data-testid="new-folder">
            + Folder
          </button>
          <button onClick={() => setDialog({ kind: "newFile" })} className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800" data-testid="new-file">
            + File
          </button>
          <button onClick={() => uploadRef.current?.click()} className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800" data-testid="upload-btn">
            ⬆ Upload
          </button>
          <button onClick={() => folderRef.current?.click()} className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800" title="Upload a whole folder" data-testid="upload-folder-btn">
            ⬆ Folder
          </button>
          {clip && (
            <button onClick={() => doPaste(listing!.path)} className="rounded-lg border border-emerald-700 px-2.5 py-1.5 text-xs text-emerald-400 hover:bg-emerald-900/30" data-testid="paste-btn">
              Paste {clip.paths.length}
            </button>
          )}
          <button
            onClick={load}
            className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            title="Refresh"
          >
            ⟳
          </button>
          <button
            onClick={() => navigate("term", { cwd: listing?.path ?? "~" })}
            className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            title="Open terminal here"
          >
            ▚ Shell
          </button>
        </div>
        <input ref={uploadRef} type="file" multiple className="hidden" data-testid="upload-input" onChange={(e) => e.target.files?.length && doUpload(e.target.files)} />
        <input
          ref={folderRef}
          type="file"
          multiple
          className="hidden"
          data-testid="upload-folder-input"
          // @ts-expect-error non-standard but universally supported
          webkitdirectory=""
          onChange={(e) => e.target.files?.length && doUpload(e.target.files)}
        />
      </div>

      <div className="flex min-h-0 flex-1">
        {/* directory tree (desktop) */}
        {listing && (
          <aside className="hidden w-52 shrink-0 overflow-auto border-r border-zinc-800/70 p-1.5 md:block" data-testid="file-tree">
            <TreeNode path={listing.home} name="~" depth={0} current={listing.path} onNavigate={go} />
          </aside>
        )}

      {/* body */}
      <div className={`relative min-w-0 flex-1 overflow-auto ${dragOver ? "ring-2 ring-inset ring-emerald-500/60" : ""}`}>
        {error && (
          <div className="m-6 rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>
        )}

        {deepResults ? (
          <div className="p-4">
            <div className="mb-2 flex items-center gap-3 text-xs text-zinc-500">
              <span>
                {deepResults.length} result{deepResults.length === 1 ? "" : "s"} for “{filter}” under {listing?.path}
              </span>
              <button className="text-emerald-400 hover:underline" onClick={() => setDeepResults(null)}>
                back to listing
              </button>
            </div>
            <div className="divide-y divide-zinc-800/60 overflow-hidden rounded-lg border border-zinc-800">
              {deepResults.map((p) => (
                <button
                  key={p}
                  className="block w-full px-3 py-2 text-left font-mono text-xs text-zinc-300 hover:bg-zinc-900"
                  onClick={() => {
                    const parent = p.slice(0, p.lastIndexOf("/"));
                    go(parent);
                  }}
                >
                  {p}
                </button>
              ))}
              {deepResults.length === 0 && <div className="px-3 py-6 text-center text-sm text-zinc-500">Nothing found.</div>}
            </div>
          </div>
        ) : (
          <table className="w-full text-sm" data-testid="files-table">
            <thead className="sticky top-0 bg-zinc-950 text-left text-xs uppercase tracking-wider text-zinc-500">
              <tr className="border-b border-zinc-800">
                {(
                  [
                    ["name", "Name", ""],
                    ["mode", "Permissions", "hidden w-32 md:table-cell"],
                    ["owner", "Owner", "hidden w-36 lg:table-cell"],
                    ["size", "Size", "w-24 text-right"],
                    ["mtime", "Modified", "hidden w-28 text-right sm:table-cell"],
                    ["menu", "", "w-8"],
                  ] as const
                ).map(([key, label, cls]) => (
                  <th
                    key={key}
                    className={`cursor-pointer px-4 py-2 font-medium hover:text-zinc-300 ${cls}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (key === "mode" || key === "owner" || key === "menu") return;
                      if (sortKey === key) setSortDir(sortDir === 1 ? -1 : 1);
                      else {
                        setSortKey(key as any);
                        setSortDir(1);
                      }
                    }}
                  >
                    {label}
                    {sortKey === key ? (sortDir === 1 ? " ↑" : " ↓") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {listing?.parent && (
                <tr
                  className="cursor-pointer text-zinc-500 hover:bg-zinc-900/50"
                  onDoubleClick={() => go(listing.parent!)}
                  onClick={(e) => e.stopPropagation()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    const data = e.dataTransfer.getData("application/x-steward-paths");
                    if (data) {
                      e.preventDefault();
                      doMove(JSON.parse(data), listing.parent!);
                    }
                  }}
                >
                  <td className="px-4 py-2" colSpan={6}>
                    ⬑ ..
                  </td>
                </tr>
              )}
              {visible.map((e) => {
                const isDirLike = e.type === "dir" || (e.type === "symlink" && e.targetType === "dir");
                return (
                  <tr
                    key={e.name}
                    draggable
                    data-testid={`row-${e.name}`}
                    className={`cursor-default select-none ${sel.has(e.name) ? "bg-emerald-900/25" : "hover:bg-zinc-900/50"}`}
                    onClick={(ev) => clickRow(e, ev)}
                    onDoubleClick={() => doOpen(e)}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      if (!sel.has(e.name)) setSel(new Set([e.name]));
                      setCtx({ x: ev.clientX, y: ev.clientY, entry: e });
                    }}
                    onDragStart={(ev) => {
                      const paths = sel.has(e.name) ? selPaths : [joinPath(listing!.path, e.name)];
                      ev.dataTransfer.setData("application/x-steward-paths", JSON.stringify(paths));
                      ev.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(ev) => {
                      if (isDirLike) ev.preventDefault();
                    }}
                    onDrop={(ev) => {
                      if (!isDirLike) return;
                      const data = ev.dataTransfer.getData("application/x-steward-paths");
                      if (data) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        const dest = joinPath(listing!.path, e.name);
                        doMove(JSON.parse(data).filter((p: string) => p !== dest), dest);
                      }
                    }}
                  >
                    <td className="px-4 py-1.5">
                      <div className="flex items-center gap-2">
                        <span>{icon(e)}</span>
                        <span className={`truncate ${e.hidden ? "text-zinc-500" : "text-zinc-200"}`}>{e.name}</span>
                        {e.type === "symlink" && (
                          <span className="truncate text-xs text-sky-500/80" title={e.target ?? ""}>
                            → {e.target}
                          </span>
                        )}
                        {e.type === "file" && e.nlink > 1 && (
                          <span className="rounded bg-purple-500/15 px-1.5 text-[10px] text-purple-400 ring-1 ring-purple-500/30" title={`${e.nlink} hard links share this content`}>
                            ⧉ {e.nlink}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="hidden px-4 py-1.5 font-mono text-xs text-zinc-500 md:table-cell">
                      {(e.type === "dir" ? "d" : e.type === "symlink" ? "l" : "-") + fmtMode(e.mode)}
                    </td>
                    <td className="hidden px-4 py-1.5 text-xs text-zinc-500 lg:table-cell">
                      {listing!.users[e.uid] ?? e.uid}:{listing!.groups[e.gid] ?? e.gid}
                    </td>
                    <td className="px-4 py-1.5 text-right text-xs tabular-nums text-zinc-400">
                      {e.type === "file" ? fmtBytes(e.size) : "—"}
                    </td>
                    <td className="hidden px-4 py-1.5 text-right text-xs tabular-nums text-zinc-500 sm:table-cell">{fmtAgo(e.mtime)}</td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        className="rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
                        data-testid={`rowmenu-${e.name}`}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setSel(new Set([e.name]));
                          const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                          setCtx({ x: rect.left - 200, y: rect.bottom + 4, entry: e });
                        }}
                      >
                        <DotsIcon size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && !error && (
                <tr>
                  <td colSpan={6} className="px-4 py-14 text-center text-sm text-zinc-600">
                    {listing ? "Empty folder — drop files here to upload." : "Loading…"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {dragOver && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-emerald-500/5">
            <div className="rounded-xl border border-emerald-500/50 bg-zinc-900/90 px-6 py-3 text-sm text-emerald-300">
              Drop to upload into {listing?.path.split("/").pop() || "~"}
            </div>
          </div>
        )}
      </div>
      </div>

      {/* status bar */}
      <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-1.5 text-xs text-zinc-600">
        <span data-testid="status-count">
          {visible.length} item{visible.length === 1 ? "" : "s"}
          {sel.size > 0 && ` · ${sel.size} selected`}
          {clip && ` · clipboard: ${clip.paths.length} (${clip.mode})`}
        </span>
        <span className="hidden lg:inline">⌘C copy · ⌘X cut · ⌘V paste · ⌘A all · ⌫ delete · drag to move · drop files to upload</span>
      </div>

      {/* context menu */}
      {ctx && (
        <div
          className="fixed z-50 w-56 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 py-1 text-sm shadow-2xl"
          style={{ left: Math.max(8, Math.min(ctx.x, window.innerWidth - 240)), top: Math.max(8, Math.min(ctx.y, window.innerHeight - 420)) }}
          onClick={(e) => e.stopPropagation()}
          data-testid="context-menu"
        >
          {buildMenu().map((item, i) =>
            item.sep ? (
              <div key={i} className="my-1 border-t border-zinc-800" />
            ) : (
              <button
                key={i}
                className={`block w-full px-3 py-1.5 text-left hover:bg-zinc-800 ${item.label!.startsWith("Delete") ? "text-red-400" : "text-zinc-200"}`}
                onClick={() => {
                  setCtx(null);
                  item.run!();
                }}
              >
                {item.label}
              </button>
            )
          )}
        </div>
      )}

      {/* dialogs */}
      {dialog?.kind === "newFolder" && (
        <NameDialog
          title="New folder"
          initial="untitled folder"
          action="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await post("/api/fs/mkdir", { path: joinPath(listing!.path, name) }).catch((err) => toast(String(err.message ?? err)));
            setDialog(null);
            load();
          }}
        />
      )}
      {dialog?.kind === "newFile" && (
        <NameDialog
          title="New file"
          initial="untitled.txt"
          action="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await post("/api/fs/write", { path: joinPath(listing!.path, name), content: "" }).catch((err) => toast(String(err.message ?? err)));
            setDialog(null);
            load();
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title={`Rename ${dialog.entry.name}`}
          initial={dialog.entry.name}
          action="Rename"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await post("/api/fs/rename", {
              from: joinPath(listing!.path, dialog.entry.name),
              to: joinPath(listing!.path, name),
            }).catch((err) => toast(String(err.message ?? err)));
            setDialog(null);
            load();
          }}
        />
      )}
      {dialog?.kind === "link" && (
        <NameDialog
          title={`New ${dialog.linkKind === "hard" ? "hard link" : "symlink"} to ${dialog.entry.name}`}
          initial={`${dialog.entry.name}-link`}
          action="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await post("/api/fs/link", {
              target: joinPath(listing!.path, dialog.entry.name),
              path: joinPath(listing!.path, name),
              kind: dialog.linkKind,
            }).catch((err) => toast(String(err.message ?? err)));
            setDialog(null);
            load();
          }}
        />
      )}
      {dialog?.kind === "chmod" && listing && (
        <ChmodDialog entry={dialog.entry} path={listing.path} toast={toast} onClose={() => setDialog(null)} onDone={() => { setDialog(null); load(); }} />
      )}
      {dialog?.kind === "info" && listing && <InfoDialog entry={dialog.entry} path={listing.path} listing={listing} onClose={() => setDialog(null)} />}
      {dialog?.kind === "delete" && (
        <Modal title={`Delete ${dialog.names.length} item${dialog.names.length > 1 ? "s" : ""}?`} onClose={() => setDialog(null)}>
          <p className="max-h-32 overflow-auto text-sm text-zinc-400">{dialog.names.join(", ")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setDialog(null)} className="rounded-lg px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800">
              Cancel
            </button>
            <button onClick={() => doDelete(dialog.names, true)} className="rounded-lg border border-red-800 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950/40">
              Delete permanently
            </button>
            <button onClick={() => doDelete(dialog.names, false)} data-testid="confirm-trash" className="rounded-lg bg-zinc-100 px-4 py-1.5 text-sm font-medium text-zinc-900 hover:bg-white">
              Move to Trash
            </button>
          </div>
        </Modal>
      )}

      {toastMsg && (
        <div className="fixed bottom-10 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-200 shadow-xl" data-testid="toast">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
