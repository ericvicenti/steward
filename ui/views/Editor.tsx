import { useCallback, useEffect, useRef, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { languages } from "@codemirror/language-data";
import { api, post, rawUrl, scoped, activeNode, navigate, fmtBytes, ApiError } from "../lib/api";
import { SkipBackIcon, SkipFwdIcon, RepeatIcon, ShuffleIcon } from "../lib/icons";
import videojs from "video.js";
import "video.js/dist/video-js.css";

const MEDIA_EXT: Record<string, "image" | "video" | "audio" | "pdf"> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", svg: "image", ico: "image", avif: "image",
  // non-native containers (mkv, avi, ...) play via the HLS transcoder
  mp4: "video", webm: "video", mov: "video", m4v: "video", mkv: "video", avi: "video",
  flv: "video", wmv: "video", mpg: "video", mpeg: "video", mts: "video", m2ts: "video",
  mp3: "audio", wav: "audio", m4a: "audio", flac: "audio", ogg: "audio", aiff: "audio", opus: "audio",
  pdf: "pdf",
};

// ---------- video.js player (direct or HLS-transcoded) ----------

// mov is usually h264+aac, playable in real Chrome/Safari; the error handler
// falls back to HLS transcode when the codec turns out to be unsupported.
const NATIVE_VIDEO = new Set(["mp4", "webm", "m4v", "mov"]);
const VIDEO_MIME: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime" };

function VideoJsPlayer(props: { path: string; loop: boolean; onEnded: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const playerRef = useRef<ReturnType<typeof videojs> | null>(null);
  const ext = props.path.toLowerCase().split(".").pop() ?? "";
  const [mode, setMode] = useState<"direct" | "hls">(NATIVE_VIDEO.has(ext) ? "direct" : "hls");
  const [status, setStatus] = useState<string | null>(null);
  const [ffmpegAvailable, setFfmpegAvailable] = useState(true);

  useEffect(() => {
    api<{ ffmpeg: boolean }>(`/api/media/info?path=${encodeURIComponent(props.path)}`)
      .then((i) => setFfmpegAvailable(i.ffmpeg))
      .catch(() => {});
  }, [props.path]);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    // video.js manages its own DOM; give it an element React doesn't own.
    const el = document.createElement("video-js");
    el.classList.add("vjs-big-play-centered");
    el.setAttribute("playsinline", "");
    host.current.appendChild(el);
    const player = videojs(el, {
      controls: true,
      autoplay: true,
      fluid: true,
      loop: props.loop,
      playbackRates: [0.75, 1, 1.25, 1.5, 2],
    });
    playerRef.current = player;
    player.on("ended", () => props.onEnded());

    (async () => {
      try {
        if (mode === "hls") {
          setStatus("preparing stream…");
          const res = await post<{ url: string; transcoding: boolean }>("/api/media/hls/start", { path: props.path });
          if (disposed) return;
          setStatus(res.transcoding ? "transcoding in the background — seek range grows as it runs" : null);
          player.src({ src: scoped(res.url), type: "application/x-mpegURL" });
        } else {
          setStatus(null);
          player.src({ src: rawUrl("/api/fs/read", { path: props.path }), type: VIDEO_MIME[ext] ?? "video/mp4" });
          // If the browser can't decode this file, fall back to transcoding.
          player.one("error", () => {
            if (!disposed && ffmpegAvailable) setMode("hls");
          });
        }
      } catch (err) {
        if (!disposed) setStatus(`playback failed: ${err instanceof Error ? err.message : err}`);
      }
    })();

    return () => {
      disposed = true;
      playerRef.current = null;
      player.dispose();
    };
  }, [props.path, mode]);

  useEffect(() => {
    playerRef.current?.loop(props.loop);
  }, [props.loop]);

  return (
    <div className="w-full max-w-4xl">
      <div ref={host} data-testid="videojs-host" data-vjs-player className="overflow-hidden rounded-xl shadow-2xl" />
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-zinc-500">
        <span data-testid="video-status">{status ?? (mode === "hls" ? "HLS stream" : "direct playback")}</span>
        {ffmpegAvailable && mode === "direct" && (
          <button className="text-zinc-500 hover:text-emerald-400" onClick={() => setMode("hls")} data-testid="transcode-btn">
            Transcode (HLS)
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- media player with folder playlist ----------

function MediaPlayer({ path, kind }: { path: string; kind: "audio" | "video" }) {
  const name = path.split("/").pop() ?? "";
  const dir = path.slice(0, path.lastIndexOf("/")) || "~";
  const [playlist, setPlaylist] = useState<string[]>([]);
  const [loop, setLoop] = useState(false);
  const [shuffle, setShuffle] = useState(false);

  useEffect(() => {
    api<{ entries: { name: string; type: string }[] }>(`/api/fs/list?path=${encodeURIComponent(dir)}`)
      .then((res) =>
        setPlaylist(
          res.entries
            .filter((e) => e.type === "file" && ["audio", "video"].includes(MEDIA_EXT[e.name.toLowerCase().split(".").pop() ?? ""] ?? ""))
            .map((e) => e.name)
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        )
      )
      .catch(() => setPlaylist([name]));
  }, [dir]);

  const idx = playlist.indexOf(name);
  const goto = (n: string) => navigate("edit", { path: `${dir}/${n}` });
  const step = (delta: number) => {
    if (playlist.length < 2) return;
    if (shuffle) {
      const others = playlist.filter((p) => p !== name);
      goto(others[Math.floor(Math.random() * others.length)]);
    } else {
      goto(playlist[(idx + delta + playlist.length) % playlist.length]);
    }
  };

  const toggle = (on: boolean) =>
    `rounded-lg p-2 ${on ? "bg-emerald-500/15 text-emerald-400" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row" data-testid="media-player">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-4 sm:p-8">
        {kind === "video" ? (
          <VideoJsPlayer key={path} path={path} loop={loop} onEnded={() => !loop && step(1)} />
        ) : (
          <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 text-center shadow-2xl">
            <div className="mx-auto flex h-28 w-28 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500/25 to-sky-500/20 text-5xl">
              🎵
            </div>
            <div className="mt-4 truncate text-sm font-semibold text-zinc-100">{name}</div>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              {idx + 1} of {playlist.length} in {dir.split("/").pop() || "~"}
            </div>
            <audio key={path} src={rawUrl("/api/fs/read", { path })} controls autoPlay loop={loop} onEnded={() => !loop && step(1)} className="mt-4 w-full" />
          </div>
        )}
        <div className="flex items-center gap-1.5" data-testid="media-transport">
          <button onClick={() => step(-1)} title="Previous" className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            <SkipBackIcon size={18} />
          </button>
          <button onClick={() => step(1)} title="Next" className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            <SkipFwdIcon size={18} />
          </button>
          <button onClick={() => setShuffle(!shuffle)} title="Shuffle" className={toggle(shuffle)}>
            <ShuffleIcon size={16} />
          </button>
          <button onClick={() => setLoop(!loop)} title="Repeat one" className={toggle(loop)}>
            <RepeatIcon size={16} />
          </button>
        </div>
      </div>

      {playlist.length > 1 && (
        <aside className="max-h-48 shrink-0 overflow-auto border-t border-zinc-800 lg:max-h-none lg:w-72 lg:border-l lg:border-t-0" data-testid="media-playlist">
          <div className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-zinc-600">
            Up next · {playlist.length} tracks
          </div>
          {playlist.map((n, i) => (
            <button
              key={n}
              onClick={() => goto(n)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
                n === name ? "bg-emerald-500/10 text-emerald-300" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              <span className="w-5 shrink-0 text-right font-mono text-[10px] text-zinc-600">{i + 1}</span>
              <span className="truncate">{n}</span>
              {n === name && <span className="ml-auto shrink-0 text-[9px]">▶</span>}
            </button>
          ))}
        </aside>
      )}
    </div>
  );
}

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
              search({ top: true }),
              highlightSelectionMatches(),
              keymap.of([
                { key: "Mod-s", run: () => { save(); return true; } },
                indentWithTab,
                ...searchKeymap,
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-zinc-800 px-3 py-2 sm:px-4">
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
      {(media === "video" || media === "audio") && <MediaPlayer path={path} kind={media} />}
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
