import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const api = process.env.API_ORIGIN ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
      "/healthz": api,
      "/readyz": api,
    },
  },
  build: {
    target: "es2023",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) return "react";
          if (id.includes("@tanstack")) return "tanstack";
          if (id.includes("radix-ui") || id.includes("@radix-ui")) return "radix";
        },
      },
    },
  },
});
