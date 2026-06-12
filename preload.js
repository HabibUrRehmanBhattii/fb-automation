const { contextBridge, ipcRenderer } = require('electron');

// Secure bridge between renderer and main process.
// Only expose the exact methods the UI needs.

contextBridge.exposeInMainWorld('api', {
  // Folder operations (native Windows dialogs + real fs scan)
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),

  // Automation control
  startAutomation: (payload) => ipcRenderer.invoke('start-automation', payload),
  pauseAutomation: () => ipcRenderer.invoke('pause-automation'),
  setDefaultPrice: (price) => ipcRenderer.invoke('set-default-price', price),
  setDefaultTitleTemplate: (tpl) => ipcRenderer.invoke('set-default-title-template', tpl),
  runSingleItem: (payload) => ipcRenderer.invoke('run-single-item', payload),

  // Debug / Playwright browser (local visible browser for testing Marketplace flow)
  launchDebugBrowser: () => ipcRenderer.invoke('launch-debug-browser'),
  closeDebugBrowser: () => ipcRenderer.invoke('close-debug-browser'),

  // Automation Chrome (the real one that must listen on 9222 + dedicated profile for CDP + persistent FB login)
  launchAutomationChrome: () => ipcRenderer.invoke('launch-automation-chrome'),
  checkAutomationBrowser: () => ipcRenderer.invoke('check-automation-browser'),

  // Visibility toggles (Chrome window and launcher terminal/console)
  toggleChromeVisibility: () => ipcRenderer.invoke('toggle-chrome-visibility'),
  getChromeVisibility: () => ipcRenderer.invoke('get-chrome-visibility'),
  toggleTerminalVisibility: () => ipcRenderer.invoke('toggle-terminal-visibility'),
  getTerminalVisibility: () => ipcRenderer.invoke('get-terminal-visibility'),

  // New IPC bridge for reliable Chrome restart (visible/hidden) from UI
  restartChrome: (isVisible) => ipcRenderer.invoke('restart-chrome', isVisible),

  // "Copy cookies" / persistent login tools
  openAutomationProfile: () => ipcRenderer.invoke('open-automation-profile'),
  exportFBCookies: () => ipcRenderer.invoke('export-fb-cookies'),
  importFBCookies: () => ipcRenderer.invoke('import-fb-cookies'),

  // Window controls (for frameless premium title bar)
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),

  // Live event subscriptions (main pushes updates)
  onLog: (callback) => {
    ipcRenderer.on('log', (_event, message) => callback(message));
  },
  onQueueUpdate: (callback) => {
    ipcRenderer.on('queue-update', (_event, queue) => callback(queue));
  },
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, data) => callback(data));
  },
  onBrowserStatus: (callback) => {
    ipcRenderer.on('browser-status', (_event, status) => callback(status));
  },
});
