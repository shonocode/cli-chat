import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,

      pwaAssets: {
        disabled: false,
        config: true,
      },

      manifest: {
        name: 'cli-chat',
        short_name: 'cli-chat',
        description:
          'Terminal-style P2P chat PWA with optional end-to-end encryption, group chat, and file transfer — all in the browser, no backend.',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        lang: 'en',
        categories: ['social', 'communication'],
      },

      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        // The 1.3MB source `icon.png` lives in `public/` only as input to
        // pwa-assets-generator — clients should never need it. Exclude it
        // from precache so we don't bloat the service worker.
        globIgnores: ['**/icon.png'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
      },

      devOptions: {
        enabled: false,
        navigateFallback: 'index.html',
        suppressWarnings: true,
        type: 'module',
      },
    }),
  ],
  server: {
    hmr: {
      host: 'localhost',
    },
  },
})
