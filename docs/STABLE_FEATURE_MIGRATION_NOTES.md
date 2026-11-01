# Stable feature migration notes

This file records the one-time compatibility boundaries kept after graduating Identity/Friends/Incident and retiring automated slang research.

- `admin.ownerUin` is the administrator source of truth.
- Identity/Incident/Auto Update legacy owner paths are temporary read compatibility mirrors populated by `src/core/config.js`.
- The standalone updater may read an old `config.json` before the main process migrates it; it falls back to historical owner fields only when the `admin` section does not exist at all.
- Automated slang research cannot be re-enabled. Canonical `slangPilot` config contains only `enabled:false` and `graduated:false`.
- Manual slang assets remain supported and are intentionally independent from the retired research worker.
- `ui/stable-features.js` integrates at render boundaries and must not install a page-wide `MutationObserver`.
