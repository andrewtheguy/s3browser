import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Standalone build requires deterministic filenames for embedding.
// Regular builds use content hashes for browser cache busting.
const isStandaloneBuild = process.env.STANDALONE_BUILD === 'true';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: isStandaloneBuild ? {
      output: {
        // Deterministic names (no hash) for standalone build.
        // server/standalone.ts imports these by exact filename for embedding.
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    } : {}
  }
})
