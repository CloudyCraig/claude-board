import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite's default dev server is :5173. We point the API proxy at the
// FastAPI dev server on :8200 so the React app can use relative URLs
// in code, no matter where it's running. In production the server
// serves the built bundle from /assets and there's no proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api":     { target: "http://127.0.0.1:8200", changeOrigin: true },
      "/healthz": { target: "http://127.0.0.1:8200", changeOrigin: true },
      "/odin.png":{ target: "http://127.0.0.1:8200", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
