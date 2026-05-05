#!/bin/bash
export PATH="/opt/homebrew/bin:$PATH"

cd "$(dirname "$0")"

# Start ngrok tunnel in background
# Set NGROK_URL env var to your static domain (https://dashboard.ngrok.com/domains)
# or leave unset to get a random tunnel URL
if [ -n "$NGROK_URL" ]; then
  ngrok http 3000 --url="$NGROK_URL" &
else
  ngrok http 3000 &
fi
NGROK_PID=$!

# Give ngrok a moment to connect
sleep 2

echo ""
echo "🎵  Starting HIRA Jukebox..."
echo "📱  Share with friends on your WiFi: http://$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1):3000"
echo ""

# Start the server (keeps terminal open)
node server.js

# Clean up ngrok when server stops
kill $NGROK_PID 2>/dev/null
