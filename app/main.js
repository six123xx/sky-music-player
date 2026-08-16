// Electron 主进程:启动内置服务器、创建应用窗口、管理跟弹悬浮窗与截图对齐窗口
const { app, BrowserWindow, shell, dialog, ipcMain, globalShortcut, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { createServer } = require('./server');

let mainWindow = null;
let server = null;
let overlayWindow = null;      // 跟弹悬浮窗
let captureWindow = null;      // 截图对齐窗口
let lastPayload = null;        // 最近一次 openOverlay 载荷(重开/换曲时复用键位与倍速)
let overlayVisible = false;    // 悬浮窗隐藏/显示状态
let overlayInteractive = false;// 悬浮窗主动请求可交互(微调/换曲面板)

const TOOLBAR_H = 52;          // 悬浮窗顶部可点击工具条高度(DIP)

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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
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
  });

  // 主窗口聚焦时捕获琴键按键,转发给跟弹悬浮窗做命中判定
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    if (!overlayWindow || overlayWindow.isDestroyed() || !lastPayload || !lastPayload.keyMap) return;
    const idx = lastPayload.keyMap[input.code];
    if (typeof idx === 'number' && idx >= 0 && idx < 15) {
      overlayWindow.webContents.send('overlay:key', idx);
    }
  });
}

// ---------- 跟弹悬浮窗 ----------
function createOverlay(payload) {
  lastPayload = payload;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    // 已存在:仅更新数据并显示
    overlayWindow.webContents.send('overlay:data', payload);
    if (!overlayVisible) { overlayWindow.show(); overlayVisible = true; }
    return;
  }
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(1280, wa.width);
  const h = Math.min(760, wa.height);
  overlayWindow = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round((wa.width - w) / 2),
    y: Math.round((wa.height - h) / 2),
    transparent: true,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    title: '跟弹悬浮窗',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload-overlay.js')
    }
  });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow.webContents.send('overlay:data', payload);
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    overlayVisible = false;
    unregisterOverlayShortcuts();
  });
  overlayVisible = true;
  registerOverlayShortcuts();
  updateOverlayInteractive();
}

// 鼠标穿透控制:微调/换曲面板打开→整窗可交互;否则鼠标悬停顶部工具条时才可交互
function updateOverlayInteractive() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  let interactive = overlayInteractive;
  if (!interactive) {
    const b = overlayWindow.getBounds();
    const p = screen.getCursorScreenPoint();
    interactive = p.x >= b.x && p.x <= b.x + b.width &&
                  p.y >= b.y && p.y <= b.y + TOOLBAR_H;
  }
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true });
}

// 悬浮窗全局快捷键(悬浮窗存在期间生效)
function registerOverlayShortcuts() {
  globalShortcut.register('F9', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
    else if (lastPayload) createOverlay(lastPayload);
  });
  globalShortcut.register('F10', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (overlayVisible) { overlayWindow.hide(); overlayVisible = false; }
    else { overlayWindow.show(); overlayVisible = true; updateOverlayInteractive(); }
  });
  globalShortcut.register('F11', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay:command', 'toggle-play');
    }
  });
  globalShortcut.register('F12', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) startCapture();
  });
}
function unregisterOverlayShortcuts() {
  ['F9', 'F10', 'F11', 'F12'].forEach((k) => {
    try { globalShortcut.unregister(k); } catch (e) { /* ignore */ }
  });
}

// ---------- 截图对齐窗口(截全屏→标记 3 个琴键点→生成 15 键绝对坐标) ----------
function startCapture() {
  if (captureWindow && !captureWindow.isDestroyed()) return;
  const size = screen.getPrimaryDisplay().size;
  captureWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width: size.width,
    height: size.height,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'capture-preload.js')
    }
  });
  captureWindow.loadFile(path.join(__dirname, 'capture.html'));
  captureWindow.on('closed', () => { captureWindow = null; });

  desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: size.width, height: size.height }
  }).then((sources) => {
    if (!captureWindow || captureWindow.isDestroyed() || !sources.length) return;
    const dataUrl = sources[0].thumbnail.toDataURL();
    captureWindow.webContents.send('capture:image', { dataUrl });
  }).catch((err) => {
    console.error('[截图对齐] 截图失败:', err);
    if (captureWindow && !captureWindow.isDestroyed()) captureWindow.close();
  });
}

// ---------- IPC ----------
function registerIpc() {
  // 主窗口:打开/更新跟弹悬浮窗
  ipcMain.on('overlay:open', (e, payload) => {
    createOverlay(payload || {});
  });

  // 悬浮窗:鼠标穿透开关
  ipcMain.on('overlay:set-interactive', (e, flag) => {
    overlayInteractive = !!flag;
    updateOverlayInteractive();
  });
  // 悬浮窗:调整模式(整窗可交互)
  ipcMain.on('overlay:set-adjust-mode', (e, flag) => {
    overlayInteractive = !!flag;
    updateOverlayInteractive();
  });
  // 悬浮窗:关闭
  ipcMain.on('overlay:close', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
  });
  // 悬浮窗:隐藏
  ipcMain.on('overlay:hide', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide();
      overlayVisible = false;
    }
  });
  // 悬浮窗:设置倍速(记入 lastPayload,换曲时沿用)
  ipcMain.on('overlay:set-speed', (e, v) => {
    if (lastPayload && typeof v === 'number') lastPayload.speed = v;
  });
  // 悬浮窗:开始截图对齐
  ipcMain.on('overlay:capture', () => startCapture());

  // 截图对齐:完成(3 个标记点→15 键绝对坐标→推给悬浮窗)
  ipcMain.on('overlay:capture-done', (e, { points } = {}) => {
    if (captureWindow) { captureWindow.close(); captureWindow = null; }
    if (!overlayWindow || overlayWindow.isDestroyed() || !points || points.length < 3) return;
    const p0 = points[0], p1 = points[1], p2 = points[2];
    const cw = (p1.x - p0.x) / 4;
    const rh = (p2.y - p0.y) / 2;
    if (!(cw > 0 && rh > 0)) return;
    const ob = overlayWindow.getBounds();
    const keys = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 5; c++) {
        keys.push({
          cx: p0.x + cw * c - ob.x,
          cy: p0.y + rh * r - ob.y,
          w: cw * 0.92,
          h: rh * 0.92
        });
      }
    }
    overlayWindow.webContents.send('overlay:align-keys', { keys });
  });
  // 截图对齐:取消
  ipcMain.on('overlay:capture-cancel', () => {
    if (captureWindow) { captureWindow.close(); captureWindow = null; }
  });

  // 悬浮窗:获取本地乐谱列表(读数据文件)
  ipcMain.handle('overlay:list-songs', async () => {
    try {
      const file = server ? server.dataFile : null;
      if (!file || !fs.existsSync(file)) return { songs: [] };
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const songs = (data.sheets || []).map((s) => ({
        id: s.id,
        name: s.name,
        author: s.author || '',
        source: 'local'
      }));
      return { songs };
    } catch (err) {
      return { songs: [] };
    }
  });

  // 悬浮窗:切换歌曲(推新数据到悬浮窗)
  ipcMain.handle('overlay:select-song', async (e, id) => {
    try {
      const file = server ? server.dataFile : null;
      if (!file || !fs.existsSync(file)) return { ok: false, error: '数据文件不存在' };
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const s = (data.sheets || []).find((x) => x.id === id);
      if (!s) return { ok: false, error: '乐谱不存在' };
      let notes;
      try { notes = JSON.parse(s.songNotes); } catch (err) { return { ok: false, error: '乐谱数据损坏' }; }
      const payload = Object.assign({}, lastPayload || {}, {
        name: s.name,
        author: s.author || '',
        songNotes: notes,
        pitchLevel: s.pitchLevel || 0
      });
      lastPayload = payload;
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('overlay:data', payload);
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  try {
    server = createServer({ staticDir: __dirname });
    const { port } = await server.listen(3000);
    console.log(`[内置服务器] 运行在 http://127.0.0.1:${port}`);
    console.log(`[数据文件] ${server.dataFile}`);
    registerIpc();
    createWindow(`http://127.0.0.1:${port}/sky-music-player.html`);
    setInterval(updateOverlayInteractive, 120);
  } catch (err) {
    dialog.showErrorBox('启动失败', '无法启动内置服务器:\n' + err.message);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  unregisterOverlayShortcuts();
  if (server) server.close();
});
