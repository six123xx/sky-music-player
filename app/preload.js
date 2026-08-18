// 主窗口 preload:向页面暴露桌面能力 API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  // 打开/更新跟弹悬浮窗
  openOverlay: (payload) => ipcRenderer.send('overlay:open', payload),
  // 同步本地歌曲列表给主进程(供悬浮窗换曲面板使用)
  syncSongs: (songs) => ipcRenderer.send('overlay:sync-songs', songs),
  // 自绘标题栏:最小化窗口
  minimizeWindow: () => ipcRenderer.send('win:minimize'),
  // 自绘标题栏:关闭窗口
  closeWindow: () => ipcRenderer.send('win:close'),
  // 选择文件夹批量导入曲库(子文件夹名自动成为分类)
  importLibraryFolder: () => ipcRenderer.invoke('library:import-folder'),
});
