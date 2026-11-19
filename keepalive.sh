#!/usr/bin/env bash
cd /Users/yovo/.gemini/antigravity/scratch/media-saver || exit 1

LAST_SYNCED_URL=""
FAIL_COUNT=0
LOOP_COUNT=0

while true; do
  LOOP_COUNT=$((LOOP_COUNT + 1))
  if ! lsof -ti tcp:3456 -sTCP:LISTEN >/dev/null 2>&1; then
    nohup node /Users/yovo/.gemini/antigravity/scratch/media-saver/server.js >> /Users/yovo/.gemini/antigravity/scratch/media-saver/.server.log 2>&1 &
  fi
  if [ -f .tunnel_url.txt ] && tail -n 5 .tunnel_url.txt | grep -qE "Tunnel not found|TLS handshake with edge error"; then
    pkill -f "cloudflared tunnel" >/dev/null 2>&1
    rm -f .tunnel_url.txt
    FAIL_COUNT=0
    sleep 2
  fi
  if [ $((LOOP_COUNT % 6)) -eq 0 ] && [ -n "$LAST_SYNCED_URL" ]; then
    if ! curl -sf --max-time 6 "${LAST_SYNCED_URL}/api/status" >/dev/null 2>&1; then
      FAIL_COUNT=$((FAIL_COUNT + 1))
      if [ "$FAIL_COUNT" -ge 2 ]; then
        pkill -f "cloudflared tunnel" >/dev/null 2>&1
        rm -f .tunnel_url.txt
        FAIL_COUNT=0
        LAST_SYNCED_URL=""
        sleep 2
      fi
    else
      FAIL_COUNT=0
    fi
  fi
  if ! pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
    rm -f .tunnel_url.txt
    nohup /Users/yovo/.gemini/antigravity/scratch/media-saver/bin/cloudflared tunnel --protocol http2 --url http://127.0.0.1:3456 --logfile /Users/yovo/.gemini/antigravity/scratch/media-saver/.tunnel_url.txt >/dev/null 2>&1 &
  fi

  if [ -f /Users/yovo/.gemini/antigravity/scratch/media-saver/.tunnel_url.txt ]; then
    CUR_URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' /Users/yovo/.gemini/antigravity/scratch/media-saver/.tunnel_url.txt | tail -n 1)
    if [ -n "$CUR_URL" ] && [ "$CUR_URL" != "$LAST_SYNCED_URL" ]; then
      LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || echo "127.0.0.1")
      printf '{"publicUrl":"https://puresave-backend-production.up.railway.app","macTunnelUrl":"%s","lanUrl":"http://%s:3456","updatedAt":%s}\n' "$CUR_URL" "$LAN_IP" "$(date +%s)" > tunnel.json
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
