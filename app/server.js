// 内置后端服务器:完整复刻原 server.js 的 API(存储改用 JSON 文件,零原生依赖,保证打包可靠)
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function defaultDataFile() {
  const base =
    process.env.SKY_MUSIC_DATA_DIR ||
    (process.env.APPDATA ? path.join(process.env.APPDATA, 'SkyMusicPlayer') : __dirname);
  return path.join(base, 'sky-music-data.json');
}

function createServer(options = {}) {
  const { staticDir, dataFile } = options;
  const file = dataFile || defaultDataFile();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  if (staticDir) app.use(express.static(staticDir));

  // ---- 数据层(JSON 文件存储,等价于原 SQLite) ----
  let data = { sheets: [], nextId: 1 };

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.sheets)) {
        data = parsed;
        if (!data.nextId) {
          data.nextId = data.sheets.reduce((m, s) => Math.max(m, s.id || 0), 0) + 1;
        }
      }
    } catch (e) {
      data = { sheets: [], nextId: 1 };
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch (e) { /* ignore */ }
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  }

  load();

  function validateSongNotes(notes) {
    if (!Array.isArray(notes) || notes.length === 0) return false;
    for (const n of notes) {
      if (n.time === undefined || n.key === undefined) return false;
      if (typeof n.key !== 'string' || !/^\dKey\d+$/.test(n.key)) return false;
    }
    return true;
  }

  function generateToken() {
    return crypto.randomBytes(8).toString('hex');
  }

  function toListItem(s) {
    let noteCount = 0;
    try { noteCount = JSON.parse(s.songNotes).length; } catch (e) {}
    return {
      id: s.id,
      name: s.name,
      author: s.author,
      bpm: s.bpm,
      pitch_level: s.pitchLevel,
      share_token: s.shareToken,
      created_at: s.createdAt,
      download_count: s.downloadCount,
      size: s.songNotes ? String(s.songNotes).length : 0,
      noteCount
    };
  }

  // 上传乐谱
  app.post('/api/sheets', (req, res) => {
    const { name, author, bpm, pitchLevel, songNotes } = req.body || {};
    if (!name || !songNotes || !validateSongNotes(songNotes)) {
      return res.status(400).json({ error: '乐谱数据无效：需要 name 和合法的 songNotes 数组' });
    }
    const sheet = {
      id: data.nextId++,
      name: String(name).slice(0, 200),
      author: author ? String(author).slice(0, 100) : '',
      bpm: bpm || 120,
      pitchLevel: pitchLevel || 0,
      songNotes: JSON.stringify(songNotes),
      shareToken: generateToken(),
      createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
      downloadCount: 0
    };
    data.sheets.unshift(sheet);
    save();
    res.json({ id: sheet.id, shareToken: sheet.shareToken });
  });

  // 获取乐谱列表
  app.get('/api/sheets', (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const search = req.query.search || '';
    let list = data.sheets;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (s) => s.name.toLowerCase().includes(q) || s.author.toLowerCase().includes(q)
      );
    }
    const total = list.length;
    const start = (page - 1) * limit;
    const rows = list.slice(start, start + limit).map(toListItem);
    res.json({ sheets: rows, total, page, limit });
  });

  // 通过分享 token 获取乐谱
  app.get('/api/share/:token', (req, res) => {
    const s = data.sheets.find((x) => x.shareToken === req.params.token);
    if (!s) return res.status(404).json({ error: '分享链接无效或已失效' });
    s.downloadCount = (s.downloadCount || 0) + 1;
    save();
    res.json({
      name: s.name,
      author: s.author,
      bpm: s.bpm,
      pitchLevel: s.pitchLevel,
      songNotes: JSON.parse(s.songNotes)
    });
  });

  // 删除乐谱
  app.delete('/api/sheets/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    const idx = data.sheets.findIndex((x) => x.id === id);
    if (idx === -1) return res.status(404).json({ error: '乐谱不存在' });
    data.sheets.splice(idx, 1);
    save();
    res.json({ success: true });
  });

  // 启动(端口被占用时自动递增)
  let serverHandle = null;
  function listen(preferredPort = 3000) {
    return new Promise((resolve, reject) => {
      const tryPort = (port) => {
        const srv = app.listen(port, '127.0.0.1', () => {
          serverHandle = srv;
          resolve({ port, server: srv });
        });
        srv.on('error', (err) => {
          if (err.code === 'EADDRINUSE' && port < preferredPort + 20) {
            tryPort(port + 1);
          } else {
            reject(err);
          }
        });
      };
      tryPort(preferredPort);
    });
  }

  function close() {
    if (serverHandle) serverHandle.close();
  }

  return { app, listen, close, get dataFile() { return file; } };
}

module.exports = { createServer, defaultDataFile };

// 独立运行时(用于测试):node server.js
if (require.main === module) {
  createServer({ staticDir: __dirname })
    .listen(3000)
    .then(({ port }) => {
      console.log(`光遇乐谱服务器运行在 http://localhost:${port}`);
      console.log(`数据文件: ${defaultDataFile()}`);
    })
    .catch((err) => {
      console.error('服务器启动失败:', err);
      process.exit(1);
    });
}
