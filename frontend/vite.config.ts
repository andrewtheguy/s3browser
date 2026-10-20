import path from "node:path"
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Cargo's build.rs points this at its OUT_DIR for every build; a
    // standalone `bun run build` writes frontend/dist.
    outDir: process.env.S3BROWSER_FRONTEND_OUT_DIR ?? 'dist',
    // Vite won't empty an outDir outside the project root by default; stale
    // content-hashed assets must not linger in Cargo's directory.
    emptyOutDir: true,
  },
})
