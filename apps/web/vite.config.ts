import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // A new version waits until the learner taps "Update"; it never reloads mid-conversation.
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['pcm-capture.js', 'icon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Mural 个人版',
        short_name: 'Mural',
        description: '个人语言对话练习（语音原型）',
        lang: 'zh-CN',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#fff9ee',
        theme_color: '#fff9ee',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: { proxy: { '/api': { target: 'http://127.0.0.1:8080', ws: true } } },
});
