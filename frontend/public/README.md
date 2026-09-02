# Static assets

Files in this folder are served by Vite at the site root (`/`) and copied
as-is into `dist/` on build. Do not reference them through `src/` imports —
use root-absolute paths (e.g. `/favicon.png`).

## Favicon

Drop the icon here as **`favicon.png`** (already wired up in `index.html`).

Recommended: a square PNG, 512×512, transparent background.
Optionally also add:

- `favicon.svg` — crisp at any size; `index.html` will prefer it if present
- `apple-touch-icon.png` — 180×180, for iOS home-screen bookmarks
