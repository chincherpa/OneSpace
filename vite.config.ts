import { defineConfig } from "vite";

// Settings recommended for Tauri: fixed port, no screen clearing.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "chrome105", outDir: "dist", emptyOutDir: true },
});
