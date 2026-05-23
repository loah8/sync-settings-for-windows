# Sync Settings for Windows

An Obsidian plugin that shares settings (plugins, themes, snippets, hotkeys, etc.) across multiple vaults using profiles.

![Settings View](docs/settings-view.png)

> **Migrating from `profile-settings`?**
> This plugin was previously published under the id `profile-settings`. It has been re-registered as `sync-settings-for-windows`. If you installed the older version, please follow the [migration steps](#migration-from-profile-settings) below before upgrading.

## Features

- **Profile management** — Create named profiles (e.g. `default`, `work`, `mobile`) in a central folder
- **One-click apply** — Apply a profile to any vault with a single click
- **Selective sync** — Choose which settings to share per profile. Keeps workspace and graph settings local per vault
- **Windows native** — Built for Windows

## How it works

1. Set a **profiles folder** (e.g. `D:\Obsidian\settings\`)
2. Create or select a **profile** — each profile is a subfolder containing shared settings
3. **Apply** the profile to your vault — the plugin links your vault's settings to the profile

Multiple vaults pointing to the same profile will always stay in sync.

## Shared items

| Item | Type |
|---|---|
| `plugins/` | Folder |
| `themes/` | Folder |
| `snippets/` | Folder |
| `appearance.json` | File |
| `app.json` | File |
| `hotkeys.json` | File |
| `community-plugins.json` | File |
| `core-plugins.json` | File |

## Local-only items (not shared)

- `workspace.json`
- `workspace-mobile.json`
- `graph.json`

## Important notes

- **Run Obsidian as Administrator** for best results. This removes all drive restrictions.
- Without Administrator, only vaults on the **same drive** as the profiles folder can be linked.
- After applying or changing a profile, Obsidian may not pick up the new settings immediately due to caching.
- The settings tab may also show stale values until you restart.
- **Restarting Obsidian** will always load the latest settings.

## How file access works

This plugin uses Node.js filesystem APIs to read, write, and link files **outside the Obsidian vault directory**. This is required for its core purpose — sharing settings between vaults cannot be done through Obsidian's vault adapter API, which only accesses files inside a single vault.

The plugin touches only the paths you explicitly configure:

- The **profiles folder** you set (e.g. `D:\Obsidian\settings\`)
- Each vault's `.obsidian/` directory that you choose to link
- Symlinks / junctions / hardlinks created between the two

No other location on the filesystem is read or written.

## Installation

### From within Obsidian

1. Open **Settings → Community plugins → Browse**
2. Search for "Sync Settings for Windows"
3. Click **Install**, then **Enable**

### Manually

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/loah8/sync-settings-for-windows/releases/latest)
2. Create a folder `<vault>/.obsidian/plugins/sync-settings-for-windows/`
3. Copy the three files into that folder
4. Restart Obsidian and enable the plugin under **Settings → Community plugins**

## Migration from `profile-settings`

If you previously installed the plugin under its old id, your settings will not be picked up automatically. Migrate once:

1. In Obsidian, open **Settings → Community Plugins** and **disable** the old "Profile Settings" entry (if still listed).
2. Close Obsidian.
3. In your vault, open `<vault>/.obsidian/plugins/` and **delete** the `profile-settings/` folder.
4. (Optional) Back up `<vault>/.obsidian/plugins/profile-settings/data.json` first if you want to copy custom settings over manually.
5. Install **Sync Settings for Windows** (see [Installation](#installation) above) and re-enable it.
6. Re-select your **profiles folder** in the plugin settings — your existing profile folders on disk are reused as-is, no data loss.

## Requirements

- Windows 10 or later
- Obsidian 1.5.0+

## License

[MIT](LICENSE)
