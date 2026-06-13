# FB Marketplace Automation — Technical Architecture Guide

A detailed reference for building similar marketplace automation apps (eBay, Etsy, Mercari, etc.). This document explains every layer so you can fork or rebuild for another platform.

---

## Table of Contents

1. [High-Level Architecture](#1-high-level-architecture)
2. [Tech Stack & Why Each Piece](#2-tech-stack--why-each-piece)
3. [Project File Map](#3-project-file-map)
4. [The Automation Flow (Step by Step)](#4-the-automation-flow-step-by-step)
5. [Chrome CDP Pattern (The Big Trick)](#5-chrome-cdp-pattern-the-big-trick)
6. [Login Persistence](#6-login-persistence)
7. [Playwright Form-Filling Strategy](#7-playwright-form-filling-strategy)
8. [AI Integration (DeepSeek)](#8-ai-integration-deepseek)
9. [Template System](#9-template-system)
10. [Queue & Tracking System](#10-queue--tracking-system)
11. [Build & Packaging](#11-build--packaging)
12. [What Changes for eBay](#12-what-changes-for-ebay)
13. [Common Pitfalls & Fixes](#13-common-pitfalls--fixes)

---

## 1. High-Level Architecture

```
┌──────────────────────────────────────────────────────┐
│   Electron App (main.js + renderer.js + index.html)  │
│                                                      │
│  ┌──────────┐  IPC Bridge  ┌──────────────────────┐ │
│  │ Renderer │◄────────────►│    Main Process       │ │
│  │ (UI)     │  (preload.js) │                      │ │
│  │          │               │  - Folder Scanner    │ │
│  │ Dark UI  │               │  - Queue Manager     │ │
│  │ Queue    │               │  - Chrome Launcher   │ │
│  │ Logs     │               │  - Playwright CDP    │ │
│  │ Controls │               │  - DeepSeek API      │ │
│  └──────────┘               │  - Template Engine   │ │
│                              └──────────┬───────────┘ │
└─────────────────────────────────────────┼─────────────┘
                                          │
                    CDP (Chrome DevTools Protocol)
                    connectOverCDP('http://127.0.0.1:9222')
                                          │
┌─────────────────────────────────────────┼─────────────┐
│  Dedicated Chrome Browser               │             │
│  --remote-debugging-port=9222           │             │
│  --user-data-dir=C:\chrome-automation-profile          │
│                                          │             │
│  Facebook Marketplace page ◄─────────────┘             │
│  (logged in via persistent profile)                    │
└────────────────────────────────────────────────────────┘
```

**Key insight:** Electron doesn't embed a browser. Instead, it **connects to the user's real Chrome** via Chrome DevTools Protocol (CDP). This means Facebook sees a real browser with real cookies, real fingerprint, and persistent login — no detection.

---

## 2. Tech Stack & Why Each Piece

| Technology | Version | Why This, Not That |
|-----------|---------|-------------------|
| **Electron** | 42 | Cross-platform desktop wrapper. Alternative: Tauri (Rust) would be smaller but Playwright doesn't support it well on Windows. |
| **Playwright** | 1.60 | Browser automation. We use `connectOverCDP()` (not `chromium.launch()`) to attach to the user's real Chrome. This avoids bot detection entirely. |
| **Node.js** | CommonJS | Standard runtime. No TypeScript — simpler for small teams, fewer build steps. |
| **DeepSeek API** | v4-flash | AI for descriptions, titles, categories. Cheaper than OpenAI GPT. Any LLM API works — just swap the fetch URL and model name. |
| **electron-builder** | 26 | Packages Electron into a Windows .exe installer (NSIS). Also supports Mac .dmg and Linux .AppImage. |
| **dotenv** | 17 | Loads `.env` file. Not critical — can inline config. |

### Why CDP Instead of Puppeteer or Selenium?

| Approach | Bot Detection Risk | Browser Fingerprint | Login Persistence |
|----------|-------------------|-------------------|-------------------|
| **CDP (this project)** | Very low | Real Chrome = real fingerprint | Chrome profile = cookies survive |
| Puppeteer | Medium | Bundled Chromium can be detected | Must manage cookies manually |
| Selenium | High | WebDriver flag visible to sites | Must manage cookies manually |
| Playwright headless | Medium-High | Different from real Chrome | Must manage cookies manually |

---

## 3. Project File Map

```
C:\fb-automation\
├── main.js                       # ★ THE BRAIN — 95% of all logic (~2300 lines)
│   ├── Chrome launcher           #   spawns real Chrome with --remote-debugging-port
│   ├── Folder scanner            #   reads product subfolders, finds images
│   ├── Queue manager             #   pending → processing → done flow
│   ├── Playwright CDP flow       #   connects to Chrome, fills FB form
│   ├── DeepSeek integration      #   generates descriptions, titles, categories
│   ├── Template engine           #   loads/saves description templates
│   ├── Processed.json tracker    #   remembers what's been published
│   ├── Settings manager          #   DeepSeek key, last folder, defaults
│   └── All IPC handlers          #   ~30 handlers bridging UI ↔ logic
│
├── preload.js                    # ★ SECURITY BRIDGE — whitelists what renderer can call (75 lines)
│   └── contextBridge.exposeInMainWorld('api', { ... })
│
├── renderer.js                   # ★ UI WIRING — button clicks → IPC calls → DOM updates (~1300 lines)
│   ├── Queue table rendering
│   ├── Log console
│   ├── Visibility toggles
│   ├── Bulk edit
│   └── Image upload modal
│
├── index.html                    # ★ UI STRUCTURE — dark-themed dashboard (~1100 lines)
│   └── Custom frameless title bar + two-tab layout
│
├── package.json                  # Dependencies + electron-builder config
├── icon.png                      # App icon
├── start-debug.ps1               # PowerShell launcher (for development)
├── launch-clean.bat              # Batch wrapper for PS1
├── scripts/
│   └── start-electron.js         # Spawns Electron as child process
├── grok-description-worker.js    # Forked worker (42 lines, currently unused alternative)
└── startup-config.html           # Old startup dialog (bypassed in current version)
```

---

## 4. The Automation Flow (Step by Step)

### User Journey (Happy Path)

```
1. User double-clicks "Start FB Automation (Clean)"
   ↓
2. App window opens + Chrome auto-launches (visible, maximized)
   ↓
3. First time: User logs into Facebook in the Chrome window (one-time)
   ↓
4. User clicks "Select Folder" → picks a parent folder
   ↓
5. App scans subfolders → shows queue table
   ↓
6. User sets price ($65 default), picks template, optionally edits per-item
   ↓
7. User clicks "Start Automation"
   ↓
8. For each item: generate title → generate description → navigate FB → fill form → upload photos → submit → wait 3-8 min
   ↓
9. After 15 items: stops (daily limit)
```

### The Code Path (What Functions Call What)

```
START BUTTON CLICK
  renderer.js: startBtn click
    → window.api.startAutomation({folder, price, template})
    → main.js IPC: 'start-automation' handler
      → ensureAutomationBrowserReady()        // Chrome with CDP running?
        → isCdpAvailable()                    // Ping port 9222
        → launchAutomationChrome(visible)     // If not, launch it
      → runAutomationLoop()                    // Background async loop
        → for each pending item:
          → processOneItem(item, uploadState, MAX_DAILY=15)
            → ensureImagesExtracted()          // Unzip if needed
            → getImagesInFolder()             // List JPG/PNG/WEBP
            → generateTitleWithDeepSeek()     // AI: folder name → clean title
            → getDescriptionFromTemplate()     // OR generateDescriptionWithDeepSeek()
            → createFbMarketplaceListing()    // ★ THE BIG ONE
              → chromium.connectOverCDP()     // Attach to Chrome
              → context.newPage()
              → page.goto('facebook.com/marketplace/create/item')
              → fill title, price, description
              → upload photos (hidden input[type=file])
              → select category (with PageDown hack)
              → select condition (combobox)
              → click "Next" → click "Publish"
              → browser.disconnect()          // NOT .close() — never kill user's Chrome!
            → save to processed.json
          → delay 3-8 minutes (random)
          → check daily limit (15)
```

---

## 5. Chrome CDP Pattern (The Big Trick)

### Why This Architecture

Most automation tools work like this (WRONG):
```
App → launch bundled Chromium → navigate to site → fill forms
```
Facebook can detect: headless flag, `navigator.webdriver`, missing plugins, wrong fingerprint.

This project works like this (RIGHT):
```
App → connect to user's REAL Chrome → reuse existing browser → fill forms
```
Facebook sees: normal Chrome, real fingerprint, real cookies, real login session.

### The Launch Command

```bash
chrome.exe \
  --remote-debugging-port=9222 \
  --user-data-dir="C:\chrome-automation-profile" \
  --no-first-run \
  --no-default-browser-check \
  --no-sandbox \
  --start-maximized
```

| Flag | Why |
|------|-----|
| `--remote-debugging-port=9222` | Opens CDP — Playwright connects to this |
| `--user-data-dir=...` | Fixed profile = cookies/login survive reboots |
| `--no-first-run` | Skips Chrome welcome wizard |
| `--no-default-browser-check` | Skips "default browser" prompt |
| `--no-sandbox` | Needed on some Windows machines |
| `--start-maximized` | User can see and interact |

### The Launch Code (main.js: ~line 1653)

This was the hardest part to get right. Here's what works and why:

**Final working approach:**
```javascript
const shellCmd = `"${chromePath}" --remote-debugging-port=9222 --user-data-dir="C:\\chrome-automation-profile" --no-first-run --no-default-browser-check --no-sandbox --start-maximized`;
const child = spawn(shellCmd, [], {
  shell: true,        // ★ cmd.exe resolves paths, sets up window/console context
  detached: true,     // ★ Chrome survives if Electron exits
  stdio: 'ignore',    // ★ No buffer limits (unlike exec)
  windowsHide: false  // Visible = user can log into FB
});
child.unref();        // ★ Don't keep Electron alive waiting for Chrome
```

**Why `spawn` with `shell: true`:** Use `shell: true` — it's the Node.js equivalent of PowerShell's `Start-Process`. Without it, Chrome's GPU process fails to initialize and you get a completely white window.

**What failed before:**
- `spawn` with `detached: true` but WITHOUT `shell: true` → white window
- `exec` / `execPromise` → works in dev but kills Chrome in packaged builds (output exceeds 200KB default exec buffer)
- `spawn` with `shell: false` → same white window

**The CDP connection:**
```javascript
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
// Always use 127.0.0.1, not localhost — avoids IPv6 ECONNREFUSED on Windows
```

**CRITICAL: disconnect() vs close()**
```javascript
await browser.disconnect();  // ✓ Just detaches Playwright — Chrome keeps running
// NEVER: await browser.close();  // ✗ KILLS the user's Chrome process!
```

### Starting Chrome from the App

The app auto-launches Chrome when it opens (`app.whenReady()`):

```javascript
app.whenReady().then(async () => {
  createWindow();
  await delay(500);
  launchAutomationChrome(true);  // true = visible
});
```

---

## 6. Login Persistence

### How It Works

Facebook login is stored in Chrome's profile folder (`C:\chrome-automation-profile`). As long as you always launch Chrome with the same `--user-data-dir`, cookies persist automatically.

**No code needed** — Chrome handles it natively.

### The Backup System

Two additional safety nets:

1. **Cookie export/import** — Buttons in the UI can export Facebook cookies as JSON and restore them into a new profile.

2. **Whole profile backup** — The app has a button to open `C:\chrome-automation-profile` in Explorer. The user can copy the entire folder as a backup.

Files stored in `app.getPath('userData')` (Electron's data directory):
```
processed.json              ← which folders are published
settings.json               ← DeepSeek API key, last folder path, defaults
templates.json              ← user's custom description templates
folder_customizations.json  ← per-folder price/template overrides
fb-cookies.json             ← cookie backup file
```

---

## 7. Playwright Form-Filling Strategy

Facebook Marketplace's form changes frequently. The approach uses **multiple fallback selectors** for every field.

### Selector Strategy (ordered by reliability)

```javascript
// For each field, try multiple selectors:
const input = page.getByLabel(/title/i)           // Best: accessibility label
  .or(page.getByPlaceholder(/what are you selling/i))  // Good: placeholder text
  .or(page.locator('input[aria-label*="Title"]'))      // OK: ARIA attribute
  .first();                                            // Take first match
```

### The Form Fields

| Field | Selector Type | Notes |
|-------|-------------|-------|
| Title | `getByLabel(/title/i)` | Template: `${name} - 3D Printed DIY Cosplay Kit` |
| Price | `getByLabel(/price/i)` | Input is a number field |
| Description | `locator('textarea[aria-label*="Description"]')` | Multi-line text |
| Photos | `locator('input[type="file"]')` | Hidden file input — setInputFiles() works |
| Category | `getByLabel('Category')` + `getByText(regex).last().click({force:true})` | See Category Hack below |
| Condition | `getByRole('combobox', {name: /condition/i})` | Standard ARIA combobox |

### The Category Hack

Facebook's category dropdown is virtualized — items not currently visible in the scroll area don't exist in the DOM. To access "Toys and games" (near the bottom):

```javascript
// 1. Click to open dropdown
await page.getByLabel('Category').click();
// 2. Press PageDown 3× to force items into the DOM
await page.keyboard.press('PageDown'); await delay(400);
await page.keyboard.press('PageDown'); await delay(400);
await page.keyboard.press('PageDown'); await delay(800);
// 3. Click by raw text (bypass broken ARIA)
await page.getByText(/Toys and games/i).last().click({ force: true });
```

### Photo Upload

Facebook has a hidden `<input type="file">` element. Clicking the "Add Photos" UI triggers CSS errors. The fix:

```javascript
const fileInput = page.locator('input[type="file"]').first();
await fileInput.setInputFiles(sortedImages.slice(0, 10)); // max 10
```

**Pro tip:** Sort images so the digital render (named with prefix "01_" or "rendered") comes first — Facebook shows the first image as the listing thumbnail.

### Publish Sequence

```javascript
await clickVisibleActionButton(page, 'Next', { timeout: 20000 });
await delay(3000);  // Wait for review screen
await clickVisibleActionButton(page, 'Publish', { timeout: 25000 });
await delay(7000);  // Wait for FB to process
```

### The `clickVisibleActionButton` Helper

```javascript
async function clickVisibleActionButton(page, label, { timeout = 15000 } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    // Try all possible selectors
    const candidates = [
      page.locator(`div[role="button"] span:has-text("${label}")`),
      page.getByRole('button', { name: label }),
      page.locator(`div[aria-label="${label}"]`),
      page.locator(`div[role="button"][aria-label="${label}"]`)
    ];
    for (const candidate of candidates) {
      // Only click if visible AND enabled (not aria-disabled)
      if (await candidate.isVisible().catch(() => false)) {
        const disabled = await candidate.getAttribute('aria-disabled')
          || await candidate.getAttribute('disabled');
        if (disabled === 'true' || disabled !== null) continue;
        await candidate.click({ timeout: 5000 });
        return true;
      }
    }
    await delay(350);
  }
  throw new Error(`Could not find "${label}" button`);
}
```

The key lesson: **FB changes their DOM constantly**. Every form field and button needs 2-4 fallback selectors + retry loops.

---

## 8. AI Integration (DeepSeek)

### Three AI Features

| Feature | Trigger | Prompt Strategy | Fallback |
|---------|---------|----------------|----------|
| **Title generation** | Per item (if API key set) | "Convert this raw folder name into a short, clean FB listing title" | Use folder name as-is |
| **Description generation** | Template = "deepseek" | "Write a high-converting FB Marketplace description for X" | Universal template |
| **Category selection** | Per item (if API key set) | "Pick the most fitting category from [list] for X" | "Toys and games" |

### API Call Pattern

```javascript
const response = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 30   // Small for titles/categories, omitted for descriptions
  })
});
const data = await response.json();
return data.choices[0].message.content.trim();
```

### To Swap to OpenAI / Claude / Another API

Just change 3 things in each of the 3 generator functions:
1. The URL (`https://api.deepseek.com/chat/completions` → `https://api.openai.com/v1/chat/completions`)
2. The `model` field (`deepseek-v4-flash` → `gpt-4o-mini`)
3. The `Authorization` header format (same `Bearer` format for most providers)

---

## 9. Template System

### Structure

Templates are stored in `templates.json` as a map:

```json
{
  "helmet": {
    "name": "Helmet DIY Kit",
    "text": "Custom 3D Printed ${name} Cosplay Helmet Kit...\n\nIncludes:\n- High-quality raw 3D printed parts..."
  },
  "axe": { "name": "Axe DIY Kit", "text": "..." },
  "sword": { "name": "Sword DIY Kit", "text": "..." },
  "armor": { "name": "Armor DIY Kit", "text": "..." },
  "mask": { "name": "Mask DIY Kit", "text": "..." },
  "lifesize": { "name": "Lifesize Prop Kit", "text": "..." },
  "universal": { "name": "Universal DIY Kit", "text": "..." }
}
```

### Template Variables

- `${name}` — replaced with the product name (AI-cleaned or folder name)
- `${productName}` — same thing, alias

### Custom Templates

Users can create/edit/delete templates from the UI (templates modal). They're saved to `templates.json` via IPC.

### Per-Folder Customization

If a user sets a custom price or template for a specific folder, it's saved in `folder_customizations.json`:

```json
{
  "IronMan_Helmet": { "price": 85, "template": "helmet" },
  "Stormbreaker_Axe": { "price": 120, "template": "axe" }
}
```

This survives re-scans — next time that folder appears, the custom settings are remembered.

---

## 10. Queue & Tracking System

### Queue Item Object

```javascript
{
  name: "IronMan_Helmet",        // Folder name
  fullPath: "C:\\Products\\IronMan_Helmet",  // Absolute path
  status: "Pending",             // "Pending" | "Processing" | "Done" | "Failed" | "No images"
  errorReason: null,             // e.g. "Generic folder name — contains only numbers or underscores"
  thumb: "C:\\...\\preview.jpg", // Thumbnail path or null
  price: 85,                     // Default or custom
  template: "helmet"             // Template key
}
```

### Status Flow

```
Folder scanned → "Pending"
  │
  ├─ Has no images → "No images" (skipped)
  ├─ Has generic name → "Generic name" (skipped)
  ├─ Already in processed.json → "Done" (skipped)
  │
  └─ Automation runs → "Processing"
       ├─ Success → "Done" (added to processed.json)
       └─ Error → "Failed" (stays in queue, NOT added to processed.json)
```

### Processed.json

```json
{ "processed": ["IronMan_Helmet", "Stormbreaker_Axe", "Mandalorian_Armor"] }
```

This is a simple array of folder names. Before scanning, completed names are filtered out. This means:
- You can re-scan the same parent folder and only new items appear
- Deleting an entry from processed.json makes it re-processable
- The "Republish" button in the UI removes an entry from processed.json

### Daily Limit

```javascript
const MAX_DAILY_UPLOADS = 15;
// ...in the automation loop:
if (uploadState.count >= MAX_DAILY_UPLOADS) {
  sendLog(`DAILY UPLOAD LIMIT REACHED. Stopping.`);
  break;
}
```

### Rate Limiting (Human Emulation)

```javascript
const MIN_POST_DELAY_MS = 180000; // 3 minutes
const MAX_POST_DELAY_MS = 480000; // 8 minutes

const waitTimeMs = Math.floor(
  Math.random() * (MAX_POST_DELAY_MS - MIN_POST_DELAY_MS + 1)
) + MIN_POST_DELAY_MS;
```

Random delay between each post to avoid pattern detection.

---

## 11. Build & Packaging

### package.json build config

```json
{
  "build": {
    "appId": "com.yoshstudios.fbmarketplace",
    "productName": "FB Marketplace Automation",
    "directories": { "output": "dist" },
    "win": {
      "target": "nsis",
      "icon": "icon.png"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    },
    "files": ["**/*", "!dist/**/*"]
  }
}
```

### Build Command

```bash
npm run build
# Runs: electron-builder --win
# Output: dist/FB Marketplace Automation Setup 1.0.0.exe (~98 MB)
```

### Critical Build Config Notes

1. **`"oneClick": false`** — Lets user choose install directory (better UX)
2. **`"files": ["**/*", "!dist/**/*"]`** — Includes everything except dist. Must NOT exclude `node_modules/**` because `playwright` and `dotenv` are runtime dependencies.
3. **electron-builder auto-includes** `node_modules` for dependencies listed in `dependencies` (not `devDependencies`). Make sure Playwright is in `dependencies`, not `devDependencies`.

---

## 12. What Changes for eBay

When you build the eBay version, here's exactly what changes and what stays the same.

### What STAYS the Same (Copy As-Is)

| Component | File(s) | Why |
|-----------|---------|-----|
| **Electron shell** | `main.js` (window, IPC, tray) | Same app framework |
| **Preload bridge** | `preload.js` | Same security pattern |
| **Chrome CDP launcher** | `main.js` (launchAutomationChrome) | Same Chrome startup |
| **Folder scanner** | `main.js` (scanFolder handler) | Same product folder structure |
| **Queue system** | `main.js` (queue, processed.json) | Same tracking logic |
| **Template engine** | `main.js` (loadTemplatesInternal, etc.) | Same template system |
| **AI integration** | `main.js` (DeepSeek functions) | Same LLM API pattern, just change prompts |
| **UI framework** | `renderer.js` + `index.html` | Same dashboard layout |
| **Build config** | `package.json` (build section) | Same electron-builder setup |

### What CHANGES

| Component | Change Needed |
|-----------|--------------|
| **`CONFIG.MARKETPLACE_URL`** | FB URL → eBay listing URL (e.g. `https://www.ebay.com/sl/list`) |
| **`createFbMarketplaceListing()`** | Rename to `createEbayListing()`. Rewrite form selectors entirely for eBay's DOM. |
| **Form fields** | eBay has different fields: item specifics, shipping, returns policy, item condition (different options), category (different tree), fixed price vs auction, etc. |
| **Category selection** | eBay uses a different category tree. The PageDown hack may not apply. |
| **Photo upload** | eBay may have a different file input mechanism. |
| **Description format** | eBay supports full HTML descriptions (FB is plain text). You can embed formatted text, images, templates. |
| **Shipping settings** | eBay requires shipping method, cost, handling time. New section needed. |
| **Price model** | eBay supports both fixed price ("Buy It Now") and auction. Need a toggle. |
| **Template content** | Rewrite templates for eBay buyers (different audience than FB Marketplace). |
| **AI prompts** | Change prompts to generate eBay-optimized descriptions. |
| **Rate limits** | eBay has different rate limits. Adjust MIN/MAX_POST_DELAY_MS and MAX_DAILY_UPLOADS. |
| **Publish flow** | May be single-page or multi-step. Might not have "Next → Publish" pattern. |
| **Login persistence** | Same Chrome profile approach works. Just log into eBay instead of FB. |
| **`clickVisibleActionButton()`** | May need different button labels for eBay's flow. |
| **App ID / name** | Change in `package.json`: `appId`, `productName`, window title. |
| **Default templates** | Replace the 7 FB templates with eBay-appropriate ones. |

### Step-by-Step eBay Adaptation Plan

1. **Explore eBay's listing form manually first** — Open Chrome DevTools, inspect every field and button. Note the selectors, ARIA labels, and DOM structure.

2. **Update `CONFIG`:**
   ```javascript
   const CONFIG = {
     CHROME_PROFILE_DIR: 'C:\\ebay-automation-profile',  // Separate profile
     CDP_PORT: 9223,  // Different port to avoid conflict with FB version
     MARKETPLACE_URL: 'https://www.ebay.com/sl/list',
     ...
   };
   ```

3. **Rewrite `createEbayListing()`** — Start with just the title and price fields. Test. Add one field at a time. EBay's form is complex — don't try to do it all at once.

4. **Add eBay-specific sections:**
   ```javascript
   // New functions needed:
   async function fillShippingDetails(page, shippingConfig) { ... }
   async function selectEbayCategory(page, categoryId) { ... }
   async function setListingType(page, type) { ... } // 'fixed' | 'auction'
   ```

5. **Update templates** — eBay descriptions can be longer, more detailed, with HTML formatting.

6. **Use a separate Chrome profile** — `C:\ebay-automation-profile` so eBay login is isolated from Facebook login.

---

## 13. Common Pitfalls & Fixes

### Pitfall 1: White/Blank Chrome Window

**Symptom:** Chrome launches but shows a completely white, unresponsive window.

**Root cause:** Node's `spawn()` without `shell: true` prevents Chrome's GPU process from initializing. Also, `child_process.exec()` has a buffer limit that kills Chrome when output exceeds ~200KB.

**Fix:**
```javascript
// ✓ CORRECT — shell:true lets cmd.exe set up the window/GPU context
spawn(shellCmd, [], { shell: true, detached: true, stdio: 'ignore' });

// ✗ WRONG — no shell, GPU init fails → white window
spawn(chromePath, args, { detached: true, stdio: 'ignore' });

// ✗ WRONG — exec buffer overflows in packaged builds → Chrome killed
execPromise(cmd, { windowsHide: false });
```

### Pitfall 2: `browser.close()` kills Chrome

**Symptom:** After automation finishes, the Chrome window disappears.

**Root cause:** `connectOverCDP()` attaches to an existing Chrome. Calling `.close()` tells Chrome to quit entirely.

**Fix:** Always use `.disconnect()`:
```javascript
await browser.disconnect();  // Detach Playwright, Chrome stays running
```

### Pitfall 3: ECONNREFUSED on localhost

**Symptom:** `connectOverCDP('http://localhost:9222')` fails with connection refused on Windows.

**Root cause:** Windows resolves `localhost` to IPv6 `::1` sometimes, but Chrome's CDP only listens on IPv4 `127.0.0.1`.

**Fix:** Use `127.0.0.1` as primary, fall back to `localhost`:
```javascript
const endpoints = [
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`
];
for (const ep of endpoints) {
  try { browser = await chromium.connectOverCDP(ep); break; } catch {}
}
```

### Pitfall 4: Playwright not found in packaged build

**Symptom:** `Error: Cannot find module 'playwright'` when running the installed EXE.

**Root cause:** `"files"` config had `"!node_modules/**/*"` which excluded all dependencies from the packaged app.

**Fix:** Remove the exclusion. electron-builder will include only production `dependencies`, not `devDependencies`.

### Pitfall 5: Form field not found

**Symptom:** `Timeout waiting for selector` on a field that was working yesterday.

**Root cause:** Facebook (and eBay) change their DOM frequently — class names, ARIA labels, structure.

**Fix:** Always use multi-selector fallback pattern:
```javascript
const input = page.getByLabel(/title/i)
  .or(page.getByPlaceholder(/what are you selling/i))
  .or(page.locator('input[aria-label*="Title"]'))
  .first();
```
Test regularly and add new selectors when old ones break.

### Pitfall 6: Category list items not clickable

**Symptom:** Category dropdown opens but clicking a specific category doesn't work.

**Root cause:** Virtualized/scrolled lists — items outside the visible scroll area don't exist in the DOM.

**Fix:** Force items into the DOM before clicking:
```javascript
await page.keyboard.press('PageDown'); // Force render
await page.keyboard.press('PageDown'); // Force render more
await page.getByText(/your category/i).last().click({ force: true });
```

### Pitfall 7: Next/Publish button stays disabled

**Symptom:** All fields are filled but the Next/Publish button is grayed out.

**Root cause:** Facebook validates all fields client-side. Missing or incorrectly filled fields (category, condition, photos) can leave the button disabled.

**Fix:** Add delays after each field to let React re-validate. Check all fields filled correctly. The `clickVisibleActionButton` helper skips disabled buttons and retries.

---

## Summary: The Key Design Decisions

1. **CDP over bundled Chromium** — Real browser, real fingerprint, no detection
2. **Fixed Chrome profile** — Login persists across reboots, zero cookie management
3. **Shell-based Chrome launch** — `spawn` with `shell:true` for proper GPU/window init
4. **Multi-selector fallbacks** — Every field has 2-4 selector strategies for resilience
5. **disconnect() not close()** — Never kill the user's browser
6. **processed.json** — Simple array, no database needed
7. **Random delays** — 3-8 minutes between posts, human-like behavior
8. **Daily cap** — 15 uploads max, protects account from flags

---

*Last updated: June 12, 2026. Built by Yosh Studios Fan.*
