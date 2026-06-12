// renderer.js - UI orchestration and IPC wiring for Marketplace Automation Studio
// This file runs in the renderer process (secure context).
// Heavy operations (fs scan with filtering, grok_cli spawn, Playwright CDP) are handled in main.js via IPC.

const $ = (id) => document.getElementById(id);

// UI Elements
const dropZone = $('drop-zone');
const pickBtn = $('pick-folder-btn');
const selectedPathEl = $('selected-path');
const queueRows = $('queue-rows');
const queueCountEl = $('queue-count');
const startBtn = $('start-btn');
const pauseBtn = $('pause-btn');
const priceInput = $('price-input');
const titleTemplateInput = $('title-template-input');
const toggleChromeBtn = $('toggle-chrome-btn');
const toggleTerminalBtn = $('toggle-terminal-btn');
const rescanBtn = $('rescan-btn');
const clearQueueBtn = $('clear-queue-btn');
const clearLogBtn = $('clear-log-btn');
const logContent = $('log-content');

// Browser status
const browserDot = $('browser-dot');
const browserStatusText = $('browser-status-text');
const browserToggle = $('browser-toggle');

// Window controls (custom titlebar)
$('min-btn').addEventListener('click', () => window.api.minimizeWindow());
$('max-btn').addEventListener('click', () => window.api.maximizeWindow());
$('close-btn').addEventListener('click', () => window.api.closeWindow());

// State (renderer only)
let currentFolder = null;
let queue = [];
let isRunning = false;
let isPaused = false;

// ==================== Logging (receives streamed events from main) ====================
function addLog(message, type = 'system') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  line.textContent = `[${ts}] ${message}`;
  logContent.appendChild(line);
  logContent.scrollTop = logContent.scrollHeight;

  // Keep only last ~80 lines for performance
  while (logContent.children.length > 80) {
    logContent.removeChild(logContent.firstChild);
  }
}

clearLogBtn.addEventListener('click', () => {
  logContent.innerHTML = '';
  addLog('Log cleared', 'system');
});

const copyLogBtn = $('copy-log-btn');
if (copyLogBtn) {
  copyLogBtn.addEventListener('click', () => {
    const text = logContent.textContent || logContent.innerText || '';
    if (!text.trim()) {
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      const original = copyLogBtn.textContent;
      copyLogBtn.textContent = 'COPIED!';
      setTimeout(() => { copyLogBtn.textContent = original; }, 1500);
    } catch (e) {
      // fallback: alert the text or console
      console.log('Copy failed, log text:', text);
    }
    document.body.removeChild(textarea);
  });
}

// ==================== Queue Rendering ====================
function renderQueue() {
  queueRows.innerHTML = '';

  if (!queue.length) {
    queueRows.innerHTML = `
      <div class="empty-state">
        <div class="icon">📁</div>
        <div>Select a target folder above to scan for product subfolders.</div>
      </div>`;
    queueCountEl.textContent = '(0 folders)';
    return;
  }

  queueCountEl.textContent = `(${queue.length} folders)`;

  queue.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'queue-row';

    const thumbHTML = item.thumb
      ? `<img src="file://${item.thumb.replace(/\\/g, '/')}" alt="">`
      : `<span style="font-size:18px;opacity:.7;">🖼️</span>`;

    const statusClass = `status-${item.status.toLowerCase()}`;
    const statusLabel = item.status;

    row.innerHTML = `
      <div class="thumb">${thumbHTML}</div>
      <div class="folder-name" title="${item.name}">${item.name}</div>
      <div>
        <span class="status-pill ${statusClass}">${statusLabel}</span>
      </div>
      <div class="row-actions">
        ${item.status === 'Pending' ? 
          `<button class="btn btn-secondary" style="padding:4px 10px;font-size:11px;" data-index="${index}">Process</button>` : 
          ''}
      </div>
    `;

    // Per-row single item trigger (calls into main via IPC)
    const processBtn = row.querySelector('button');
    if (processBtn) {
      processBtn.addEventListener('click', () => {
        window.api.runSingleItem({ 
          index, 
          folder: currentFolder, 
          defaultPrice: parseInt(priceInput.value) || 65,
          titleTemplate: (titleTemplateInput && titleTemplateInput.value) || '${name}'
        });
      });
    }

    queueRows.appendChild(row);
  });
}

// ==================== IPC Listeners (main pushes real-time updates) ====================
function setupListeners() {
  // Live logs streamed from main (includes grok_cli stdout, playwright steps, errors, etc.)
  window.api.onLog((msg) => {
    let type = 'system';
    if (msg.includes('[Grok]') || msg.includes('description') || msg.includes('title')) type = 'grok';
    else if (msg.includes('Marketplace') || msg.includes('listing') || msg.includes('Playwright')) type = 'marketplace';
    else if (msg.includes('Scanning') || msg.includes('Found') || msg.includes('folder') || msg.includes('Scanner')) type = 'scanner';
    addLog(msg, type);
  });

  // Queue updates from main (after scan filter, status changes during processing)
  window.api.onQueueUpdate((newQueue) => {
    queue = newQueue;
    renderQueue();
    updateControlStates();
  });

  // Status updates
  window.api.onStatusUpdate((data) => {
    if (data.isRunning !== undefined) isRunning = data.isRunning;
    if (data.isPaused !== undefined) isPaused = data.isPaused;
    updateControlStates();
  });

  // Browser (CDP) status - reflects the automation Chrome that Playwright connects to over localhost:9222
  window.api.onBrowserStatus((status) => {
    updateBrowserStatus(status);
  });

  // Boot message
  setTimeout(() => {
    addLog('Electron + Playwright automation engine initialized. Ready for real grok_cli + CDP flow.', 'system');
  }, 300);

  // Initial probe so the header dot shows correct state even if Chrome was already started via ps1
  setTimeout(async () => {
    try {
      await window.api.checkAutomationBrowser();
    } catch (_) {}
  }, 1200);
}

function updateBrowserStatus(status) {
  const text = status === 'connected' ? 'Connected' : 
               status === 'connecting' ? 'Connecting...' : 'Disconnected';
  browserStatusText.textContent = text;
  
  browserDot.classList.remove('connected', 'connecting');
  if (status === 'connected') browserDot.classList.add('connected');
  else if (status === 'connecting') browserDot.classList.add('connecting');

  // For the external automation Chrome we can't force-close from here; the button is "Launch / Check"
  browserToggle.textContent = 'Launch';
}

// ==================== Folder Selection & Scanning (triggers main process scan + processed.json filter) ====================
async function selectAndScanFolder() {
  const folderPath = await window.api.selectFolder();
  if (!folderPath) return;

  currentFolder = folderPath;
  selectedPathEl.textContent = folderPath;
  selectedPathEl.style.color = '#e0e7ff';

  addLog(`[System]: Selected target folder → ${folderPath}`, 'system');
  await scanCurrentFolder();
}

async function scanCurrentFolder() {
  if (!currentFolder) return;

  addLog(`[Scanner]: Scanning directory for product subfolders (filtering processed.json)...`, 'scanner');
  queueRows.innerHTML = `<div class="empty-state"><div style="margin:18px 0;">Scanning & filtering...</div></div>`;

  try {
    const result = await window.api.scanFolder(currentFolder);
    queue = result;
    renderQueue();
    addLog(`[Scanner]: Loaded ${queue.length} pending product folders (processed items filtered).`, 'scanner');

    if (queue.length > 0) {
      addLog(`[System]: Queue ready. Set default price and press Start Automation.`, 'system');
    } else {
      addLog(`[System]: No new items (all folders already in processed.json).`, 'system');
    }
  } catch (err) {
    addLog(`[Error]: Failed to scan folder — ${err.message}`, 'system');
    renderQueue();
  }

  updateControlStates();
}

// Drag and drop support (uses native file.path from Electron)
function setupDragAndDrop() {
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');

    const file = e.dataTransfer.files[0];
    if (file && file.path) {
      currentFolder = file.path;
      selectedPathEl.textContent = currentFolder;
      selectedPathEl.style.color = '#e0e7ff';
      addLog(`[System]: Dropped folder → ${currentFolder}`, 'system');
      await scanCurrentFolder();
    }
  });

  dropZone.addEventListener('click', (e) => {
    if (e.target.id !== 'pick-folder-btn') {
      pickBtn.click();
    }
  });
}

// ==================== Control Buttons & Automation Triggers ====================
function updateControlStates() {
  const hasQueue = queue.length > 0;
  const hasPending = queue.some(item => item.status === 'Pending');

  startBtn.disabled = !hasQueue || !hasPending || isRunning;
  pauseBtn.disabled = !isRunning;

  if (isRunning) {
    startBtn.textContent = isPaused ? '▶ Resume' : '⏹ Stop';
    pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
  } else {
    startBtn.textContent = '▶ Start Automation';
    pauseBtn.textContent = '⏸ Pause';
  }
}

async function startAutomation() {
  if (!currentFolder || queue.length === 0) return;

  const defaultPrice = parseInt(priceInput.value) || 65;
  const titleTemplate = (titleTemplateInput && titleTemplateInput.value) || '${name}';

  addLog(`[System]: Starting full automation (grok_cli + Playwright CDP) for ${queue.length} items at $${defaultPrice}...`, 'system');

  isRunning = true;
  isPaused = false;
  updateControlStates();

  // This triggers the real workflow in main.js (directory scan + filter + per-item grok + playwright)
  await window.api.startAutomation({
    folder: currentFolder,
    defaultPrice,
    titleTemplate
  });
}

async function pauseAutomation() {
  isPaused = !isPaused;
  await window.api.pauseAutomation();
  updateControlStates();

  addLog(isPaused ? '[System]: Automation paused by user.' : '[System]: Automation resumed.', 'system');
}

function setupControlButtons() {
  pickBtn.addEventListener('click', selectAndScanFolder);
  rescanBtn.addEventListener('click', scanCurrentFolder);
  clearQueueBtn.addEventListener('click', () => {
    queue = [];
    renderQueue();
    updateControlStates();
    addLog('[System]: Queue cleared (local only).', 'system');
  });

  startBtn.addEventListener('click', startAutomation);
  pauseBtn.addEventListener('click', pauseAutomation);

  // Live price sync to main
  priceInput.addEventListener('change', () => {
    const val = parseInt(priceInput.value) || 65;
    window.api.setDefaultPrice(val);
  });

  // Live title template sync to main
  if (titleTemplateInput) {
    titleTemplateInput.addEventListener('change', () => {
      window.api.setDefaultTitleTemplate(titleTemplateInput.value);
    });
  }

  // Visibility toggles (Chrome window and launcher terminal)
  async function updateVisibilityButtons() {
    if (toggleChromeBtn) {
      try {
        const visible = await window.api.getChromeVisibility();
        toggleChromeBtn.textContent = `Chrome: ${visible ? 'Visible' : 'Hidden'}`;
      } catch (e) {}
    }
    if (toggleTerminalBtn) {
      try {
        const visible = await window.api.getTerminalVisibility();
        toggleTerminalBtn.textContent = `Terminal: ${visible ? 'Visible' : 'Hidden'}`;
      } catch (e) {}
    }
  }

  if (toggleChromeBtn) {
    toggleChromeBtn.addEventListener('click', async () => {
      try {
        // Use the new IPC restart bridge (Main process does the actual spawn/kill)
        // Get current state, flip it, request restart with desired visible state
        const current = await window.api.getChromeVisibility();
        const desiredVisible = !current;
        await window.api.restartChrome(desiredVisible);
        await updateVisibilityButtons();
      } catch (e) {
        console.error('Failed to restart Chrome visibility via bridge', e);
      }
    });
  }

  if (toggleTerminalBtn) {
    toggleTerminalBtn.addEventListener('click', async () => {
      try {
        await window.api.toggleTerminalVisibility();
        await updateVisibilityButtons();
      } catch (e) {
        console.error('Failed to toggle terminal visibility', e);
      }
    });
  }

  // Initialize button states
  setTimeout(updateVisibilityButtons, 1500);

  // Automation Chrome (CDP) - this is the critical one for persistent FB login + Playwright automation.
  // Clicking toggles launch / re-check. We do not have a reliable "close" for the external Chrome (user closes the window).
  browserToggle.addEventListener('click', async () => {
    const current = browserStatusText.textContent || '';
    if (current.includes('Connected')) {
      // Re-check (user may have closed the window)
      browserDot.classList.add('connecting');
      browserStatusText.textContent = 'Checking...';
      await window.api.checkAutomationBrowser();
    } else {
      browserDot.classList.add('connecting');
      browserStatusText.textContent = 'Connecting...';
      await window.api.launchAutomationChrome();
      // After launch the main process will send status updates via the existing 'browser-status' channel
    }
  });

  // Persistent login tools ("copy cookies" + profile access)
  const openProfileBtn = $('open-profile-btn');
  if (openProfileBtn) {
    openProfileBtn.addEventListener('click', async () => {
      await window.api.openAutomationProfile();
    });
  }

  const exportBtn = $('export-cookies-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const original = exportBtn.textContent;
      exportBtn.textContent = '…';
      const res = await window.api.exportFBCookies();
      exportBtn.textContent = res && res.success ? '✓' : '!';
      setTimeout(() => { exportBtn.textContent = original; }, 1400);
    });
  }

  const restoreBtn = $('restore-cookies-btn');
  if (restoreBtn) {
    restoreBtn.addEventListener('click', async () => {
      const original = restoreBtn.textContent;
      restoreBtn.textContent = '…';
      const res = await window.api.importFBCookies();
      restoreBtn.textContent = res && res.success ? '✓' : '!';
      setTimeout(() => { restoreBtn.textContent = original; }, 1400);
    });
  }

  // Keyboard shortcut
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !startBtn.disabled) {
      startAutomation();
    }
  });
}

// ==================== Initialization ====================
async function init() {
  setupListeners();
  setupDragAndDrop();
  setupControlButtons();

  setTimeout(() => {
    addLog('Ready. Select or drop your product folder. Processed items will be filtered via processed.json.', 'system');
    addLog('[Tip]: Use the top-right Automation Chrome buttons: Launch the dedicated profile → log into FB *once* there. 💾 backs up cookies, ↩︎ restores login, 📁 opens the profile folder (this is what actually keeps you logged in).', 'system');
    addLog('[Tip]: Edit TITLE TEMPLATE (next to price) before Start. Use ${name} placeholder e.g. "${name} DIY from YoshStudios".', 'system');
  }, 800);

  console.log('%c[Marketplace Automation] Renderer ready. IPC wired to main for grok_cli + CDP automation.', 'color:#475569');
}

// Boot
window.addEventListener('DOMContentLoaded', init);
