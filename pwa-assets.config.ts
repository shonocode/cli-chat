import {
    defineConfig,
    minimal2023Preset as preset,
} from '@vite-pwa/assets-generator/config'

// The default `minimal2023Preset` applies `padding: 0.3` (30% inset) and
// `background: 'white'` to both `maskable` and `apple` icons — i.e. it
// shrinks our full-bleed source into a small box on a white border. iOS
// then displays the apple-touch-icon as-is, so the user sees a tiny logo
// floating on a white square. Override both to padding: 0 with a black
// background so the generated icons preserve our edge-to-edge design.
const noPaddingPng = {
    padding: 0,
    resizeOptions: { fit: 'contain', background: 'black' },
} as const

export default defineConfig({
    headLinkOptions: {
        preset: '2023',
    },
    preset: {
        ...preset,
        maskable: { ...preset.maskable, ...noPaddingPng },
        apple: { ...preset.apple, ...noPaddingPng },
    },
    // Source icon. The 1.3MB original is in `public/` so the generator
    // writes the resized assets next to it; the workbox config in
    // vite.config.ts globIgnores `icon.png` to keep it out of the SW
    // precache (manifest only references the smaller pwa-*.png).
    images: ['public/icon.png'],
})
