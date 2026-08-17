import { useCallback, useEffect, useRef, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { languages } from "@codemirror/language-data";
import { api, post, rawUrl, navigate, fmtBytes, ApiError } from "../lib/api";

const MEDIA_EXT: Record<string, "image" | "video" | "audio" | "pdf"> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", ico: "image", avif: "image",
  mp4: "video", webm: "video", mov: "video",
  mp3: "audio", wav: "audio", m4a: "audio", flac: "audio",
  pdf: "pdf",
};

export function Editor({ params, onLocked }: { params: URLSearchParams; onLocked: () => void }) {
  const path = params.get("path") ?? "";
  const name = path.split("/").pop() ?? "";
  const dir = path.slice(0, path.lastIndexOf("/")) || "~";
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const media = MEDIA_EXT[ext];

  const [state, setState] = useState<"loading" | "text" | "binary" | "error">("loading");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [size, setSize] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());

  const save = useCallback(async () => {
    if (!view.current) return;
    setSaving(true);
    try {
      await post("/api/fs/write", { path, content: view.current.state.doc.toString() });
      setDirty(false);
      setSavedAt(Date.now());
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSaving(false);
    }
  }, [path]);

  useEffect(() => {
    if (media) {
      setState("text"); // media handled by render below; no editor needed
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ content: string; size: number }>(`/api/fs/text?path=${encodeURIComponent(path)}`);
        if (cancelled) return;
        setSize(res.size);
        setState("text");
        const lang = languages.find((l) => l.extensions.includes(ext) || l.filename?.test(name));
        const langSupport = lang ? await lang.load() : [];
        if (cancelled || !host.current) return;
        view.current?.destroy();
        view.current = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: res.content,
            extensions: [
              lineNumbers(),
              history(),
              bracketMatching(),
              indentOnInput(),
              highlightActiveLine(),
              syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
              oneDark,
              langCompartment.current.of(langSupport),
              keymap.of([
                { key: "Mod-s", run: () => { save(); return true; } },
                indentWithTab,
                ...defaultKeymap,
                ...historyKeymap,
              ]),
              EditorView.updateListener.of((u) => {
                if (u.docChanged) setDirty(true);
              }),
              EditorView.theme({
                "&": { height: "100%", fontSize: "13px" },
                ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
              }),
            ],
          }),
        });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) return onLocked();
        if (err instanceof ApiError && err.status === 415) setState("binary");
        else {
          setState("error");
          setError(String(err instanceof Error ? err.message : err));
        }
      }
    })();
    return () => {
      cancelled = true;
      view.current?.destroy();
      view.current = null;
    };
  }, [path]);

  // Warn before closing with unsaved changes.
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", onBefore);
    return () => window.removeEventListener("beforeunload", onBefore);
  }, [dirty]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2.5">
        <button onClick={() => navigate("files", { path: dir })} className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
          ← {dir.split("/").pop() || "~"}
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-zinc-100">
            {name}
            {dirty && <span className="ml-2 text-amber-400">●</span>}
          </div>
          <div className="truncate font-mono text-[11px] text-zinc-600">{path}</div>
        </div>
        {!media && state === "text" && (
          <>
            <span className="text-xs text-zinc-600">
              {fmtBytes(size)}
              {savedAt && !dirty ? " · saved" : ""}
            </span>
            <a
              href={rawUrl("/api/fs/read", { path, download: "1" })}
              download={name}
              className="rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              Download
            </a>
            <button
              onClick={save}
              disabled={!dirty || saving}
              data-testid="save-btn"
              className="rounded-lg bg-emerald-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              {saving ? "Saving…" : "Save ⌘S"}
            </button>
          </>
        )}
      </div>

      {error && <div className="m-4 rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">{error}</div>}

      {media === "image" && (
        <div className="flex flex-1 items-center justify-center overflow-auto p-8">
          <img src={rawUrl("/api/fs/read", { path })} alt={name} className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
      )}
      {media === "video" && (
        <div className="flex flex-1 items-center justify-center p-8">
          <video src={rawUrl("/api/fs/read", { path })} controls className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
      {media === "audio" && (
        <div className="flex flex-1 items-center justify-center p-8">
          <audio src={rawUrl("/api/fs/read", { path })} controls />
        </div>
      )}
      {media === "pdf" && <iframe src={rawUrl("/api/fs/read", { path })} className="flex-1" title={name} />}

      {!media && state === "binary" && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-500">
          <div className="text-4xl">📦</div>
          <div className="text-sm">Binary file — no text preview.</div>
          <a href={rawUrl("/api/fs/read", { path, download: "1" })} download={name} className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">
            Download
          </a>
        </div>
      )}
      {!media && state === "loading" && <div className="flex flex-1 items-center justify-center text-sm text-zinc-600">Loading…</div>}
      {!media && <div ref={host} data-testid="editor-host" className={`min-h-0 flex-1 overflow-hidden ${state === "text" ? "" : "hidden"}`} />}
    </div>
  );
}
