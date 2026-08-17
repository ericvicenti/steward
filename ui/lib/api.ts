export const token = () => localStorage.getItem("steward-token") ?? "";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { authorization: `Bearer ${token()}`, ...init?.headers },
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      message = (await res.json()).error ?? message;
    } catch {}
    throw new ApiError(res.status, message);
  }
  return res.json();
}

export const post = <T,>(path: string, body: unknown): Promise<T> =>
  api<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export const wsUrl = (path: string, params: Record<string, string> = {}): string => {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const q = new URLSearchParams({ token: token(), ...params });
  return `${proto}://${location.host}${path}?${q}`;
};

export const rawUrl = (path: string, params: Record<string, string> = {}): string =>
  `${path}?${new URLSearchParams({ ...params, token: token() })}`;

// ---- tiny hash router: #/route?key=value ----
export interface Route {
  view: string;
  params: URLSearchParams;
}

export function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = h.split("?");
  return { view: path || "dashboard", params: new URLSearchParams(query) };
}

export function navigate(view: string, params: Record<string, string> = {}): void {
  const q = new URLSearchParams(params).toString();
  location.hash = `#/${view}${q ? `?${q}` : ""}`;
}

// ---- formatting ----
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtAgo(ms: number | null): string {
  if (!ms) return "—";
  const d = Date.now() - ms;
  const days = Math.floor(d / 86400000);
  if (days > 365) return `${Math.floor(days / 365)}y ago`;
  if (days > 30) return `${Math.floor(days / 30)}mo ago`;
  if (days > 0) return `${days}d ago`;
  const hours = Math.floor(d / 3600000);
  if (hours > 0) return `${hours}h ago`;
  const mins = Math.floor(d / 60000);
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}

/** 0o755 -> "rwxr-xr-x" */
export function fmtMode(mode: number): string {
  const rwx = (bits: number) =>
    `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
  return rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7);
}

export const fmtOctal = (mode: number): string => (mode & 0o777).toString(8).padStart(3, "0");
