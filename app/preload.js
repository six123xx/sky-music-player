// 主窗口 preload:向页面暴露桌面能力 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  // 打开/更新跟弹悬浮窗
  openOverlay: (payload) => ipcRenderer.send('overlay:open', payload),
});
