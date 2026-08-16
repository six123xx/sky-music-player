// Electron 主进程:启动内置服务器、创建应用窗口、管理跟弹透明悬浮窗
const { app, BrowserWindow, shell, dialog, ipcMain, screen } = require('electron');
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

function closeOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  overlayWindow = null;
  pressedCodes.clear();
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
  overlayWindow.setIgnoreMouseEvents(!flag, { forward: true });
  if (flag) {
    // 进入调整模式:确保窗口可聚焦以接收拖拽边缘事件
    overlayWindow.setFocusable(true);
    overlayWindow.focus();
  } else {
    overlayWindow.setFocusable(false);
  }
  try { overlayWindow.webContents.send('overlay:adjust-mode', !!flag); } catch (e) {}
}

function createOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const wa = screen.getPrimaryDisplay().workArea;
  const state = loadOverlayState();
  const W = 320;
  const H = 168;
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
    x: x,
    y: y,
    minWidth: 260,
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
  return overlayWindow;
}

function sendOverlayData(win) {
  if (overlayData) {
    try { win.webContents.send('overlay:data', overlayData); } catch (err) {}
  }
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

// 鼠标穿透控制:true=可交互(关闭穿透), false=穿透到游戏
ipcMain.on('overlay:set-interactive', (_e, flag) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(!flag, { forward: true });
  }
});

// 调整模式:开启后整个窗口可交互,便于拖动边缘调整大小对齐游戏琴键
ipcMain.on('overlay:set-adjust-mode', (_e, flag) => {
  setOverlayAdjustMode(!!flag);
});

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  try {
    server = createServer({ staticDir: __dirname });
    const { port } = await server.listen(3000);
    console.log(`[内置服务器] 运行在 http://127.0.0.1:${port}`);
    console.log(`[数据文件] ${server.dataFile}`);
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
  stopKeyPolling();
  if (server) server.close();
});
