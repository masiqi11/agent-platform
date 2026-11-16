/**
 * `bun run dev`: API (watch) on :3000 + Vite on :5173 with proxy. Ctrl+C stops both.
 * Requires a reachable DATABASE_URL (apps/server/.env). Migrations run on server start.
 */
const procs = [
  Bun.spawn(["bun", "--watch", "src/main.ts"], { cwd: "apps/server", stdout: "inherit", stderr: "inherit", env: { ...process.env, PORT: process.env.PORT ?? "3000" } }),
  Bun.spawn(["bun", "x", "vite"], { cwd: "apps/web", stdout: "inherit", stderr: "inherit" }),
];
console.log("\n  API  → http://localhost:3000\n  Web  → http://localhost:5173\n");
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race(procs.map((p) => p.exited));
stop();
