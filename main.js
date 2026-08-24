const { app, BrowserWindow, BrowserView, Tray, Menu, ipcMain, screen, nativeImage, shell, safeStorage, session, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// ── Crash/error logging — without this, a startup failure on a
// teammate's PC is completely invisible: no console (no terminal
// attached when launched from the installed .exe), so "it doesn't
// work" has no diagnosable cause. Every uncaught error now gets
// written to a log file next to the app's own data folder, and (once
// the app has finished starting) shown in a plain error dialog. ──
function logFilePath() {
  try { return path.join(app.getPath('userData'), 'ghz-bubble-error.log'); }
  catch (e) { return path.join(require('os').tmpdir(), 'ghz-bubble-error.log'); }
}
function logFatal(label, err) {
  const line = '[' + new Date().toISOString() + '] ' + label + ': ' +
    (err && err.stack ? err.stack : String(err)) + '\n';
  try { fs.appendFileSync(logFilePath(), line); } catch (e) { /* best effort only */ }
  try {
    if (app.isReady()) {
      dialog.showErrorBox('GigaHelpDesk Bubble ran into a problem',
        String(label) + '\n\n' + (err && err.message ? err.message : String(err)) +
        '\n\nDetails were saved to:\n' + logFilePath());
    }
  } catch (e) { /* dialog may not be available this early */ }
}
process.on('uncaughtException', (err) => logFatal('Uncaught exception', err));
process.on('unhandledRejection', (err) => logFatal('Unhandled rejection', err));

const BUBBLE_VISUAL = 90;  // default visible circle diameter (must match CSS --bubble-size)
const RING_PAD = 12;       // invisible margin so the connection ring/handle aren't clipped

// Messenger-style makeover for the embedded ticket page (see
// ticket-view/messenger.{css,js} and injectMessengerUI() below). Read
// once at startup; re-used on every ticket the panel loads.
let MESSENGER_CSS = '';
let MESSENGER_JS = '';
try {
  MESSENGER_CSS = fs.readFileSync(path.join(__dirname, 'ticket-view', 'messenger.css'), 'utf8');
  MESSENGER_JS = fs.readFileSync(path.join(__dirname, 'ticket-view', 'messenger.js'), 'utf8');
} catch (e) {
  // Non-fatal — worst case the ticket panel just falls back to the site's normal layout.
}

let win;
let tray;
let currentMode = 'circle'; // 'circle' (bubble, incl. preview popup) or 'rect' (expanded panel)
let lastBubbleBounds = null; // the bubble's true "home" bounds — never touched during a transient preview
let currentBubbleDiameter = 0; // the ONE source of truth for how big the circle is — never trust win.getBounds() width/height for this, since that can transiently include preview-stack padding

const UPDATE_FEED_URL = process.env.GHZ_UPDATE_URL || '';
const GITHUB_UPDATE_CONFIG = {
  provider: 'github',
  owner: 'drewgigahertz-ai',
  repo: 'gigahelpdesk-bubble',
  releaseType: 'release'
};
let updateState = { configured: true, checking: false, available: false, downloaded: false, version: null, error: null };

function configureAutoUpdates() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL(UPDATE_FEED_URL ? { provider: 'generic', url: UPDATE_FEED_URL } : GITHUB_UPDATE_CONFIG);
  autoUpdater.on('checking-for-update', () => { updateState = { ...updateState, checking: true, error: null }; });
  autoUpdater.on('update-not-available', () => { updateState = { ...updateState, checking: false, available: false, error: null }; });
  autoUpdater.on('update-available', info => { updateState = { ...updateState, checking: false, available: true, version: info.version, error: null }; });
  autoUpdater.on('update-downloaded', info => { updateState = { ...updateState, checking: false, downloaded: true, version: info.version, error: null }; });
  autoUpdater.on('error', err => { updateState = { ...updateState, checking: false, error: err.message || String(err) }; });
  autoUpdater.checkForUpdates().catch(() => {});
}

function diameterOf(visual) { return visual + RING_PAD * 2; }

function isFiniteNum(n) { return typeof n === 'number' && Number.isFinite(n); }

// Every native BrowserWindow/BrowserView bounds call in this file goes
// through these two helpers. Electron's native bindings throw a hard
// "conversion failure" exception (crashing the whole app, since it's
// synchronous and outside any try/catch a caller might have) if asked
// to set a NaN/undefined x/y/width/height — which can happen from
// perfectly ordinary JS bugs (a measurement read before layout settles,
// an IPC payload missing a field) that differ machine-to-machine only
// because of timing, not logic. Rounding + falling back to the window's
// own current value makes that whole class of crash impossible.
function safeNum(n, fallback) {
  const r = Math.round(Number(n));
  return Number.isFinite(r) ? r : fallback;
}
function safeSetBounds(target, b) {
  if (!target) return;
  let cur;
  try { cur = target.getBounds(); } catch (e) { cur = { x: 0, y: 0, width: 1, height: 1 }; }
  target.setBounds({
    x: safeNum(b.x, cur.x),
    y: safeNum(b.y, cur.y),
    width: Math.max(1, safeNum(b.width, cur.width)),
    height: Math.max(1, safeNum(b.height, cur.height))
  });
}
function safeSetPosition(target, x, y) {
  if (!target) return;
  let cur;
  try { cur = target.getBounds(); } catch (e) { cur = { x: 0, y: 0 }; }
  target.setPosition(safeNum(x, cur.x), safeNum(y, cur.y));
}
function safeSetSize(target, method, w, h, fallbackW, fallbackH) {
  if (!target) return;
  target[method](safeNum(w, fallbackW), safeNum(h, fallbackH));
}

function clampToWorkArea(x, y, width, height) {
  x = safeNum(x, 0); y = safeNum(y, 0);
  width = safeNum(width, 300); height = safeNum(height, 300);
  const display = screen.getDisplayNearestPoint({ x, y });
  const wa = display.workArea;
  return {
    x: Math.min(Math.max(x, wa.x), wa.x + wa.width - width),
    y: Math.min(Math.max(y, wa.y), wa.y + wa.height - height)
  };
}

// Shrinks width/height (never position) so a panel can never be asked to be
// bigger than the screen it's on — this is what previously let a
// too-tall/too-wide panel get clipped or pushed partly off-screen.
function fitToWorkArea(x, y, width, height, minW, minH) {
  x = safeNum(x, 0); y = safeNum(y, 0);
  width = safeNum(width, minW); height = safeNum(height, minH);
  const display = screen.getDisplayNearestPoint({ x, y });
  const wa = display.workArea;
  return {
    width: Math.max(minW, Math.min(width, wa.width - 20)),
    height: Math.max(minH, Math.min(height, wa.height - 20))
  };
}

// The bubble's size is ALWAYS currentBubbleDiameter — only x/y are ever
// remembered from lastBubbleBounds, and only if they look sane. This is
// what guarantees the bubble can never end up "missing": a corrupted or
// stale lastBubbleBounds can at worst put it in the wrong spot, never at
// an invalid size or off every display.
function safeBubbleHome() {
  const { workArea } = screen.getPrimaryDisplay();
  const fallback = {
    x: workArea.x + workArea.width - currentBubbleDiameter - 30,
    y: workArea.y + workArea.height - currentBubbleDiameter - 70,
    width: currentBubbleDiameter,
    height: currentBubbleDiameter
  };
  if (!lastBubbleBounds || !isFiniteNum(lastBubbleBounds.x) || !isFiniteNum(lastBubbleBounds.y)) {
    return fallback;
  }
  const clamped = clampToWorkArea(lastBubbleBounds.x, lastBubbleBounds.y, currentBubbleDiameter, currentBubbleDiameter);
  return { x: clamped.x, y: clamped.y, width: currentBubbleDiameter, height: currentBubbleDiameter };
}

function reassertAlwaysOnTop() {
  if (!win) return;
  win.setAlwaysOnTop(true, 'screen-saver');
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const diameter = diameterOf(BUBBLE_VISUAL);
  currentBubbleDiameter = diameter;
  const x = workArea.x + workArea.width - diameter - 30;
  const y = workArea.y + workArea.height - diameter - 70;

  win = new BrowserWindow({
    width: diameter,
    height: diameter,
    x, y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  win.loadFile('bubble.html');
  win.webContents.once('did-finish-load', () => {
    const b = win.getBounds();
    lastBubbleBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
  });

  win.on('blur', reassertAlwaysOnTop);
  win.on('show', reassertAlwaysOnTop);
  setInterval(reassertAlwaysOnTop, 2000);

  win.on('closed', () => { win = null; ticketView = null; });

  win.webContents.on('render-process-gone', (e, details) => {
    if (details.reason === 'clean-exit') return;
    win = null;
    createWindow();
  });
}

function resetToDefaultPosition() {
  if (!win) return;
  const { workArea } = screen.getPrimaryDisplay();
  const diameter = diameterOf(BUBBLE_VISUAL);
  currentBubbleDiameter = diameter;
  const x = workArea.x + workArea.width - diameter - 30;
  const y = workArea.y + workArea.height - diameter - 70;
  safeSetBounds(win, { x, y, width: diameter, height: diameter });
  win.setResizable(false);
  currentMode = 'circle';
  lastBubbleBounds = { x, y, width: diameter, height: diameter };
  reassertAlwaysOnTop();
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('GigaHelpDesk Bubble');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show/Hide Bubble', click: () => { if (!win) return; win.isVisible() ? win.hide() : win.show(); } },
    { label: 'Reset Position', click: resetToDefaultPosition },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('click', () => { if (!win) return; win.isVisible() ? win.hide() : win.show(); });
}

// Only one copy should ever run per user — a second double-click (very
// common when someone isn't sure the first launch "did anything") would
// otherwise silently exit with no window ever appearing, which looks
// exactly like "it doesn't work."
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); reassertAlwaysOnTop(); }
  });

  app.whenReady().then(() => {
    try {
      removeLegacyCustomSound();
      createWindow();
      createTray();
      setupDownloadAutoOpen();
      configureAutoUpdates();
    } catch (err) {
      logFatal('Startup failed', err);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── IPC from the renderer (bubble.html) — window chrome ──

ipcMain.on('set-ignore-mouse', (e, ignore) => {
  if (!win) return;
  win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

ipcMain.on('hide-window', () => {
  if (win && !win.isDestroyed()) win.hide();
});

ipcMain.on('move-window', (e, { dx, dy }) => {
  if (!win) return;
  const cur = win.getBounds();
  const clamped = clampToWorkArea(cur.x + dx, cur.y + dy, cur.width, cur.height);
  safeSetPosition(win, clamped.x, clamped.y);
  if (currentMode === 'circle') {
    // Use the tracked diameter, NOT cur.width/height — if a preview-stack
    // popup happened to be showing (window temporarily wider to fit the
    // cards) at the moment of a drag, cur.width/height would be that
    // enlarged size, and saving it as the bubble's "home" is what could
    // make the bubble come back oddly sized/placed later.
    lastBubbleBounds = { x: clamped.x, y: clamped.y, width: currentBubbleDiameter, height: currentBubbleDiameter };
  }
});

ipcMain.on('resize-bubble', (e, { visualSize }) => {
  if (!win) return;
  const diameter = diameterOf(Math.max(40, safeNum(visualSize, BUBBLE_VISUAL)));
  currentBubbleDiameter = diameter;
  const cur = win.getBounds();
  const rightEdge = cur.x + cur.width;
  const centerY = cur.y + cur.height / 2;
  const targetX = rightEdge - diameter;
  const targetY = Math.round(centerY - diameter / 2);
  const clamped = clampToWorkArea(targetX, targetY, diameter, diameter);
  safeSetBounds(win, { x: clamped.x, y: clamped.y, width: diameter, height: diameter });
  win.setResizable(false);
  currentMode = 'circle';
  lastBubbleBounds = { x: clamped.x, y: clamped.y, width: diameter, height: diameter };
  reassertAlwaysOnTop();
});

ipcMain.on('expand-panel', (e, { width, height }) => {
  if (!win) return;
  win.setIgnoreMouseEvents(false, { forward: true });
  detachTicketView();
  const cur = win.getBounds();
  if (currentMode === 'circle') {
    lastBubbleBounds = { x: cur.x, y: cur.y, width: currentBubbleDiameter, height: currentBubbleDiameter };
  }
  const fitted = fitToWorkArea(cur.x, cur.y, width, height, 320, 420);
  const targetX = cur.x + cur.width - fitted.width;
  const targetY = cur.y;
  const clamped = clampToWorkArea(targetX, targetY, fitted.width, fitted.height);
  safeSetBounds(win, { x: clamped.x, y: clamped.y, width: fitted.width, height: fitted.height });
  // Resizable in this mode — lets the person drag an edge/corner to make
  // the panel bigger themselves, on top of whatever default size we set.
  win.setMinimumSize(320, 420);
  win.setMaximumSize(1000, 1400);
  win.setResizable(true);
  currentMode = 'rect';
  reassertAlwaysOnTop();
});

ipcMain.on('resize-panel', (e, { width, height }) => {
  if (!win || currentMode === 'circle') return;
  win.setIgnoreMouseEvents(false, { forward: true });
  const cur = win.getBounds();
  const fitted = fitToWorkArea(cur.x, cur.y, width, height, 320, 420);
  safeSetBounds(win, { x: cur.x, y: cur.y, width: fitted.width, height: fitted.height });
  reassertAlwaysOnTop();
});

ipcMain.on('collapse-bubble', () => {
  if (!win) return;
  detachTicketView();
  const target = safeBubbleHome();
  safeSetBounds(win, target);
  win.setResizable(false);
  currentMode = 'circle';
  lastBubbleBounds = target;
  reassertAlwaysOnTop();
});

ipcMain.on('show-preview-stack', (e, { extraWidth, stackHeight }) => {
  if (!win || currentMode !== 'circle') return;
  const home = lastBubbleBounds || win.getBounds();
  const diameter = currentBubbleDiameter;
  const newWidth = diameter + Math.max(0, extraWidth);
  const newHeight = Math.max(diameter, stackHeight);
  const rightEdge = home.x + home.width;
  const centerY = home.y + home.height / 2;
  const targetX = rightEdge - newWidth;
  const targetY = Math.round(centerY - newHeight / 2);
  const clamped = clampToWorkArea(targetX, targetY, newWidth, newHeight);
  safeSetBounds(win, { x: clamped.x, y: clamped.y, width: newWidth, height: newHeight });
  reassertAlwaysOnTop();
});

// ══════════════════════════════════════════════════════════════════════
// GigaHelpDesk login + notification polling — ported from Code.gs.
// Runs in the main process (not the renderer) because reading Set-Cookie
// headers and doing the token/cookie login dance needs full HTTP access
// that a browser-sandboxed renderer fetch() doesn't have.
// ══════════════════════════════════════════════════════════════════════

const BASE_URL = 'https://gigahelpdesk.ghzportal.com';
const LOGIN_PAGE_URL = BASE_URL + '/login';
const NOTIF_ENDPOINT = BASE_URL + '/admin/notifications/dropdown-data';
const SLA_CACHE_TTL_MS = 30000;
const SLA_WARNING_PERCENT = 0.8;
const SLA_BUSINESS_HOURS = { start: 9, end: 17 };
const ticketSlaCache = new Map();

function sessionFilePath() {
  return path.join(app.getPath('userData'), 'ghz-session.json');
}

function readSession() {
  try {
    return JSON.parse(fs.readFileSync(sessionFilePath(), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeSession(obj) {
  try {
    fs.writeFileSync(sessionFilePath(), JSON.stringify(obj), 'utf8');
  } catch (e) {
    // Non-fatal — worst case the user has to sign in again next launch.
  }
}

function customSoundsDir() {
  return path.join(app.getPath('userData'), 'custom-sounds');
}

function legacyCustomSoundFilePath() {
  return path.join(customSoundsDir(), 'sla-warning.mp3');
}

function legacyCustomSoundNamePath() {
  return path.join(customSoundsDir(), 'sla-warning-name.txt');
}

function removeLegacyCustomSound() {
  [legacyCustomSoundFilePath(), legacyCustomSoundNamePath()].forEach(file => {
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) {}
  });
}

ipcMain.handle('ghz:save-custom-sound', async (e, { name, data }) => {
  try {
    const bytes = Buffer.from(data);
    if (!bytes.length || bytes.length > 25 * 1024 * 1024) {
      return { success: false, message: 'Sound file is empty or larger than 25 MB' };
    }
    const id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const dir = customSoundsDir();
    fs.mkdirSync(dir, { recursive: true });
    const savedName = path.basename(typeof name === 'string' && name ? name : 'sound.mp3');
    fs.writeFileSync(path.join(dir, id + '.audio'), bytes);
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, name: savedName }), 'utf8');
    return { success: true, id, name: savedName };
  } catch (err) {
    return { success: false, message: 'Could not save sound: ' + err.message };
  }
});

ipcMain.handle('ghz:load-custom-sound', async () => {
  try {
    const dir = customSoundsDir();
    if (!fs.existsSync(dir)) return { success: true, sounds: [] };
    const sounds = [];
    fs.readdirSync(dir).filter(file => file.endsWith('.json')).forEach(metaFile => {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, metaFile), 'utf8'));
        const audioFile = path.join(dir, meta.id + '.audio');
        if (meta.id && fs.existsSync(audioFile)) {
          sounds.push({ id: meta.id, name: meta.name || 'sound', data: fs.readFileSync(audioFile).toString('base64') });
        }
      } catch (e) {}
    });
    if (!sounds.length && fs.existsSync(legacyCustomSoundFilePath())) {
      let name = 'sla-warning.mp3';
      try { name = fs.readFileSync(legacyCustomSoundNamePath(), 'utf8').trim() || name; } catch (e) {}
      sounds.push({ id: 'legacy-sla-warning', name, data: fs.readFileSync(legacyCustomSoundFilePath()).toString('base64') });
    }
    return { success: true, sounds };
  } catch (err) {
    return { success: false };
  }
});

ipcMain.handle('ghz:rename-custom-sound', async (e, { id, name }) => {
  try {
    const safeId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const savedName = path.basename(String(name || '').trim());
    if (!safeId || !savedName) return { success: false, message: 'Name is required' };
    const metaFile = path.join(customSoundsDir(), safeId + '.json');
    if (!fs.existsSync(metaFile)) return { success: false, message: 'Sound not found' };
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.name = savedName;
    fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');
    return { success: true, id: safeId, name: savedName };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('ghz:delete-custom-sound', async (e, { id }) => {
  try {
    const safeId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return { success: false };
    [safeId + '.audio', safeId + '.json'].forEach(file => {
      const target = path.join(customSoundsDir(), file);
      if (fs.existsSync(target)) fs.unlinkSync(target);
    });
    return { success: true, id: safeId };
  } catch (err) {
    return { success: false, message: err.message };
  }
});

ipcMain.handle('ghz:update-state', async () => updateState);
ipcMain.handle('ghz:check-for-update', async () => {
  if (updateState.checking) return updateState;
  try {
    updateState = { ...updateState, checking: true, error: null };
    await autoUpdater.checkForUpdates();
  } catch (err) {
    updateState = { ...updateState, checking: false, error: err.message || String(err) };
  }
  return updateState;
});
ipcMain.handle('ghz:install-update', async () => {
  if (!updateState.downloaded) return { success: false, message: 'No update downloaded' };
  autoUpdater.quitAndInstall();
  return { success: true };
});

// Encrypts the remembered password with the OS keychain (DPAPI / Keychain /
// libsecret) via Electron's safeStorage when available, falling back to
// storing it as-is (matching the original GAS PropertiesService behavior)
// on systems where OS-level encryption isn't available.
function encryptMaybe(str) {
  if (!str) return null;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { enc: true, data: safeStorage.encryptString(str).toString('base64') };
    }
  } catch (e) {}
  return { enc: false, data: str };
}

function decryptMaybe(obj) {
  if (!obj) return null;
  try {
    if (obj.enc && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(obj.data, 'base64'));
    }
  } catch (e) {}
  return obj.data;
}

function extractCookiesFromResponse(response, existingMap) {
  const map = Object.assign({}, existingMap || {});
  let list = [];
  if (typeof response.headers.getSetCookie === 'function') {
    list = response.headers.getSetCookie();
  } else {
    const single = response.headers.get('set-cookie');
    if (single) list = [single];
  }
  list.forEach(setCookieStr => {
    const firstPart = setCookieStr.split(';')[0];
    const idx = firstPart.indexOf('=');
    if (idx > -1) {
      map[firstPart.slice(0, idx).trim()] = firstPart.slice(idx + 1).trim();
    }
  });
  return map;
}

function cookieMapToString(map) {
  return Object.keys(map).map(k => k + '=' + map[k]).join('; ');
}

// Returns an updated cookie string if the response rotated any cookies
// (e.g. Laravel session regeneration), otherwise null.
function captureRotatedCookie(response, currentCookieString) {
  const cookieMap = {};
  (currentCookieString || '').split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > -1) cookieMap[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  });
  const updatedMap = extractCookiesFromResponse(response, cookieMap);
  const updatedString = cookieMapToString(updatedMap);
  return updatedString !== currentCookieString ? updatedString : null;
}

async function doLogin(email, password) {
  const getResp = await fetch(LOGIN_PAGE_URL, { method: 'GET' });
  const html = await getResp.text();
  const tokenMatch = html.match(/name="_token"\s+value="([^"]+)"/) ||
                      html.match(/name="csrf-token"\s+content="([^"]+)"/);

  if (!tokenMatch) {
    return { success: false, message: 'Could not find CSRF token on login page' };
  }
  const token = tokenMatch[1];
  const initialCookies = extractCookiesFromResponse(getResp);

  const body = new URLSearchParams({ _token: token, email, password });

  const postResp = await fetch(BASE_URL + '/login', {
    method: 'POST',
    body,
    headers: {
      'Cookie': cookieMapToString(initialCookies),
      'Referer': LOGIN_PAGE_URL,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    redirect: 'manual'
  });

  const postCode = postResp.status;
  if (postCode !== 302 && postCode !== 200 && postCode !== 0) {
    return { success: false, message: 'Login failed (code ' + postCode + ') — check email/password' };
  }

  const finalCookies = extractCookiesFromResponse(postResp, initialCookies);
  const cookieString = cookieMapToString(finalCookies);

  if (!finalCookies['gigahertz_helpdesk_session']) {
    return { success: false, message: 'Login rejected — check email/password' };
  }

  return { success: true, cookie: cookieString };
}

async function fetchNotifications(cookie) {
  const response = await fetch(NOTIF_ENDPOINT, {
    method: 'GET',
    headers: {
      'Cookie': cookie,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json'
    }
  });
  const code = response.status;
  const body = await response.text();
  const rotatedCookie = captureRotatedCookie(response, cookie);
  return { code, body, rotatedCookie };
}

function htmlToSearchText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDateNearLabel(text, labels) {
  const label = labels.join('|');
  const date = '(?:\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}(?:[ T,]+\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s*[AP]M)?)?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s+\\d{1,2},?\\s+\\d{4}(?:,?\\s+\\d{1,2}:\\d{2}(?::\\d{2})?\\s*[AP]M?)?)';
  const match = text.match(new RegExp('(?:' + label + ')[^\\d]{0,180}(' + date + ')', 'i'));
  if (!match) return null;
  const parsed = new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseDurationNearLabel(text, labels) {
  const label = labels.join('|');
  const duration = '(\\d+(?:\\.\\d+)?)\\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)';
  const match = text.match(new RegExp('(?:' + label + ')[^\\d]{0,100}(' + duration + ')', 'i'));
  if (!match) return null;
  const amount = Number(match[2]);
  const unit = match[3].toLowerCase();
  if (unit.startsWith('second') || unit.startsWith('sec')) return amount * 1000;
  if (unit.startsWith('minute') || unit.startsWith('min')) return amount * 60 * 1000;
  if (unit.startsWith('hour') || unit.startsWith('hr')) return amount * 60 * 60 * 1000;
  return amount * 24 * 60 * 60 * 1000;
}

function isBusinessTime(date) {
  const day = date.getDay();
  const hour = date.getHours() + date.getMinutes() / 60;
  return day >= 1 && day <= 5 && hour >= SLA_BUSINESS_HOURS.start && hour < SLA_BUSINESS_HOURS.end;
}

function addBusinessDuration(start, durationMs) {
  let cursor = new Date(start.getTime());
  let remaining = durationMs;
  while (remaining > 0) {
    if (!isBusinessTime(cursor)) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    const end = new Date(cursor);
    end.setHours(SLA_BUSINESS_HOURS.end, 0, 0, 0);
    const available = Math.min(remaining, end.getTime() - cursor.getTime());
    cursor = new Date(cursor.getTime() + available);
    remaining -= available;
    if (remaining > 0) cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
  }
  return cursor;
}

function parseSlaKpiCards(html) {
  const cards = [];
  const cardPattern = /<div[^>]*class=["'][^"']*ticket-sla-kpi-card[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]*class=["'][^"']*ticket-sla-kpi-card|$)/gi;
  let match;
  while ((match = cardPattern.exec(html))) {
    const card = htmlToSearchText(match[1]);
    const label = (card.match(/(?:First Response|Resolution)/i) || [])[0];
    const target = card.match(/Target\s+([\d.]+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?))/i);
    const due = card.match(/Due By\s+((?:\w{3,9}\s+\d{1,2},\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)))/i);
    if (!label) continue;
    cards.push({
      label: label.toLowerCase(),
      targetMs: target ? parseDurationNearLabel('Target ' + target[1], ['Target']) : null,
      due: due ? new Date(due[1]) : null,
      text: card
    });
  }
  return cards;
}

function parseTicketDetail(text, label, pattern) {
  const match = text.match(new RegExp(label + '[^\\S\\r\\n]{0,8}' + pattern, 'i'));
  return match ? match[1].trim() : null;
}

function extractTicketSla(html) {
  const text = htmlToSearchText(html);
  const status = (html.match(/ticket-detail-badge[^>]*>\s*([^<]+)/i) || [])[1] || '';
  const priority = (text.match(/Priority\s+([^\s]+(?:\s+[^\s]+)?)(?=\s+Created|\s+Ticket|\s+Status)/i) || [])[1] || '';
  const ticketNumber = parseTicketDetail(text, 'Ticket #', '([A-Z0-9][A-Z0-9-]*)');
  const requester = parseTicketDetail(text, 'Name', '(.+?)(?=\\s+Email\\s+)');
  const assignee = parseTicketDetail(text, '(?:Assigned To|Assignee)', '(.+?)(?=\\s+(?:Department|Team|SLA|Route)\\b|$)');
  const cards = parseSlaKpiCards(html);
  const firstResponseCard = cards.find(card => card.label === 'first response');
  const resolutionCard = cards.find(card => card.label === 'resolution');
  const firstResponseComplete = !!(firstResponseCard &&
    /(?:completed|met|sent|responded)/i.test(firstResponseCard.text)) ||
    /ticket-thread-item(?![^>]*\bis-system\b)/i.test(html);
  return {
    details: {
      ticket_number: ticketNumber,
      priority: priority || null,
      requester_name: requester,
      assignee_name: assignee,
      status: status.trim() || null
    },
    closed: /closed|resolved|cancelled/i.test(status),
    firstResponseComplete,
    createdAt: parseDateNearLabel(text, ['created(?: / received| at| on)?', 'opened(?: at| on)?', 'submitted(?: at| on)?', 'ticket date']),
    firstResponseDue: (firstResponseCard && firstResponseCard.due) || parseDateNearLabel(text, ['first response(?: due| deadline)?', 'response due', 'first reply(?: due| deadline)?']),
    firstResponseDurationMs: (firstResponseCard && firstResponseCard.targetMs) || parseDurationNearLabel(text, ['first response(?: time| SLA| target)?', 'response(?: time| SLA| target)?', 'first reply(?: time| SLA| target)?']),
    resolutionDue: (resolutionCard && resolutionCard.due) || parseDateNearLabel(text, ['resolution(?: due| deadline)?', 'resolve by', 'resolution target', 'due date']),
    resolutionDurationMs: (resolutionCard && resolutionCard.targetMs) || parseDurationNearLabel(text, ['resolution(?: time| SLA| target)?', 'resolve(?: time| SLA| target)?'])
  };
}

async function fetchTicketSla(cookie, url) {
  const cached = ticketSlaCache.get(url);
  if (cached && Date.now() - cached.checkedAt < SLA_CACHE_TTL_MS) return cached.value;
  // Abort after 10 s — a hung or slow server response must never block the
  // main-process event loop long enough for Windows to kill the app as hung.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const response = await fetch(url, { headers: { Cookie: cookie, Accept: 'text/html' }, signal: ac.signal });
    if (response.status !== 200) return null;
    const value = extractTicketSla(await response.text());
    ticketSlaCache.set(url, { checkedAt: Date.now(), value });
    return value;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function makeSlaAlerts(items, slaByUrl) {
  const now = Date.now();
  const alerts = [];
  items.forEach(item => {
    if (!item.open_url) return;
    const sla = slaByUrl[item.open_url];
    if (!sla || sla.closed) return;
    const checks = [
      ['first_response', 'First response SLA is close to overdue', sla.firstResponseComplete ? null : sla.firstResponseDue, sla.firstResponseDurationMs],
      ['resolution', 'Resolution SLA is close to overdue', sla.resolutionDue, sla.resolutionDurationMs]
    ];
    checks.forEach(([kind, title, parsedDue, durationMs]) => {
      if (kind === 'first_response' && sla.firstResponseComplete) return;
      const start = sla.createdAt || (item.created_at ? new Date(item.created_at) : null);
      const due = parsedDue || (start && durationMs ? addBusinessDuration(start, durationMs) : null);
      if (!due || !start || Number.isNaN(start.getTime()) || due <= start) return;
      const warningAt = start.getTime() + (due.getTime() - start.getTime()) * SLA_WARNING_PERCENT;
      const remaining = due.getTime() - now;
      if (now >= warningAt && remaining > -24 * 60 * 60000) {
        const overdue = remaining <= 0;
        alerts.push({
          id: 'sla:' + item.id + ':' + kind + ':' + due.getTime(),
          title,
          message: (item.title || 'Ticket') + ' — due ' + due.toLocaleString(),
          ticket_number: item.ticket_number,
          priority: item.priority,
          requester_name: item.requester_name,
          assignee_name: item.assignee_name,
          status: item.status,
          type: 'sla',
          sla_kind: kind,
          sla_state: overdue ? 'overdue' : 'warning',
          first_response_complete: !!sla.firstResponseComplete,
          sla_due_at: due.toISOString(),
          sla_remaining_ms: remaining,
          is_read: false,
          created_at: new Date().toISOString(),
          open_url: item.open_url
        });
      }
    });
  });
  return alerts;
}

async function getNotificationsInternal() {
  const session = readSession();
  let cookie = session.cookie;

  if (!cookie) {
    return { error: true, code: 401, message: 'Not logged in' };
  }

  let result = await fetchNotifications(cookie);
  if (result.rotatedCookie) {
    session.cookie = result.rotatedCookie;
    writeSession(session);
    cookie = result.rotatedCookie;
  }

  if (result.code === 401 || result.code === 419) {
    const email = session.email;
    const password = decryptMaybe(session.password);
    if (email && password) {
      const relogin = await doLogin(email, password);
      if (relogin.success) {
        session.cookie = relogin.cookie;
        writeSession(session);
        result = await fetchNotifications(relogin.cookie);
      } else {
        return { error: true, code: 401, message: 'Session expired, re-login failed' };
      }
    } else {
      delete session.cookie;
      writeSession(session);
      return { error: true, code: 401, message: 'Session expired, please log in again' };
    }
  }

  if (result.code !== 200) {
    return { error: true, code: result.code };
  }

  try {
    const data = JSON.parse(result.body);
    if (Array.isArray(data.items)) {
      const slaByUrl = {};
      // Fetch SLA data serially (one at a time) and cap at the 5 highest-priority
      // tickets per poll. Promise.all fired all fetches simultaneously, which — with
      // many open tickets or a slow server — created a fetch stampede that starved
      // the Node.js event loop long enough for Windows to kill Electron as hung.
      const urlsToFetch = [...new Set(data.items.filter(item => item.open_url).map(item => item.open_url))].slice(0, 5);
      for (const url of urlsToFetch) {
        const sla = await fetchTicketSla(cookie, url);
        if (sla) slaByUrl[url] = sla;
      }
      data.items.forEach(item => {
        const sla = item.open_url && slaByUrl[item.open_url];
        if (sla && sla.details) Object.assign(item, sla.details);
        if (sla) item.first_response_complete = !!sla.firstResponseComplete;
      });
      data.items = data.items.concat(makeSlaAlerts(data.items, slaByUrl));
    }
    return data;
  } catch (e) {
    return { error: true, code: 500, message: 'Invalid response from server' };
  }
}

ipcMain.handle('ghz:check-login', async () => {
  const session = readSession();
  return { loggedIn: !!session.cookie, email: session.email || null };
});

ipcMain.handle('ghz:login', async (e, { email, password, remember }) => {
  let result;
  try {
    result = await doLogin(email, password);
  } catch (err) {
    return { success: false, message: 'Network error: ' + err.message };
  }
  if (!result.success) {
    return { success: false, message: result.message };
  }

  const session = readSession();
  session.cookie = result.cookie;
  if (remember) {
    session.email = email;
    session.password = encryptMaybe(password);
  } else {
    delete session.email;
    delete session.password;
  }
  writeSession(session);
  return { success: true };
});

ipcMain.handle('ghz:logout', async () => {
  writeSession({});
  return { success: true };
});

ipcMain.handle('ghz:get-notifications', async () => {
  try {
    return await getNotificationsInternal();
  } catch (err) {
    return { error: true, code: 0, message: 'Network error: ' + err.message };
  }
});

// ══════════════════════════════════════════════════════════════════════
// Expanded ticket panel — NOT a separate window. This reuses the same
// bubble window: it resizes to a bigger panel and embeds a BrowserView
// (a native web layer docked inside that window, below the panel header)
// that loads the real GigaHelpDesk ticket page — status, SLA/pending
// time, full conversation, reply box, attachments, exactly as on the
// site. One BrowserView is created once and reused: clicking a different
// notification just loads a new URL into the same view instead of
// opening anything new.
//
// It works by handing the ticket page the same session cookie the bubble
// already uses for polling notifications, so it opens signed-in. Because
// this reuses the site's own page (not a hand-rolled re-implementation),
// replying and attaching files behave exactly like they do on the site —
// no guessing at undocumented "submit comment" endpoints.
// ══════════════════════════════════════════════════════════════════════

let ticketView = null; // the single reused BrowserView

// Re-validates (and if needed, silently refreshes) the stored session
// cookie before we hand it to the ticket panel — same 401/419
// auto-relogin path getNotificationsInternal() uses.
async function ensureFreshCookie() {
  const session = readSession();
  if (!session.cookie) return null;

  let result = await fetchNotifications(session.cookie);
  if (result.rotatedCookie) {
    session.cookie = result.rotatedCookie;
    writeSession(session);
  }

  if (result.code === 401 || result.code === 419) {
    const email = session.email;
    const password = decryptMaybe(session.password);
    if (email && password) {
      const relogin = await doLogin(email, password);
      if (relogin.success) {
        session.cookie = relogin.cookie;
        writeSession(session);
      } else {
        return null;
      }
    } else {
      return null;
    }
  }

  return readSession().cookie || null;
}

async function applyCookiesToSession(cookieString, ses) {
  const pairs = (cookieString || '').split(';').map(s => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    try {
      await ses.cookies.set({
        url: BASE_URL,
        name,
        value,
        path: '/',
        secure: true,
        httpOnly: true
      });
    } catch (e) {
      // Non-fatal — worst case that one cookie is missing and the page asks to sign in.
    }
  }
}

let downloadAutoOpenWired = false;
function setupDownloadAutoOpen() {
  if (downloadAutoOpenWired) return;
  downloadAutoOpenWired = true;
  // So clicking an attachment in the ticket panel actually opens it
  // (e.g. in the OS's default image/PDF viewer) once the download completes,
  // rather than silently landing in a downloads folder.
  session.defaultSession.on('will-download', (event, item) => {
    item.once('done', (e2, state) => {
      if (state === 'completed') {
        shell.openPath(item.getSavePath()).catch(() => {});
      }
    });
  });
}

function ensureTicketView() {
  if (ticketView) return ticketView;
  ticketView = new BrowserView({
    webPreferences: {
      session: session.defaultSession,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // Keep it scoped to the helpdesk site; anything that tries to open in a
  // new tab/window opens in the system browser instead of spawning windows.
  ticketView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/gigahelpdesk\.ghzportal\.com\//i.test(url)) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Re-skin the ticket page into the Messenger-style layout every time it
  // (re)loads — including when clicking a different notification reuses
  // this same view. dom-ready fires once per navigation, on the real
  // gigahelpdesk.ghzportal.com page, so this never touches any other site.
  ticketView.webContents.on('dom-ready', () => injectMessengerUI(ticketView));
  return ticketView;
}

function injectMessengerUI(view) {
  if (!view || view.webContents.isDestroyed()) return;
  if (MESSENGER_CSS) view.webContents.insertCSS(MESSENGER_CSS).catch(() => {});
  if (MESSENGER_JS) view.webContents.executeJavaScript(MESSENGER_JS).catch(() => {});
}

function detachTicketView() {
  if (win && ticketView) {
    try { win.removeBrowserView(ticketView); } catch (e) {}
  }
}

async function showTicketPanel(rawUrl, width, height, headerHeight) {
  if (typeof rawUrl !== 'string' || !/^https:\/\/gigahelpdesk\.ghzportal\.com\//i.test(rawUrl)) {
    return { success: false, message: 'Invalid ticket URL' };
  }
  if (!win) return { success: false, message: 'Window not ready' };

  const cookie = await ensureFreshCookie();
  if (!cookie) return { success: false, message: 'Not logged in' };
  await applyCookiesToSession(cookie, session.defaultSession);

  // Resize the bubble's own window to the ticket-panel size (same
  // mechanism as expand-panel), anchored to the same corner it already
  // occupies so it grows in place instead of jumping around. The size is
  // fitted to the screen's work area so a tall/portrait panel never gets
  // clipped or pushed off-screen on smaller displays.
  const cur = win.getBounds();
  if (currentMode === 'circle') {
    lastBubbleBounds = { x: cur.x, y: cur.y, width: currentBubbleDiameter, height: currentBubbleDiameter };
  }
  const fitted = fitToWorkArea(cur.x, cur.y, width, height, 320, 420);
  const targetX = cur.x + cur.width - fitted.width;
  const targetY = cur.y;
  const clamped = clampToWorkArea(targetX, targetY, fitted.width, fitted.height);
  safeSetBounds(win, { x: clamped.x, y: clamped.y, width: fitted.width, height: fitted.height });
  win.setMinimumSize(320, 420);
  win.setMaximumSize(1400, 1500);
  win.setResizable(true);
  currentMode = 'rect';
  reassertAlwaysOnTop();

  const view = ensureTicketView();
  if (!win.getBrowserViews().includes(view)) {
    win.addBrowserView(view);
  }
  const hh = Math.max(0, Math.round(headerHeight) || 0);
  safeSetBounds(view, { x: 0, y: hh, width: fitted.width, height: Math.max(0, fitted.height - hh) });
  view.setAutoResize({ width: true, height: true });

  view.webContents.loadURL(rawUrl);
  return { success: true };
}

function hideTicketPanel(width, height) {
  detachTicketView();
  if (win) {
    const cur = win.getBounds();
    const fitted = fitToWorkArea(cur.x, cur.y, width, height, 320, 420);
    const clamped = clampToWorkArea(cur.x + cur.width - fitted.width, cur.y, fitted.width, fitted.height);
    safeSetBounds(win, { x: clamped.x, y: clamped.y, width: fitted.width, height: fitted.height });
    win.setMinimumSize(320, 420);
    win.setResizable(true);
    currentMode = 'rect';
    reassertAlwaysOnTop();
  }
}

ipcMain.handle('ghz:show-ticket-panel', async (e, { url, width, height, headerHeight }) => {
  try {
    return await showTicketPanel(url, width, height, headerHeight);
  } catch (err) {
    return { success: false, message: 'Error: ' + err.message };
  }
});

ipcMain.on('ghz:hide-ticket-panel', (e, { width, height }) => {
  hideTicketPanel(width, height);
});

ipcMain.handle('ghz:open-external', async (e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
  return true;
});
