# HIRA Jukebox

A local party jukebox powered by Spotify. The host authenticates once with Spotify Premium; anyone on the same network (or via ngrok tunnel) can search and queue tracks from their phone or browser — no Spotify account required for guests.

## Features

- Real-time queue visible to all connected clients (Socket.io)
- Now-playing card with live progress bar
- Search Spotify's full catalogue
- Queue persists across page refreshes; tokens survive server restarts
- Optional ngrok tunnel for guests outside your LAN

## Requirements

- Node.js 18+
- A [Spotify Developer app](https://developer.spotify.com/dashboard) with a Premium account
- (Optional) [ngrok](https://ngrok.com) for remote access

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/hira-jukebox.git
cd hira-jukebox
npm install
```

### 2. Create a Spotify app

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. Under **Edit Settings → Redirect URIs**, add `http://localhost:3000/callback`.
3. Copy your **Client ID** and **Client Secret**.

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
REDIRECT_URI=http://localhost:3000/callback
PORT=3000
```

### 4. Run

```bash
npm start
```

Open `http://localhost:3000` in your browser. The host should click **Connect Spotify** to authenticate. After that, guests can access the jukebox at `http://<your-local-ip>:3000`.

## Optional: ngrok tunnel

To share the jukebox with people outside your LAN, install [ngrok](https://ngrok.com) and either:

- Run `start.command` (macOS) — set `NGROK_URL` to your static domain, or leave it unset for a random URL.
- Or run manually: `ngrok http 3000`

Remember to add the ngrok URL to your Spotify app's Redirect URIs and update `REDIRECT_URI` in `.env`.

## Project structure

```
server.js          — Express + Socket.io server, Spotify OAuth, search/queue API
public/index.html  — Single-file frontend
.env.example       — Environment variable template
start.command      — macOS double-click launcher with optional ngrok
```

## How it works

- The host visits `/login` → Spotify OAuth → tokens stored in memory and persisted to `.tokens.json`.
- Guests hit the main page — no login needed.
- `/api/search` proxies Spotify search; `/api/queue` calls the Spotify queue API.
- The server polls `currently-playing` every 5 s and broadcasts updates to all clients via Socket.io.
- When a queued track starts playing, it's automatically removed from the in-app queue display.
