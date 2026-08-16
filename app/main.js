// Electron 主进程:启动内置服务器、创建应用窗口、管理跟弹透明悬浮窗
const { app, BrowserWindow, shell, dialog, ipcMain, screen } = require('electron');
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

function createOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const wa = screen.getPrimaryDisplay().workArea;
  const W = 300;
  const H = 154;
  overlayWindow = new BrowserWindow({
    width: W,
    height: H,
    x: wa.x + wa.width - W - 20,
    y: wa.y + wa.height - H - 20,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false, // 不抢游戏焦点
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
