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
const toggleTerminalBtn = null;
const rescanBtn = $('rescan-btn');
const clearQueueBtn = $('clear-queue-btn');
const cleanNamesBtn = $('clean-names-btn');
const clearLogBtn = $('clear-log-btn');
const logContent = $('log-content');

// New Advanced Features DOM Elements
const searchInput = $('search-input');
const bulkEditPanel = $('bulk-edit-panel');
const bulkSelectCount = $('bulk-select-count');
const bulkPriceInput = $('bulk-price-input');
const bulkTemplateSelect = $('bulk-template-select');
const bulkApplyBtn = $('bulk-apply-btn');
const bulkCancelBtn = $('bulk-cancel-btn');
const bulkSelectAll = $('bulk-select-all');
const deepseekKeyInput = $('deepseek-key-input');
const deepseekVerifyBtn = $('deepseek-verify-btn');
const deepseekStatus = $('deepseek-status');

const imgModal = $('image-manager-modal');
const imgModalClose = $('image-manager-modal-close');
const imgModalBackdrop = $('image-manager-modal-backdrop');
const imgFolderTitle = $('image-manager-folder-name');
const imgDropzone = $('image-dropzone');
const imgFileInput = $('image-file-input');
const imgPreviewGrid = $('image-preview-grid');
const imgPreviewEmpty = $('image-preview-empty');
const imgSaveBtn = $('save-upload-btn');
const imgCancelBtn = $('cancel-upload-btn');

// Templates Modal Elements
const templatesModal = $('templates-modal');
const manageTemplatesBtn = $('manage-templates-btn');
const templatesModalClose = $('templates-modal-close');
const templatesModalBackdrop = $('templates-modal-backdrop');
const templatesListItems = $('templates-list-items');
const addTemplateBtn = $('add-template-btn');
const templateEditorForm = $('template-editor-form');
const templateEditorEmpty = $('template-editor-empty');
const tplLabelInput = $('tpl-label-input');
const tplTextInput = $('tpl-text-input');
const deleteTemplateBtn = $('delete-template-btn');
const saveTemplateBtn = $('save-template-btn');

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
let templatesMap = {};
let activeTemplateKey = null;
let activeTab = 'pending'; // 'pending' or 'published'

// Image Upload State
let uploadImagesArray = []; // [{ name, base64 }]
let uploadTargetItem = null; // item object currently editing

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
function getFilteredQueue() {
  const searchQuery = searchInput ? searchInput.value.toLowerCase().trim() : '';
  return queue.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchQuery);
    if (activeTab === 'published') {
      return item.status === 'Done' && matchesSearch;
    } else {
      return item.status !== 'Done' && matchesSearch;
    }
  });
}

function updateBulkPanel() {
  const selectedItems = queue.filter(item => item.selected);
  if (selectedItems.length > 0 && activeTab === 'pending') {
    bulkEditPanel.style.display = 'flex';
    bulkSelectCount.textContent = `${selectedItems.length} items selected`;
  } else {
    bulkEditPanel.style.display = 'none';
  }
}

function openUploadModal(item) {
  uploadTargetItem = item;
  uploadImagesArray = [];
  imgFolderTitle.textContent = item.name;
  imgSaveBtn.disabled = true;
  renderUploadPreviews();
  imgModal.style.display = 'flex';
}

function closeUploadModal() {
  imgModal.style.display = 'none';
  uploadTargetItem = null;
  uploadImagesArray = [];
}

function renderUploadPreviews() {
  imgPreviewGrid.innerHTML = '';
  if (uploadImagesArray.length === 0) {
    imgPreviewGrid.appendChild(imgPreviewEmpty);
    imgSaveBtn.disabled = true;
    return;
  }
  
  if (imgPreviewEmpty && imgPreviewEmpty.parentNode) {
    imgPreviewEmpty.remove();
  }
  imgSaveBtn.disabled = false;
  
  uploadImagesArray.forEach((img, idx) => {
    const card = document.createElement('div');
    card.className = 'image-preview-card';
    
    const imgEl = document.createElement('img');
    imgEl.src = img.base64;
    card.appendChild(imgEl);
    
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove-btn';
    removeBtn.innerHTML = '&times;';
    removeBtn.addEventListener('click', () => {
      uploadImagesArray.splice(idx, 1);
      renderUploadPreviews();
    });
    card.appendChild(removeBtn);
    
    imgPreviewGrid.appendChild(card);
  });
}

async function handleFilesSelected(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    
    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.readAsDataURL(file);
    });
    
    if (!uploadImagesArray.some(img => img.name === file.name)) {
      uploadImagesArray.push({ name: file.name, base64 });
    }
  }
  renderUploadPreviews();
}

function renderQueue() {
  queueRows.innerHTML = '';

  const filteredQueue = getFilteredQueue();

  const pendingCount = queue.filter(item => item.status !== 'Done').length;
  const publishedCount = queue.filter(item => item.status === 'Done').length;

  const pendingBadge = $('queue-count-pending');
  const publishedBadge = $('queue-count-published');
  if (pendingBadge) pendingBadge.textContent = pendingCount;
  if (publishedBadge) publishedBadge.textContent = publishedCount;

  if (queueCountEl) {
    queueCountEl.textContent = `(${filteredQueue.length} folders)`;
  }

  // Update bulk select all checkbox status
  if (bulkSelectAll) {
    const allSelected = filteredQueue.length > 0 && filteredQueue.every(item => item.selected);
    bulkSelectAll.checked = allSelected;
  }

  if (!filteredQueue.length) {
    if (!queue.length) {
      queueRows.innerHTML = `
        <div class="empty-state">
          <div class="icon">📁</div>
          <div>Select a target folder above to scan for product subfolders.</div>
        </div>`;
    } else if (activeTab === 'published') {
      queueRows.innerHTML = `
        <div class="empty-state">
          <div class="icon">✅</div>
          <div>No published items yet. Run automation to list products on Facebook.</div>
        </div>`;
    } else {
      queueRows.innerHTML = `
        <div class="empty-state">
          <div class="icon">🎉</div>
          <div>No pending items left! All products are successfully published.</div>
        </div>`;
    }
    updateBulkPanel();
    return;
  }

  filteredQueue.forEach((item) => {
    const index = queue.findIndex(q => q.name === item.name);
    const row = document.createElement('div');
    row.className = 'queue-row';

    const thumbHTML = item.thumb
      ? `<img src="file://${item.thumb.replace(/\\/g, '/')}" alt="">`
      : `<span style="font-size:18px;opacity:.7;">🖼️</span>`;

    const statusClass = `status-${item.status.toLowerCase()}`;
    const statusLabel = item.status === 'Review' ? `Review: ${item.errorReason}` : (item.status === 'Done' ? 'Published' : item.status);

    const isDeepSeekSelected = (item.template || 'universal').toLowerCase() === 'deepseek' ? 'selected' : '';
    let optionsHTML = `
      <option value="deepseek" ${isDeepSeekSelected}>✨ DeepSeek AI Description</option>
    `;
    
    Object.keys(templatesMap).forEach(key => {
      if (key === 'groq' || key === 'deepseek' || key === 'gemini' || key === 'grok') return;
      const isSelected = (item.template || 'universal').toLowerCase() === key.toLowerCase() ? 'selected' : '';
      optionsHTML += `<option value="${key}" ${isSelected}>${templatesMap[key].label}</option>`;
    });
    const selectHTML = `<select class="row-template-select" data-index="${index}">${optionsHTML}</select>`;

    let actionsHTML = '';
    if (item.status === 'Done') {
      actionsHTML = `
        <button class="btn btn-primary row-btn" data-action="republish" data-index="${index}">🔄 Republish</button>
        <button class="btn btn-secondary row-btn" data-action="open-dir" data-index="${index}">📁 Open</button>
      `;
    } else if (item.status === 'Pending') {
      actionsHTML = `
        <button class="btn btn-secondary row-btn" data-action="process" data-index="${index}">Process</button>
        <button class="btn btn-success row-btn" data-action="done" data-index="${index}">Done</button>
      `;
    } else if (item.status === 'Review') {
      if (item.errorReason === 'No Images') {
        actionsHTML = `
          <button class="btn btn-primary row-btn" data-action="upload-imgs" data-index="${index}">📸 Upload</button>
          <button class="btn btn-secondary row-btn" data-action="open-dir" data-index="${index}">📁 Open</button>
          <button class="btn btn-success row-btn" data-action="done" data-index="${index}">Done</button>
        `;
      } else {
        actionsHTML = `
          <button class="btn btn-secondary row-btn" data-action="rename" data-index="${index}">✏️ Rename</button>
          <button class="btn btn-success row-btn" data-action="done" data-index="${index}">Done</button>
        `;
      }
    }

    row.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:center;">
        <input type="checkbox" class="row-select" data-index="${index}" ${item.selected ? 'checked' : ''} style="cursor:pointer; width:14px; height:14px; margin:0;">
      </div>
      <div class="thumb">${thumbHTML}</div>
      <div class="folder-name" title="${item.name}">${item.name}</div>
      <div>
        <input type="number" class="row-price-input" data-index="${index}" value="${item.price !== undefined ? item.price : 65}" min="0">
      </div>
      <div>
        ${selectHTML}
      </div>
      <div>
        <span class="status-pill ${statusClass}" title="${item.errorReason || ''}">${statusLabel}</span>
      </div>
      <div class="row-actions">
        ${actionsHTML}
      </div>
    `;

    // Row Checkbox Event
    const rowCb = row.querySelector('.row-select');
    if (rowCb) {
      rowCb.addEventListener('change', (e) => {
        queue[index].selected = e.target.checked;
        const filtered = getFilteredQueue();
        const allSelected = filtered.length > 0 && filtered.every(i => i.selected);
        if (bulkSelectAll) bulkSelectAll.checked = allSelected;
        updateBulkPanel();
      });
    }

    // Double-click image or product name to open the folder
    const thumbEl = row.querySelector('.thumb');
    if (thumbEl) {
      thumbEl.style.cursor = 'pointer';
      thumbEl.title = 'Double-click to open folder';
      thumbEl.addEventListener('dblclick', async () => {
        await window.api.openFolder(item.fullPath);
      });
    }

    const nameEl = row.querySelector('.folder-name');
    if (nameEl) {
      nameEl.style.cursor = 'pointer';
      nameEl.title = 'Double-click to open folder';
      nameEl.addEventListener('dblclick', async () => {
        await window.api.openFolder(item.fullPath);
      });
    }

    // Sync overrides to queue state and persist to disk
    const priceIn = row.querySelector('.row-price-input');
    if (priceIn) {
      if (item.price === undefined) item.price = 65;
      priceIn.addEventListener('input', () => {
        const val = parseInt(priceIn.value) || 0;
        queue[index].price = val;
        window.api.saveFolderCustomization(item.name, val, queue[index].template || 'universal');
      });
    }

    const templateSel = row.querySelector('.row-template-select');
    if (templateSel) {
      if (!item.template) item.template = 'universal';
      templateSel.addEventListener('change', () => {
        const val = templateSel.value;
        queue[index].template = val;
        window.api.saveFolderCustomization(item.name, queue[index].price !== undefined ? queue[index].price : 65, val);
      });
    }

    // Per-row single item trigger (calls into main via IPC)
    const processBtn = row.querySelector('[data-action="process"]');
    if (processBtn) {
      processBtn.addEventListener('click', () => {
        window.api.runSingleItem({ 
          index, 
          folder: currentFolder, 
          price: queue[index].price !== undefined ? queue[index].price : 65,
          template: queue[index].template || 'universal',
          titleTemplate: (titleTemplateInput && titleTemplateInput.value) || '${name}'
        });
      });
    }

    // Auto-Rename item using vision (Removed since DeepSeek V4 does not support vision)

    // Image Upload trigger
    const uploadImgsBtn = row.querySelector('[data-action="upload-imgs"]');
    if (uploadImgsBtn) {
      uploadImgsBtn.addEventListener('click', () => {
        openUploadModal(item);
      });
    }

    // Rename folder handler (inline edit)
    const renameBtn = row.querySelector('[data-action="rename"]');
    if (renameBtn) {
      renameBtn.addEventListener('click', () => {
        const folderNameEl = row.querySelector('.folder-name');
        const rowActionsEl = row.querySelector('.row-actions');
        if (!folderNameEl || !rowActionsEl) return;

        // Replace folder name with an inline text input
        folderNameEl.innerHTML = `<input type="text" class="inline-rename-input" value="${item.name}" style="width: 100%; background: #020617; color: #fff; border: 1px solid var(--border); padding: 2px 6px; border-radius: 4px; font-size: 13px; font-weight: 500; outline: none;">`;
        const inputEl = folderNameEl.querySelector('.inline-rename-input');
        inputEl.focus();
        inputEl.select();

        // Replace actions with Save / Cancel buttons
        rowActionsEl.innerHTML = `
          <button class="btn btn-success row-btn" data-action="save-rename" style="padding: 2px 6px; font-size: 11px;">💾 Save</button>
          <button class="btn btn-secondary row-btn" data-action="cancel-rename" style="padding: 2px 6px; font-size: 11px;">❌</button>
        `;

        // Wire up cancel
        rowActionsEl.querySelector('[data-action="cancel-rename"]').addEventListener('click', () => {
          renderQueue();
        });

        // Wire up save
        const saveBtn = rowActionsEl.querySelector('[data-action="save-rename"]');
        const triggerSave = async () => {
          const newName = inputEl.value.trim();
          if (!newName || newName === item.name) {
            renderQueue();
            return;
          }
          saveBtn.disabled = true;
          saveBtn.textContent = '...';
          try {
            const res = await window.api.renameFolder(currentFolder, item.name, newName);
            if (res && res.success) {
              addLog(`[System]: Renamed folder on disk from "${item.name}" to "${newName}"`, 'system');
              await scanCurrentFolder();
            } else {
              alert(res.message || 'Failed to rename folder.');
              renderQueue();
            }
          } catch (err) {
            alert(`Error renaming folder: ${err.message}`);
            renderQueue();
          }
        };

        saveBtn.addEventListener('click', triggerSave);

        // Enter to Save, Escape to Cancel
        inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            triggerSave();
          } else if (e.key === 'Escape') {
            renderQueue();
          }
        });
      });
    }

    // Open directory in File Explorer handler
    const openDirBtn = row.querySelector('[data-action="open-dir"]');
    if (openDirBtn) {
      openDirBtn.addEventListener('click', async () => {
        await window.api.openFolder(item.fullPath);
      });
    }

    const doneBtn = row.querySelector('[data-action="done"]');
    if (doneBtn) {
      doneBtn.addEventListener('click', async () => {
        doneBtn.disabled = true;
        doneBtn.textContent = '...';

        try {
          const result = await window.api.markItemDone({ index, name: item.name });
          if (result && result.success) {
            addLog(`[System]: Manually marked "${item.name}" as done.`, 'system');
          } else {
            addLog(`[Error]: ${result?.message || 'Could not mark item done.'}`, 'system');
            doneBtn.disabled = false;
            doneBtn.textContent = 'Done';
          }
        } catch (err) {
          addLog(`[Error]: Could not mark item done - ${err.message}`, 'system');
          doneBtn.disabled = false;
          doneBtn.textContent = 'Done';
        }
      });
    }

    // Republish handler
    const republishBtn = row.querySelector('[data-action="republish"]');
    if (republishBtn) {
      republishBtn.addEventListener('click', async () => {
        republishBtn.disabled = true;
        republishBtn.textContent = '...';
        try {
          const result = await window.api.republishItem({ name: item.name });
          if (result && result.success) {
            addLog(`[System]: "${item.name}" moved back to pending list and republishing started.`, 'system');
            await scanCurrentFolder();
          } else {
            addLog(`[Error]: Failed to republish "${item.name}" - ${result?.message || 'Unknown error'}`, 'system');
            republishBtn.disabled = false;
            republishBtn.textContent = '🔄 Republish';
          }
        } catch (err) {
          addLog(`[Error]: Failed to republish "${item.name}" - ${err.message}`, 'system');
          republishBtn.disabled = false;
          republishBtn.textContent = '🔄 Republish';
        }
      });
    }

    queueRows.appendChild(row);
  });
  updateBulkPanel();
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

  if (isRunning) {
    startBtn.disabled = false;
    startBtn.textContent = '⏹ Stop';
    pauseBtn.disabled = false;
    pauseBtn.textContent = isPaused ? '▶ Resume' : '⏸ Pause';
  } else {
    startBtn.disabled = !hasQueue || !hasPending;
    startBtn.textContent = '▶ Start Automation';
    pauseBtn.disabled = true;
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
    titleTemplate,
    items: queue.map(item => ({
      name: item.name,
      price: item.price !== undefined ? item.price : defaultPrice,
      template: item.template || 'universal'
    }))
  });
}

async function stopAutomation() {
  addLog('[System]: Stopping automation...', 'system');
  await window.api.stopAutomation();
  isRunning = false;
  isPaused = false;
  updateControlStates();
}

async function pauseAutomation() {
  isPaused = !isPaused;
  await window.api.pauseAutomation();
  updateControlStates();

  addLog(isPaused ? '[System]: Automation paused by user.' : '[System]: Automation resumed.', 'system');
}

function setupControlButtons() {
  const tabPending = $('tab-pending');
  const tabPublished = $('tab-published');

  if (tabPending && tabPublished) {
    tabPending.addEventListener('click', () => {
      activeTab = 'pending';
      tabPending.classList.add('active');
      tabPublished.classList.remove('active');
      renderQueue();
    });

    tabPublished.addEventListener('click', () => {
      activeTab = 'published';
      tabPublished.classList.add('active');
      tabPending.classList.remove('active');
      renderQueue();
    });
  }

  // Search Input Event
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderQueue();
    });
  }

  // Bulk Select All Event
  if (bulkSelectAll) {
    bulkSelectAll.addEventListener('change', (e) => {
      const checked = e.target.checked;
      const filtered = getFilteredQueue();
      filtered.forEach(item => {
        item.selected = checked;
      });
      const checkboxes = queueRows.querySelectorAll('.row-select');
      checkboxes.forEach(cb => {
        cb.checked = checked;
      });
      updateBulkPanel();
    });
  }

  // Bulk Cancel
  if (bulkCancelBtn) {
    bulkCancelBtn.addEventListener('click', () => {
      queue.forEach(item => item.selected = false);
      if (bulkSelectAll) bulkSelectAll.checked = false;
      updateBulkPanel();
      renderQueue();
    });
  }

  // Bulk Apply
  if (bulkApplyBtn) {
    bulkApplyBtn.addEventListener('click', async () => {
      const selectedItems = queue.filter(item => item.selected);
      if (selectedItems.length === 0) return;

      const bulkPriceRaw = bulkPriceInput.value.trim();
      const bulkPrice = bulkPriceRaw !== '' ? parseInt(bulkPriceRaw) : null;
      const bulkTemplate = bulkTemplateSelect.value;

      if (bulkPrice === null && !bulkTemplate) {
        alert('Please specify a price or template to apply.');
        return;
      }

      bulkApplyBtn.disabled = true;
      bulkApplyBtn.textContent = 'Applying...';
      addLog(`[System]: Applying bulk overrides to ${selectedItems.length} items...`, 'system');

      try {
        for (const item of selectedItems) {
          if (bulkPrice !== null) item.price = bulkPrice;
          if (bulkTemplate) item.template = bulkTemplate;

          const priceToSave = item.price !== undefined ? item.price : 65;
          const templateToSave = item.template || 'universal';

          await window.api.saveFolderCustomization(item.name, priceToSave, templateToSave);
        }

        bulkPriceInput.value = '';
        bulkTemplateSelect.value = '';
        queue.forEach(item => item.selected = false);
        if (bulkSelectAll) bulkSelectAll.checked = false;
        updateBulkPanel();
        await scanCurrentFolder();
      } catch (err) {
        addLog(`[Error]: Failed to apply bulk overrides - ${err.message}`, 'system');
        alert(`Error applying bulk changes: ${err.message}`);
      } finally {
        bulkApplyBtn.disabled = false;
        bulkApplyBtn.textContent = 'Apply to Selected';
      }
    });
  }

  // Bulk DeepSeek Rewrite
  const bulkDeepSeekBtn = $('bulk-deepseek-btn');
  if (bulkDeepSeekBtn) {
    bulkDeepSeekBtn.addEventListener('click', async () => {
      const selectedItems = queue.filter(item => item.selected);
      if (selectedItems.length === 0) return;
      bulkDeepSeekBtn.disabled = true;
      bulkDeepSeekBtn.textContent = `Rewriting ${selectedItems.length}...`;
      addLog(`[DeepSeek]: Bulk rewriting descriptions for ${selectedItems.length} item(s)...`, 'system');
      try {
        const names = selectedItems.map(i => i.name);
        const res = await window.api.bulkDeepSeekRewrite(names);
        if (res.success) {
          for (const item of selectedItems) {
            if (res.results[item.name]) item.generatedDescription = res.results[item.name];
          }
          addLog(`[DeepSeek]: Bulk rewrite complete. Descriptions pre-loaded for ${selectedItems.length} item(s).`, 'system');
          renderQueue();
        } else {
          addLog(`[DeepSeek Error]: ${res.message}`, 'system');
        }
      } catch (err) {
        addLog(`[DeepSeek Error]: Bulk rewrite failed — ${err.message}`, 'system');
      } finally {
        bulkDeepSeekBtn.disabled = false;
        bulkDeepSeekBtn.textContent = '✨ Rewrite with DeepSeek';
      }
    });
  }

  // DeepSeek Verify Key Click
  if (deepseekVerifyBtn) {
    deepseekVerifyBtn.addEventListener('click', async () => {
      const key = deepseekKeyInput.value.trim();
      if (!key) {
        deepseekStatus.textContent = 'No Key';
        deepseekStatus.style.background = '#1e2937';
        deepseekStatus.style.color = '#cbd5e1';
        return;
      }

      deepseekVerifyBtn.disabled = true;
      deepseekVerifyBtn.textContent = '...';
      deepseekStatus.textContent = 'Verifying';
      deepseekStatus.style.background = '#1e2937';
      deepseekStatus.style.color = '#cbd5e1';

      try {
        const res = await window.api.validateDeepSeekKey(key);
        if (res && res.success) {
          deepseekStatus.textContent = 'DeepSeek Ready';
          deepseekStatus.style.background = '#166534';
          deepseekStatus.style.color = '#4ade80';
          addLog(`[DeepSeek]: Key verified successfully.`, 'system');
        } else {
          deepseekStatus.textContent = 'Invalid';
          deepseekStatus.style.background = '#450a0a';
          deepseekStatus.style.color = '#fda4af';
          addLog(`[DeepSeek Error]: Key validation failed: ${res.message || 'Unknown error'}`, 'system');
        }
      } catch (err) {
        deepseekStatus.textContent = 'Error';
        deepseekStatus.style.background = '#450a0a';
        deepseekStatus.style.color = '#fda4af';
        addLog(`[DeepSeek Error]: Verification failed - ${err.message}`, 'system');
      } finally {
        deepseekVerifyBtn.disabled = false;
        deepseekVerifyBtn.textContent = 'Verify';
      }
    });
  }

  // Image Upload Modal Events
  if (imgModalClose) {
    const closeImgModal = () => closeUploadModal();
    imgModalClose.addEventListener('click', closeImgModal);
    if (imgCancelBtn) imgCancelBtn.addEventListener('click', closeImgModal);
    if (imgModalBackdrop) imgModalBackdrop.addEventListener('click', closeImgModal);
  }

  if (imgDropzone) {
    imgDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      imgDropzone.classList.add('dragover');
    });

    imgDropzone.addEventListener('dragleave', () => {
      imgDropzone.classList.remove('dragover');
    });

    imgDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      imgDropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleFilesSelected(e.dataTransfer.files);
      }
    });

    imgDropzone.addEventListener('click', (e) => {
      if (e.target.id !== 'image-file-input') {
        imgFileInput.click();
      }
    });
  }

  if (imgFileInput) {
    imgFileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        handleFilesSelected(e.target.files);
      }
    });
  }

  if (imgSaveBtn) {
    imgSaveBtn.addEventListener('click', async () => {
      if (!uploadTargetItem || uploadImagesArray.length === 0) return;

      imgSaveBtn.disabled = true;
      imgSaveBtn.textContent = 'Saving...';
      addLog(`[System]: Saving ${uploadImagesArray.length} images to ${uploadTargetItem.name}...`, 'system');

      try {
        const res = await window.api.saveUploadedImages(uploadTargetItem.fullPath, uploadImagesArray);
        if (res && res.success) {
          addLog(`[System]: Images saved successfully to disk. Rescanning.`, 'system');
          closeUploadModal();
          await scanCurrentFolder();
        } else {
          alert(res.message || 'Failed to save images.');
        }
      } catch (err) {
        alert(`Error saving images: ${err.message}`);
      } finally {
        imgSaveBtn.disabled = false;
        imgSaveBtn.textContent = 'Save Images';
      }
    });
  }

  pickBtn.addEventListener('click', selectAndScanFolder);
  rescanBtn.addEventListener('click', scanCurrentFolder);
  if (cleanNamesBtn) {
    cleanNamesBtn.addEventListener('click', async () => {
      if (!currentFolder) {
        alert('Please select a target folder first.');
        return;
      }
      const confirmed = confirm('Are you sure you want to clean/correct the subfolder names in the current folder?\n\nThis will:\n1. Rename subfolders on disk (remove timestamps, social handles, Telegram tags)\n2. Handle duplicate folder names by appending (1), (2), etc.\n3. Update matching records in processed.json to keep them marked as Done.\n\nProceed?');
      if (!confirmed) return;

      cleanNamesBtn.disabled = true;
      const originalText = cleanNamesBtn.textContent;
      cleanNamesBtn.textContent = '🧹 Cleaning...';
      try {
        const result = await window.api.cleanFolderNames(currentFolder);
        if (result && result.success) {
          addLog(`[System]: Folder names cleaned successfully. Renamed ${result.renamedCount} folder(s).`, 'system');
          await scanCurrentFolder();
        } else {
          addLog(`[Error]: Failed to clean folder names: ${result?.message || 'Unknown error'}`, 'system');
          alert(`Failed to clean folder names: ${result?.message || 'Unknown error'}`);
        }
      } catch (err) {
        addLog(`[Error]: Failed to clean folder names: ${err.message}`, 'system');
        alert(`Failed to clean folder names: ${err.message}`);
      } finally {
        cleanNamesBtn.disabled = false;
        cleanNamesBtn.textContent = originalText;
      }
    });
  }
  clearQueueBtn.addEventListener('click', () => {
    queue = [];
    renderQueue();
    updateControlStates();
    addLog('[System]: Queue cleared (local only).', 'system');
  });

  startBtn.addEventListener('click', () => {
    if (isRunning) {
      stopAutomation();
    } else {
      startAutomation();
    }
  });
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

  // Automation Chrome (CDP)
  browserToggle.addEventListener('click', async () => {
    const current = browserStatusText.textContent || '';
    if (current.includes('Connected')) {
      browserDot.classList.add('connecting');
      browserStatusText.textContent = 'Checking...';
      await window.api.checkAutomationBrowser();
    } else {
      browserDot.classList.add('connecting');
      browserStatusText.textContent = 'Connecting...';
      await window.api.launchAutomationChrome();
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

// ==================== Templates Modal Management & Editor ====================
async function fetchTemplates() {
  try {
    templatesMap = await window.api.loadTemplates();
  } catch (err) {
    console.error('Failed to load templates', err);
  }
}

function renderModalTemplatesList() {
  templatesListItems.innerHTML = '';
  
  Object.keys(templatesMap).forEach(key => {
    const item = templatesMap[key];
    const div = document.createElement('div');
    div.className = `template-item ${activeTemplateKey === key ? 'active' : ''}`;
    
    const systemDefaults = ['helmet', 'axe', 'sword', 'armor', 'mask', 'lifesize', 'universal'];
    if (systemDefaults.includes(key)) {
      div.classList.add('system-default');
    }
    
    div.textContent = item.label;
    div.addEventListener('click', () => {
      selectTemplateForEditing(key);
    });
    templatesListItems.appendChild(div);
  });
}

function selectTemplateForEditing(key) {
  activeTemplateKey = key;
  renderModalTemplatesList();
  
  if (key === null) {
    templateEditorForm.style.display = 'none';
    templateEditorEmpty.style.display = 'flex';
    return;
  }
  
  templateEditorForm.style.display = 'flex';
  templateEditorEmpty.style.display = 'none';
  
  const item = templatesMap[key];
  tplLabelInput.value = item.label;
  tplTextInput.value = item.text || '';
  
  const systemDefaults = ['helmet', 'axe', 'sword', 'armor', 'mask', 'lifesize', 'universal'];
  if (systemDefaults.includes(key)) {
    deleteTemplateBtn.style.display = 'none';
  } else {
    deleteTemplateBtn.style.display = 'block';
  }
}

function setupTemplatesModal() {
  if (!manageTemplatesBtn) return;
  
  manageTemplatesBtn.addEventListener('click', async () => {
    await fetchTemplates();
    activeTemplateKey = null;
    selectTemplateForEditing(null);
    templatesModal.style.display = 'flex';
  });
  
  const closeModal = () => {
    templatesModal.style.display = 'none';
    renderQueue();
  };
  
  templatesModalClose.addEventListener('click', closeModal);
  templatesModalBackdrop.addEventListener('click', closeModal);
  
  addTemplateBtn.addEventListener('click', () => {
    const newKey = 'custom_' + Date.now();
    templatesMap[newKey] = {
      label: 'New Template',
      text: 'Description text using ${name}...'
    };
    selectTemplateForEditing(newKey);
  });
  
  saveTemplateBtn.addEventListener('click', async () => {
    if (!activeTemplateKey) return;
    
    const label = tplLabelInput.value.trim();
    const text = tplTextInput.value;
    
    if (!label) {
      alert('Template name cannot be empty.');
      return;
    }
    
    templatesMap[activeTemplateKey].label = label;
    templatesMap[activeTemplateKey].text = text;
    
    const success = await window.api.saveTemplates(templatesMap);
    if (success) {
      addLog(`[System]: Template "${label}" saved successfully.`, 'system');
      renderModalTemplatesList();
    } else {
      alert('Failed to save templates.');
    }
  });
  
  deleteTemplateBtn.addEventListener('click', async () => {
    if (!activeTemplateKey) return;
    const systemDefaults = ['helmet', 'axe', 'sword', 'armor', 'mask', 'lifesize', 'universal'];
    if (systemDefaults.includes(activeTemplateKey)) {
      alert('Cannot delete default system templates.');
      return;
    }
    
    const label = templatesMap[activeTemplateKey].label;
    const confirmed = confirm(`Are you sure you want to delete template "${label}"?`);
    if (!confirmed) return;
    
    delete templatesMap[activeTemplateKey];
    activeTemplateKey = null;
    
    const success = await window.api.saveTemplates(templatesMap);
    if (success) {
      addLog(`[System]: Template "${label}" deleted.`, 'system');
      selectTemplateForEditing(null);
    } else {
      alert('Failed to delete template.');
    }
  });
}

// ==================== Initialization ====================
async function init() {
  await fetchTemplates();
  setupListeners();
  setupDragAndDrop();
  setupControlButtons();
  setupTemplatesModal();

  // Load DeepSeek key on startup
  try {
    const key = await window.api.getDeepSeekKey();
    if (key) {
      deepseekKeyInput.value = key;
      const res = await window.api.validateDeepSeekKey(key);
      if (res && res.success) {
        deepseekStatus.textContent = 'DeepSeek Ready';
        deepseekStatus.style.background = '#166534';
        deepseekStatus.style.color = '#4ade80';
      } else {
        deepseekStatus.textContent = 'Invalid';
        deepseekStatus.style.background = '#450a0a';
        deepseekStatus.style.color = '#fda4af';
      }
    }
  } catch (err) {
    console.error('Failed to load/validate DeepSeek Key on start', err);
  }

  setTimeout(() => {
    addLog('Ready. Select or drop your product folder. Processed items will be filtered via processed.json.', 'system');
    addLog('[Tip]: Use the top-right Automation Chrome buttons: Launch the dedicated profile → log into FB *once* there. 💾 backs up cookies, ↩︎ restores login, 📁 opens the profile folder (this is what actually keeps you logged in).', 'system');
    addLog('[Tip]: Edit TITLE TEMPLATE (next to price) before Start. Use ${name} placeholder e.g. "${name} DIY from YoshStudios".', 'system');
  }, 800);

  // Restore last folder if any
  try {
    const lastFolder = await window.api.getLastFolder();
    if (lastFolder) {
      currentFolder = lastFolder;
      selectedPathEl.textContent = lastFolder;
      selectedPathEl.style.color = '#e0e7ff';
      addLog(`[System]: Restored last folder → ${lastFolder}`, 'system');
      await scanCurrentFolder();
    }
  } catch (err) {
    console.error('Failed to restore last folder', err);
  }

  console.log('%c[Marketplace Automation] Renderer ready. IPC wired to main for grok_cli + CDP automation.', 'color:#475569');
}

// Boot
window.addEventListener('DOMContentLoaded', init);
