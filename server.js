require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Wall setup ────────────────────────────────────────────────────────────────
const WALL_FILE = path.join(__dirname, 'wall.json');
const WALL_UPLOAD_DIR = path.join(__dirname, 'uploads', 'wall');
const ARCHIVES_DIR = path.join(__dirname, 'archives');
const WALL_MAX = 30;

[WALL_UPLOAD_DIR, ARCHIVES_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const wallStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, WALL_UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, crypto.randomUUID() + ext);
  },
});

const wallUpload = multer({
  storage: wallStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// ── Token persistence ─────────────────────────────────────────────────────────
const TOKENS_FILE = path.join(__dirname, '.tokens.json');

function saveTokens() {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens), 'utf8');
}

function loadTokens() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    Object.assign(tokens, data);
    console.log('✅  Loaded saved Spotify tokens — no login needed');
  } catch {
    // no saved tokens yet, that's fine
  }
}

// ── Wall persistence ──────────────────────────────────────────────────────────
function saveWall() {
  fs.writeFileSync(WALL_FILE, JSON.stringify({ photos: wallPhotos, lastReset: wallLastReset }), 'utf8');
}

function loadWall() {
  try {
    const data = JSON.parse(fs.readFileSync(WALL_FILE, 'utf8'));
    wallPhotos = data.photos || [];
    wallLastReset = data.lastReset || Date.now();
    console.log(`✅  Loaded wall — ${wallPhotos.length} photo(s)`);
  } catch {
    // no wall.json yet
  }
}

// ── Wall archive + reset ──────────────────────────────────────────────────────
async function archiveAndResetWall() {
  console.log('[wall] archiving…');

  try {
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(`http://localhost:${PORT}/wall-snapshot`, { waitUntil: 'networkidle0', timeout: 30000 });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(ARCHIVES_DIR, `wall_archive_${timestamp}.png`);
    await page.screenshot({ path: archivePath, fullPage: true });
    await browser.close();
    console.log(`[wall] screenshot saved → ${archivePath}`);
  } catch (err) {
    console.error('[wall] screenshot failed:', err.message);
  }

  try {
    fs.readdirSync(WALL_UPLOAD_DIR).forEach((f) => {
      try { fs.unlinkSync(path.join(WALL_UPLOAD_DIR, f)); } catch {}
    });
  } catch {}

  wallPhotos = [];
  wallLastReset = Date.now();
  saveWall();
  io.emit('wall:update', { photos: wallPhotos, lastReset: wallLastReset });
  console.log('[wall] reset complete');
}

function checkWallTimer() {
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  if (!wallArchiving && wallPhotos.length > 0 && Date.now() - wallLastReset >= THREE_DAYS_MS) {
    console.log('[wall] 3-day timer triggered — archiving');
    wallArchiving = true;
    archiveAndResetWall().catch(console.error).finally(() => { wallArchiving = false; });
  }
}

// ── In-memory state ──────────────────────────────────────────────────────────
const tokens = { access: null, refresh: null, expiresAt: 0 };
let queue = [];        // tracks we've added via this app
let nowPlaying = null; // last known now-playing snapshot
let oauthState = null; // CSRF guard for the OAuth round-trip
let hardStopArmed = false; // true while the last queued track is playing; triggers pause on next track
let removedUris = {};     // uri → count of pending removals (auto-skip when track starts playing)
let chatMessages = [];    // { nickname, text, ts } — last 200 kept in memory
let playHistory = [];     // { uri, name, artist, album, image, duration_ms, playedAt } — last 48h
let currentLyrics = null; // { syncedLyrics: string|null, plainLyrics: string|null } | null
let lyricsUri = null;    // URI of the track for which lyrics were last fetched

let wallPhotos = [];     // [{ id, filename, caption, rotation, offsetX, offsetY, addedAt }]
let wallLastReset = Date.now();
let wallArchiving = false;

// ── Config ───────────────────────────────────────────────────────────────────
const {
  SPOTIFY_CLIENT_ID: CLIENT_ID,
  SPOTIFY_CLIENT_SECRET: CLIENT_SECRET,
  REDIRECT_URI = 'http://localhost:3000/callback',
  PORT = 3000,
} = process.env;

const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
].join(' ');

// ── Token helpers ─────────────────────────────────────────────────────────────
const spotifyAuthHeader = () =>
  'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

async function refreshAccessToken() {
  const { data } = await axios.post(
    'https://accounts.spotify.com/api/token',
    querystring.stringify({ grant_type: 'refresh_token', refresh_token: tokens.refresh }),
    { headers: { Authorization: spotifyAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  tokens.access = data.access_token;
  tokens.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
  if (data.refresh_token) tokens.refresh = data.refresh_token;
  saveTokens();
}

async function getToken() {
  if (!tokens.access) throw Object.assign(new Error('Not authenticated'), { status: 401 });
  if (Date.now() >= tokens.expiresAt) await refreshAccessToken();
  return tokens.access;
}

const authHeader = (token) => ({ Authorization: `Bearer ${token}` });

async function pausePlayback(token) {
  await axios.put('https://api.spotify.com/v1/me/player/pause', null, {
    headers: authHeader(token),
    validateStatus: (s) => s < 500,
  });
}

async function tryAutoplayFromHistory(excludeUri, token) {
  const candidates = playHistory.filter((h) => h.uri !== excludeUri);
  if (candidates.length === 0) { hardStopArmed = true; return; }
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  try {
    await axios.post(
      `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(pick.uri)}`,
      null,
      { headers: authHeader(token) }
    );
    const track = { uri: pick.uri, name: pick.name, artist: pick.artist, album: pick.album, image: pick.image, duration_ms: pick.duration_ms, clientId: 'jukebox-auto', addedAt: Date.now() };
    queue.push(track);
    hardStopArmed = false;
    io.emit('queue:update', queue);
    io.emit('jukebox:autoplay', { name: pick.name, artist: pick.artist });
  } catch {
    hardStopArmed = true;
  }
}

async function fetchLyrics(track) {
  const duration = Math.round(track.duration_ms / 1000);
  const params = new URLSearchParams({
    artist_name: track.artist,
    track_name: track.name,
    album_name: track.album,
    duration,
  });
  console.log(`[lyrics] fetching: "${track.name}" by ${track.artist} (${duration}s)`);
  try {
    let res = await axios.get(`https://lrclib.net/api/get?${params}`, {
      validateStatus: (s) => s < 500,
      timeout: 8000,
    });
    console.log(`[lyrics] /api/get status: ${res.status}`);
    if (res.status === 404) {
      const q = encodeURIComponent(`${track.artist} ${track.name}`);
      res = await axios.get(`https://lrclib.net/api/search?q=${q}`, {
        validateStatus: (s) => s < 500,
        timeout: 8000,
      });
      console.log(`[lyrics] /api/search status: ${res.status}, results: ${Array.isArray(res.data) ? res.data.length : 'n/a'}`);
      const first = Array.isArray(res.data) && res.data[0];
      if (!first) { console.log('[lyrics] no results found'); return null; }
      const result = { syncedLyrics: first.syncedLyrics || null, plainLyrics: first.plainLyrics || null };
      console.log(`[lyrics] found via search — synced: ${!!result.syncedLyrics}, plain: ${!!result.plainLyrics}`);
      return result;
    }
    if (!res.data) { console.log('[lyrics] empty response body'); return null; }
    const result = { syncedLyrics: res.data.syncedLyrics || null, plainLyrics: res.data.plainLyrics || null };
    console.log(`[lyrics] found — synced: ${!!result.syncedLyrics}, plain: ${!!result.plainLyrics}`);
    return result;
  } catch (err) {
    console.log(`[lyrics] fetch error: ${err.message}`);
    return null;
  }
}

// ── OAuth routes ──────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  oauthState = crypto.randomBytes(16).toString('hex');
  const qs = querystring.stringify({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state: oauthState,
  });
  res.redirect(`https://accounts.spotify.com/authorize?${qs}`);
});

app.get('/callback', async (req, res) => {
  const { code, error, state } = req.query;

  if (error) return res.status(400).send(`Spotify refused: ${error}`);
  if (state !== oauthState) return res.status(403).send('State mismatch — possible CSRF');
  oauthState = null;

  try {
    const { data } = await axios.post(
      'https://accounts.spotify.com/api/token',
      querystring.stringify({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      { headers: { Authorization: spotifyAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokens.access = data.access_token;
    tokens.refresh = data.refresh_token;
    tokens.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
    saveTokens();

    io.emit('auth:status', { authenticated: true });
    res.redirect('http://localhost:' + PORT);
  } catch (err) {
    res.status(500).send('Token exchange failed: ' + (err.response?.data?.error_description || err.message));
  }
});

// ── API: status ───────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ authenticated: !!tokens.access && !!tokens.refresh });
});

// ── API: search ───────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q?.trim()) return res.status(400).json({ error: 'q is required' });

  try {
    const token = await getToken();
    const { data } = await axios.get('https://api.spotify.com/v1/search', {
      headers: authHeader(token),
      params: { q, type: 'track', limit: '10' },
    });

    const tracks = data.tracks.items.map((t) => ({
      id: t.id,
      uri: t.uri,
      name: t.name,
      artist: t.artists.map((a) => a.name).join(', '),
      album: t.album.name,
      image: t.album.images[1]?.url ?? t.album.images[0]?.url ?? null,
      duration_ms: t.duration_ms,
    }));

    res.json(tracks);
  } catch (err) {
    const status = err.status ?? err.response?.status ?? 500;
    res.status(status).json({ error: err.response?.data?.error?.message ?? err.message });
  }
});

// ── API: add to queue ─────────────────────────────────────────────────────────
app.post('/api/queue', async (req, res) => {
  const { uri, name, artist, album, image, duration_ms, clientId } = req.body;
  if (!uri) return res.status(400).json({ error: 'uri is required' });

  try {
    const token = await getToken();
    await axios.post(
      `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
      null,
      { headers: authHeader(token) }
    );

    const track = { uri, name, artist, album, image, duration_ms, clientId, addedAt: Date.now() };
    queue.push(track);
    hardStopArmed = false; // new song coming — cancel any pending hard stop
    io.emit('queue:update', queue);
    res.json({ ok: true });
  } catch (err) {
    const spotifyMsg = err.response?.data?.error?.message;
    const status = err.status ?? err.response?.status ?? 500;

    if (status === 404 || status === 403) {
      return res.status(404).json({
        error: 'No active Spotify device found. Open Spotify on any device and start playing something first.',
      });
    }
    res.status(status).json({ error: spotifyMsg ?? err.message });
  }
});

// ── API: remove from queue ────────────────────────────────────────────────────
app.delete('/api/queue', (req, res) => {
  const { uri, clientId } = req.body;
  if (!uri || !clientId) return res.status(400).json({ error: 'uri and clientId are required' });

  const idx = queue.findIndex((t) => t.uri === uri && t.clientId === clientId);
  if (idx === -1) return res.status(404).json({ error: 'Track not found or not yours' });

  queue.splice(idx, 1);
  // Spotify has no remove-from-queue API — mark for auto-skip when it starts playing
  removedUris[uri] = (removedUris[uri] || 0) + 1;
  io.emit('queue:update', queue);
  res.json({ ok: true });
});

// ── Wall snapshot page (for Puppeteer archive screenshot) ────────────────────
app.get('/wall-snapshot', (req, res) => {
  const photosHtml = wallPhotos.map((p) => {
    const cap = (p.caption || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="pol" style="transform:rotate(${p.rotation}deg)"><img src="/uploads/wall/${encodeURIComponent(p.filename)}" alt=""><div class="cap">${cap}</div></div>`;
  }).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#f5efe0;padding:32px;font-family:sans-serif}
.wall{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}
.pol{background:#fff;padding:10px 10px 36px;box-shadow:2px 4px 14px rgba(0,0,0,.3);display:inline-block}
.pol img{width:156px;height:156px;object-fit:cover;display:block}
.cap{margin-top:8px;font-size:13px;color:#333;text-align:center;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:156px}
  </style></head><body><div class="wall">${photosHtml}</div></body></html>`);
});

// ── Wall upload ───────────────────────────────────────────────────────────────
const wallUploadMiddleware = wallUpload.single('photo');

app.post('/wall/upload', async (req, res) => {
  let uploadErr = null;
  await new Promise((resolve) => {
    wallUploadMiddleware(req, res, (err) => { uploadErr = err || null; resolve(); });
  });

  if (uploadErr) return res.status(400).json({ error: uploadErr.message || 'Upload failed' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

  const caption = (req.body.caption ?? '').trim().slice(0, 30);
  const photo = {
    id: crypto.randomUUID(),
    filename: req.file.filename,
    caption,
    rotation: parseFloat((Math.random() * 16 - 8).toFixed(2)),
    offsetX: parseFloat((Math.random() * 30 - 15).toFixed(1)),
    offsetY: parseFloat((Math.random() * 30 - 15).toFixed(1)),
    addedAt: Date.now(),
  };

  wallPhotos.push(photo);
  saveWall();
  io.emit('wall:update', { photos: wallPhotos, lastReset: wallLastReset });
  res.json({ ok: true, photo });

  if (wallPhotos.length >= WALL_MAX && !wallArchiving) {
    wallArchiving = true;
    archiveAndResetWall().catch(console.error).finally(() => { wallArchiving = false; });
  }
});

// ── Now-playing poll (every 5 s) ──────────────────────────────────────────────
async function pollNowPlaying() {
  if (!tokens.access) return;

  try {
    const token = await getToken();
    const res = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: authHeader(token),
      validateStatus: (s) => s < 500,
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers['retry-after'] || '10', 10);
      console.warn(`[poll] Spotify rate limit hit — backing off ${retryAfter}s`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return;
    }

    if (res.status === 204 || !res.data?.item) {
      if (nowPlaying !== null) {
        nowPlaying = null;
        io.emit('nowPlaying:update', null);
      }
      return;
    }

    const item = res.data.item;
    const np = {
      id: item.id,
      uri: item.uri,
      name: item.name,
      artist: item.artists.map((a) => a.name).join(', '),
      album: item.album.name,
      image: item.album.images[1]?.url ?? item.album.images[0]?.url ?? null,
      duration_ms: item.duration_ms,
      progress_ms: res.data.progress_ms,
      is_playing: res.data.is_playing,
      polledAt: Date.now(),
    };

    // Trim our queue when a queued track starts playing; hard-stop if queue runs out
    if (nowPlaying?.uri !== np.uri) {
      // Auto-skip tracks the user removed — Spotify has no remove API so we skip on play
      if (removedUris[np.uri] > 0) {
        removedUris[np.uri]--;
        if (removedUris[np.uri] === 0) delete removedUris[np.uri];
        try {
          await axios.post('https://api.spotify.com/v1/me/player/next', null, {
            headers: authHeader(token),
            validateStatus: (s) => s < 500,
          });
        } catch {}
        return; // let the next poll handle the track that actually plays
      }

      // Record every song that starts playing (not just queued ones)
      playHistory.unshift({ uri: np.uri, name: np.name, artist: np.artist, album: np.album, image: np.image, duration_ms: np.duration_ms, playedAt: Date.now() });
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;
      playHistory = playHistory.filter((h) => h.playedAt >= cutoff);
      io.emit('history:update', playHistory);

      currentLyrics = null;
      lyricsUri = np.uri;
      io.emit('lyrics:update', null);
      fetchLyrics(np).then((lyrics) => {
        currentLyrics = lyrics;
        io.emit('lyrics:update', currentLyrics);
      }).catch(() => {});

      const idx = queue.findIndex((t) => t.uri === np.uri);
      if (idx !== -1) {
        queue = queue.slice(idx + 1);
        io.emit('queue:update', queue);
        if (queue.length === 0) {
          await tryAutoplayFromHistory(np.uri, token);
        } else {
          hardStopArmed = false;
        }
      } else if (hardStopArmed) {
        // Spotify moved to a non-queued track after our queue emptied — pause it
        hardStopArmed = false;
        try { await pausePlayback(token); } catch {}
        io.emit('jukebox:stopped');
        return;
      }
    } else if (np.uri === lyricsUri && currentLyrics === null) {
      // Same track, but lyrics previously returned null — retry once in case of transient failure
      lyricsUri = null;
      fetchLyrics(np).then((lyrics) => {
        if (lyrics && nowPlaying?.uri === np.uri) {
          currentLyrics = lyrics;
          io.emit('lyrics:update', currentLyrics);
        }
      }).catch(() => {});
    }

    nowPlaying = np;
    io.emit('nowPlaying:update', nowPlaying);
  } catch {
    // silently swallow — next poll will retry (token refresh handled in getToken)
  }
}

setInterval(pollNowPlaying, 5000);

// ── Socket.io — hydrate new clients ──────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('auth:status', { authenticated: !!tokens.access && !!tokens.refresh });
  socket.emit('nowPlaying:update', nowPlaying);
  socket.emit('queue:update', queue);
  socket.emit('history:update', playHistory);
  socket.emit('lyrics:update', currentLyrics);
  socket.emit('chat:history', chatMessages.slice(-50));
  socket.emit('wall:update', { photos: wallPhotos, lastReset: wallLastReset });

  socket.on('chat:send', ({ nickname, text }) => {
    if (!nickname?.trim() || !text?.trim()) return;
    const msg = {
      nickname: nickname.trim().slice(0, 30),
      text: text.trim().slice(0, 300),
      ts: Date.now(),
    };
    chatMessages.push(msg);
    if (chatMessages.length > 200) chatMessages = chatMessages.slice(-200);
    io.emit('chat:message', msg);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
loadTokens();
loadWall();
checkWallTimer();
setInterval(checkWallTimer, 60 * 60 * 1000);
server.listen(PORT, () => {
  console.log(`\n🎵  HIRA Jukebox running at http://localhost:${PORT}`);
  if (!tokens.refresh) {
    console.log(`🔐  Host: open http://localhost:${PORT}/login to connect Spotify\n`);
  } else {
    console.log(`✅  Spotify already connected — no login needed\n`);
  }
});
