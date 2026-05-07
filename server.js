require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const querystring = require('querystring');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// ── In-memory state ──────────────────────────────────────────────────────────
const tokens = { access: null, refresh: null, expiresAt: 0 };
let queue = [];        // tracks we've added via this app
let nowPlaying = null; // last known now-playing snapshot
let oauthState = null; // CSRF guard for the OAuth round-trip
let hardStopArmed = false; // true while the last queued track is playing; triggers pause on next track
let chatMessages = [];    // { nickname, text, ts } — last 200 kept in memory
let playHistory = [];     // { uri, name, artist, album, image, duration_ms, playedAt } — last 48h

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
  io.emit('queue:update', queue);
  res.json({ ok: true });
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
      // Record every song that starts playing (not just queued ones)
      playHistory.unshift({ uri: np.uri, name: np.name, artist: np.artist, album: np.album, image: np.image, duration_ms: np.duration_ms, playedAt: Date.now() });
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;
      playHistory = playHistory.filter((h) => h.playedAt >= cutoff);
      io.emit('history:update', playHistory);

      const idx = queue.findIndex((t) => t.uri === np.uri);
      if (idx !== -1) {
        queue = queue.slice(idx + 1);
        io.emit('queue:update', queue);
        hardStopArmed = queue.length === 0;
      } else if (hardStopArmed) {
        // Spotify moved to a non-queued track after our queue emptied — pause it
        hardStopArmed = false;
        try { await pausePlayback(token); } catch {}
        io.emit('jukebox:stopped');
        return;
      }
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
  socket.emit('chat:history', chatMessages.slice(-50));

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
server.listen(PORT, () => {
  console.log(`\n🎵  HIRA Jukebox running at http://localhost:${PORT}`);
  if (!tokens.refresh) {
    console.log(`🔐  Host: open http://localhost:${PORT}/login to connect Spotify\n`);
  } else {
    console.log(`✅  Spotify already connected — no login needed\n`);
  }
});
