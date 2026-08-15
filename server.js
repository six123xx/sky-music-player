const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('.'));

const db = new Database(path.join(__dirname, 'sky-music.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS sheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    author TEXT DEFAULT '',
    bpm INTEGER DEFAULT 120,
    pitch_level INTEGER DEFAULT 0,
    song_notes TEXT NOT NULL,
    share_token TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    download_count INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_share_token ON sheets(share_token);
  CREATE INDEX IF NOT EXISTS idx_name ON sheets(name);
`);

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

// 上传乐谱
app.post('/api/sheets', (req, res) => {
  const { name, author, bpm, pitchLevel, songNotes } = req.body;
  if (!name || !songNotes || !validateSongNotes(songNotes)) {
    return res.status(400).json({ error: '乐谱数据无效：需要 name 和合法的 songNotes 数组' });
  }
  const token = generateToken();
  const stmt = db.prepare(`
    INSERT INTO sheets (name, author, bpm, pitch_level, song_notes, share_token)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    name, author || '', bpm || 120, pitchLevel || 0,
    JSON.stringify(songNotes), token
  );
  res.json({ id: info.lastInsertRowid, shareToken: token });
});

// 获取乐谱列表
app.get('/api/sheets', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const search = req.query.search || '';

  let rows, countRow;
  if (search) {
    const like = '%' + search + '%';
    rows = db.prepare(`
      SELECT id, name, author, bpm, pitch_level, share_token, created_at, download_count,
             LENGTH(song_notes) as size
      FROM sheets WHERE name LIKE ? OR author LIKE ?
      ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(like, like, limit, offset);
    countRow = db.prepare(`SELECT COUNT(*) as total FROM sheets WHERE name LIKE ? OR author LIKE ?`).get(like, like);
  } else {
    rows = db.prepare(`
      SELECT id, name, author, bpm, pitch_level, share_token, created_at, download_count,
             LENGTH(song_notes) as size
      FROM sheets ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
    countRow = db.prepare(`SELECT COUNT(*) as total FROM sheets`).get();
  }

  res.json({
    sheets: rows.map(r => ({
      ...r,
      noteCount: JSON.parse(db.prepare('SELECT song_notes FROM sheets WHERE id = ?').get(r.id).song_notes).length
    })),
    total: countRow.total,
    page, limit
  });
});

// 通过分享 token 获取乐谱
app.get('/api/share/:token', (req, res) => {
  const row = db.prepare(`SELECT * FROM sheets WHERE share_token = ?`).get(req.params.token);
  if (!row) return res.status(404).json({ error: '分享链接无效或已失效' });
  db.prepare(`UPDATE sheets SET download_count = download_count + 1 WHERE id = ?`).run(row.id);
  res.json({
    name: row.name, author: row.author, bpm: row.bpm,
    pitchLevel: row.pitch_level, songNotes: JSON.parse(row.song_notes)
  });
});

// 删除乐谱
app.delete('/api/sheets/:id', (req, res) => {
  const info = db.prepare(`DELETE FROM sheets WHERE id = ?`).run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: '乐谱不存在' });
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`光遇乐谱服务器运行在 http://localhost:${PORT}`);
});
