const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { chromium } = require('playwright');
const { spawn, fork, execSync } = require('child_process');
const util = require('util');
const execPromise = util.promisify(require('child_process').exec);
const os = require('os');

require('dotenv').config();

// ==================== Configuration & Constants ====================
const CONFIG = {
  CHROME_PROFILE_DIR: 'C:\\chrome-automation-profile',
  CDP_PORT: 9222,
  MARKETPLACE_URL: 'https://www.facebook.com/marketplace/create/item',
  WINDOW_WIDTH: 1120,
  WINDOW_HEIGHT: 820,
  BG_COLOR: '#020617',
  MIN_POST_DELAY_MS: 180000, // 3 minutes
  MAX_POST_DELAY_MS: 480000  // 8 minutes
};

// Robust helper to run PowerShell code from Node on Windows.
// Uses a temp .ps1 file to avoid all the quoting / here-string / -Command hell.
function runPowerShell(scriptContent) {
  if (process.platform !== 'win32') return;
  const tmpFile = path.join(os.tmpdir(), `fb-auto-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  try {
    fsSync.writeFileSync(tmpFile, scriptContent, 'utf8');
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, {
      windowsHide: true,
      stdio: 'ignore'
    });
  } catch (e) {
    // swallow - these are best-effort UI manipulations
  } finally {
    try { fsSync.unlinkSync(tmpFile); } catch (_) {}
  }
}

// ==================== App State ====================
let mainWindow = null;
let debugBrowser = null;          // Playwright instance (the "local debug browser")
let currentQueue = [];            // [{ name, fullPath, status: 'Pending'|'Processing'|'Done', thumb: string|null }]
let isAutomationRunning = false;
let isAutomationPaused = false;
let defaultPrice = 65;
let targetFolder = null;
let defaultTitleTemplate = '${name}';

let tray = null;
let isQuitting = false;
let chromeVisible = true; // VISIBLE by default (rollback state)
let terminalVisible = false; // HIDDEN by default

// Persistent session backup (cookies for facebook.com). The real long-term persistence
// comes from always launching Chrome with the SAME --user-data-dir folder.
const fbCookiesFile = path.join(app.getPath('userData'), 'fb-cookies.json');

// ==================== Window Creation (Premium Frameless Dark) ====================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: CONFIG.WINDOW_WIDTH,
    height: CONFIG.WINDOW_HEIGHT,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: CONFIG.BG_COLOR,
    frame: false,                 // Custom title bar for ultra-premium look
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,             // Needed for fs + Playwright in main
    },
    icon: path.join(__dirname, 'icon.png'), // use existing root icon
    show: false,
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Send initial browser status
    sendBrowserStatus();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Ensure tray
  setTimeout(() => { initSystemTray(); }, 200);

  // Minimize to tray instead of quitting when user clicks the window close button (X)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    } else {
      // On explicit quit, FORCE close bot Chrome (visible or hidden) + FORCE close terminal
      killBotChrome();
      forceCloseTerminal();
    }
  });
}

// (Dialog fully removed - rollback complete. Both Chrome and terminal visible by default via ps1 + main defaults.)

function initSystemTray() {
  if (tray) return; // already initialized

  const iconPath = path.join(__dirname, 'icon.png');
  try {
    if (require('fs').existsSync(iconPath)) {
      tray = new Tray(iconPath);
    } else {
      console.error(`[Tray] icon.png not found at ${iconPath}. Tray not created.`);
      tray = null;
    }
  } catch (e) {
    console.error('[Tray] Failed to create tray icon:', e.message);
    tray = null;
  }

  if (tray) {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Dashboard',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      {
        label: 'Quit Automation',
        click: () => {
          isQuitting = true;
          killBotChrome();
          forceCloseTerminal();
          if (mainWindow) mainWindow.destroy();
          app.quit();
        }
      }
    ]);

    tray.setToolTip('Marketplace Automation Studio');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  }
}

// ==================== Helpers ====================
function sendLog(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', message);
  } else {
    console.log('[Pre-main]', message);
  }
}

function sendQueueUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('queue-update', currentQueue);
  }
}

function sendStatusUpdate() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', {
      isRunning: isAutomationRunning,
      isPaused: isAutomationPaused,
    });
  }
}

function sendBrowserStatus(status = null) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  let currentStatus = status;
  if (!currentStatus) {
    currentStatus = debugBrowser ? 'connected' : 'disconnected';
  }
  mainWindow.webContents.send('browser-status', currentStatus);
}

// Find first image inside a product folder for thumbnail (UI)
async function findFirstImage(folderPath) {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
          return path.join(folderPath, entry.name);
        }
      }
    }
  } catch (_) {}
  return null;
}

// Get all image paths in a folder (for Playwright upload)
async function getImagesInFolder(folderPath) {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    return entries
      .filter(e => e.isFile())
      .map(e => path.join(folderPath, e.name))
      .filter(p => /\.(jpe?g|png|webp|gif)$/i.test(p));
  } catch (_) {
    return [];
  }
}

// ==================== processed.json tracking (filters already done listings) ====================
const processedFile = path.join(app.getPath('userData'), 'processed.json');

async function loadProcessed() {
  try {
    const data = await fs.readFile(processedFile, 'utf8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed.processed) ? parsed.processed : [];
  } catch {
    return [];
  }
}

async function saveProcessed(processedList) {
  try {
    await fs.writeFile(processedFile, JSON.stringify({ processed: processedList }, null, 2));
  } catch (err) {
    sendLog(`[Error]: Failed to save processed.json — ${err.message}`);
  }
}

// ==================== folder_customizations.json tracking (remembers custom template/price selections) ====================
const folderCustomizationsFile = path.join(app.getPath('userData'), 'folder_customizations.json');

async function loadFolderCustomizations() {
  try {
    const data = await fs.readFile(folderCustomizationsFile, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveFolderCustomizations(customizations) {
  try {
    await fs.writeFile(folderCustomizationsFile, JSON.stringify(customizations, null, 2), 'utf8');
    return true;
  } catch (err) {
    sendLog(`[Error]: Failed to save folder customizations — ${err.message}`);
    return false;
  }
}

// ==================== settings.json tracking (remembers general app settings like lastFolder) ====================
const settingsFile = path.join(app.getPath('userData'), 'settings.json');

async function loadSettings() {
  try {
    const data = await fs.readFile(settingsFile, 'utf8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveSettings(settings) {
  try {
    await fs.writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
    return true;
  } catch (err) {
    sendLog(`[Error]: Failed to save settings — ${err.message}`);
    return false;
  }
}

// ==================== templates.json tracking (custom description templates) ====================
const templatesFile = path.join(app.getPath('userData'), 'templates.json');

const defaultTemplates = {
  helmet: {
    label: "Helmet DIY",
    text: `3D Printed DIY Cosplay Helmet Kit - \${name}

Bring your favorite character to life with this highly detailed, 3D printed DIY cosplay helmet kit! Perfect for cosplayers, makers, and collectors.

What is included:
- Premium quality 3D printed raw parts (unassembled)
- Printed in durable PLA/PETG material
- Raw print status: Needs sanding, priming, and painting to your liking

Sizing:
- Fits standard adult head sizes (approx. 22-24 inches circumference). Let us know if you need specific sizing.

Please note: This is a DIY kit. Sanding, gluing, and painting are required to achieve a finished prop. Renders shown are for reference.`
  },
  axe: {
    label: "Axe DIY",
    text: `3D Printed DIY Cosplay Axe Kit - \${name}

Craft the ultimate weapon prop with this premium 3D printed DIY cosplay axe kit! Superb details, perfect for display, conventions, or photoshoot.

What is included:
- Premium 3D printed raw parts (unassembled)
- Engineered with alignment keys/internal dowel channels for easy assembly and maximum durability
- Printed in robust PLA/PETG

Please note: This is a raw DIY kit. Gluing, sanding, and painting are required to finish the prop. Assembly rod/dowel is not included.`
  },
  sword: {
    label: "Sword DIY",
    text: `3D Printed DIY Cosplay Sword Kit - \${name}

Forge your own legendary blade! This premium 3D printed DIY cosplay sword kit features screen-accurate details and a durable design.

What is included:
- Raw 3D printed pieces (unassembled)
- Features internal alignment channels for inserting a reinforcing metal or wood rod
- Printed in high-strength PLA/PETG

Perfect for conventions, photo shoots, and collections.
Note: This is a raw print kit. Sanding, assembly (glue), and custom paint work are required. Reinforcing rod not included.`
  },
  armor: {
    label: "Armor DIY",
    text: `3D Printed DIY Cosplay Armor Set/Piece - \${name}

Upgrade your cosplay with this highly detailed, 3D printed DIY armor kit! Lightweight, durable, and designed for maximum comfort and realism.

What is included:
- Raw 3D printed armor parts (unassembled and unpainted)
- Durable PLA/PETG construction

Sizing:
- Standard adult fit. Can be scaled or heat-formed slightly for a custom fit.

Note: Sanding, priming, painting, and strapping are required. Raw 3D prints may have slight surface lines.`
  },
  mask: {
    label: "Mask",
    text: `3D Printed Cosplay Mask / Wearable Prop - \${name}

Highly detailed, screen-accurate 3D printed cosplay mask! Lightweight and durable, perfect for cosplay, display, or conventions.

Features:
- Raw 3D print ready for your custom finish
- Printed in high-grade PLA/PETG
- Can be easily sanded, primed, and painted

Note: This is a DIY mask kit. Straps, padding, painting, and finishing are done by the buyer.`
  },
  lifesize: {
    label: "Special Life Sized",
    text: `Life-Size 3D Printed DIY Cosplay Prop / Replica - \${name}

An incredible 1:1 scale life-size replica prop! Perfect for ultimate display collections, man caves, and conventions.

Details:
- Full 1:1 scale life-size model
- 3D printed raw assembly kit
- Highly detailed surfaces

Note: Assembly, gluing, sanding, and painting are required. Renders shown are for visual reference of the finished piece.`
  },
  universal: {
    label: "Universal",
    text: `3D Printed DIY Cosplay Prop Kit - \${name}

Premium 3D printed DIY replica prop. A fantastic project for any cosplay enthusiast, maker, or gamer!

Includes:
- High-quality raw 3D printed parts
- Durable PLA/PETG material
- Unassembled and unpainted

Note: This is a DIY kit. Sanding, assembly (gluing), and painting are required to finish the product.`
  }
};

async function loadTemplatesInternal() {
  try {
    const data = await fs.readFile(templatesFile, 'utf8');
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? parsed : defaultTemplates;
  } catch {
    try {
      await fs.writeFile(templatesFile, JSON.stringify(defaultTemplates, null, 2));
    } catch (_) {}
    return defaultTemplates;
  }
}

async function saveTemplatesInternal(templates) {
  try {
    await fs.writeFile(templatesFile, JSON.stringify(templates, null, 2));
    return true;
  } catch (err) {
    sendLog(`[Error]: Failed to save templates - ${err.message}`);
    return false;
  }
}

// ==================== Native Dialog + Real Folder Scanning ====================
ipcMain.handle('select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Target Product Folder',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Select Folder',
  });

  if (result.canceled || !result.filePaths.length) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('get-last-folder', async () => {
  try {
    const settings = await loadSettings();
    if (settings.lastFolder) {
      try {
        await fs.access(settings.lastFolder);
        return settings.lastFolder;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
});

function getFolderValidity(name, imageCount) {
  if (imageCount === 0) {
    return { valid: false, status: 'Review', reason: 'No Images' };
  }
  if (/^item_/i.test(name)) {
    return { valid: false, status: 'Review', reason: 'Generic Name' };
  }
  if (/\s\(\d+\)$/.test(name)) {
    return { valid: false, status: 'Review', reason: 'Duplicate' };
  }
  return { valid: true, status: 'Pending', reason: null };
}

ipcMain.handle('scan-folder', async (event, folderPath) => {
  if (!folderPath) return [];

  targetFolder = folderPath;
  currentQueue = [];

  try {
    const settings = await loadSettings();
    settings.lastFolder = folderPath;
    await saveSettings(settings);

    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const subdirs = entries.filter(e => e.isDirectory());

    const processed = await loadProcessed();
    const customizations = await loadFolderCustomizations();
    sendLog(`[System]: Found ${subdirs.length} subfolders. Scanning items...`);

    for (const dir of subdirs) {
      const isProcessed = processed.includes(dir.name);
      const fullPath = path.join(folderPath, dir.name);
      await ensureImagesExtracted(fullPath);
      const thumb = await findFirstImage(fullPath);

      const images = await getImagesInFolder(fullPath);
      const validity = getFolderValidity(dir.name, images.length);

      const custom = customizations[dir.name] || {};

      currentQueue.push({
        name: dir.name,
        fullPath,
        status: isProcessed ? 'Done' : validity.status,
        errorReason: isProcessed ? null : validity.reason,
        thumb,
        price: custom.price,
        template: custom.template
      });
    }

    const pendingCount = currentQueue.filter(i => i.status !== 'Done').length;
    const publishedCount = currentQueue.filter(i => i.status === 'Done').length;
    sendLog(`[Scanner]: ${currentQueue.length} folders scanned: ${pendingCount} pending, ${publishedCount} published.`);
    sendQueueUpdate();
    return currentQueue;
  } catch (err) {
    sendLog(`[Error]: Could not read directory — ${err.message}`);
    return [];
  }
});

// ==================== Folder Name Cleaning Utility & IPC Handler ====================
function cleanFolderName(name) {
  let cleaned = name;
  // 1. Google Drive zip timestamp suffix, e.g. -20260410T132343Z-3-001
  cleaned = cleaned.replace(/-\d{8}T\d{6}Z(?:-\d+)*$/i, '');
  // 2. Social handles, e.g. @Print3DWorld
  cleaned = cleaned.replace(/\s*@[\w-]+/gi, '');
  // 3. Telegram links/handles, e.g. t.me_MOXOMOR_aka
  cleaned = cleaned.replace(/\s*t\.me_\S+/gi, '');
  // Trim any leading/trailing spaces or leftover dashes/underscores at the ends
  cleaned = cleaned.replace(/^[\s-_]+|[\s-_]+$/g, '');
  
  if (!cleaned) {
    cleaned = name;
  }
  return cleaned;
}

async function getUniqueFolderName(parentDir, cleanedName, originalName) {
  let targetName = cleanedName;
  let counter = 1;
  while (true) {
    if (targetName === originalName) {
      return targetName;
    }
    const targetPath = path.join(parentDir, targetName);
    try {
      await fs.access(targetPath);
      // Path exists, so we need to generate a new name
      targetName = `${cleanedName} (${counter})`;
      counter++;
    } catch {
      // Path does not exist, safe to use!
      return targetName;
    }
  }
}

// Quick recursive check inside product folder to see if there is any zip file
async function hasZipFileRecursive(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
        return true;
      }
      if (entry.isDirectory()) {
        const found = await hasZipFileRecursive(path.join(dirPath, entry.name));
        if (found) return true;
      }
    }
  } catch (_) {}
  return false;
}

// Asynchronous PowerShell runner for zip extraction
async function runPowerShellAsync(scriptContent) {
  if (process.platform !== 'win32') return;
  const tmpFile = path.join(os.tmpdir(), `fb-auto-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  try {
    await fs.writeFile(tmpFile, scriptContent, 'utf8');
    await execPromise(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, {
      windowsHide: true
    });
  } catch (e) {
    sendLog(`[Error]: PowerShell zip extract failed - ${e.message}`);
  } finally {
    try { await fs.unlink(tmpFile); } catch (_) {}
  }
}

// Extracts only images from any zip files inside productFolderPath recursively
async function extractImagesFromZips(productFolderPath) {
  if (process.platform !== 'win32') return;
  
  const escapedPath = productFolderPath.replace(/'/g, "''");
  
  const scriptContent = `
Add-Type -AssemblyName System.IO.Compression.FileSystem
$parentDir = '${escapedPath}'
$zips = Get-ChildItem -Path $parentDir -Filter *.zip -File -Recurse
foreach ($zipFile in $zips) {
    try {
        $zip = [System.IO.Compression.ZipFile]::OpenRead($zipFile.FullName)
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName -match '\\.(jpe?g|png|webp|gif)$') {
                $entryName = $entry.Name
                if ($entryName) {
                    $targetPath = Join-Path $parentDir $entryName
                    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $targetPath, $true)
                }
            }
        }
        $zip.Dispose()
    } catch {}
}
`;
  
  await runPowerShellAsync(scriptContent);
}

// Ensures images are extracted if product folder has 0 or 1 images and contains zip file(s)
async function ensureImagesExtracted(folderPath) {
  try {
    const flagFile = path.join(folderPath, '.extracted-imgs');
    try {
      await fs.access(flagFile);
      // Already extracted/checked, skip to avoid repeating PowerShell overhead
      return;
    } catch {
      // Flag file doesn't exist, proceed
    }

    const images = await getImagesInFolder(folderPath);
    if (images.length <= 1) {
      const hasZip = await hasZipFileRecursive(folderPath);
      if (hasZip) {
        sendLog(`[Scanner]: Folder "${path.basename(folderPath)}" has ${images.length} image(s). Extracting preview images from zip...`);
        await extractImagesFromZips(folderPath);
        // Write flag file so we don't scan it again
        await fs.writeFile(flagFile, 'extracted', 'utf8');
      }
    }
  } catch (_) {}
}

ipcMain.handle('clean-folder-names', async (event, folderPath) => {
  if (isAutomationRunning) {
    return { success: false, message: 'Cannot clean folder names while automation is running.' };
  }
  if (!folderPath) {
    return { success: false, message: 'No folder path selected.' };
  }

  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const subdirs = entries.filter(e => e.isDirectory());

    let renamedCount = 0;
    const processed = await loadProcessed();
    let processedChanged = false;

    for (const dir of subdirs) {
      const originalName = dir.name;
      const cleanedName = cleanFolderName(originalName);

      if (cleanedName !== originalName) {
        const uniqueName = await getUniqueFolderName(folderPath, cleanedName, originalName);
        
        if (uniqueName !== originalName) {
          const oldPath = path.join(folderPath, originalName);
          const newPath = path.join(folderPath, uniqueName);

          await fs.rename(oldPath, newPath);
          sendLog(`[Scanner]: Renamed folder "${originalName}" -> "${uniqueName}"`);
          
          // Update processed.json if this folder was already done
          const idx = processed.indexOf(originalName);
          if (idx !== -1) {
            if (!processed.includes(uniqueName)) {
              processed[idx] = uniqueName;
            } else {
              processed.splice(idx, 1);
            }
            processedChanged = true;
          }

          // Update customizations if any
          const customizations = await loadFolderCustomizations();
          if (customizations[originalName]) {
            customizations[uniqueName] = customizations[originalName];
            delete customizations[originalName];
            await saveFolderCustomizations(customizations);
          }
          
          renamedCount++;
        }
      }
    }

    if (processedChanged) {
      await saveProcessed(processed);
      sendLog(`[Scanner]: Updated processed.json entries for renamed folders.`);
    }

    if (renamedCount > 0) {
      sendLog(`[Scanner]: Successfully cleaned ${renamedCount} folder names.`);
    } else {
      sendLog(`[Scanner]: No folders needed renaming.`);
    }

    return { success: true, renamedCount };
  } catch (err) {
    sendLog(`[Error]: Failed to clean folder names - ${err.message}`);
    return { success: false, message: err.message };
  }
});

// ==================== Real Automation Engine (DeepSeek + Playwright CDP) ====================
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function clickVisibleActionButton(page, label, options = {}) {
  const timeout = options.timeout || 15000;
  const exactLabel = String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labelRegex = new RegExp(`^\\s*${exactLabel}\\s*$`, 'i');
  const deadline = Date.now() + timeout;

  const candidates = [
    page.getByRole('button', { name: labelRegex }),
    page.locator('button, div[role="button"], span[role="button"]').filter({ hasText: labelRegex }),
  ];

  while (Date.now() < deadline) {
    for (const locator of candidates) {
      const count = await locator.count().catch(() => 0);

      for (let index = 0; index < count; index++) {
        const candidate = locator.nth(index);
        const isVisible = await candidate.isVisible().catch(() => false);
        if (!isVisible) continue;

        const ariaLabel = await candidate.getAttribute('aria-label').catch(() => '');
        if (/image|photo|carousel|previous/i.test(ariaLabel || '')) continue;

        const ariaDisabled = await candidate.getAttribute('aria-disabled').catch(() => '');
        const disabledAttr = await candidate.getAttribute('disabled').catch(() => null);
        const isEnabled = await candidate.isEnabled().catch(() => true);
        if (ariaDisabled === 'true' || disabledAttr !== null || !isEnabled) continue;

        await candidate.scrollIntoViewIfNeeded().catch(() => {});
        await candidate.click({ timeout: 5000 });
        return true;
      }
    }

    await delay(350);
  }

  throw new Error(`Could not find an enabled "${label}" action button.`);
}

// Background DeepSeek execution
async function generateDescriptionWithDeepSeek(apiKey, productName) {
  sendLog(`[DeepSeek]: Generating description for "${productName}"...`);
  try {
    const prompt = `Write a high-converting, friendly, and details-rich Facebook Marketplace product description for: "${productName}". 
This is a raw 3D printed DIY cosplay prop/helmet kit (unassembled, unpainted, needs sanding and assembly, printed in PLA/PETG, standard adult sizing, local pickup in Toronto and shipping available).
Make it readable with bullet points. Avoid markdown brackets like [ ] or asterisks * if possible, or keep formatting clean. Do not include price.`;

    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API returned status ${response.status}: ${errText}`);
    }

    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      const text = data.choices[0].message.content.trim();
      sendLog(`[DeepSeek]: Generated description successfully (${text.length} chars).`);
      return text;
    } else {
      throw new Error('Unexpected API response structure');
    }
  } catch (err) {
    sendLog(`[DeepSeek Error]: Description generation failed - ${err.message}. Using generic fallback.`);
    return `${productName} — Raw 3D printed DIY cosplay kit. Unassembled, unpainted, PLA/PETG. Local pickup Toronto, shipping available.`;
  }
}

async function generateTitleWithDeepSeek(apiKey, folderName) {
  sendLog(`[DeepSeek]: Generating title for "${folderName}"...`);
  try {
    const prompt = `Convert this raw folder name into a short, clean Facebook Marketplace listing title (max 8 words, no special characters, no price): "${folderName}". Reply with only the title, nothing else.`;
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: prompt }], max_tokens: 30 })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const title = data.choices?.[0]?.message?.content?.trim();
    if (title) { sendLog(`[DeepSeek]: Title: "${title}"`); return title; }
    throw new Error('Empty response');
  } catch (err) {
    sendLog(`[DeepSeek Warning]: Title generation failed — ${err.message}. Using folder name.`);
    return folderName.replace(/[\d_-]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  }
}

async function diagnoseErrorWithDeepSeek(apiKey, itemName, errorMessage) {
  try {
    const safeError = errorMessage.substring(0, 300);
    const prompt = `My Playwright automation for Facebook Marketplace failed on item "${itemName}" with: "${safeError}". In 1-2 short sentences, what likely went wrong and what should I check?`;
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: prompt }], max_tokens: 80 })
    });
    if (!response.ok) return;
    const data = await response.json();
    const diagnosis = data.choices?.[0]?.message?.content?.trim();
    if (diagnosis) sendLog(`[DeepSeek Diagnosis]: ${diagnosis}`);
  } catch (_) {}
}

const FB_CATEGORY_MAP = {
  'toys': /Toys and games/i,
  'hobbies': /Hobbies/i,
  'collectibles': /Collectibles/i,
  'art': /Art/i,
  'crafts': /Arts and crafts/i,
  'electronics': /Electronics/i,
  'clothing': /Clothing/i,
  'sporting': /Sporting goods/i,
  'other': /Other/i,
};

async function selectCategoryWithDeepSeek(apiKey, productName) {
  try {
    const categories = Object.keys(FB_CATEGORY_MAP).join(', ');
    const prompt = `For a Facebook Marketplace listing titled "${productName}", pick the single most fitting category from this list: ${categories}. Reply with only one word from the list.`;
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: prompt }], max_tokens: 10 })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content?.trim().toLowerCase() || '';
    for (const [key, regex] of Object.entries(FB_CATEGORY_MAP)) {
      if (raw.includes(key)) return regex;
    }
  } catch (_) {}
  return /Toys and games/i;
}

// Playwright routine using user's running Chrome via CDP
// Robust best-effort filling for title (templated), price, description, photos, category, condition.
// FB Marketplace UI changes often, so we use multiple locator strategies + granular error handling.
// Final action is limited to safe "Next" + explicit boost dismissal to avoid auto-activating promote/boost.
async function createFbMarketplaceListing({ title, description, price, imagePaths, titleTemplate, apiKey, uploadState = { count: 0 }, MAX_DAILY_UPLOADS = 15 }) {
  // Prefer explicit IPv4 to avoid the ::1 ECONNREFUSED some users see with "localhost"
  const cdpEndpoints = [
    `http://127.0.0.1:${CONFIG.CDP_PORT}`,
    `http://localhost:${CONFIG.CDP_PORT}`
  ];

  sendLog(`[Playwright]: Connecting to running Chrome on ${cdpEndpoints[0]} (CDP) ...`);

  let browser;
  let lastErr;

  for (const endpoint of cdpEndpoints) {
    try {
      browser = await chromium.connectOverCDP(endpoint);
      sendLog(`[Playwright]: Connected via CDP to the Chrome listening on port ${CONFIG.CDP_PORT} (${endpoint}).`);
      sendBrowserStatus('connected');
      break;
    } catch (e) {
      lastErr = e;
      sendLog(`[Playwright]: Failed to connect on ${endpoint} — ${e.message}`);
    }
  }

  if (!browser) {
    sendLog(`[Playwright Error]: ${lastErr ? lastErr.message : `Could not connect to Chrome on port ${CONFIG.CDP_PORT}`}`);
    sendLog(`[Tip]: Launch Chrome with: chrome.exe --remote-debugging-port=${CONFIG.CDP_PORT} --user-data-dir="${CONFIG.CHROME_PROFILE_DIR}" (and log into Facebook in that window)`);
    return { success: false, message: lastErr ? lastErr.message : 'CDP connect failed' };
  }

  try {
    sendLog(`[!!! WARNING !!!] This automation is now CONTROLLING the Chrome instance that has --remote-debugging-port=${CONFIG.CDP_PORT}.`);
    sendLog(`[!!! WARNING !!!] If this is your MAIN personal Chrome (the one with Gmail, tabs, etc.), automation actions may interfere with it or create listings in the wrong profile.`);
    sendLog(`[!!! WARNING !!!] Recommended: Always use the dedicated "${CONFIG.CHROME_PROFILE_DIR}" Chrome for the bot. Keep your personal Chrome completely separate (no debug port).`);
    sendLog(`[Note]: Use the top-right "Automation Chrome (CDP)" button or Start Automation to ensure the dedicated profile is running.`);

    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    const page = await context.newPage();

    sendLog(`[Playwright]: Navigating to Marketplace (bypassing heavy network load)...`);

    // Use domcontentloaded so Playwright doesn't wait for images and trackers
    await page.goto(CONFIG.MARKETPLACE_URL, { 
      waitUntil: 'domcontentloaded',
      timeout: 60000 
    });

    sendLog(`[Playwright]: Waiting for the Marketplace React form to render...`);

    // Explicitly wait for the Title input field to be visible before we start typing
    await page.getByLabel('Title').waitFor({ state: 'visible', timeout: 15000 });
    sendLog(`[Playwright]: Form detected! Starting input sequence.`);

    // === TITLE (use caller-provided template or default; supports ${name} placeholder) ===
    try {
      sendLog(`[Playwright]: Filling title...`);
      const tpl = (titleTemplate || defaultTitleTemplate || '${name}');
      let filledTitle = tpl.replace(/\$\{name\}/gi, title).trim() || title;
      // Strip numbers, underscores, and dashes commonly found in folder names
      filledTitle = filledTitle.replace(/[\d_-]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      
      const titleInput = page.getByLabel(/title/i)
        .or(page.getByPlaceholder(/what are you selling/i))
        .or(page.locator('input[aria-label*="Title"]'))
        .first();
      await titleInput.waitFor({ state: 'visible', timeout: 25000 });
      await titleInput.scrollIntoViewIfNeeded().catch(() => {});
      await titleInput.fill(filledTitle);
      sendLog(`[Playwright]: Title filled as "${filledTitle}".`);
    } catch (e) {
      sendLog(`[Playwright Warning]: Title fill failed — ${e.message}. (FB UI may have changed; you can edit manually in the open tab.)`);
    }

    // === PRICE ===
    try {
      const priceInput = page.getByLabel(/price/i)
        .or(page.locator('input[aria-label*="Price"]'))
        .or(page.getByPlaceholder(/price/i))
        .first();
      await priceInput.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      await priceInput.fill(String(price));
      sendLog(`[Playwright]: Price set to $${price}.`);
    } catch (e) {
      sendLog(`[Playwright Warning]: Price fill issue — ${e.message}`);
    }

    // === DESCRIPTION ===
    try {
      const descInput = page.getByLabel(/description/i)
        .or(page.locator('textarea[aria-label*="Description"]'))
        .or(page.getByPlaceholder(/describe your item/i))
        .first();
      await descInput.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
      await descInput.fill(description);
      sendLog(`[Playwright]: Description filled.`);
    } catch (e) {
      sendLog(`[Playwright Warning]: Description fill issue — ${e.message}`);
    }

    // === PHOTOS ===
    // Do NOT click the visible "Add Photos" box or use complex ARIA/text selectors
    // (that was causing the "Unexpected token" CSS parse error and broken uploads).
    // Facebook keeps a hidden <input type="file"> under the hood — target it directly.
    if (imagePaths && imagePaths.length > 0) {
      try {
        const sortedImages = [...imagePaths].sort().slice(0, 10); // FB limits max 10 photos
        sendLog(`[Playwright]: Uploading ${sortedImages.length} images from folder...`);
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
        // Sort images so "rendered" or "01_" files come first (per pro-tip: first photo should be the nice digital render)
        await fileInput.setInputFiles(sortedImages);
        await delay(2500); // Give FB time to process and enable the Next button
        sendLog(`[Playwright]: Images uploaded via hidden file input.`);
      } catch (e) {
        sendLog(`[Playwright Warning]: Photo upload issue — ${e.message}. Add the photos manually in the open Chrome window if needed.`);
      }
    } else {
      sendLog(`[Playwright]: Warning — no images found to upload.`);
    }

    // === CATEGORY SELECTION (PAGEDOWN & TEXT BYPASS) ===
    // This replaces the previous Category logic.
    // Condition logic is left exactly as-is.
    try {
      // 1. Click the Category box to open the dropdown
      await page.getByLabel('Category').click();
      await delay(1000);

      // 2. Press PageDown to force the virtualized list to physically render 
      // the bottom items (like Toys) into the DOM.
      sendLog('[Playwright]: Scrolling list down to render categories...');
      await page.keyboard.press('PageDown');
      await delay(400);
      await page.keyboard.press('PageDown');
      await delay(400);
      await page.keyboard.press('PageDown');
      await delay(800);

      // 3. Bypass broken ARIA roles completely and click the raw text.
      const categoryRegex = apiKey
        ? await selectCategoryWithDeepSeek(apiKey, title)
        : /Toys and games/i;
      sendLog(`[DeepSeek]: Using category pattern: ${categoryRegex}`);
      await page.getByText(categoryRegex).last().click({ force: true });
      await delay(1000);

      sendLog('[Playwright]: Category locked in successfully.');
    } catch (error) {
      sendLog(`[Playwright Error]: Category PageDown method failed: ${error.message}`);
    }

    // === CONDITION (using robust ARIA combobox) ===
    try {
      sendLog(`[Playwright]: Selecting Condition (combobox)...`);
      const condCombobox = page.getByRole('combobox', { name: /condition/i });
      if (await condCombobox.isVisible({ timeout: 6000 }).catch(() => false)) {
        await condCombobox.click();
        await delay(900); // allow dropdown to render
        // Use 'New' per example, or good alternatives for printed props
        const condOption = page.getByRole('option', { name: /new|used - like new|used - good/i }).first();
        if (await condOption.isVisible({ timeout: 5000 }).catch(() => false)) {
          await condOption.click();
          await delay(700);
          sendLog(`[Playwright]: Condition selected via combobox.`);
        } else {
          await page.getByRole('option').first().click().catch(() => {});
          await delay(700);
          sendLog(`[Playwright]: Condition selected (fallback).`);
        }
      }
    } catch (e) {
      sendLog(`[Playwright Warning]: Condition combobox failed — ${e.message}. Next may stay disabled.`);
    }

    // === FINAL PUBLISH SEQUENCE ===
    sendLog('[Playwright]: Clicking Next to advance to the review screen...');
    try {
      // 1. Click Next on the first page
      await clickVisibleActionButton(page, 'Next', { timeout: 20000 });
      await delay(3000); // Wait 3 seconds for the review screen to slide in
      
      // 2. Click the final Publish button
      sendLog('[Playwright]: Clicking final Publish button...');
      await clickVisibleActionButton(page, 'Publish', { timeout: 25000 });
      
      // Wait 7 seconds for Facebook to process the upload and route back to the dashboard
      sendLog('[Playwright]: Waiting for Facebook to process the listing...');
      await delay(7000); 
      
      sendLog('[Marketplace]: Listing successfully published!');
      uploadState.count++;
      sendLog(`[System]: Upload successful. Daily limit tracker: ${uploadState.count}/${MAX_DAILY_UPLOADS}.`);
    } catch (error) {
      sendLog(`[Playwright Error]: Failed in the Publish sequence: ${error.message}`);
      throw error; // Throw error so it doesn't get added to processed.json if it fails
    }

    // exportFBCookies() was removed as it caused ReferenceErrors
    // Cookies are stored naturally in the --user-data-dir Chrome profile

    // === CDP BEST PRACTICE (fixes the common "kills my Chrome" bug) ===
    // We used connectOverCDP, so we MUST call .disconnect() (not .close()).
    // .close() would terminate the entire attached Chrome process.
    // .disconnect() only detaches Playwright's client — the Chrome window and the
    // new draft tab stay fully alive and interactive for the user.
    try {
      await browser.disconnect();
      sendLog(`[Playwright]: Client disconnected from CDP. Chrome + draft tab left running.`);
    } catch (e) {
      // Non-fatal
    }

    return { success: true };
  } catch (err) {
    sendLog(`[Playwright Error]: ${err.message}`);
    sendLog(`[Tip]: Launch Chrome with: chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\\chrome-automation-profile" (and log into Facebook in that window)`);

    // Best-effort cleanup: if we connected, disconnect instead of close
    if (browser) {
      try { await browser.disconnect(); } catch (_) {}
    }
    return { success: false, message: err.message };
  }
}

// Dynamic description generator using custom/loaded templates
function getDescriptionFromTemplate(templatesMap, templateKey, productName) {
  const tpl = templatesMap[templateKey];
  if (!tpl || !tpl.text) {
    return `3D Printed DIY Cosplay Prop Kit - ${productName}`;
  }
  // Replace ${name} or ${productName} with the actual product name
  return tpl.text
    .replace(/\$\{name\}/g, productName)
    .replace(/\$\{productName\}/g, productName);
}

// Main orchestration for a single item (used by both full run and single-item button)
async function processOneItem(item, uploadState = { count: 0 }, MAX_DAILY_UPLOADS = 15) {
  item.status = 'Processing';
  sendQueueUpdate();
  sendLog(`[System]: === Starting workflow for "${item.name}" ===`);

  try {
    // 1. Discover images
    await ensureImagesExtracted(item.fullPath);
    const imagePaths = await getImagesInFolder(item.fullPath);
    sendLog(`[Scanner]: Found ${imagePaths.length} image(s) in folder.`);

    // 1. Load settings once for all DeepSeek features in this item's run
    const settings = await loadSettings();
    const deepseekKey = settings.deepseekApiKey || null;

    // AI Title Generation
    let productName = item.name;
    if (deepseekKey) {
      productName = await generateTitleWithDeepSeek(deepseekKey, item.name);
    }

    // 2. Description generation (pre-generated, templates, or DeepSeek)
    let description;
    if (item.generatedDescription) {
      description = item.generatedDescription;
      sendLog(`[System]: Using pre-generated DeepSeek description for "${item.name}".`);
    } else {
      const template = item.template || 'universal';
      if (template !== 'deepseek') {
        const templatesMap = await loadTemplatesInternal();
        description = getDescriptionFromTemplate(templatesMap, template, productName);
        sendLog(`[System]: Generated description using template "${template}".`);
      } else {
        if (deepseekKey) {
          description = await generateDescriptionWithDeepSeek(deepseekKey, productName);
        } else {
          sendLog(`[System Warning]: No DeepSeek API key set. Using template fallback.`);
          const templatesMap = await loadTemplatesInternal();
          description = getDescriptionFromTemplate(templatesMap, 'universal', productName);
        }
      }
    }

    // 3. Playwright CDP posting flow - use custom price if specified
    const priceToUse = (item.price != null) ? item.price : defaultPrice;
    const result = await createFbMarketplaceListing({
      title: productName,
      description,
      price: priceToUse,
      imagePaths,
      titleTemplate: defaultTitleTemplate,
      apiKey: deepseekKey,
      uploadState,
      MAX_DAILY_UPLOADS
    });

    if (result.success) {
      item.status = 'Done';

      // Persist to processed.json so future scans filter it out (use folderName = item.name)
      const processed = await loadProcessed();
      if (!processed.includes(item.name)) {
        processed.push(item.name);
        await saveProcessed(processed);
      }

      sendLog(`[System]: "${item.name}" marked Done and added to processed.json.`);
      return true;
    } else {
      item.status = 'Failed';
      sendLog(`[Error]: Playwright flow failed for "${item.name}". Item left in queue (not added to processed.json).`);
      return false;
    }
  } catch (err) {
    item.status = 'Failed';
    sendLog(`[Error]: ${err.message} while processing "${item.name}". Item left in queue (not added to processed.json).`);
    throw err; // rethrow for AI diagnosis in the main loop
  } finally {
    sendQueueUpdate();
  }
}

// Background runner that respects pause and processes pending items one-by-one
async function runAutomationLoop() {
  isAutomationRunning = true;
  isAutomationPaused = false;
  sendStatusUpdate();

  const MAX_DAILY_UPLOADS = 15;
  const uploadState = { count: 0 };

  // Work on a copy of current pending items
  const itemsToProcess = currentQueue.filter(i => i.status === 'Pending');

  for (const item of itemsToProcess) {
    if (uploadState.count >= MAX_DAILY_UPLOADS) {
      sendLog(`[System]: DAILY UPLOAD LIMIT REACHED (${MAX_DAILY_UPLOADS}). Stopping automation to protect account.`);
      break;
    }

    // Pause support
    while (isAutomationPaused && isAutomationRunning) {
      await delay(250);
    }
    if (!isAutomationRunning) break;

    try {
      const ok = await processOneItem(item, uploadState, MAX_DAILY_UPLOADS);
      if (ok && item !== itemsToProcess[itemsToProcess.length - 1] && isAutomationRunning) {
        const waitTimeMs = Math.floor(Math.random() * (CONFIG.MAX_POST_DELAY_MS - CONFIG.MIN_POST_DELAY_MS + 1)) + CONFIG.MIN_POST_DELAY_MS;
        const waitTimeMins = (waitTimeMs / 60000).toFixed(2);
        sendLog(`[System]: Success! Resting for ${waitTimeMins} minutes to emulate human behavior before the next item...`);

        const startTime = Date.now();
        while (Date.now() - startTime < waitTimeMs && isAutomationRunning) {
          if (isAutomationPaused) {
            await delay(250);
            continue;
          }
          await delay(500);
        }
      }
    } catch (error) {
      sendLog(`[Playwright Error]: Flow failed for ${item.name}: ${error.message}`);
      const diagSettings = await loadSettings().catch(() => ({}));
      if (diagSettings.deepseekApiKey) {
        await diagnoseErrorWithDeepSeek(diagSettings.deepseekApiKey, item.name, error.message);
      }
      sendLog(`[System]: Safely skipping ${item.name} and moving to the next item to prevent queue freeze.`);
      // Note: Do NOT add to processed.json so it can be retried later.
      continue; // Move to the next item in the for...of loop
    }

    await delay(650); // polite gap between items
    if (!isAutomationRunning) break;
  }

  const remainingPending = currentQueue.some(i => i.status === 'Pending');
  if (!remainingPending && isAutomationRunning) {
    sendLog('[System]: All pending items completed for this run!');
  }

  isAutomationRunning = false;
  isAutomationPaused = false;
  sendStatusUpdate();
  sendQueueUpdate();
}

ipcMain.handle('start-automation', async (event, payload) => {
  if (isAutomationRunning) return { success: false, message: 'Already running' };

  if (payload && payload.defaultPrice != null) {
    defaultPrice = payload.defaultPrice;
  }
  if (payload && payload.titleTemplate != null) {
    defaultTitleTemplate = payload.titleTemplate || '${name}';
  }
  if (payload && payload.folder) {
    targetFolder = payload.folder;
  }

  if (!targetFolder) {
    sendLog('[Error]: No target folder selected.');
    return { success: false };
  }

  // Fresh filtered scan so queue reflects processed.json
  const processed = await loadProcessed();
  const customizations = await loadFolderCustomizations();
  // Re-scan to ensure we have latest image info etc.
  const allSubdirs = (await fs.readdir(targetFolder, { withFileTypes: true }))
    .filter(e => e.isDirectory())
    .map(d => d.name);

  currentQueue = [];
  const itemsLookup = {};
  if (payload && Array.isArray(payload.items)) {
    payload.items.forEach(i => {
      itemsLookup[i.name] = i;
    });
  }

  for (const name of allSubdirs) {
    const isProcessed = processed.includes(name);
    const fullPath = path.join(targetFolder, name);
    await ensureImagesExtracted(fullPath);
    const thumb = await findFirstImage(fullPath);

    const lookup = itemsLookup[name];
    const custom = customizations[name] || {};
    const itemPrice = (lookup && lookup.price != null) ? lookup.price : (custom.price != null ? custom.price : defaultPrice);
    const itemTemplate = (lookup && lookup.template) ? lookup.template : (custom.template ? custom.template : 'universal');

    const images = await getImagesInFolder(fullPath);
    const validity = getFolderValidity(name, images.length);

    currentQueue.push({
      name,
      fullPath,
      status: isProcessed ? 'Done' : validity.status,
      errorReason: isProcessed ? null : validity.reason,
      thumb,
      price: itemPrice,
      template: itemTemplate
    });
  }

  sendQueueUpdate();

  const pendingCount = currentQueue.filter(i => i.status === 'Pending').length;
  if (pendingCount === 0) {
    sendLog('[System]: No pending items to process.');
    return { success: false };
  }

  // === Pre-flight: make sure the dedicated Chrome with remote debugging is running ===
  // This is the Chrome the user must be logged into Facebook inside (the one with the automation profile).
  // If not present we auto-launch it here so the subsequent CDP steps succeed.
  const cdpReady = await ensureAutomationBrowserReady();
  if (!cdpReady) {
    sendLog('[Error]: Automation Chrome (port 9222) is not available. Launch it using the top-right button, keep the window open, log into Facebook there, then press Start again.');
    isAutomationRunning = false;
    isAutomationPaused = false;
    sendStatusUpdate();
    return { success: false, message: 'Automation Chrome not ready' };
  }

  sendLog(`[System]: Starting automation for ${pendingCount} items. Default price $${defaultPrice}.`);
  runAutomationLoop(); // background, non-blocking
  return { success: true };
});

ipcMain.handle('pause-automation', async () => {
  isAutomationPaused = !isAutomationPaused;
  sendStatusUpdate();
  sendLog(isAutomationPaused ? '[System]: Paused by user.' : '[System]: Resumed.');
  return { paused: isAutomationPaused };
});

ipcMain.handle('stop-automation', async () => {
  isAutomationRunning = false;
  isAutomationPaused = false;
  sendStatusUpdate();
  sendLog('[System]: Automation stopped by user.');
  return { success: true };
});

// Single item from the per-row "Process" button
ipcMain.handle('run-single-item', async (event, payload) => {
  const { folder, defaultPrice: newPrice, titleTemplate: newTitleTemplate } = payload || {};
  if (newPrice != null) defaultPrice = newPrice;
  if (newTitleTemplate != null) defaultTitleTemplate = newTitleTemplate || '${name}';

  if (!folder || !currentQueue.length) {
    return { success: false, message: 'No folder or queue' };
  }

  // Find the item (by index if provided, or first pending)
  let item = currentQueue.find(i => i.status === 'Pending');
  if (payload && typeof payload.index === 'number' && currentQueue[payload.index]) {
    item = currentQueue[payload.index];
  }

  if (!item || item.status !== 'Pending') {
    sendLog('[System]: No pending item to process singly.');
    return { success: false };
  }

  if (item && payload) {
    if (payload.price != null) item.price = payload.price;
    if (payload.template != null) item.template = payload.template;
  }

  sendLog(`[System]: Single-item mode for "${item.name}"`);
  const ok = await processOneItem(item);
  return { success: ok };
});

ipcMain.handle('mark-item-done', async (event, payload) => {
  const { index, name } = payload || {};
  let item = null;

  if (typeof index === 'number' && currentQueue[index]) {
    item = currentQueue[index];
  } else if (name) {
    item = currentQueue.find(queueItem => queueItem.name === name);
  }

  if (!item) {
    return { success: false, message: 'Item not found in queue.' };
  }

  if (item.status === 'Processing') {
    return { success: false, message: 'Cannot mark an item done while it is processing.' };
  }

  const processed = await loadProcessed();
  if (!processed.includes(item.name)) {
    processed.push(item.name);
    await saveProcessed(processed);
  }

  item.status = 'Done';
  sendQueueUpdate();
  sendLog(`[System]: "${item.name}" manually marked Done and added to processed.json.`);

  return { success: true, name: item.name };
});

ipcMain.handle('republish-item', async (event, payload) => {
  const { name } = payload || {};
  if (!name) return { success: false, message: 'No item name provided' };

  // 1. Remove from processed.json
  const processed = await loadProcessed();
  const idx = processed.indexOf(name);
  if (idx !== -1) {
    processed.splice(idx, 1);
    await saveProcessed(processed);
  }

  // 2. Find it in currentQueue
  let item = currentQueue.find(i => i.name === name);
  if (!item && targetFolder) {
    const fullPath = path.join(targetFolder, name);
    await ensureImagesExtracted(fullPath);
    const thumb = await findFirstImage(fullPath);
    const images = await getImagesInFolder(fullPath);
    const validity = getFolderValidity(name, images.length);
    const customizations = await loadFolderCustomizations();
    const custom = customizations[name] || {};
    item = {
      name,
      fullPath,
      status: validity.status,
      errorReason: validity.reason,
      thumb,
      price: custom.price,
      template: custom.template
    };
    currentQueue.push(item);
  }

  if (item) {
    // Reset status to Pending (or Review if invalid)
    const images = await getImagesInFolder(item.fullPath);
    const validity = getFolderValidity(item.name, images.length);
    item.status = validity.status;
    item.errorReason = validity.reason;
    sendQueueUpdate();

    if (item.status === 'Pending') {
      sendLog(`[System]: Republishing "${name}"...`);
      // Start in background
      processOneItem(item).catch(err => {
        sendLog(`[Error]: Republish failed for "${name}" - ${err.message}`);
      });
      return { success: true, status: 'Processing' };
    } else {
      sendLog(`[System]: "${name}" moved back to pending but requires review: ${item.errorReason}`);
      return { success: true, status: 'Review' };
    }
  }

  return { success: false, message: 'Item not found on disk' };
});

ipcMain.handle('set-default-price', (event, price) => {
  defaultPrice = price;
  sendLog(`[System]: Default price updated to $${price}`);
  return true;
});

ipcMain.handle('set-default-title-template', (event, template) => {
  defaultTitleTemplate = template || '${name}';
  sendLog(`[System]: Default title template updated to "${defaultTitleTemplate}"`);
  return true;
});

// (Duplicate run-single-item removed — the robust version is defined above)

// ==================== Automation Chrome Launcher (the one that must be running for CDP) ====================
// This launches the *user's installed Google Chrome* with a dedicated profile + remote debugging.
// This is DIFFERENT from the "launchDebugBrowser" which starts Playwright's bundled Chromium.
// The dedicated profile keeps your Facebook login persistent (as long as you do not close that window).

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
].filter(Boolean);

function findChromeExecutable() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      // fs from promises doesn't have sync exists, but we can use a sync require here for simplicity in main
      const fsSync = require('fs');
      if (fsSync.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return null;
}

function killBotChrome() {
  if (process.platform !== 'win32') return;
  const ps = `
$profile = "C:\\chrome-automation-profile"
$port = 9222
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.CommandLine -and ($_.CommandLine -like "*$profile*" -or $_.CommandLine -like "*remote-debugging-port=$port*")) {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
`;
  runPowerShell(ps);
}

function bringChromeToFront() {
  if (process.platform !== 'win32') return;
  const script = `
$profile = "C:\\chrome-automation-profile"
$processes = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$profile*" }
if ($processes) {
  Add-Type -Name Win32 -Namespace Win32 -MemberDefinition @"
[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")]
public static extern bool SetForegroundWindow(IntPtr hWnd);
"@
  for ($i=0; $i -lt 5; $i++) {
    foreach ($proc in $processes) {
      $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
      if ($p -and $p.MainWindowHandle -ne 0) {
        [Win32.Win32]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
        [Win32.Win32]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
      }
    }
    Start-Sleep -Milliseconds 300
  }
}
`;
  runPowerShell(script);
}

function setChromeWindowVisible(visible) {
  chromeVisible = visible;
  if (process.platform !== 'win32') return;

  const nCmdShow = visible ? 9 : 0; // SW_RESTORE : SW_HIDE
  const script = `
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;

public class WindowHelper {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    
    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static List<IntPtr> GetProcessWindows(int processId) {
        List<IntPtr> windows = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid == processId) {
                StringBuilder className = new StringBuilder(256);
                GetClassName(hWnd, className, className.Capacity);
                if (className.ToString() == "Chrome_WidgetWin_1") {
                    windows.Add(hWnd);
                }
            }
            return true;
        }, IntPtr.Zero);
        return windows;
    }
}
'@

Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue

$profile = "C:\\chrome-automation-profile"
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.CommandLine -and ($_.CommandLine -like "*$profile*")) {
    [WindowHelper]::GetProcessWindows($_.ProcessId) | ForEach-Object {
      [WindowHelper]::ShowWindow($_, ${nCmdShow}) | Out-Null
      if (${visible ? '$true' : '$false'}) {
        [WindowHelper]::SetForegroundWindow($_) | Out-Null
      }
    }
  }
}
`;

  try {
    runPowerShell(script);
  } catch (_) {}
}

async function launchAutomationChrome(visible = chromeVisible) {
  chromeVisible = visible;
  killBotChrome();
  await delay(800);

  const chromePath = findChromeExecutable();
  const userDataDir = 'C:\\chrome-automation-profile';
  const debugPort = 9222;

  if (!chromePath) {
    sendLog('[Error]: Could not find Google Chrome. Install it or launch manually with the flags below.');
    sendLog(`[Tip]: chrome.exe --remote-debugging-port=${debugPort} --user-data-dir="${userDataDir}"`);
    sendBrowserStatus('disconnected');
    return { success: false, message: 'Chrome not found' };
  }

  // === The key to "never login again" ===
  // We always use the exact same userDataDir. Chrome stores cookies, localStorage, session, etc. inside it.
  // As long as you launch with this same profile, the FB login survives restarts (unless you log out or FB forces re-auth).
  const fsSync = require('fs');
  const profileExists = fsSync.existsSync(userDataDir);

  if (profileExists) {
    try {
      const stats = fsSync.statSync(userDataDir);
      const ageDays = Math.floor((Date.now() - stats.mtimeMs) / (1000 * 60 * 60 * 24));
      sendLog(`[Session]: Existing automation profile found (last used ~${ageDays} day(s) ago). Previous Facebook login + cookies should be remembered automatically.`);
    } catch (_) {
      sendLog(`[Session]: Existing automation profile folder detected at ${userDataDir}. Login from prior sessions should persist.`);
    }
  } else {
    sendLog(`[Session]: Creating NEW automation profile at ${userDataDir}.`);
    sendLog(`[Session]: You will need to log into Facebook ONCE in the window that is about to open. After that, re-using this profile means you should not have to sign in again.`);
  }

  // Best-effort: if a previous bot instance using this profile is running we still launch — Chrome will reuse the profile.
  // For a completely fresh instance per user's "close earlier before new" testing rule, close the previous bot window first (or use start-debug.ps1).
  sendLog(`[System]: Launching dedicated automation Chrome (profile: ${userDataDir}, port ${debugPort})...`);
  sendBrowserStatus('connecting');

  try {
    // Use spawn with shell:true to launch Chrome — this is the Node.js equivalent of
    // PowerShell's Start-Process (which the working start-debug.ps1 uses). The shell
    // (cmd.exe) resolves paths and sets up the console/window environment properly.
    // Without shell:true, Chrome's GPU process fails to initialize → white window.
    // Without detached + unref, Chrome dies when Electron exits.
    // We use stdio:'ignore' to avoid buffer limits (unlike exec which can kill Chrome
    // if its output exceeds the 200KB default buffer, especially in packaged builds).
    const shellCmd = `"${chromePath}" --remote-debugging-port=${debugPort} --user-data-dir="${userDataDir}" --no-first-run --no-default-browser-check --no-sandbox${visible ? ' --start-maximized' : ' --headless=new --start-minimized'}`;
    sendLog(`[System]: Shell launching: ${shellCmd}`);

    const child = spawn(shellCmd, [], {
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: !visible
    });

    child.unref();

    // For visible mode, bring the window to front as soon as possible (don't wait for full CDP)
    if (visible) {
      await delay(2500);
      bringChromeToFront();
      await delay(1000);
      bringChromeToFront();
    }

    // Give Chrome a moment to start the debug server (for CDP / automation)
    await delay(visible ? 1000 : 2000);

    // Quick probe
    const ready = await isCdpAvailable();
    if (ready) {
      sendLog(`[System]: Dedicated automation Chrome is now running (${visible ? 'VISIBLE' : 'HIDDEN/headless'} mode).`);
      sendLog('[Important]: Your Facebook login lives in this profile. Use the UI toggles to switch visibility. For first-time login you may need to launch visibly once. The profile will remember it. Only log in here — never in your personal Chrome.');
      sendBrowserStatus('connected');

      if (visible) {
        bringChromeToFront();
        await delay(300);
        bringChromeToFront();
      }

      // Auto-export current cookies as a live backup (if any are present)
      // This gives you a "copy cookies" safety net even if the profile folder gets lost.
      setTimeout(() => { exportFBCookies().catch(() => {}); }, 1500);

      return { success: true };
    } else {
      sendLog('[System]: Chrome launched but CDP not yet reachable. It may still be starting — try Start Automation in a few seconds.');
      sendBrowserStatus('connecting');
      return { success: true }; // launched, caller can retry
    }
  } catch (err) {
    sendLog(`[Error]: Failed to launch automation Chrome — ${err.message}`);
    sendBrowserStatus('disconnected');
    return { success: false, message: err.message };
  }
}

let terminalWindowHandle = null;

function getTerminalWindowHandle() {
  if (terminalWindowHandle !== null) return terminalWindowHandle;
  if (process.platform !== 'win32') return null;

  const rootPid = process.pid;
  const script = `
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;

public class ConsoleFinder {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    
    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    public static List<IntPtr> GetProcessConsoleWindows(List<int> pids) {
        List<IntPtr> windows = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pids.Contains((int)pid)) {
                StringBuilder className = new StringBuilder(256);
                GetClassName(hWnd, className, className.Capacity);
                string cls = className.ToString();
                if (cls == "ConsoleWindowClass" || cls == "CASCADIA_HOSTING_WINDOW_CLASS") {
                    windows.Add(hWnd);
                }
            }
            return true;
        }, IntPtr.Zero);
        return windows;
    }
}
'@

Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue

$pidsList = New-Object System.Collections.Generic.List[int]
$pidToCheck = ${rootPid}
$visited = @{}
for ($i = 0; $i -lt 8 -and $pidToCheck -and -not $visited.ContainsKey($pidToCheck); $i++) {
  $visited[$pidToCheck] = $true
  $pidsList.Add($pidToCheck)
  $wmi = Get-CimInstance Win32_Process -Filter "ProcessId = $pidToCheck" -ErrorAction SilentlyContinue
  if (-not $wmi) { break }
  $pidToCheck = $wmi.ParentProcessId
}

$wins = [ConsoleFinder]::GetProcessConsoleWindows($pidsList)
if ($wins.Count -gt 0) {
  Write-Output $wins[0]
}
`;

  try {
    const tmpFile = path.join(os.tmpdir(), `fb-auto-find-${Date.now()}.ps1`);
    fsSync.writeFileSync(tmpFile, script, 'utf8');
    const stdout = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, { windowsHide: true });
    try { fsSync.unlinkSync(tmpFile); } catch (_) {}
    const handleStr = stdout.toString().trim();
    if (handleStr) {
      terminalWindowHandle = parseInt(handleStr, 10);
      return terminalWindowHandle;
    }
  } catch (e) {
    // ignore
  }
  return null;
}

function setTerminalVisible(visible) {
  terminalVisible = visible;
  if (process.platform !== 'win32') return;

  const handle = getTerminalWindowHandle();
  if (handle) {
    const nCmdShow = visible ? 5 : 0; // SW_SHOW : SW_HIDE
    const script = `
Add-Type -Name Win32ShowConsole -Namespace Win32 -MemberDefinition @"
[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
"@
[Win32.Win32ShowConsole]::ShowWindow([IntPtr]${handle}, ${nCmdShow}) | Out-Null
`;
    runPowerShell(script);
  }
}

// Force close the terminal/console window hosting this app (if any).
// Used on program close so that "when I close my program it should force and close terminal and bot chrome (visible or hidden)".
// If the app was launched fully hidden (no console allocated), GetConsoleWindow() returns 0 and this is a no-op.
// This cleanly closes the cmd/pwsh window even if it was visible or hidden.
function forceCloseTerminal() {
  if (process.platform !== 'win32') return;
  const handle = getTerminalWindowHandle();
  if (handle) {
    const script = `
Add-Type -Name Win32CloseConsole -Namespace Win32 -MemberDefinition @"
[DllImport("user32.dll")]
public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
"@
[Win32.Win32CloseConsole]::PostMessage([IntPtr]${handle}, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
`;
    runPowerShell(script);
  }
}

ipcMain.handle('toggle-chrome-visibility', async () => {
  const newVisible = !chromeVisible;
  await launchAutomationChrome(newVisible);
  if (newVisible) {
    await delay(1000);
    bringChromeToFront();
  }
  return chromeVisible;
});

ipcMain.handle('get-chrome-visibility', () => chromeVisible);

ipcMain.handle('toggle-terminal-visibility', () => {
  setTerminalVisible(!terminalVisible);
  return terminalVisible;
});

ipcMain.handle('get-terminal-visibility', () => terminalVisible);

async function isCdpAvailable() {
  const endpoints = ['http://127.0.0.1:9222', 'http://localhost:9222'];
  for (const ep of endpoints) {
    try {
      const b = await chromium.connectOverCDP(ep);
      try { await b.disconnect(); } catch (_) {}
      return true;
    } catch (_) {
      // try next
    }
  }
  return false;
}

async function ensureAutomationBrowserReady() {
  const ready = await isCdpAvailable();
  if (ready) {
    sendLog('[Playwright]: Automation Chrome (CDP) already reachable on port 9222.');
    sendBrowserStatus('connected');
    return true;
  }

  sendLog('[System]: No automation Chrome detected on port 9222. Launching dedicated instance now...');
  const launchResult = await launchAutomationChrome();
  if (!launchResult.success) {
    sendBrowserStatus('disconnected');
    return false;
  }

  // Second chance after launch
  await delay(1800);
  const ready2 = await isCdpAvailable();
  if (ready2) {
    sendBrowserStatus('connected');
    return true;
  }

  sendLog('[Warning]: Chrome was launched but is still not accepting connections. You may need to wait a couple more seconds or click the header Launch button again.');
  sendBrowserStatus('connecting');
  return false;
}

// ==================== Persistent Login Helpers (cookie backup + profile folder) ====================
// The primary mechanism is the --user-data-dir profile (Chrome writes cookies there automatically).
// These helpers give you an explicit "copy cookies" export/import as a backup / recovery tool.

async function openAutomationProfileFolder() {
  const userDataDir = 'C:\\chrome-automation-profile';
  try {
    await shell.openPath(userDataDir);
    sendLog(`[Session]: Opened automation profile folder: ${userDataDir}`);
    sendLog(`[Session]: The "Default" subfolder contains your cookies, logins, etc. You can back up this entire folder to never lose the session.`);
    return { success: true };
  } catch (err) {
    sendLog(`[Session Error]: Could not open profile folder — ${err.message}`);
    return { success: false, message: err.message };
  }
}

async function exportFBCookies() {
  // Briefly connect over CDP, pull cookies for facebook domains, and save them as a portable backup.
  let browser = null;
  try {
    const endpoints = ['http://127.0.0.1:9222', 'http://localhost:9222'];
    for (const ep of endpoints) {
      try {
        browser = await chromium.connectOverCDP(ep);
        break;
      } catch (_) {}
    }
    if (!browser) throw new Error('No running automation Chrome on port 9222');

    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();

    const allCookies = await context.cookies();
    const fbCookies = allCookies.filter(c =>
      (c.domain || '').includes('facebook') ||
      (c.domain || '').includes('fb.com') ||
      (c.domain || '').includes('.facebook.com')
    );

    await fs.writeFile(fbCookiesFile, JSON.stringify(fbCookies, null, 2));
    sendLog(`[Session]: Backed up ${fbCookies.length} Facebook cookies to ${fbCookiesFile}`);
    sendLog(`[Session]: This is your "copy cookies" safety net. You can restore them later even if you have to use a fresh profile.`);
    return { success: true, count: fbCookies.length, path: fbCookiesFile };
  } catch (err) {
    sendLog(`[Session Error]: Export cookies failed — ${err.message}`);
    return { success: false, message: err.message };
  } finally {
    if (browser) {
      try { await browser.disconnect(); } catch (_) {}
    }
  }
}

async function importFBCookies() {
  // Loads the saved fb-cookies.json and injects them into the currently running automation Chrome.
  // This makes the browser "logged in" for the current session without you typing credentials again.
  // Note: For the login to survive future launches, the cookies must also get written into the profile
  // (which usually happens automatically once you visit facebook.com after injection).
  try {
    const raw = await fs.readFile(fbCookiesFile, 'utf8');
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw new Error('No saved cookies found (or file is empty). Export first while logged in.');
    }

    let browser = null;
    const endpoints = ['http://127.0.0.1:9222', 'http://localhost:9222'];
    for (const ep of endpoints) {
      try {
        browser = await chromium.connectOverCDP(ep);
        break;
      } catch (_) {}
    }
    if (!browser) {
      // Try to launch it for the user
      await launchAutomationChrome();
      await delay(2500);
      for (const ep of endpoints) {
        try {
          browser = await chromium.connectOverCDP(ep);
          break;
        } catch (_) {}
      }
    }
    if (!browser) throw new Error('Could not connect to automation Chrome to inject cookies.');

    const context = browser.contexts().length > 0 ? browser.contexts()[0] : await browser.newContext();
    await context.addCookies(cookies);
    sendLog(`[Session]: Injected ${cookies.length} saved Facebook cookies into the running Chrome.`);

    // Visit facebook so the session activates and Chrome has a chance to persist the cookies into the profile
    const page = await context.newPage();
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await delay(1800);
    sendLog(`[Session]: Session restored. Check the Chrome window — you should now appear logged in.`);

    try { await browser.disconnect(); } catch (_) {}
    return { success: true, count: cookies.length };
  } catch (err) {
    sendLog(`[Session Error]: Restore cookies failed — ${err.message}`);
    return { success: false, message: err.message };
  }
}

// IPC for manual control from UI
ipcMain.handle('launch-automation-chrome', async () => {
  return launchAutomationChrome();
});

ipcMain.handle('check-automation-browser', async () => {
  const ok = await isCdpAvailable();
  sendBrowserStatus(ok ? 'connected' : 'disconnected');
  return { ready: ok };
});

ipcMain.handle('open-automation-profile', openAutomationProfileFolder);
ipcMain.handle('export-fb-cookies', exportFBCookies);
ipcMain.handle('import-fb-cookies', importFBCookies);

ipcMain.handle('restart-chrome', async (event, isVisible) => {
  // Always kill and relaunch when toggling — you can't make a headless Chrome visible
  // or vice versa without fully restarting the process.
  killBotChrome();
  await delay(600);
  await launchAutomationChrome(isVisible);
  return chromeVisible;
});

// ==================== Debug Browser (Playwright) - separate "Launch" button for visible browser (different from CDP automation) ====================
async function launchDebugBrowser() {
  if (debugBrowser) {
    sendLog('[System]: Debug browser already running.');
    sendBrowserStatus('connected');
    return { success: true };
  }

  try {
    sendLog('[System]: Launching local debug browser (Playwright Chromium)...');
    sendBrowserStatus('connecting');

    debugBrowser = await chromium.launch({
      headless: false,
      slowMo: 30,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-default-browser-check',
      ],
    });

    const page = await debugBrowser.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded' });

    sendLog('[System]: Debug browser ready at Facebook Marketplace create page.');
    sendBrowserStatus('connected');
    return { success: true };
  } catch (err) {
    sendLog(`[Error]: Failed to launch debug browser — ${err.message}`);
    debugBrowser = null;
    sendBrowserStatus('disconnected');
    return { success: false, message: err.message };
  }
}

async function closeDebugBrowser() {
  if (debugBrowser) {
    try {
      await debugBrowser.close();
      sendLog('[System]: Debug browser closed.');
    } catch (_) {}
    debugBrowser = null;
  }
  sendBrowserStatus('disconnected');
}

ipcMain.handle('launch-debug-browser', launchDebugBrowser);
ipcMain.handle('close-debug-browser', closeDebugBrowser);

ipcMain.handle('load-templates', async () => {
  return await loadTemplatesInternal();
});
ipcMain.handle('save-templates', async (event, templates) => {
  return await saveTemplatesInternal(templates);
});
ipcMain.handle('rename-folder', async (event, payload) => {
  const { parentPath, oldName, newName } = payload || {};
  if (!parentPath || !oldName || !newName) {
    return { success: false, message: 'Invalid arguments' };
  }
  
  const oldPath = path.join(parentPath, oldName);
  const newPath = path.join(parentPath, newName);
  
  try {
    try {
      await fs.access(newPath);
      return { success: false, message: `Folder "${newName}" already exists.` };
    } catch (_) {}
    
    await fs.rename(oldPath, newPath);
    
    // Also sync processed.json if the old folder was processed
    const processed = await loadProcessed();
    const idx = processed.indexOf(oldName);
    if (idx !== -1) {
      if (!processed.includes(newName)) {
        processed[idx] = newName;
      } else {
        processed.splice(idx, 1);
      }
      await saveProcessed(processed);
    }

    // Also sync folder customizations if any
    const customizations = await loadFolderCustomizations();
    if (customizations[oldName]) {
      customizations[newName] = customizations[oldName];
      delete customizations[oldName];
      await saveFolderCustomizations(customizations);
    }
    
    sendLog(`[System]: Folder renamed on disk from "${oldName}" to "${newName}"`);
    return { success: true };
  } catch (err) {
    sendLog(`[Error]: Failed to rename folder - ${err.message}`);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('open-folder', async (event, folderPath) => {
  if (!folderPath) return false;
  try {
    await shell.openPath(folderPath);
    return true;
  } catch (err) {
    sendLog(`[Error]: Failed to open folder - ${err.message}`);
    return false;
  }
});

ipcMain.handle('save-folder-customization', async (event, payload) => {
  const { folderName, price, template } = payload || {};
  if (!folderName) return false;
  const customizations = await loadFolderCustomizations();
  customizations[folderName] = { price, template };
  return await saveFolderCustomizations(customizations);
});

// DeepSeek settings and verification
ipcMain.handle('validate-deepseek-key', async (event, key) => {
  if (!key) {
    return { success: false, message: 'API key is empty.' };
  }
  sendLog(`[DeepSeek]: Validating API key...`);
  try {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'Ping' }],
        max_tokens: 5
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return { success: false, message: `Validation failed (HTTP ${response.status})` };
    }

    const data = await response.json();
    if (data.choices && data.choices[0]) {
      const settings = await loadSettings();
      settings.deepseekApiKey = key;
      await saveSettings(settings);
      sendLog(`[DeepSeek]: API Key verified successfully. Saved to settings.`);
      return { success: true };
    } else {
      return { success: false, message: 'Invalid response from API.' };
    }
  } catch (err) {
    sendLog(`[DeepSeek Validation Error]: ${err.message}`);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('get-deepseek-key', async () => {
  try {
    const settings = await loadSettings();
    return settings.deepseekApiKey || '';
  } catch (_) {
    return '';
  }
});

ipcMain.handle('bulk-deepseek-rewrite', async (event, itemNames) => {
  const settings = await loadSettings();
  if (!settings.deepseekApiKey) return { success: false, message: 'No DeepSeek API key set.' };
  const results = {};
  for (const name of itemNames) {
    results[name] = await generateDescriptionWithDeepSeek(settings.deepseekApiKey, name);
  }
  return { success: true, results };
});

ipcMain.handle('save-uploaded-images', async (event, { folderPath, images }) => {
  if (!folderPath || !images || !images.length) {
    return { success: false, message: 'Missing parameters.' };
  }
  try {
    sendLog(`[System]: Saving ${images.length} uploaded images to folder: "${path.basename(folderPath)}"...`);
    await fs.mkdir(folderPath, { recursive: true });
    for (const img of images) {
      const base64Data = img.base64.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, 'base64');
      const targetPath = path.join(folderPath, img.name);
      await fs.writeFile(targetPath, buffer);
      sendLog(`[Scanner]: Saved uploaded image: "${img.name}"`);
    }
    return { success: true };
  } catch (err) {
    sendLog(`[Error]: Failed to save uploaded images - ${err.message}`);
    return { success: false, message: err.message };
  }
});



// ==================== Window Controls (Frameless) ====================
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) {
    if (tray && !isQuitting) {
      // Hide to tray instead of closing (for custom titlebar close button)
      mainWindow.hide();
    } else {
      // When quitting (via tray Quit or explicit), force cleanup
      if (isQuitting) {
        killBotChrome();  // force close bot Chrome (visible or hidden)
        forceCloseTerminal();  // force close the terminal window
        mainWindow.destroy();
      } else {
        mainWindow.close();
      }
    }
  }
});

// (Dialog handler removed in rollback.)

// ==================== Cleanup ====================
app.on('before-quit', async () => {
  isQuitting = true;
  killBotChrome();       // force close the dedicated bot Chrome (visible or hidden)
  forceCloseTerminal();  // force close terminal (visible or the hidden one attached to this process)
  if (debugBrowser) {
    try { await debugBrowser.close(); } catch (_) {}
  }
  if (mainWindow) {
    try { mainWindow.destroy(); } catch (_) {}
  }
});

app.whenReady().then(async () => {
  // Direct main window (rollback to earlier simple visible state, no startup dialog).
  createWindow();

  // Auto-launch the dedicated automation Chrome on startup (visible, with persistent profile).
  // This means the user never needs to manually launch Chrome — just log into FB once in it.
  sendLog('[System]: Auto-launching automation Chrome on startup...');
  await delay(500);
  launchAutomationChrome(true);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // With tray, we only quit when explicitly requested (isQuitting set by tray menu or before-quit)
  if (process.platform !== 'darwin' && isQuitting) {
    app.quit();
  }
});
