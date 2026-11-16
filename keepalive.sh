#!/usr/bin/env bash
cd /Users/yovo/.gemini/antigravity/scratch/media-saver || exit 1

LAST_SYNCED_URL=""

while true; do
  if ! lsof -ti tcp:3456 -sTCP:LISTEN >/dev/null 2>&1; then
    nohup node /Users/yovo/.gemini/antigravity/scratch/media-saver/server.js >> /Users/yovo/.gemini/antigravity/scratch/media-saver/.server.log 2>&1 &
  fi
  if [ -f .tunnel_url.txt ] && tail -n 5 .tunnel_url.txt | grep -q "Tunnel not found"; then
    pkill -f "cloudflared tunnel" >/dev/null 2>&1
    rm -f .tunnel_url.txt
    sleep 2
  fi
  if ! pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
    rm -f .tunnel_url.txt
    nohup /Users/yovo/.gemini/antigravity/scratch/media-saver/bin/cloudflared tunnel --protocol http2 --url http://127.0.0.1:3456 --logfile /Users/yovo/.gemini/antigravity/scratch/media-saver/.tunnel_url.txt >/dev/null 2>&1 &
  fi

  if [ -f /Users/yovo/.gemini/antigravity/scratch/media-saver/.tunnel_url.txt ]; then
    CUR_URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' /Users/yovo/.gemini/antigravity/scratch/media-saver/.tunnel_url.txt | tail -n 1)
    if [ -n "$CUR_URL" ] && [ "$CUR_URL" != "$LAST_SYNCED_URL" ]; then
      printf '{"publicUrl":"%s","lanUrl":"http://192.168.1.4:3456","updatedAt":%s}\n' "$CUR_URL" "$(date +%s)" > tunnel.json
      cp tunnel.json public/tunnel.json 2>/dev/null || true
      cp tunnel.json docs/tunnel.json 2>/dev/null || true
      if [ -f .gh_token ]; then
        GH_TOK=$(cat .gh_token | tr -d '[:space:]')
        if [ -n "$GH_TOK" ]; then
          git add tunnel.json public/tunnel.json docs/tunnel.json >/dev/null 2>&1 || true
          git commit -m "chore: sync active tunnel endpoint" >/dev/null 2>&1 || true
          git push "https://x-access-token:${GH_TOK}@github.com/jenmenxu-ctrl/puresave.git" main >/dev/null 2>&1 && LAST_SYNCED_URL="$CUR_URL"
        fi
      else
        LAST_SYNCED_URL="$CUR_URL"
      fi
    fi
  fi
  sleep 5
done
