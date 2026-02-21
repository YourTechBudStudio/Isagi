import { useState } from "react";

import reactLogo from "@/assets/react.svg";

export default function Home() {
  const [count, setCount] = useState(0);

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
      <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-8 rounded-2xl border border-slate-800 bg-slate-900/70 p-10 shadow-xl">
        <a
          href="https://react.dev"
          target="_blank"
          rel="noreferrer"
          className="group inline-flex rounded-xl p-2 transition-transform duration-200 hover:scale-105"
        >
          <img
            src={reactLogo}
            className="size-24 drop-shadow-[0_0_1.5rem_rgba(56,189,248,0.45)] transition-transform duration-300 group-hover:rotate-6"
            alt="React logo"
          />
        </a>
        <h1 className="text-center text-5xl font-semibold tracking-tight">
          Vite + React + Tailwind
        </h1>
        <div className="flex flex-col items-center gap-4">
          <button
            onClick={() => setCount(count => count + 1)}
            className="rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 font-medium text-slate-100 transition hover:border-sky-400 hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 focus-visible:outline-none"
          >
            count is {count}
          </button>
          <p className="text-sm text-slate-300">
            Edit
            <code className="mx-1 rounded bg-slate-800 px-1.5 py-0.5 text-sky-200">
              src/pages/Home.tsx
            </code>
            and save to test HMR
          </p>
        </div>
        <p className="text-sm text-slate-400">
          Click the React logo to learn more
        </p>
      </div>
    </main>
  );
}
