import { useState } from "react";

export function TokenGate() {
  const [value, setValue] = useState("");
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8">
        <div className="text-3xl">🛡️</div>
        <h1 className="mt-3 text-xl font-semibold text-zinc-100">Steward is locked</h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
          Run <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-200">steward open</code> in a
          terminal to open an authenticated session, or paste the token from{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-200">~/.steward/token</code>.
        </p>
        <form
          className="mt-5 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            localStorage.setItem("steward-token", value.trim());
            location.reload();
          }}
        >
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="access token"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-zinc-500"
          />
          <button className="rounded-lg bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-white">
            Unlock
          </button>
        </form>
      </div>
    </div>
  );
}
