// Electron 主进程:启动内置服务器、创建应用窗口、管理跟弹透明悬浮窗
const { app, BrowserWindow, shell, dialog, ipcMain, screen, desktopCapturer, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');
const { createServer } = require('./server');
const koffi = require('koffi');

// 通过 koffi(FFI) 调用 Windows 原生 API,轮询全局键盘状态(GetAsyncKeyState)
// 无需全局钩子、无额外可执行文件、不会被杀软拦截;游戏在前台时同样有效
const user32 = koffi.load('user32.dll');
const GetAsyncKeyState = user32.func('short GetAsyncKeyState(int vKey)');

let mainWindow = null;
let server = null;

// ---------- 跟弹悬浮窗 ----------
let overlayWindow = null;
let overlayData = null;
let pollTimer = null;
const pressedCodes = new Set(); // 正在按下的键(用于上升沿检测)
let captureWindow = null;       // 截图对齐窗口

// Windows 虚拟键码(VK) <-> KeyboardEvent.code
const VK_TO_CODE = (() => {
  const m = {};
  for (let i = 0; i < 26; i++) m[0x41 + i] = 'Key' + String.fromCharCode(0x41 + i);
  for (let i = 0; i < 10; i++) m[0x30 + i] = 'Digit' + i;
  for (let i = 0; i < 10; i++) m[0x60 + i] = 'Numpad' + i;
  for (let i = 0; i < 24; i++) m[0x70 + i] = 'F' + (i + 1);
  Object.assign(m, {
    0x20: 'Space', 0x0D: 'Enter', 0x09: 'Tab', 0x1B: 'Escape', 0x08: 'Backspace', 0x2E: 'Delete',
    0x25: 'ArrowLeft', 0x26: 'ArrowUp', 0x27: 'ArrowRight', 0x28: 'ArrowDown',
    0xBA: 'Semicolon', 0xBB: 'Equal', 0xBC: 'Comma', 0xBD: 'Minus', 0xBE: 'Period',
    0xBF: 'Slash', 0xC0: 'Backquote', 0xDB: 'BracketLeft', 0xDC: 'Backslash',
    0xDD: 'BracketRight', 0xDE: 'Quote', 0xE2: 'IntlBackslash',
  });
  return m;
})();
const CODE_TO_VK = Object.fromEntries(Object.entries(VK_TO_CODE).map(([vk, code]) => [code, Number(vk)]));

// 轮询键盘状态:检测到琴键按下(上升沿)即转发给悬浮窗;不拦截按键,游戏照常收到
function startKeyPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayData || !overlayData.keyMap) return;
    const km = overlayData.keyMap;
    for (const code in km) {
      const vk = CODE_TO_VK[code];
      if (!vk) continue;
      let down = false;
      try {
        down = (GetAsyncKeyState(vk) & 0x8000) !== 0;
      } catch (err) {
        continue;
      }
      if (down && !pressedCodes.has(code)) {
        pressedCodes.add(code);
        try {
          overlayWindow.webContents.send('overlay:key', km[code]);
        } catch (err) { /* 窗口可能已销毁 */ }
      } else if (!down && pressedCodes.has(code)) {
        pressedCodes.delete(code);
      }
    }
  }, 10);
}

function stopKeyPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pressedCodes.clear();
}

// ---------- 穿透控制(主进程统一决策,不依赖渲染层 mousemove) ----------
// 原则:鼠标位于标题栏区域(顶部 OVERLAY_TOOLBAR_H 高度)或渲染层要求整窗可交互时,窗口可点击;
// 否则整窗穿透到游戏,保证"想点标题栏就点,想玩琴键就穿透"。
const OVERLAY_TOOLBAR_H = 49; // 需与 overlay.html 中 TOOLBAR_H 保持一致
let overlayTimer = null;
let forceInteractive = false; // 渲染层要求整窗可交互(换曲面板/调整模式等)
let lastInteractive = null;   // 上次应用的穿透状态,避免重复 setIgnoreMouseEvents

function applyOverlayInteractive(interactive) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  if (interactive === lastInteractive) return;
  lastInteractive = interactive;
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
}

function startOverlayTracking() {
  if (overlayTimer) return;
  overlayTimer = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (forceInteractive) { applyOverlayInteractive(true); return; }
    let interactive = false;
    try {
      const pt = screen.getCursorScreenPoint();
      const b = overlayWindow.getBounds();
      interactive = pt.x >= b.x && pt.x <= b.x + b.width &&
                    pt.y >= b.y && pt.y <= b.y + OVERLAY_TOOLBAR_H;
    } catch (e) { /* 忽略 */ }
    applyOverlayInteractive(interactive);
  }, 40);
}
function stopOverlayTracking() {
  if (overlayTimer) { clearInterval(overlayTimer); overlayTimer = null; }
  lastInteractive = null;
}

function closeOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  overlayWindow = null;
  pressedCodes.clear();
  stopOverlayTracking();
}

// 悬浮窗位置/大小记忆:保存到用户数据目录,便于下次对齐游戏琴键
const overlayStateFile = () => path.join(app.getPath('userData'), 'overlay-state.json');
function loadOverlayState() {
  try { return JSON.parse(fs.readFileSync(overlayStateFile(), 'utf8')); } catch (e) { return {}; }
}
function saveOverlayState(state) {
  try { fs.writeFileSync(overlayStateFile(), JSON.stringify(state)); } catch (e) {}
}

// 调整模式:true=整个窗口可交互(拖动边缘调整大小/拖动移动), false=正常穿透模式
function setOverlayAdjustMode(flag) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  forceInteractive = !!flag;
  if (flag) {
    // 进入调整模式:确保窗口可聚焦以接收拖拽边缘事件
    overlayWindow.setFocusable(true);
    overlayWindow.focus();
    applyOverlayInteractive(true);
  } else {
    overlayWindow.setFocusable(false);
    lastInteractive = null; // 重置缓存,让定时器重新决策
  }
  try { overlayWindow.webContents.send('overlay:adjust-mode', !!flag); } catch (e) {}
}

function createOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const wa = screen.getPrimaryDisplay().workArea;
  const state = loadOverlayState();
  const W = 480;
  const H = 210;
  let x = wa.x + wa.width - W - 20;
  let y = wa.y + wa.height - H - 20;
  if (state.bounds && Number.isFinite(state.bounds.x)) {
    x = Math.round(state.bounds.x);
    y = Math.round(state.bounds.y);
    if (state.bounds.width > 0) state.bounds.width = Math.round(state.bounds.width);
    if (state.bounds.height > 0) state.bounds.height = Math.round(state.bounds.height);
  }
  overlayWindow = new BrowserWindow({
    width: (state.bounds && state.bounds.width > 0) ? state.bounds.width : W,
    height: (state.bounds && state.bounds.height > 0) ? state.bounds.height : H,
    maxWidth: wa.width,
    maxHeight: wa.height,
    x: x,
    y: y,
    minWidth: 300,
    minHeight: 120,
    transparent: true,
    frame: false,
    resizable: true, // 可调整大小以对齐游戏琴键
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false, // 不抢游戏焦点(调整模式临时开启)
    webPreferences: {
      preload: path.join(__dirname, 'preload-overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  // 加载完成后恢复上次截图对齐的琴键位置
  overlayWindow.webContents.once('did-finish-load', () => {
    if (state.alignKeys && Array.isArray(state.alignKeys) && state.alignKeys.length === TOTAL_KEYS) {
      try {
        const b = overlayWindow.getBounds();
        const rel = state.alignKeys.map(k => ({ cx: k.x - b.x, cy: k.y - b.y, w: k.w, h: k.h }));
        overlayWindow.webContents.send('overlay:align-keys', { keys: rel });
      } catch (e) { /* 忽略 */ }
    }
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    pressedCodes.clear();
  });
  // 记忆窗口位置与大小(松手后保存)
  let persistTimer = null;
  const persistBounds = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      saveOverlayState({ bounds: overlayWindow.getBounds() });
    }, 400);
  };
  overlayWindow.on('moved', persistBounds);
  overlayWindow.on('resized', persistBounds);
  startKeyPolling();
  startOverlayTracking();
  return overlayWindow;
}

function sendOverlayData(win) {
  if (overlayData) {
    try { win.webContents.send('overlay:data', overlayData); } catch (err) {}
  }
}

// ---------- 截图对齐 ----------
const TOTAL_KEYS = 15;

// 根据 15 个琴键的屏幕绝对坐标(键中心+尺寸)调整悬浮窗位置/大小并通知渲染
function setOverlayAlignKeys(keys) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  keys.forEach(k => {
    minX = Math.min(minX, k.x - k.w / 2);
    minY = Math.min(minY, k.y - k.h / 2);
    maxX = Math.max(maxX, k.x + k.w / 2);
    maxY = Math.max(maxY, k.y + k.h / 2);
  });
  if (!Number.isFinite(minX)) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const PAD = 14;
  const TOOLBAR = 49;
  const winX = Math.round(minX - PAD);
  const winY = Math.round(minY - PAD - TOOLBAR);
  const winW = Math.max(Math.round((maxX - minX) + PAD * 2), 260);
  const winH = Math.max(Math.round((maxY - minY) + PAD * 2 + TOOLBAR), 120);
  // 限制在屏幕工作区内
  const bx = Math.max(wa.x, Math.min(winX, wa.x + wa.width - winW));
  const by = Math.max(wa.y, Math.min(winY, wa.y + wa.height - winH));
  overlayWindow.setBounds({ x: bx, y: by, width: winW, height: winH });
  const rel = keys.map(k => ({ cx: k.x - bx, cy: k.y - by, w: k.w, h: k.h }));
  try { overlayWindow.webContents.send('overlay:align-keys', { keys: rel }); } catch (e) {}
  saveOverlayState({ bounds: overlayWindow.getBounds(), alignKeys: keys });
}

async function startCapture() {
  if (captureWindow && !captureWindow.isDestroyed()) return;
  // 先隐藏悬浮窗,避免被截进画面干扰标记
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  try {
    const display = screen.getPrimaryDisplay();
    const b = display.bounds;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(b.width), height: Math.round(b.height) },
      fetchWindowIcons: false
    });
    const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) {
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.show();
      dialog.showErrorBox('截图失败', '未能捕获屏幕画面。\n请确认光遇使用窗口化或无边框全屏模式(非独占全屏),再重试。');
      return;
    }
    const img = src.thumbnail;
    const imgSize = img.getSize();
    const scale = b.width > 0 ? imgSize.width / b.width : 1;
    const dataUrl = img.toDataURL();
    captureWindow = new BrowserWindow({
      x: b.x, y: b.y,
      width: b.width, height: b.height,
      transparent: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      fullscreenable: false,
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, 'capture-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    captureWindow.setAlwaysOnTop(true, 'screen-saver');
    captureWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    captureWindow.loadFile(path.join(__dirname, 'capture.html'));
    captureWindow.once('ready-to-show', () => captureWindow.show());
    captureWindow.webContents.once('did-finish-load', () => {
      // 截图窗口就绪后恢复悬浮窗显示
      if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.show();
      try {
        captureWindow.webContents.send('capture:image', {
          dataUrl,
          scale,
          display: { width: b.width, height: b.height }
        });
      } catch (e) {}
    });
    captureWindow.on('closed', () => { captureWindow = null; });
  } catch (err) {
    console.error('capture failed', err);
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.show();
    dialog.showErrorBox('截图失败', '无法捕获屏幕画面:\n' + (err && err.message));
  }
}

function closeCapture() {
  if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy();
  // 恢复悬浮窗显示
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.show();
}

// ---------- 全局快捷键(游戏中同样可用) ----------
// 均为不常用的功能键,可在下方自行修改
const SHORTCUTS = {
  toggleOverlay: 'F9',   // 打开/关闭跟弹悬浮窗
  toggleVisible: 'F10',  // 显示/隐藏悬浮窗(隐藏时自动停止跟弹)
  togglePlay: 'F11',     // 开始/停止跟弹
  captureAlign: 'F12',   // 截图对齐
};

function registerShortcuts() {
  const defs = [
    [SHORTCUTS.toggleOverlay, () => {
      if (overlayWindow && !overlayWindow.isDestroyed()) closeOverlay();
      else if (overlayData) createOverlay();
    }],
    [SHORTCUTS.toggleVisible, () => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      if (overlayWindow.isVisible()) {
        overlayWindow.hide();
        try { overlayWindow.webContents.send('overlay:command', 'stop'); } catch (e) {}
      } else {
        overlayWindow.show();
        overlayWindow.setAlwaysOnTop(true, 'screen-saver');
      }
    }],
    [SHORTCUTS.togglePlay, () => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      try { overlayWindow.webContents.send('overlay:command', 'toggle-play'); } catch (e) {}
    }],
    [SHORTCUTS.captureAlign, () => {
      startCapture();
    }],
  ];
  for (const [acc, fn] of defs) {
    try {
      globalShortcut.register(acc, fn);
    } catch (e) {
      console.warn('快捷键注册失败: ' + acc, e && e.message);
    }
  }
}

function unregisterShortcuts() {
  try { globalShortcut.unregisterAll(); } catch (e) {}
}

// ---------- 主窗口 ----------
function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: '#0d0d14',
    title: '光遇乐谱播放器',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadURL(url);

  // 外链一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (u.startsWith('http://') || u.startsWith('https://')) {
      shell.openExternal(u);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, u) => {
    if (!u.startsWith('http://127.0.0.1') && !u.startsWith('http://localhost')) {
      e.preventDefault();
      shell.openExternal(u);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    closeOverlay();
  });
}

// ---------- IPC ----------
ipcMain.on('overlay:open', (_e, payload) => {
  overlayData = payload || null;
  const win = createOverlay();
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => sendOverlayData(win));
  } else {
    sendOverlayData(win);
  }
});

ipcMain.on('overlay:close', () => closeOverlay());

// 鼠标穿透控制:true=渲染层要求整窗可交互(换曲面板等), false=按鼠标位置自动判断
ipcMain.on('overlay:set-interactive', (_e, flag) => {
  forceInteractive = !!flag;
  if (forceInteractive) applyOverlayInteractive(true);
  else lastInteractive = null; // 重置缓存,让定时器重新决策
});

// 调整模式:开启后整个窗口可交互,便于拖动边缘调整大小对齐游戏琴键
ipcMain.on('overlay:set-adjust-mode', (_e, flag) => {
  setOverlayAdjustMode(!!flag);
});

// 截图对齐:捕获屏幕并打开全屏标记窗口
ipcMain.on('overlay:capture', () => startCapture());
ipcMain.on('overlay:capture-cancel', () => closeCapture());

// 截图标记完成:points = 3 个键中心(截图坐标),依次为 左上/右上/左下
ipcMain.on('overlay:capture-done', (_e, payload) => {
  try {
    closeCapture();
    const pts = (payload && payload.points) || [];
    if (pts.length < 3) return;
    // 截图窗口按屏幕 DIP 尺寸覆盖,点击坐标即为屏幕 DIP 坐标,与窗口 bounds 一致
    const p = pts.map(pt => ({ x: pt.x, y: pt.y }));
    const cw = (p[1].x - p[0].x) / 4;   // 列间距
    const rh = (p[2].y - p[0].y) / 2;   // 行间距
    if (cw <= 1 || rh <= 1) return;
    const keys = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 5; c++) {
        keys.push({ x: p[0].x + cw * c, y: p[0].y + rh * r, w: cw, h: rh });
      }
    }
    setOverlayAlignKeys(keys);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      try { overlayWindow.webContents.send('overlay:align-done'); } catch (e) {}
    }
  } catch (err) {
    console.error('capture-done error', err);
  }
});

// ---------- 悬浮窗直接换曲 ----------
const LIBRARY_KEY = 'skyMusicLibrary';

// 云端曲谱(来自内置服务器数据文件)
function getCloudSongs() {
  try {
    if (!server) return [];
    const raw = fs.readFileSync(server.dataFile, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.sheets)) return [];
    return data.sheets.map((s) => ({
      id: 'cloud-' + s.id,
      name: s.name || '未知曲目',
      author: s.author || '',
      source: 'cloud',
      song: {
        name: s.name || '未知曲目',
        author: s.author || '',
        bpm: s.bpm || 120,
        pitchLevel: s.pitchLevel || 0,
        songNotes: JSON.parse(s.songNotes || '[]')
      }
    }));
  } catch (e) {
    return [];
  }
}

// 本地曲库(主窗口 localStorage 中的收藏/已加载乐谱)
async function getLibrarySongs() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return [];
    const raw = await mainWindow.webContents.executeJavaScript(
      "localStorage.getItem('" + LIBRARY_KEY + "') || '[]'"
    );
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((s, i) => ({
      id: 'lib-' + i,
      name: s.name || '未知曲目',
      author: s.author || '',
      source: 'library',
      song: s
    }));
  } catch (e) {
    return [];
  }
}

// 获取可换曲目列表(本地曲库优先,云端曲谱其次)
ipcMain.handle('overlay:list-songs', async () => {
  const [lib, cloud] = await Promise.all([getLibrarySongs(), Promise.resolve(getCloudSongs())]);
  const songs = lib.slice(0, 100).concat(cloud.slice(0, 100))
    .map(({ id, name, author, source }) => ({ id, name, author, source }));
  return { songs };
});

// 切换歌曲:更新悬浮窗数据并同步主窗口播放器
ipcMain.handle('overlay:select-song', async (_e, id) => {
  if (!id || typeof id !== 'string') return { ok: false, error: '无效曲目' };
  let song = null;
  let label = '';
  if (id.startsWith('lib-')) {
    const lib = await getLibrarySongs();
    const item = lib.find((x) => x.id === id);
    if (item) { song = item.song; label = song.name || '未知曲目'; }
  } else if (id.startsWith('cloud-')) {
    const cloud = getCloudSongs();
    const item = cloud.find((x) => x.id === id);
    if (item) { song = item.song; label = song.name || '未知曲目'; }
  }
  if (!song || !song.songNotes || !song.songNotes.length) return { ok: false, error: '乐谱数据无效' };
  // 构造新跟弹数据(保留原有键位映射与速度设置)
  const base = overlayData || {};
  overlayData = {
    name: song.name || '未知曲目',
    author: song.author || '',
    songNotes: song.songNotes,
    keyMap: base.keyMap || {},
    keyLabels: base.keyLabels || [],
    pitchLevel: song.pitchLevel || base.pitchLevel || 0,
    speed: base.speed || 1,
  };
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.webContents.send('overlay:data', overlayData); } catch (e) {}
  }
  // 同步主窗口:加载该曲并切到播放页
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const js = '(function(){ try { ' +
        "if (typeof loadSongs === 'function') loadSongs(" + JSON.stringify([song]) + ', ' + JSON.stringify(label) + '); ' +
        "if (typeof switchPage === 'function') switchPage('player'); " +
        "return 'ok'; } catch (e) { return 'err'; } })()";
      await mainWindow.webContents.executeJavaScript(js);
    }
  } catch (e) { /* 主窗口可能未就绪 */ }
  return { ok: true };
});

// 隐藏悬浮窗(工具栏「隐藏」按钮,与 F10 快捷键同义)
ipcMain.on('overlay:hide', () => {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) {
    overlayWindow.hide();
    try { overlayWindow.webContents.send('overlay:command', 'stop'); } catch (e) {}
  }
});

// 悬浮窗倍速调整:更新跟弹速度,并同步主窗口播放器的速度档位
ipcMain.on('overlay:set-speed', async (_e, v) => {
  const s = Number(v);
  if (!Number.isFinite(s) || s <= 0) return;
  if (overlayData) overlayData.speed = s;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const js = '(function(){ var b = document.querySelector(\'.speed-btn[data-speed="' + s + '"]\'); if (b) { b.click(); return "ok"; } return "no"; })()';
      await mainWindow.webContents.executeJavaScript(js);
    }
  } catch (e) { /* 主窗口可能未就绪 */ }
});

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  try {
    server = createServer({ staticDir: __dirname });
    const { port } = await server.listen(3000);
    console.log(`[内置服务器] 运行在 http://127.0.0.1:${port}`);
    console.log(`[数据文件] ${server.dataFile}`);
    console.log(`[快捷键] F9=开关悬浮窗 F10=显示/隐藏 F11=开始/停止 F12=截图对齐`);
    registerShortcuts();
    createWindow(`http://127.0.0.1:${port}/sky-music-player.html`);
  } catch (err) {
    dialog.showErrorBox('启动失败', '无法启动内置服务器:\n' + err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  unregisterShortcuts();
  stopKeyPolling();
  stopOverlayTracking();
  if (server) server.close();
});
