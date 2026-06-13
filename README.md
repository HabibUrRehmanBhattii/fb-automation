# FB Marketplace Automation

An Electron + Playwright desktop app that automates batch-posting products to Facebook Marketplace. Built for sellers of 3D-printed cosplay props, helmets, armor, and accessories.

## Features

- **Batch queue** — Select a folder of product subfolders; each subfolder becomes one Facebook listing
- **Image handling** — Auto-extracts images from zip files, uploads up to 10 photos per listing
- **AI-powered content** — Uses DeepSeek AI to generate titles, descriptions, and category selections
- **Template system** — Built-in description templates (Helmet, Axe, Sword, Armor, Mask, Universal) plus custom templates
- **Rate limiting** — Randomized 3–8 minute delays between posts to emulate human behavior
- **Daily limit** — Hard cap of 15 uploads per day
- **Persistent login** — Dedicated Chrome profile saves Facebook login across sessions; cookie backup/restore buttons in-app
- **Bulk editing** — Select multiple queue items and apply price/template changes at once
- **Tracking** — Completed listings are saved in `processed.json` and skipped on future scans

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Framework | Electron 42 |
| Browser Automation | Playwright 1.60 (CDP) |
| AI Integration | DeepSeek API (deepseek-v4-flash) |
| Runtime | Node.js (CommonJS) |
| Build | electron-builder (NSIS installer) |

## Getting Started

### First-time Setup

1. Make sure Chrome is installed at `C:\Program Files\Google\Chrome\Application\chrome.exe`
2. Launch the app (see shortcuts below)
3. Log into Facebook in the bot Chrome window that opens (one-time setup)
4. Click the 💾 backup button in the app to save a cookie backup

### Shortcuts

| Shortcut | What it does |
|----------|-------------|
| **Start FB Automation (Clean)** | Full launch — kills old bot processes, opens Chrome, starts the app |
| **Launch Bot Chrome Only** | Just opens the automation Chrome (if you need to check login) |
| **Start App Only** | Starts the Electron app only (expects Chrome already running on port 9222) |
| **Open Project Folder** | Opens `C:\fb-automation` (the source code and project files) |

## How It Works

1. **Prepare products** — Each product gets its own subfolder with images (JPG, PNG, WEBP, GIF)
2. **Launch the app** — Use the "Start FB Automation (Clean)" shortcut
3. **Select a folder** — Pick the parent folder containing all product subfolders
4. **Configure** — Set default price and title template (or override per-item)
5. **Run** — The automation processes each item: generates descriptions, navigates Marketplace, fills the form, and publishes

## Configuration

Persistent data is stored in Electron's `userData` directory:

| File | Purpose |
|------|---------|
| `settings.json` | App settings (last folder path, DeepSeek API key) |
| `processed.json` | Tracks which folders have been published |
| `templates.json` | Custom description templates |
| `folder_customizations.json` | Per-folder price/template overrides |
| `fb-cookies.json` | Facebook cookie backup for recovery |

### Defaults

- **Price**: $65
- **Title template**: `${name} - 3D Printed DIY Cosplay Kit`
- **Condition**: New
- **Category**: Toys and Games (AI-selectable)
- **Daily limit**: 15 uploads
- **Post delay**: 3–8 minutes (randomized)

## Important Notes

- **Login persistence** — Facebook login is stored in `C:\chrome-automation-profile`. Do not log into Facebook in your personal Chrome with the same profile directory.
- **Chrome visibility** — The bot Chrome runs in a visible window by default; can be toggled to hidden mode from the app.
- **Daily limit** — The app stops after 15 successful uploads per day to stay under radar.
- **Delay between posts** — 3–8 minute randomized delays are enforced between each listing.

## Project Structure

Source code lives at `C:\fb-automation`:

```
fb-automation/
  main.js                       # Electron main process (~2300 lines)
  renderer.js                   # UI logic (~1300 lines)
  preload.js                    # Secure IPC bridge
  index.html                    # Dark-themed dashboard UI
  grok-description-worker.js    # Forked worker for description generation
  startup-config.html           # Startup config (currently bypassed)
  scripts/start-electron.js     # Node script to spawn Electron
  start-debug.ps1               # PowerShell launcher
  launch-clean.bat              # Batch wrapper
```

## Building from Source

```bash
cd C:\fb-automation
npm install
npm run build    # Produces NSIS installer in dist/
```
