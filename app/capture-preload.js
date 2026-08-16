// 截图对齐窗口 preload:与主进程通信
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('captureAPI', {
  // 接收截图数据
  onImage: (cb) => ipcRenderer.on('capture:image', (_e, payload) => cb(payload)),
  // 完成:回传 3 个标记点
  done: (points) => ipcRenderer.send('overlay:capture-done', { points }),
  // 取消
  cancel: () => ipcRenderer.send('overlay:capture-cancel'),
});
