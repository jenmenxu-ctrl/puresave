#!/usr/bin/env bash
cd /Users/yovo/.gemini/antigravity/scratch/media-saver || exit 1

while true; do
  if ! lsof -ti:3456 >/dev/null 2>&1; then
    nohup node /Users/yovo/.gemini/antigravity/scratch/media-saver/server.js >> /Users/yovo/.gemini/antigravity/scratch/media-saver/.server.log 2>&1 &
  fi
  if ! pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
    nohup /Users/yovo/.gemini/antigravity/scratch/media-saver/bin/cloudflared tunnel --protocol http2 --url http://127.0.0.1:3456 --logfile /Users/yovo/.gemini/antigravity/scratch/media-saver/.tunnel_url.txt >/dev/null 2>&1 &
  fi
  sleep 5
done
