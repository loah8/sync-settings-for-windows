# Contributing

Thanks for your interest in improving Sync Settings for Windows.

## Reporting issues

- Use the [GitHub issue tracker](https://github.com/loah8/sync-settings-for-windows/issues).
- Include your OS, Obsidian version, and plugin version.
- For sync problems, describe your profiles folder location and vault location
  (same drive vs different drives, run as Administrator or not).

## Development

```bash
npm install      # once
npm run dev      # watch build
npm run build    # production build (type-check + bundle)
npm run lint     # ESLint + Obsidian review-bot policy scan (must be 0 errors)
```

Built output (`main.js`) is generated; do not commit it. To test in a vault,
copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/sync-settings-for-windows/` and reload the plugin.

## Pull requests

- Keep changes focused and described.
- Run `npm run lint` and make sure it passes with 0 errors before opening a PR.
- This plugin is desktop/Windows only; keep that in mind for platform APIs.
