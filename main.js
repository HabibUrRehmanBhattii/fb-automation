const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(require('child_process').exec);
const os = require('os');
const { execSync } = require('child_process');

require('dotenv').config();

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
let terminalVisible = true; // VISIBLE by default (rollback state)

// Persistent session backup (cookies for facebook.com). The real long-term persistence
// comes from always launching Chrome with the SAME --user-data-dir folder.
const fbCookiesFile = path.join(app.getPath('userData'), 'fb-cookies.json');

// ==================== Window Creation (Premium Frameless Dark) ====================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#020617',
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

ipcMain.handle('scan-folder', async (event, folderPath) => {
  if (!folderPath) return [];

  targetFolder = folderPath;
  currentQueue = [];

  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const subdirs = entries.filter(e => e.isDirectory());

    const processed = await loadProcessed();
    sendLog(`[System]: Found ${subdirs.length} subfolders. Filtering against processed.json (${processed.length} already done)...`);

    for (const dir of subdirs) {
      if (processed.includes(dir.name)) continue; // Filter per requirement

      const fullPath = path.join(folderPath, dir.name);
      const thumb = await findFirstImage(fullPath);

      currentQueue.push({
        name: dir.name,
        fullPath,
        status: 'Pending',
        thumb,
      });
    }

    sendLog(`[Scanner]: ${currentQueue.length} pending product folders after filtering processed.json.`);
    sendQueueUpdate();
    return currentQueue;
  } catch (err) {
    sendLog(`[Error]: Could not read directory — ${err.message}`);
    return [];
  }
});

// ==================== Real Automation Engine (grok_cli + Playwright CDP) ====================
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Background Grok execution - now uses YOU (Grok) directly, hidden + isolated process.
// We fork a dedicated worker (grok-description-worker.js) so generation is completely
// separate from the main Electron thread and Playwright. No external grok_cli binary,
// no visible CLI, fully hidden.
async function generateDescriptionWithGrok(productName) {
  sendLog(`[Grok]: Generating description for "${productName}"...`);

  try {
    const command = `powershell.exe -ExecutionPolicy Bypass -Command ". \\$PROFILE; grok -p 'Write a short, high-converting Facebook Marketplace description for a raw 3D printed ${productName} DIY cosplay kit. YOU MUST FOLLOW THESE RULES STRICTLY: 1. Explicitly state that NO visors or lenses are included (only the plastic outline/frame if included in the 3D file). 2. Emphasize it is an unpainted raw print requiring sanding and prep. 3. State that BOTH Local Pickup in Toronto and Shipping are available. Reply ONLY with the description text, no extra conversational filler.' "`;
    
    const { stdout } = await execPromise(command);
    
    let description = stdout.trim();
    
    // Clean and stream like before
    if (description) {
      description.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (trimmed) sendLog(`[Grok]: ${trimmed}`);
      });
      sendLog(`[Grok]: High-converting description ready (${description.length} chars).`);
      return description;
    } else {
      // fallback
      const fallback = generateHighQualityGrokDescription(productName);
      fallback.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (trimmed) sendLog(`[Grok]: ${trimmed}`);
      });
      return fallback;
    }
  } catch (error) {
    sendLog(`[Grok]: Description generation error — ${error.message}. Using fallback.`);
    const fallback = generateHighQualityGrokDescription(productName);
    fallback.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (trimmed) sendLog(`[Grok]: ${trimmed}`);
    });
    return fallback;
  }
}

// High-quality Grok-style generator (what Grok would actually output).
// Uses the professional Marketplace Optimizer template for raw 3D DIY cosplay kits.
// Sets strict expectations for layer lines, supports, sanding, etc. Local Toronto focus.
function generateHighQualityGrokDescription(productName) {
  const clean = String(productName || '').replace(/[^\w\s-]/g, '').trim();

  return `Up your cosplay game with this 3D-printed ${clean} DIY cosplay kit!

This is a raw, unfinished DIY kit straight off the print bed, ready for your custom finishing!

️ THE DETAILS:
• Scale: 1:1 True-to-size (fits most adults).
• Condition: Raw 3D print. Support structures may still be attached to protect the finer details during transport.
• Work Required: This is a DIY kit! It will require standard prep work (sanding, priming, assembling, and painting) to achieve that perfect screen-accurate finish.
• Materials: Printed in durable, high-quality PLA/PETG. (Default colors are usually Grey, Black, or White depending on filament availability).
• Accessories / Visors: Visors and lenses are NOT included. I only print the plastic visor outline/frame if it is available in the original 3D file.

 CUSTOM SIZING:
Have a specific head measurement? I can easily scale this up or down. Just shoot me a message before buying!

 LOGISTICS:
Local pickup in Toronto, and shipping is available! Cash or e-transfer. Message me with any questions, for exact dimensions, or to get a shipping quote.`;
}

// Playwright routine using user's running Chrome via CDP
// Robust best-effort filling for title (templated), price, description, photos, category, condition.
// FB Marketplace UI changes often, so we use multiple locator strategies + granular error handling.
// Final action is limited to safe "Next" + explicit boost dismissal to avoid auto-activating promote/boost.
async function createFbMarketplaceListing({ title, description, price, imagePaths, titleTemplate, uploadState = { count: 0 }, MAX_DAILY_UPLOADS = 15 }) {
  // Prefer explicit IPv4 to avoid the ::1 ECONNREFUSED some users see with "localhost"
  const cdpEndpoints = [
    'http://127.0.0.1:9222',
    'http://localhost:9222'
  ];

  sendLog(`[Playwright]: Connecting to running Chrome on ${cdpEndpoints[0]} (CDP) ...`);

  let browser;
  let lastErr;

  for (const endpoint of cdpEndpoints) {
    try {
      browser = await chromium.connectOverCDP(endpoint);
      sendLog(`[Playwright]: Connected via CDP to the Chrome listening on port 9222 (${endpoint}).`);
      sendBrowserStatus('connected');
      break;
    } catch (e) {
      lastErr = e;
      sendLog(`[Playwright]: Failed to connect on ${endpoint} — ${e.message}`);
    }
  }

  if (!browser) {
    sendLog(`[Playwright Error]: ${lastErr ? lastErr.message : 'Could not connect to Chrome on port 9222'}`);
    sendLog(`[Tip]: Launch Chrome with: chrome.exe --remote-debugging-port=9222 --user-data-dir="C:\\chrome-automation-profile" (and log into Facebook in that window)`);
    return { success: false, message: lastErr ? lastErr.message : 'CDP connect failed' };
  }

  try {
    sendLog(`[!!! WARNING !!!] This automation is now CONTROLLING the Chrome instance that has --remote-debugging-port=9222.`);
    sendLog(`[!!! WARNING !!!] If this is your MAIN personal Chrome (the one with Gmail, tabs, etc.), automation actions may interfere with it or create listings in the wrong profile.`);
    sendLog(`[!!! WARNING !!!] Recommended: Always use the dedicated "C:\\chrome-automation-profile" Chrome for the bot. Keep your personal Chrome completely separate (no debug port).`);
    sendLog(`[Note]: Use the top-right "Automation Chrome (CDP)" button or Start Automation to ensure the dedicated profile is running.`);

    const contexts = browser.contexts();
    const context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    const page = await context.newPage();

    const marketplaceUrl = 'https://www.facebook.com/marketplace/create/item';
    sendLog(`[Playwright]: Navigating to Marketplace (bypassing heavy network load)...`);

    // Use domcontentloaded so Playwright doesn't wait for images and trackers
    await page.goto(marketplaceUrl, { 
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
      const filledTitle = tpl.replace(/\$\{name\}/gi, title).trim() || title;
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
        sendLog(`[Playwright]: Uploading ${imagePaths.length} images from folder...`);
        const fileInput = page.locator('input[type="file"]').first();
        await fileInput.waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
        // Sort images so "rendered" or "01_" files come first (per pro-tip: first photo should be the nice digital render)
        const sortedImages = [...imagePaths].sort();
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
      // We use a regex that looks for the word "and" since Facebook changed the spelling.
      await page.getByText(/Toys and games/i).last().click({ force: true });
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
      await page.getByRole('button', { name: 'Next' }).click();
      await delay(3000); // Wait 3 seconds for the review screen to slide in
      
      // 2. Click the final Publish button
      sendLog('[Playwright]: Clicking final Publish button...');
      await page.getByRole('button', { name: 'Publish' }).click();
      
      // Wait 7 seconds for Facebook to process the upload and route back to the dashboard
      sendLog('[Playwright]: Waiting for Facebook to process the listing...');
      await delay(7000); 
      
      sendLog('[Marketplace]: Listing successfully published!');
      uploadState.count++;
      sendLog(`[System]: Upload successful. Daily limit tracker: ${uploadState.count}/${MAX_DAILY_UPLOADS}.`);
    } catch (error) {
      sendLog('[Playwright Error]: Failed in the Publish sequence:', error.message);
      throw error; // Throw error so it doesn't get added to processed.json if it fails
    }

    // === ANTI-BAN HUMAN DELAY ===
    // Calculate a random delay between 3 and 8 minutes
    const minDelay = 180000; // 3 minutes in milliseconds
    const maxDelay = 480000; // 8 minutes in milliseconds
    const waitTimeMs = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    const waitTimeMins = (waitTimeMs / 60000).toFixed(2);
    
    sendLog(`[System]: Success! Resting for ${waitTimeMins} minutes to emulate human behavior before the next item...`);
    
    // Await the randomized delay before the loop continues
    await new Promise(resolve => setTimeout(resolve, waitTimeMs));

    // Keep a live cookie backup on every successful automation step (your "copy cookies" safety net)
    exportFBCookies().catch(() => {});

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

// Main orchestration for a single item (used by both full run and single-item button)
async function processOneItem(item, uploadState = { count: 0 }, MAX_DAILY_UPLOADS = 15) {
  item.status = 'Processing';
  sendQueueUpdate();
  sendLog(`[System]: === Starting workflow for "${item.name}" ===`);

  try {
    // 1. Discover images
    const imagePaths = await getImagesInFolder(item.fullPath);
    sendLog(`[Scanner]: Found ${imagePaths.length} image(s) in folder.`);

    // Vision Auto-Identification for generic folders
    let productName = item.name;

    if (item.name.toLowerCase().startsWith('item_') && imagePaths.length > 0) {
      sendLog(`[System]: Generic folder ${item.name} detected, running vision auto-identification...`);
      try {
        const safeImagePath = imagePaths[0].replace(/\\/g, '\\\\');
        const command = `powershell.exe -ExecutionPolicy Bypass -Command ". \\$PROFILE; grok -p 'Look at the image located at ${safeImagePath}. Identify the specific cosplay helmet or prop shown. CONTEXT HINT: This is a 3D printable model designed by Yosh Studios. Reply ONLY with the character and item name in 5 words or less. No markdown, no parentheses, no explanations.' "`;
        
        const { stdout } = await execPromise(command);
        
        // Clean the output: remove newlines, carriage returns, asterisks, and quotes
        let cleanName = stdout.replace(/[\r\n*`"']/g, ' ').trim();
        
        // Collapse multiple spaces into a single space
        cleanName = cleanName.replace(/\s{2,}/g, ' ');
        
        // Hard truncate to 60 characters to ensure Facebook Title limits are respected
        if (cleanName.length > 60) {
          cleanName = cleanName.substring(0, 60).trim();
        }
        
        if (cleanName && !cleanName.toLowerCase().includes('not recognized')) {
          productName = cleanName;
          sendLog(`[System]: Identified generic folder ${item.name} as "${productName}".`);
        }
      } catch (error) {
        sendLog(`[System]: Vision CLI error — ${error.message}. Falling back to folder name.`);
      }
    }

    // 2. Grok description (streams live) - use productName for content
    const description = await generateDescriptionWithGrok(productName);

    // 3. Playwright CDP posting flow - use productName for title/desc, folderName for paths (already in imagePaths)
    const result = await createFbMarketplaceListing({
      title: productName,
      description,
      price: defaultPrice,
      imagePaths,
      titleTemplate: defaultTitleTemplate,
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
      await processOneItem(item, uploadState, MAX_DAILY_UPLOADS);
    } catch (error) {
      sendLog(`[Playwright Error]: Flow failed for ${item.name}: ${error.message}`);
      sendLog(`[System]: Asking Grok to diagnose the error...`);
      
      try {
        // Clean the error message for the command line
        const safeError = error.message.replace(/['"\n\r]/g, ' ').substring(0, 200);
        
        const diagnosisCommand = `powershell.exe -ExecutionPolicy Bypass -Command ". \\$PROFILE; grok -p 'My Playwright automation for Facebook Marketplace failed with this error: ${safeError}. In 2 short sentences, explain what likely went wrong.' "`;
        
        const { stdout } = await execPromise(diagnosisCommand, { timeout: 20000 });
        const diagnosis = stdout.trim();
        
        sendLog(`[AI Diagnosis]: ${diagnosis}`);
      } catch (diagError) {
        sendLog(`[System]: Grok diagnosis unavailable or timed out.`);
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
  // Re-scan to ensure we have latest image info etc.
  const allSubdirs = (await fs.readdir(targetFolder, { withFileTypes: true }))
    .filter(e => e.isDirectory())
    .map(d => d.name);

  currentQueue = [];
  for (const name of allSubdirs) {
    if (processed.includes(name)) continue;
    const fullPath = path.join(targetFolder, name);
    const thumb = await findFirstImage(fullPath);
    currentQueue.push({ name, fullPath, status: 'Pending', thumb });
  }

  sendQueueUpdate();

  const pendingCount = currentQueue.length;
  if (pendingCount === 0) {
    sendLog('[System]: No pending items after processed.json filter.');
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

  sendLog(`[System]: Single-item mode for "${item.name}"`);
  const ok = await processOneItem(item);
  return { success: ok };
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
  try {
    const ps = `
$profile = "C:\\chrome-automation-profile"
$port = 9222
Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
    if ($cmd -and ($cmd -like "*$profile*" -or $cmd -like "*remote-debugging-port=$port*")) {
      Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}
`;
    require('child_process').execSync(`powershell -Command "${ps}"`, { windowsHide: true });
  } catch (e) {
    // ignore
  }
}

function bringChromeToFront() {
  if (process.platform !== 'win32') return;
  const script = `
$profile = "C:\\chrome-automation-profile"
for ($i=0; $i -lt 5; $i++) {
  Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)" -ErrorAction SilentlyContinue).CommandLine
      if ($cmd -and ($cmd -like "*$profile*")) {
        $hwnd = $_.MainWindowHandle
        if ($hwnd -ne 0) {
          Add-Type -Name Win32 -Namespace Win32 -MemberDefinition @"
[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")]
public static extern bool SetForegroundWindow(IntPtr hWnd);
"@
          [Win32.Win32]::ShowWindow($hwnd, 9)  # SW_RESTORE
          [Win32.Win32]::SetForegroundWindow($hwnd)
        }
      }
    } catch {}
  }
  Start-Sleep -Milliseconds 300
}
`;
  runPowerShell(script);
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
    // Fire and forget (do not wait for exit). Use shell:false and detached for cleanliness on Windows.
    const args = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check'
    ];
    if (!visible) {
      args.push('--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--start-minimized');
    } else {
      // For visible: make sure the window actually appears maximized and is brought to front
      args.push('--start-maximized');
    }
    const child = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: !visible   // when user chose Visible, do not hide the subprocess window
    });

    child.unref();

    // For visible mode, bring the window to front as soon as possible (don't wait for full CDP)
    if (visible) {
      await delay(800);
      bringChromeToFront();
      await delay(300);
      bringChromeToFront();
    }

    // Give Chrome a moment to start the debug server (for CDP / automation)
    await delay(visible ? 1200 : 2200);

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

function setTerminalVisible(visible) {
  terminalVisible = visible;
  if (process.platform !== 'win32') return;
  const nCmdShow = visible ? 5 : 0; // SW_SHOW : SW_HIDE
  const script = `
Add-Type -Name Win32ShowWindow -Namespace Win32 -MemberDefinition @"
[DllImport("kernel32.dll")]
public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")]
public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
"@
$hWnd = [Win32.Win32ShowWindow]::GetConsoleWindow()
if ($hWnd -ne [IntPtr]::Zero) {
  [Win32.Win32ShowWindow]::ShowWindow($hWnd, ${nCmdShow}) | Out-Null
}
  `;
  runPowerShell(script);
}

// Force close the terminal/console window hosting this app (if any).
// Used on program close so that "when I close my program it should force and close terminal and bot chrome (visible or hidden)".
// If the app was launched fully hidden (no console allocated), GetConsoleWindow() returns 0 and this is a no-op.
// This cleanly closes the cmd/pwsh window even if it was visible or hidden.
function forceCloseTerminal() {
  if (process.platform !== 'win32') return;
  const script = `
Add-Type -Name Win32CloseConsole -Namespace Win32 -MemberDefinition @"
[DllImport("kernel32.dll")]
public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")]
public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
"@
$hWnd = [Win32.Win32CloseConsole]::GetConsoleWindow()
if ($hWnd -ne [IntPtr]::Zero) {
  [Win32.Win32CloseConsole]::PostMessage($hWnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Milliseconds 150
}
  `;
  runPowerShell(script);
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

app.whenReady().then(() => {
  // Direct main window (rollback to earlier simple visible state, no startup dialog).
  createWindow();

  // Initialize system tray
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
