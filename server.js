const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');
const vm = require('vm');
const zlib = require('zlib');
const { execFile, spawn } = require('child_process');
const { URL } = require('url');

const PORT = process.env.PORT || 3456;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TUNNEL_INFO_FILE = path.join(__dirname, '.tunnel_url.txt');

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function getLanIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

function getPublicTunnelUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.trim();
  try {
    if (fs.existsSync(TUNNEL_INFO_FILE)) {
      const content = fs.readFileSync(TUNNEL_INFO_FILE, 'utf-8').trim();
      const match = content.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match) return match[0];
      if (/^https?:\/\//i.test(content)) return content.split(/\s+/)[0];
    }
  } catch (_) {}
  return null;
}

function decodeHtmlEntities(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/**
 * Extract the first valid URL from raw pasted share text across Douyin, TikTok, Xiaohongshu, X, Ins, Dewu
 */
function extractUrlFromText(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  const urlMatch = trimmed.match(
    /https?:\/\/[^\s"'<>，。！？；：）】\]）\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/i
  );
  if (urlMatch) {
    return urlMatch[0].replace(/[.,!?;:)'"\]）】>]+$/, '');
  }
  if (/^\d{18,20}$/.test(trimmed)) {
    return `https://www.iesdouyin.com/share/video/${trimmed}/`;
  }
  if (/^[0-9a-f]{24}$/i.test(trimmed)) {
    return `https://www.xiaohongshu.com/explore/${trimmed}`;
  }
  return null;
}

/**
 * Detect platform from URL
 */
function detectPlatform(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();
    if (host.includes('douyin.com') || host.includes('iesdouyin.com')) {
      return 'douyin';
    }
    if (host.includes('tiktok.com')) {
      return 'tiktok';
    }
    if (
      host.includes('xiaohongshu.com') ||
      host.includes('xhslink.com') ||
      host.includes('xhslink.cn') ||
      host.includes('rednote.com')
    ) {
      return 'xiaohongshu';
    }
    if (
      host.includes('x.com') ||
      host.includes('twitter.com') ||
      host.includes('vxtwitter.com') ||
      host.includes('fxtwitter.com') ||
      host.includes('t.co')
    ) {
      return 'x';
    }
    if (
      host.includes('instagram.com') ||
      host.includes('instagr.am') ||
      host.includes('ddinstagram.com') ||
      host.includes('vxinstagram.com') ||
      host.includes('kkinstagram.com') ||
      host.includes('eeinstagram.com')
    ) {
      return 'instagram';
    }
    if (
      host.includes('dewu.com') ||
      host.includes('poizon.com') ||
      host.includes('dw4.co') ||
      host.includes('duapp.com') ||
      host.includes('shizhuang-inc.com')
    ) {
      return 'dewu';
    }
    if (
      host.includes('bilibili.com') ||
      host.includes('b23.tv') ||
      host.includes('bili2233.cn')
    ) {
      return 'bilibili';
    }
  } catch (_) {}
  return 'unknown';
}

/**
 * Helper to resolve 302 redirect URL without downloading the full body
 */
async function resolveRedirectUrl(targetUrl, headers = {}, maxRedirects = 6) {
  let currentUrl = targetUrl;
  const ua = headers['User-Agent'] || MOBILE_UA;
  for (let i = 0; i < maxRedirects; i++) {
    try {
      const u = new URL(currentUrl);
      if (isDomesticChinaHost(u.hostname)) {
        const realIps = await resolveChinaDomesticIps(u.hostname);
        if (realIps.length > 0) {
          const port = u.port || (u.protocol === 'https:' ? '443' : '80');
          const headOut = await runCurl([
            '-s',
            '-I',
            '--http1.1',
            '--max-time',
            '4',
            '--interface',
            'en0',
            '--resolve',
            `${u.hostname}:${port}:${realIps[0]}`,
            '-H',
            `User-Agent: ${ua}`,
            currentUrl,
          ]).catch(() => '');
          const locMatch = headOut.match(/^location:\s*(.+)$/im);
          if (locMatch && locMatch[1]) {
            currentUrl = new URL(locMatch[1].trim(), currentUrl).toString();
            const nextHost = new URL(currentUrl).hostname.toLowerCase();
            if (
              !/^(v\.douyin\.com|vm\.tiktok\.com|vt\.tiktok\.com|xhslink\.com|xhslink\.cn|t\.co|dw4\.co)$/i.test(
                nextHost
              )
            ) {
              break;
            }
            continue;
          }
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': MOBILE_UA,
          ...headers,
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.body) {
        try {
          await res.body.cancel();
        } catch (_) {}
      }
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        currentUrl = new URL(location, currentUrl).toString();
        const nextHost = new URL(currentUrl).hostname.toLowerCase();
        if (
          !/^(v\.douyin\.com|vm\.tiktok\.com|vt\.tiktok\.com|xhslink\.com|t\.co|dw4\.co)$/i.test(
            nextHost
          )
        ) {
          break;
        }
      } else {
        break;
      }
    } catch (_) {
      break;
    }
  }
  return currentUrl;
}

/* ==========================================================================
   1. 抖音 (DOUYIN) & TIKTOK PARSER - 视频 / 图集 / 实况 LivePhoto
   ========================================================================== */

function extractDouyinId(urlStr) {
  const patterns = [
    /\/video\/(\d{15,22})/,
    /\/note\/(\d{15,22})/,
    /\/slides\/(\d{15,22})/,
    /\/share\/video\/(\d{15,22})/,
    /\/share\/note\/(\d{15,22})/,
    /\/share\/slides\/(\d{15,22})/,
    /[?&]modal_id=(\d{15,22})/,
    /[?&]vid=(\d{15,22})/,
    /[?&]aweme_id=(\d{15,22})/,
  ];
  for (const regex of patterns) {
    const m = urlStr.match(regex);
    if (m && m[1]) return m[1];
  }
  return null;
}

async function parseDouyin(inputUrl) {
  let resolvedUrl = inputUrl;
  let awemeId = extractDouyinId(resolvedUrl);

  if (!awemeId) {
    resolvedUrl = await resolveRedirectUrl(inputUrl, {
      'User-Agent': MOBILE_UA,
    });
    awemeId = extractDouyinId(resolvedUrl);
  }

  let overseasFiltered = false;

  if (awemeId) {
    const preferNote = /\/note\/|\/slides\//i.test(resolvedUrl);

    // Engine 0: Direct Domestic China Interface (en0) SSR Extractor (bypasses TUN/Fake-IP US proxy)
    try {
      const directResult = await fetchDouyinViaDirectChinaSSR(
        awemeId,
        preferNote
      );
      if (directResult) {
        return directResult;
      }
    } catch (directErr) {
      console.warn('Direct China SSR extractor warning:', directErr.message);
    }

    // Engine 1A: Try slidesinfo endpoint (used for 图文 / 实况图集 notes)
    try {
      const slidesUrl = `https://www.iesdouyin.com/web/api/v2/aweme/slidesinfo/?reflow_source=reflow_page&aweme_ids=%5B${awemeId}%5D&request_source=200`;
      const sRes = await fetch(slidesUrl, {
        headers: {
          'User-Agent': MOBILE_UA,
          Accept: 'application/json',
          Referer: `https://www.iesdouyin.com/share/note/${awemeId}/`,
        },
      });
      if (sRes.ok) {
        const sJson = await sRes.json();
        if (
          Array.isArray(sJson?.aweme_details) &&
          sJson.aweme_details.length > 0
        ) {
          return await formatDouyinRouterItem(sJson.aweme_details[0], awemeId);
        }
        if (
          Array.isArray(sJson?.filter_list) &&
          sJson.filter_list.length > 0
        ) {
          overseasFiltered = true;
        }
      }
    } catch (_) {}

    // Engine 1B: Try iesdouyin mobile share page _ROUTER_DATA
    for (const shareType of ['video', 'note']) {
      try {
        const sharePageUrl = `https://www.iesdouyin.com/share/${shareType}/${awemeId}/`;
        const res = await fetch(sharePageUrl, {
          headers: {
            'User-Agent': MOBILE_UA,
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
        });
        const html = await res.text();
        if (html.includes('"isMainland":false')) {
          overseasFiltered = true;
        }
        const routerMatch = html.match(
          /window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})<\/script>/
        );

        if (routerMatch && routerMatch[1]) {
          const routerData = JSON.parse(routerMatch[1]);
          const loaderData = routerData.loaderData || {};
          for (const key of Object.keys(loaderData)) {
            const pageData = loaderData[key];
            const itemList =
              pageData?.videoInfoRes?.item_list ||
              pageData?.slidesInfoRes?.aweme_details;
            if (Array.isArray(itemList) && itemList.length > 0) {
              return await formatDouyinRouterItem(itemList[0], awemeId);
            }
          }
        }
      } catch (_) {}
    }
  }

  // Engine 2: TikWM HD API (with automatic retry if rate-limited)
  try {
    return await parseViaTikwm(inputUrl, 'douyin', awemeId);
  } catch (err) {
    if (overseasFiltered) {
      throw new Error(
        `抖音官方对该图文作品 (ID: ${awemeId}) 启用了海外节点访问限制 (filter_reason: 8)。请确认本地 Wi-Fi (en0) 已连接国内网络。`
      );
    }
    throw err;
  }
}

const domesticDnsCache = new Map();

function isDomesticChinaHost(hostname) {
  return /(\.|^)(douyin|douyinvod|douyinpic|iesdouyin|byteimg|bytedance|snssdk|amemv|pstatp|ixigua|xiaohongshu|xhscdn|xhslink|rednote|dewu|poizon|duapp|shizhuang-inc|dw4|bilibili|b23|bili2233|bilivideo|hdslb|biliapi)\./i.test(
    hostname || ''
  );
}

/**
 * Resolve hostname via local LAN router DNS (e.g. 192.168.1.1 / 223.5.5.5) to avoid Fake-IP (198.18.x.x) from TUN proxies
 */
function resolveChinaDomesticIps(hostname) {
  const cached = domesticDnsCache.get(hostname);
  if (cached && Date.now() - cached.ts < 5 * 60 * 1000) {
    return Promise.resolve(cached.ips);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), 1800);
    const lanIp = getLanIp();
    const parts = lanIp.split('.');
    const gatewayDns =
      parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.1` : '192.168.1.1';
    const resolver = new dns.Resolver();
    resolver.setServers([gatewayDns, '223.5.5.5', '119.29.29.29']);
    resolver.resolve4(hostname, (err, addresses) => {
      clearTimeout(timer);
      if (!err && Array.isArray(addresses)) {
        const realIps = addresses.filter((ip) => !ip.startsWith('198.18.'));
        if (realIps.length > 0) {
          domesticDnsCache.set(hostname, { ips: realIps, ts: Date.now() });
        }
        return resolve(realIps);
      }
      resolve([]);
    });
  });
}

function runCurl(args, maxBuffer = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer, timeout: 12000 }, (err, stdout) => {
      if (err && !stdout) return reject(err);
      resolve(stdout || '');
    });
  });
}

/**
 * Direct China Interface (en0) SSR Extractor for www.douyin.com
 * Bypasses TUN proxy (utun) so domestic Douyin videos, image notes & Live Photos work seamlessly
 */
async function fetchDouyinViaDirectChinaSSR(awemeId, preferNote = false) {
  const realIps = await resolveChinaDomesticIps('www.douyin.com');
  const candidateIps = realIps.length > 0 ? realIps.slice(0, 2) : [null];
  const pageTypes = preferNote ? ['note', 'video'] : ['video', 'note'];

  for (const pageType of pageTypes) {
    for (const realIp of candidateIps) {
      const targetUrl = `https://www.douyin.com/${pageType}/${awemeId}`;
      const baseCurlArgs = ['-s', '--max-time', '8'];
      if (realIp) {
        baseCurlArgs.push(
          '--interface',
          'en0',
          '--resolve',
          `www.douyin.com:443:${realIp}`
        );
      }

      const step1Out = await runCurl([
        ...baseCurlArgs,
        '-i',
        '-H',
        `User-Agent: ${DESKTOP_UA}`,
        targetUrl,
      ]).catch(() => '');

      if (!step1Out) continue;

      if (step1Out.includes('self.__pace_f.push') && step1Out.includes(awemeId)) {
        const parsed = extractDouyinDetailFromHtml(step1Out, awemeId);
        if (parsed) return parsed;
      }

      const nonceMatch = step1Out.match(/set-cookie:\s*__ac_nonce=([^;\r\n]+)/i);
      if (!nonceMatch) continue;
      const nonce = nonceMatch[1].trim();

      const scripts = [...step1Out.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
        (m) => m[1]
      );
      const acrawlerScript = scripts.find((s) => s.includes('_$jsvmprt'));
      if (!acrawlerScript) continue;

      let signature = '';
      try {
        const sandbox = {
          window: null,
          global: null,
          self: null,
          document: { cookie: `__ac_nonce=${nonce}`, referrer: '' },
          navigator: { userAgent: DESKTOP_UA },
          location: { protocol: 'https:', href: targetUrl, reload: () => {} },
          sessionStorage: { setItem: () => {} },
          localStorage: { setItem: () => {} },
          performance: { timing: { navigationStart: Date.now() } },
          Object,
          Array,
          String,
          Number,
          Boolean,
          Date,
          Math,
          RegExp,
          Error,
          TypeError,
          JSON,
          Promise,
          parseInt,
          parseFloat,
          encodeURIComponent,
          decodeURIComponent,
          encodeURI,
          setTimeout,
        };
        sandbox.window = sandbox;
        sandbox.global = sandbox;
        sandbox.self = sandbox;
        vm.createContext(sandbox);
        vm.runInContext(acrawlerScript, sandbox, { timeout: 3000 });
        if (sandbox.window?.byted_acrawler) {
          sandbox.window.byted_acrawler.init({ aid: 99999999, dfp: 0 });
          signature = sandbox.window.byted_acrawler.sign('', nonce);
        }
      } catch (_) {}

      if (!signature) continue;

      const step2Html = await runCurl([
        ...baseCurlArgs,
        '-H',
        `User-Agent: ${DESKTOP_UA}`,
        '-H',
        `Cookie: __ac_nonce=${nonce}; __ac_signature=${signature}; __ac_referer=__ac_blank`,
        targetUrl,
      ]).catch(() => '');

      const parsed = extractDouyinDetailFromHtml(step2Html, awemeId);
      if (parsed) return parsed;
    }
  }

  return null;
}

function extractDouyinDetailFromHtml(html, awemeId) {
  if (!html || !html.includes('self.__pace_f.push')) return null;
  const blocks = html.split('<script');
  for (const block of blocks) {
    if (!block.includes(awemeId) || !block.includes('self.__pace_f.push')) {
      continue;
    }
    const pushStart = block.indexOf('self.__pace_f.push([1,"');
    const scriptEnd = block.indexOf('</script>');
    if (pushStart === -1 || scriptEnd === -1) continue;

    const inner = block.slice(
      pushStart + 'self.__pace_f.push([1,'.length,
      scriptEnd
    );
    const closeBracketIdx = inner.lastIndexOf('])');
    if (closeBracketIdx === -1) continue;

    const strLiteral = inner.slice(0, closeBracketIdx);
    try {
      const unescaped = JSON.parse(strLiteral);
      const colonIdx = unescaped.indexOf(':');
      if (colonIdx === -1) continue;
      const payload = JSON.parse(unescaped.slice(colonIdx + 1));
      const detail = findAwemeDetailInPayload(payload, awemeId);
      if (detail) {
        return formatDouyinPaceDetail(detail, awemeId);
      }
    } catch (_) {}
  }
  return null;
}

function findAwemeDetailInPayload(obj, awemeId, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return null;
  if (obj.aweme?.detail) {
    return obj.aweme.detail;
  }
  if (
    obj.detail &&
    (obj.detail.desc !== undefined || obj.detail.images || obj.detail.video)
  ) {
    return obj.detail;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findAwemeDetailInPayload(item, awemeId, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const k of Object.keys(obj)) {
    const found = findAwemeDetailInPayload(obj[k], awemeId, depth + 1);
    if (found) return found;
  }
  return null;
}

function cleanPaceVal(val, fallback = '') {
  if (val === undefined || val === null || val === '$undefined') return fallback;
  return val;
}

function formatDouyinPaceDetail(detail, awemeId) {
  const desc = cleanPaceVal(detail.desc, '抖音无水印作品');
  const authorInfo = detail.authorInfo || detail.author || {};
  const author = {
    name: cleanPaceVal(authorInfo.nickname, '抖音创作者'),
    username: cleanPaceVal(authorInfo.uniqueId || authorInfo.shortId, ''),
    avatar:
      authorInfo.avatarThumb?.urlList?.[0] ||
      authorInfo.avatar_thumb?.url_list?.[0] ||
      '',
  };

  const cover =
    cleanPaceVal(detail.video?.originCover) ||
    cleanPaceVal(detail.video?.cover) ||
    detail.video?.originCoverUrlList?.[0] ||
    detail.video?.coverUrlList?.[0] ||
    '';

  const rawMusic =
    detail.music?.playUrl?.urlList?.[0] ||
    cleanPaceVal(detail.music?.playUrl?.uri) ||
    (detail.mediaType === 2 ? cleanPaceVal(detail.video?.uri) : '');
  const musicUrl =
    typeof rawMusic === 'string' && rawMusic.startsWith('http') ? rawMusic : '';

  const stats = {
    likes: cleanPaceVal(detail.stats?.diggCount, 0),
    comments: cleanPaceVal(detail.stats?.commentCount, 0),
    shares: cleanPaceVal(detail.stats?.shareCount, 0),
    collects: cleanPaceVal(detail.stats?.collectCount, 0),
  };

  const images = Array.isArray(detail.images) ? detail.images : [];
  if (images.length > 0) {
    const mediaItems = images.map((img, idx) => {
      const urls = img.urlList || img.url_list || [];
      const jpegUrl = urls.find(
        (u) => typeof u === 'string' && (u.includes('.jpeg') || u.includes('.jpg'))
      );
      const webpUrl = urls.find(
        (u) => typeof u === 'string' && u.includes('.webp')
      );
      const bestImgUrl = jpegUrl || urls[urls.length - 1] || urls[0] || '';

      const rawLiveVideo =
        img.video?.playAddr?.[0]?.src ||
        img.video?.play_addr?.url_list?.[0] ||
        img.video?.bitRateList?.[0]?.playAddr?.[0]?.src ||
        null;
      const liveVideoUrl =
        typeof rawLiveVideo === 'string' && rawLiveVideo.startsWith('http')
          ? rawLiveVideo.replace('/playwm/', '/play/')
          : null;

      const variants = [];

      if (liveVideoUrl) {
        variants.push(
          {
            label: '🔊 实况带声音动态原片 (Live Photo MP4)',
            quality: '原画动态实况流 · 含原声音轨',
            url: liveVideoUrl,
            ext: 'mp4',
            isBest: true,
            isLiveVideo: true,
          },
          {
            label: '🍎 实况带声音原片 (MOV 苹果相册格式)',
            quality: 'iOS 相册兼容实况视频 · 含原声音轨',
            url: liveVideoUrl,
            ext: 'mov',
            isLiveVideo: true,
          }
        );
      }

      variants.push({
        label: liveVideoUrl
          ? '🖼️ 实况静态无损原图 (Lossless JPG 0水印)'
          : '无损未压缩原图 (Lossless JPG 0水印)',
        quality: `${img.width || 'HD'}x${img.height || 'HD'} · 原画直出`,
        url: bestImgUrl,
        ext: 'jpg',
        isBest: !liveVideoUrl,
      });

      if (webpUrl && webpUrl !== bestImgUrl) {
        variants.push({
          label: '高清 WebP 原图 (无水印)',
          quality: `${img.width || 'HD'}x${img.height || 'HD'} · WebP`,
          url: webpUrl,
          ext: 'webp',
        });
      }

      return {
        index: idx + 1,
        type: liveVideoUrl ? 'livephoto' : 'photo',
        url: bestImgUrl,
        thumbnail: bestImgUrl,
        width: img.width || 0,
        height: img.height || 0,
        liveVideoUrl,
        variants,
      };
    });

    const hasLive = mediaItems.some((m) => m.type === 'livephoto');
    return {
      platform: 'douyin',
      platformName: '抖音 (Douyin)',
      id: awemeId,
      type: hasLive ? 'livephoto' : 'gallery',
      title: desc,
      author,
      cover: mediaItems[0]?.url || cover,
      musicUrl,
      stats,
      mediaItems,
    };
  }

  // Video post
  const video = detail.video || {};
  const width = cleanPaceVal(video.width, 1080);
  const height = cleanPaceVal(video.height, 1920);
  const bitRateList = Array.isArray(video.bitRateList) ? video.bitRateList : [];

  const sortedBitrates = [...bitRateList].sort(
    (a, b) => (cleanPaceVal(b.bitRate, 0) || 0) - (cleanPaceVal(a.bitRate, 0) || 0)
  );

  const variants = [];
  const seenUrls = new Set();

  for (const br of sortedBitrates) {
    const src = br.playAddr?.[0]?.src || br.play_addr?.url_list?.[0] || '';
    if (!src || !src.startsWith('http') || seenUrls.has(src)) continue;
    seenUrls.add(src);
    const brWidth = cleanPaceVal(br.width, width);
    const brHeight = cleanPaceVal(br.height, height);
    const sizeBytes = cleanPaceVal(br.dataSize, 0);
    const sizeMb = sizeBytes ? ` · ${(sizeBytes / 1024 / 1024).toFixed(1)} MB` : '';
    const bps = cleanPaceVal(br.bitRate, 0);
    const mbps = bps ? ` · ${(bps / 1000000).toFixed(2)} Mbps` : '';
    variants.push({
      label:
        variants.length === 0
          ? '母带级最高码率无水印原片 (Lossless Master)'
          : `高清无水印流 (${cleanPaceVal(br.gearName, `${brWidth}x${brHeight}`)})`,
      quality: `${brWidth}x${brHeight}${mbps}${sizeMb}`,
      url: src,
      ext: 'mp4',
      isBest: variants.length === 0,
    });
  }

  const directPlaySrc =
    video.playAddr?.[0]?.src ||
    video.playAddrH265?.[0]?.src ||
    cleanPaceVal(video.playApi) ||
    '';
  if (directPlaySrc && directPlaySrc.startsWith('http') && !seenUrls.has(directPlaySrc)) {
    variants.push({
      label:
        variants.length === 0
          ? '原画无损无水印 (Original Lossless)'
          : '标准原画直链 (Direct Stream)',
      quality: `${width}x${height} · 无水印原片`,
      url: directPlaySrc,
      ext: 'mp4',
      isBest: variants.length === 0,
    });
  }

  const bestVideoUrl = variants[0]?.url || directPlaySrc;
  if (!bestVideoUrl) return null;

  return {
    platform: 'douyin',
    platformName: '抖音 (Douyin)',
    id: awemeId,
    type: 'video',
    title: desc,
    author,
    cover,
    musicUrl,
    stats,
    mediaItems: [
      {
        index: 1,
        type: 'video',
        url: bestVideoUrl,
        thumbnail: cover,
        width,
        height,
        duration: cleanPaceVal(video.duration, 0)
          ? Math.round(cleanPaceVal(video.duration, 0) / 1000)
          : 0,
        variants,
      },
    ],
  };
}

async function formatDouyinRouterItem(item, awemeId) {
  const desc = item.desc || '抖音无水印作品';
  const author = {
    name: item.author?.nickname || '抖音创作者',
    username: item.author?.unique_id || item.author?.short_id || '',
    avatar:
      item.author?.avatar_thumb?.url_list?.[0] ||
      item.author?.avatar_medium?.url_list?.[0] ||
      '',
  };
  const cover =
    item.video?.origin_cover?.url_list?.[0] ||
    item.video?.cover?.url_list?.[0] ||
    '';
  const musicUrl = item.music?.play_url?.url_list?.[0] || '';
  const stats = {
    likes: item.statistics?.digg_count || 0,
    comments: item.statistics?.comment_count || 0,
    shares: item.statistics?.share_count || 0,
    collects: item.statistics?.collect_count || 0,
  };

  const hasImages = Array.isArray(item.images) && item.images.length > 0;

  if (hasImages) {
    const mediaItems = item.images.map((img, idx) => {
      const urls = img.url_list || [];
      const nonWebp = urls.find((u) => !u.includes('.webp'));
      const bestImgUrl = nonWebp || urls[urls.length - 1] || urls[0] || '';
      const rawLiveVideo =
        img.video?.play_addr?.url_list?.[0] ||
        img.clip_video?.play_addr?.url_list?.[0] ||
        null;
      const liveVideoUrl = rawLiveVideo
        ? rawLiveVideo.replace('/playwm/', '/play/')
        : null;

      return {
        index: idx + 1,
        type: liveVideoUrl ? 'livephoto' : 'photo',
        url: bestImgUrl,
        thumbnail: urls[0] || bestImgUrl,
        width: img.width || 0,
        height: img.height || 0,
        liveVideoUrl,
        variants: [
          ...(liveVideoUrl
            ? [
                {
                  label: '🔊 实况带声音动态原片 (Live Photo MP4)',
                  quality: '原画动态实况流 · 含原声音轨',
                  url: liveVideoUrl,
                  ext: 'mp4',
                  isBest: true,
                  isLiveVideo: true,
                },
                {
                  label: '🍎 实况带声音原片 (MOV 苹果相册格式)',
                  quality: 'iOS 相册兼容实况视频 · 含原声音轨',
                  url: liveVideoUrl,
                  ext: 'mov',
                  isLiveVideo: true,
                },
              ]
            : []),
          {
            label: liveVideoUrl
              ? '🖼️ 实况静态无损原图 (Lossless JPG)'
              : '无损无水印原图 (Lossless Image)',
            quality: `${img.width || 'HD'}x${img.height || 'HD'} · 原图`,
            url: bestImgUrl,
            ext: 'jpg',
            isBest: !liveVideoUrl,
          },
        ],
      };
    });

    const hasLive = mediaItems.some((m) => m.type === 'livephoto');
    return {
      platform: 'douyin',
      platformName: '抖音 (Douyin)',
      id: awemeId,
      type: hasLive ? 'livephoto' : 'gallery',
      title: desc,
      author,
      cover: mediaItems[0]?.url || cover,
      musicUrl,
      stats,
      mediaItems,
    };
  }

  const video = item.video || {};
  const uri = video.play_addr?.uri || '';
  const rawUrlList = video.play_addr?.url_list || [];
  const rawPlayUrl = (rawUrlList[0] || '').replace('/playwm/', '/play/');

  const width = video.width || 1080;
  const height = video.height || 1920;

  const snssdk1080 = uri
    ? `https://aweme.snssdk.com/aweme/v1/play/?video_id=${uri}&ratio=1080p&line=0`
    : rawPlayUrl;
  const snssdk720 = uri
    ? `https://aweme.snssdk.com/aweme/v1/play/?video_id=${uri}&ratio=720p&line=0`
    : rawPlayUrl;

  const resolvedCdnUrl = await resolveRedirectUrl(
    rawPlayUrl || snssdk1080,
    { 'User-Agent': MOBILE_UA },
    3
  );

  const variants = [
    {
      label: '原画无损无水印 (Original Lossless)',
      quality: `${width}x${height} · 最高码率`,
      url: resolvedCdnUrl || snssdk1080,
      ext: 'mp4',
      isBest: true,
    },
  ];

  if (snssdk1080 && snssdk1080 !== resolvedCdnUrl) {
    variants.push({
      label: '1080P 官方直链源 (备用线路)',
      quality: '1080P Full HD',
      url: snssdk1080,
      ext: 'mp4',
    });
  }
  if (snssdk720) {
    variants.push({
      label: '720P 高清省流',
      quality: '720P HD',
      url: snssdk720,
      ext: 'mp4',
    });
  }

  return {
    platform: 'douyin',
    platformName: '抖音 (Douyin)',
    id: awemeId,
    type: 'video',
    title: desc,
    author,
    cover,
    musicUrl,
    stats,
    mediaItems: [
      {
        index: 1,
        type: 'video',
        url: resolvedCdnUrl || snssdk1080,
        thumbnail: cover,
        width,
        height,
        duration: video.duration ? Math.round(video.duration / 1000) : 0,
        variants,
      },
    ],
  };
}

/**
 * TikWM API parser for TikTok & Douyin (with automatic rate-limit backoff)
 */
async function parseViaTikwm(inputUrl, platformLabel = 'tiktok', awemeId = null) {
  const candidates = [inputUrl];
  if (platformLabel === 'douyin' && awemeId) {
    candidates.push(`https://www.douyin.com/video/${awemeId}`);
  }

  let lastMsg = '';
  for (const candidateUrl of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(
        candidateUrl
      )}&hd=1`;
      const res = await fetch(apiUrl, {
        headers: {
          'User-Agent': DESKTOP_UA,
          Accept: 'application/json',
        },
      });
      const json = await res.json();

      if (json && json.code === 0 && json.data) {
        return formatTikwmData(json.data, platformLabel);
      }

      lastMsg = json?.msg || '';
      if (/limit/i.test(lastMsg) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1150));
        continue;
      }
      break;
    }
  }

  throw new Error(
    platformLabel === 'tiktok'
      ? `无法解析该 TikTok 链接 (${lastMsg || '请检查链接是否有效'})`
      : `无法解析该抖音链接 (${lastMsg || '请确认链接有效且作品未设为私密'})`
  );
}

function formatTikwmData(d, platformLabel) {
  const author = {
    name: d.author?.nickname || '创作者',
    username: d.author?.unique_id ? `@${d.author.unique_id}` : '',
    avatar: d.author?.avatar || '',
  };
  const stats = {
    likes: d.digg_count || 0,
    comments: d.comment_count || 0,
    shares: d.share_count || 0,
    collects: d.collect_count || 0,
  };

  if (Array.isArray(d.images) && d.images.length > 0) {
    const mediaItems = d.images.map((imgUrl, idx) => ({
      index: idx + 1,
      type: 'photo',
      url: imgUrl,
      thumbnail: imgUrl,
      variants: [
        {
          label: '无损无水印原图 (Lossless Image)',
          quality: 'Original HD JPG',
          url: imgUrl,
          ext: 'jpg',
          isBest: true,
        },
      ],
    }));

    return {
      platform: platformLabel,
      platformName: platformLabel === 'tiktok' ? 'TikTok' : '抖音 (Douyin)',
      id: d.id || String(Date.now()),
      type: 'gallery',
      title: d.title || '无水印图集作品',
      author,
      cover: d.origin_cover || d.cover || d.images[0],
      musicUrl: d.music || d.music_info?.play || '',
      stats,
      mediaItems,
    };
  }

  const hdUrl = d.hdplay || d.play;
  const playUrl = d.play || hdUrl;
  const variants = [];
  if (d.hdplay) {
    variants.push({
      label: '原画无损无水印 (HD Lossless)',
      quality: d.hd_size
        ? `原画 · ${(d.hd_size / 1024 / 1024).toFixed(1)} MB`
        : '1080P 原画最高码率',
      url: d.hdplay,
      ext: 'mp4',
      isBest: true,
    });
  }
  if (playUrl && playUrl !== d.hdplay) {
    variants.push({
      label: d.hdplay ? '高清无水印 (Standard HD)' : '原画无损无水印 (Lossless)',
      quality: d.size
        ? `高清 · ${(d.size / 1024 / 1024).toFixed(1)} MB`
        : '高清无水印',
      url: playUrl,
      ext: 'mp4',
      isBest: !d.hdplay,
    });
  }

  return {
    platform: platformLabel,
    platformName: platformLabel === 'tiktok' ? 'TikTok' : '抖音 (Douyin)',
    id: d.id || String(Date.now()),
    type: 'video',
    title: d.title || '无水印视频作品',
    author,
    cover: d.origin_cover || d.cover || '',
    musicUrl: d.music || d.music_info?.play || '',
    stats,
    mediaItems: [
      {
        index: 1,
        type: 'video',
        url: hdUrl,
        thumbnail: d.origin_cover || d.cover || '',
        duration: d.duration || 0,
        variants,
      },
    ],
  };
}

/* ==========================================================================
   2. 小红书 (XIAOHONGSHU / RED) PARSER - 无水印视频 / PNG原图 / 实况 LivePhoto
   ========================================================================== */

function toLosslessXhsImage(rawUrl, explicitTraceId = '') {
  if (explicitTraceId) {
    return {
      png: `https://ci.xiaohongshu.com/${explicitTraceId}?imageView2/2/w/format/png`,
      jpg: `https://ci.xiaohongshu.com/${explicitTraceId}?imageView2/2/w/format/jpg`,
      raw: rawUrl ? rawUrl.replace(/^http:\/\//i, 'https://') : '',
    };
  }
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { png: '', jpg: '', raw: '' };
  }
  const httpsUrl = rawUrl.replace(/^http:\/\//i, 'https://');
  try {
    const u = new URL(httpsUrl);
    let cleanPath = u.pathname.split('!')[0];
    const parts = cleanPath.split('/').filter(Boolean);
    let token = '';
    if (
      parts.length >= 3 &&
      (parts.includes('notes_pre_post') || parts.includes('spectrum'))
    ) {
      const idx = parts.findIndex(
        (p) => p === 'notes_pre_post' || p === 'spectrum'
      );
      token = parts.slice(idx).join('/');
    } else if (parts.length >= 3) {
      token = parts.slice(2).join('/');
    } else if (parts.length >= 1) {
      token = parts[parts.length - 1];
    }
    if (token) {
      return {
        png: `https://ci.xiaohongshu.com/${token}?imageView2/2/w/format/png`,
        jpg: `https://ci.xiaohongshu.com/${token}?imageView2/2/w/format/jpg`,
        raw: httpsUrl,
      };
    }
  } catch (_) {}
  return { png: httpsUrl, jpg: httpsUrl, raw: httpsUrl };
}

function extractXhsNoteFromHtml(htmlText, noteId) {
  if (!htmlText || typeof htmlText !== 'string') return null;
  const stateMatch = htmlText.match(
    /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/
  );
  if (!stateMatch || !stateMatch[1]) return null;

  let state = null;
  try {
    state = vm.runInNewContext(`(${stateMatch[1]})`, Object.create(null), {
      timeout: 1000,
    });
  } catch (_) {
    try {
      const sanitized = stateMatch[1]
        .replace(/:\s*undefined\b/g, ':null')
        .replace(/\bundefined\b/g, 'null');
      state = JSON.parse(sanitized);
    } catch (_) {}
  }

  if (!state || typeof state !== 'object') return null;

  const candidates = [];
  if (state.note?.noteDetailMap?.[noteId]?.note) {
    candidates.push(state.note.noteDetailMap[noteId].note);
  }
  if (state.note?.noteDetailMap) {
    for (const entry of Object.values(state.note.noteDetailMap)) {
      if (entry?.note) candidates.push(entry.note);
    }
  }
  if (state.noteData?.data?.noteData) {
    candidates.push(state.noteData.data.noteData);
  }
  if (state.noteData?.normalNotePreloadData) {
    candidates.push(state.noteData.normalNotePreloadData);
  }
  if (state.note?.note) {
    candidates.push(state.note.note);
  }

  for (const c of candidates) {
    const imgs = c.imageList || c.imagesList;
    if ((Array.isArray(imgs) && imgs.length > 0) || c.video) {
      if (!c.imageList && Array.isArray(c.imagesList)) {
        c.imageList = c.imagesList;
      }
      return c;
    }
  }
  return null;
}

function hasXhsLiveStream(note) {
  if (!note) return false;
  const imgs = note.imageList || note.imagesList || [];
  return imgs.some(
    (img) =>
      img?.livePhoto ||
      img?.stream?.h264?.length ||
      img?.stream?.h265?.length ||
      img?.stream?.av1?.length ||
      img?.originVideoKey
  );
}

async function parseXiaohongshu(inputUrl) {
  let resolvedUrl = inputUrl;
  if (
    inputUrl.includes('xhslink.com') ||
    inputUrl.includes('xhslink.cn') ||
    !inputUrl.includes('xiaohongshu.com')
  ) {
    resolvedUrl = await resolveRedirectUrl(inputUrl, {
      'User-Agent': MOBILE_UA,
    });
  }

  const idMatch = resolvedUrl.match(
    /(?:\/explore\/|\/discovery\/item\/|\/item\/)([0-9a-fA-F]{24})/
  );
  const noteId = idMatch ? idMatch[1] : String(Date.now());

  let html = '';
  let bestNote = null;

  try {
    const xhsHost = new URL(resolvedUrl).hostname;
    const realIps = await resolveChinaDomesticIps(xhsHost);
    if (realIps.length > 0) {
      for (const ua of [DESKTOP_UA, MOBILE_UA]) {
        const directText = await runCurl([
          '-s',
          '-L',
          '--max-time',
          '8',
          '--interface',
          'en0',
          '--resolve',
          `${xhsHost}:443:${realIps[0]}`,
          '-H',
          `User-Agent: ${ua}`,
          '-H',
          'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
          '-H',
          'Referer: https://www.xiaohongshu.com/',
          resolvedUrl,
        ]).catch(() => '');
        if (
          directText.includes('__INITIAL_STATE__') ||
          directText.includes('og:image') ||
          directText.includes('og:video')
        ) {
          if (!html) html = directText;
          const extracted = extractXhsNoteFromHtml(directText, noteId);
          if (extracted) {
            if (!bestNote || hasXhsLiveStream(extracted)) {
              bestNote = extracted;
              html = directText;
            }
            if (hasXhsLiveStream(extracted) || extracted.video) {
              break;
            }
          }
        }
      }
    }
  } catch (_) {}

  if (!bestNote) {
    for (const ua of [DESKTOP_UA, MOBILE_UA]) {
      try {
        const res = await fetch(resolvedUrl, {
          headers: {
            'User-Agent': ua,
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            Referer: 'https://www.xiaohongshu.com/',
          },
        });
        const text = await res.text();
        if (
          text.includes('__INITIAL_STATE__') ||
          text.includes('og:image') ||
          text.includes('og:video')
        ) {
          if (!html) html = text;
          const extracted = extractXhsNoteFromHtml(text, noteId);
          if (extracted) {
            if (!bestNote || hasXhsLiveStream(extracted)) {
              bestNote = extracted;
              html = text;
            }
            if (hasXhsLiveStream(extracted) || extracted.video) {
              break;
            }
          }
        }
      } catch (_) {}
    }
  }

  if (!html && !bestNote) {
    throw new Error('无法连接小红书页面，请检查分享链接是否有效');
  }

  if (!bestNote && html) {
    bestNote = extractXhsNoteFromHtml(html, noteId);
  }

  if (bestNote && (bestNote.imageList?.length || bestNote.video)) {
    return formatXhsNote(bestNote, noteId);
  }

  const ogImages = [
    ...html.matchAll(
      /<meta[^>]+(?:name|property)=["']og:image["'][^>]+content=["']([^"']+)["']/gi
    ),
  ].map((m) => m[1]);
  const ogVideos = [
    ...html.matchAll(
      /<meta[^>]+(?:name|property)=["']og:video["'][^>]+content=["']([^"']+)["']/gi
    ),
  ].map((m) => m[1]);
  const ogTitle =
    decodeHtmlEntities(
      html.match(
        /<meta[^>]+(?:name|property)=["']og:title["'][^>]+content=["']([^"']+)["']/i
      )?.[1] || ''
    ).replace(/\s*-\s*小红书$/, '') || '小红书无水印作品';
  const desc = decodeHtmlEntities(
    html.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
    )?.[1] || ''
  );

  if (ogVideos.length > 0) {
    const videoUrl = ogVideos[0].replace(/^http:\/\//i, 'https://');
    const coverUrl = ogImages[0] ? toLosslessXhsImage(ogImages[0]).jpg : '';
    return {
      platform: 'xiaohongshu',
      platformName: '小红书 (RED)',
      id: noteId,
      type: 'video',
      title: desc ? `${ogTitle}\n${desc}` : ogTitle,
      author: { name: '小红书创作者', username: '', avatar: '' },
      cover: coverUrl,
      mediaItems: [
        {
          index: 1,
          type: 'video',
          url: videoUrl,
          thumbnail: coverUrl,
          variants: [
            {
              label: '无损无水印原画视频 (Lossless MP4)',
              quality: 'Original HD Stream',
              url: videoUrl,
              ext: 'mp4',
              isBest: true,
            },
          ],
        },
      ],
    };
  }

  if (ogImages.length > 0) {
    const mediaItems = ogImages.map((rawImg, idx) => {
      const lossless = toLosslessXhsImage(rawImg);
      return {
        index: idx + 1,
        type: 'photo',
        url: lossless.png || lossless.raw,
        thumbnail: lossless.jpg || lossless.raw,
        variants: [
          {
            label: '无损未压缩 PNG 原图 (无水印)',
            quality: 'Lossless PNG · 0 压缩',
            url: lossless.png || lossless.raw,
            ext: 'png',
            isBest: true,
          },
          {
            label: '无损高清 JPG 原图 (无水印)',
            quality: 'Original JPG',
            url: lossless.jpg || lossless.raw,
            ext: 'jpg',
          },
        ],
      };
    });

    return {
      platform: 'xiaohongshu',
      platformName: '小红书 (RED)',
      id: noteId,
      type: 'gallery',
      title: desc ? `${ogTitle}\n${desc}` : ogTitle,
      author: { name: '小红书创作者', username: '', avatar: '' },
      cover: mediaItems[0]?.thumbnail || '',
      mediaItems,
    };
  }

  throw new Error(
    '未能从该小红书链接提取到媒体。提示：请直接从【小红书 App -> 分享 -> 复制链接】粘贴带有 xsec_token 的分享口令或 xhslink.com 短链'
  );
}

function formatXhsNote(note, fallbackId) {
  const noteId = note.noteId || note.id || fallbackId;
  const user = note.user || {};
  const author = {
    name: user.nickname || user.nickName || '小红书创作者',
    username: user.redId ? `小红书号: ${user.redId}` : '',
    avatar: (user.avatar || user.images || '').replace(
      /^http:\/\//i,
      'https://'
    ),
  };
  const titleText =
    [note.title, note.desc].filter(Boolean).join('\n').trim() ||
    '小红书无水印笔记';
  const isVideo =
    note.type === 'video' || Boolean(note.video?.media || note.video?.consumer);

  if (isVideo && note.video) {
    const originKey =
      note.video?.consumer?.originVideoKey ||
      note.video?.originVideoKey ||
      '';
    const streams = [
      ...(note.video?.media?.stream?.h264 || []),
      ...(note.video?.media?.stream?.h265 || []),
      ...(note.video?.media?.stream?.av1 || []),
    ].sort(
      (a, b) => (b.videoBitrate || b.size || 0) - (a.videoBitrate || a.size || 0)
    );

    const variants = [];
    if (originKey) {
      variants.push({
        label: '母带级无水印原片 (Origin Master)',
        quality: '原始上传无损流 · 0 水印',
        url: `https://sns-video-bd.xhscdn.com/${originKey}`,
        ext: 'mp4',
        isBest: true,
      });
    }

    streams.forEach((s, idx) => {
      const streamUrl = (s.masterUrl || s.backupUrls?.[0] || '').replace(
        /^http:\/\//i,
        'https://'
      );
      if (!streamUrl) return;
      const resLabel =
        s.width && s.height ? `${s.width}x${s.height}` : s.qualityType || 'HD';
      const sizeMb = s.size ? ` · ${(s.size / 1024 / 1024).toFixed(1)} MB` : '';
      variants.push({
        label:
          variants.length === 0
            ? '最高码率无水印原画 (Lossless Best)'
            : `高清视频流 #${idx + 1} (${s.streamDesc || resLabel})`,
        quality: `${resLabel}${sizeMb}`,
        url: streamUrl,
        ext: 'mp4',
        isBest: variants.length === 0,
      });
    });

    const firstImg = note.imageList?.[0];
    const coverLossless = firstImg
      ? toLosslessXhsImage(
          firstImg.urlDefault || firstImg.urlPre || firstImg.url,
          firstImg.traceId
        )
      : { jpg: '' };

    const bestVideoUrl = variants[0]?.url || '';
    return {
      platform: 'xiaohongshu',
      platformName: '小红书 (RED)',
      id: noteId,
      type: 'video',
      title: titleText,
      author,
      cover: coverLossless.jpg || coverLossless.raw || '',
      mediaItems: [
        {
          index: 1,
          type: 'video',
          url: bestVideoUrl,
          thumbnail: coverLossless.jpg || coverLossless.raw || '',
          width: streams[0]?.width || 0,
          height: streams[0]?.height || 0,
          variants,
        },
      ],
    };
  }

  const imageList = note.imageList || [];
  const mediaItems = imageList.map((img, idx) => {
    const rawUrl =
      img.urlDefault ||
      img.urlPre ||
      img.url ||
      img.infoList?.[img.infoList.length - 1]?.url ||
      '';
    const lossless = toLosslessXhsImage(rawUrl, img.traceId);

    const streamObj =
      img.stream?.h264?.[0] ||
      img.stream?.h265?.[0] ||
      img.stream?.av1?.[0] ||
      null;
    const rawStreamUrl =
      streamObj?.backupUrls?.[0] ||
      streamObj?.masterUrl ||
      (img.originVideoKey
        ? `https://sns-video-bd.xhscdn.com/${img.originVideoKey}`
        : '') ||
      '';
    const liveVideoUrl = rawStreamUrl
      ? rawStreamUrl
          .replace(/^http:\/\//i, 'https://')
          .replace('://sns-video-v6.xhscdn.com/', '://sns-video-bd.xhscdn.com/')
      : null;

    const variants = [];

    if (liveVideoUrl) {
      const hasAudioTrack =
        streamObj &&
        (Number(streamObj.audioChannels) > 0 ||
          Number(streamObj.audioBitrate) > 0);
      const audioDesc =
        streamObj &&
        streamObj.audioChannels === 0 &&
        streamObj.audioBitrate === 0
          ? '原生实况视频流 (注：原作者发布该笔记时关闭了原声)'
          : '小红书原生实况动态视频流 · 含原声音轨';
      variants.push(
        {
          label: '🔊 实况带声音动态原片 (Live Photo MP4)',
          quality: audioDesc,
          url: liveVideoUrl,
          ext: 'mp4',
          isBest: true,
          isLiveVideo: true,
          hasAudioTrack,
        },
        {
          label: '🍎 实况带声音原片 (MOV 苹果相册格式)',
          quality: `iOS 相册兼容实况视频 · ${audioDesc}`,
          url: liveVideoUrl,
          ext: 'mov',
          isLiveVideo: true,
          hasAudioTrack,
        }
      );
    }

    variants.push(
      {
        label: liveVideoUrl
          ? '🖼️ 实况无损静态原图 (PNG 0压缩)'
          : '无损未压缩 PNG 原图 (无水印)',
        quality: `${img.width || 'HD'}x${img.height || 'HD'} · PNG 无损`,
        url: lossless.png || lossless.raw,
        ext: 'png',
        isBest: !liveVideoUrl,
      },
      {
        label: liveVideoUrl
          ? '🖼️ 实况高清静态原图 (JPG 无水印)'
          : '无损高清 JPG 原图 (无水印)',
        quality: `${img.width || 'HD'}x${img.height || 'HD'} · JPG 原图`,
        url: lossless.jpg || lossless.raw,
        ext: 'jpg',
      }
    );

    return {
      index: idx + 1,
      type: liveVideoUrl ? 'livephoto' : 'photo',
      url: lossless.png || lossless.raw,
      thumbnail: lossless.jpg || lossless.raw,
      width: img.width || 0,
      height: img.height || 0,
      liveVideoUrl,
      variants,
    };
  });

  const hasLive = mediaItems.some((m) => m.type === 'livephoto');
  return {
    platform: 'xiaohongshu',
    platformName: '小红书 (RED)',
    id: noteId,
    type: hasLive ? 'livephoto' : 'gallery',
    title: titleText,
    author,
    cover: mediaItems[0]?.thumbnail || '',
    mediaItems,
  };
}

/* ==========================================================================
   3. X (TWITTER) PARSER - 最高码率 MP4 视频 / :orig 未压缩原图
   ========================================================================== */

function toOrigTwitterPhoto(rawUrl) {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    if (u.hostname.includes('twimg.com')) {
      const extMatch = u.pathname.match(/\.(jpg|jpeg|png|webp)$/i);
      const format = extMatch ? extMatch[1].toLowerCase() : 'jpg';
      const cleanPath = u.pathname.replace(/\.(jpg|jpeg|png|webp)$/i, '');
      return `${u.origin}${cleanPath}?format=${format}&name=orig`;
    }
  } catch (_) {}
  return rawUrl;
}

async function parseX(inputUrl) {
  let resolvedUrl = inputUrl;
  if (inputUrl.includes('t.co/')) {
    resolvedUrl = await resolveRedirectUrl(inputUrl, {
      'User-Agent': DESKTOP_UA,
    });
  }

  const statusMatch = resolvedUrl.match(/\/status(?:es)?\/(\d{5,25})/i);
  if (!statusMatch) {
    throw new Error(
      '未检测到有效的 X (Twitter) 推文链接，请确保链接包含 /status/推文ID'
    );
  }
  const statusId = statusMatch[1];

  try {
    const fxRes = await fetch(`https://api.fxtwitter.com/i/status/${statusId}`, {
      headers: {
        'User-Agent': 'PureSaveMediaExtractor/2.0',
        Accept: 'application/json',
      },
    });
    if (fxRes.ok) {
      const fxData = await fxRes.json();
      if (fxData?.tweet) {
        return formatFxTwitterTweet(fxData.tweet, statusId);
      }
    }
  } catch (err) {
    console.warn('fxtwitter engine failed, trying vxtwitter:', err.message);
  }

  try {
    const vxRes = await fetch(
      `https://api.vxtwitter.com/Twitter/status/${statusId}`,
      {
        headers: {
          'User-Agent': 'PureSaveMediaExtractor/2.0',
          Accept: 'application/json',
        },
      }
    );
    if (vxRes.ok) {
      const vxData = await vxRes.json();
      if (vxData?.media_extended) {
        return formatVxTwitterTweet(vxData, statusId);
      }
    }
  } catch (err) {
    console.warn('vxtwitter engine failed:', err.message);
  }

  throw new Error(
    '无法获取该 X (Twitter) 推文媒体，请检查推文是否公开且包含视频/图片/GIF'
  );
}

function formatFxTwitterTweet(tweet, statusId) {
  const allMedia = tweet.media?.all || [
    ...(tweet.media?.videos || []),
    ...(tweet.media?.photos || []),
  ];

  if (!allMedia || allMedia.length === 0) {
    throw new Error('该条 X (Twitter) 推文中不包含可下载的视频或图片媒体');
  }

  const author = {
    name: tweet.author?.name || 'X User',
    username: tweet.author?.screen_name ? `@${tweet.author.screen_name}` : '',
    avatar: tweet.author?.avatar_url || '',
  };

  const stats = {
    likes: tweet.likes || 0,
    comments: tweet.replies || 0,
    shares: tweet.retweets || 0,
    views: tweet.views || 0,
  };

  const mediaItems = allMedia.map((m, idx) => {
    if (m.type === 'video' || m.type === 'gif') {
      const rawVariants = Array.isArray(m.variants)
        ? m.variants
        : Array.isArray(m.formats)
        ? m.formats
        : [];
      const mp4Variants = rawVariants
        .filter(
          (v) =>
            v.url &&
            (!v.content_type ||
              v.content_type === 'video/mp4' ||
              v.url.includes('.mp4'))
        )
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      const variants =
        mp4Variants.length > 0
          ? mp4Variants.map((v, vIdx) => {
              const resMatch = v.url.match(/\/(\d+x\d+)\//);
              const resolution = resMatch
                ? resMatch[1]
                : vIdx === 0 && m.width && m.height
                ? `${m.width}x${m.height}`
                : 'MP4';
              const mbps = v.bitrate
                ? `${(v.bitrate / 1000000).toFixed(2)} Mbps`
                : '原画直链';
              return {
                label:
                  vIdx === 0
                    ? m.type === 'gif'
                      ? '原画无损 GIF 转 MP4'
                      : '最高码率无损原画 (Lossless Best)'
                    : `高清视频流 #${vIdx + 1}`,
                quality: `${resolution} · ${mbps}`,
                bitrate: v.bitrate || 0,
                url: v.url,
                ext: 'mp4',
                isBest: vIdx === 0,
              };
            })
          : [
              {
                label: '最高码率无损原画 (Lossless Best)',
                quality:
                  m.width && m.height
                    ? `${m.width}x${m.height} · 原画`
                    : 'Original MP4',
                url: m.url,
                ext: 'mp4',
                isBest: true,
              },
            ];

      const bestUrl = variants[0]?.url || m.url;

      return {
        index: idx + 1,
        type: m.type === 'gif' ? 'gif' : 'video',
        url: bestUrl,
        thumbnail: m.thumbnail_url || '',
        width: m.width || 0,
        height: m.height || 0,
        duration: m.duration ? Math.round(m.duration) : 0,
        variants,
      };
    } else {
      const origUrl = toOrigTwitterPhoto(m.url);
      return {
        index: idx + 1,
        type: 'photo',
        url: origUrl,
        thumbnail: m.url,
        width: m.width || 0,
        height: m.height || 0,
        variants: [
          {
            label: '无损未压缩原图 (:orig 最高画质)',
            quality:
              m.width && m.height
                ? `${m.width}x${m.height} · ORIG`
                : '4K / ORIG 原图',
            url: origUrl,
            ext: 'jpg',
            isBest: true,
          },
          {
            label: '标准高清图 (Standard HD)',
            quality: 'Standard JPG',
            url: m.url,
            ext: 'jpg',
          },
        ],
      };
    }
  });

  const hasVideo = mediaItems.some(
    (item) => item.type === 'video' || item.type === 'gif'
  );

  return {
    platform: 'x',
    platformName: 'X (Twitter)',
    id: statusId,
    type: mediaItems.length > 1 ? 'gallery' : hasVideo ? 'video' : 'photo',
    title: tweet.text || `X 推文 #${statusId}`,
    author,
    cover: mediaItems[0]?.thumbnail || mediaItems[0]?.url || '',
    stats,
    mediaItems,
  };
}

function formatVxTwitterTweet(vx, statusId) {
  const mediaList = vx.media_extended || [];
  if (mediaList.length === 0) {
    throw new Error('该条 X (Twitter) 推文中不包含可下载的媒体');
  }

  const author = {
    name: vx.user_name || 'X User',
    username: vx.user_screen_name ? `@${vx.user_screen_name}` : '',
    avatar: vx.user_profile_image_url || '',
  };

  const stats = {
    likes: vx.likes || 0,
    comments: vx.replies || 0,
    shares: vx.retweets || 0,
  };

  const mediaItems = mediaList.map((m, idx) => {
    const isVideo = m.type === 'video' || m.type === 'gif';
    const width = m.size?.width || 0;
    const height = m.size?.height || 0;
    const bestUrl = isVideo ? m.url : toOrigTwitterPhoto(m.url);

    return {
      index: idx + 1,
      type: isVideo ? 'video' : 'photo',
      url: bestUrl,
      thumbnail: m.thumbnail_url || m.url,
      width,
      height,
      duration: m.duration_millis ? Math.round(m.duration_millis / 1000) : 0,
      variants: [
        {
          label: isVideo
            ? '最高码率无损原画 (Lossless Best)'
            : '无损未压缩原图 (:orig 最高画质)',
          quality:
            width && height ? `${width}x${height} · 原画` : 'Original Lossless',
          url: bestUrl,
          ext: isVideo ? 'mp4' : 'jpg',
          isBest: true,
        },
      ],
    };
  });

  return {
    platform: 'x',
    platformName: 'X (Twitter)',
    id: statusId,
    type: mediaItems.length > 1 ? 'gallery' : mediaItems[0].type,
    title: vx.text || `X 推文 #${statusId}`,
    author,
    cover: mediaItems[0]?.thumbnail || '',
    stats,
    mediaItems,
  };
}

/* ==========================================================================
   4. INSTAGRAM (INS) PARSER - Reels 无水印原画视频 / 多图轮播 Carousel 原图
   ========================================================================== */

function extractInstagramShortcode(urlStr) {
  const m = urlStr.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{5,25})/i);
  return m ? m[1] : null;
}

async function parseInstagram(inputUrl) {
  let resolvedUrl = inputUrl;
  let shortcode = extractInstagramShortcode(resolvedUrl);

  if (!shortcode) {
    resolvedUrl = await resolveRedirectUrl(inputUrl, {
      'User-Agent': MOBILE_UA,
    });
    shortcode = extractInstagramShortcode(resolvedUrl);
  }

  if (!shortcode) {
    throw new Error(
      '未识别到有效的 Instagram 帖子或 Reels 链接（支持 /p/xxx 或 /reel/xxx）'
    );
  }

  let username = '';
  let caption = '';

  try {
    const metaRes = await fetch(`https://eeinstagram.com/p/${shortcode}/`, {
      headers: {
        'User-Agent': 'TelegramBot (like TwitterBot)',
      },
    });
    if (metaRes.ok) {
      const metaHtml = await metaRes.text();
      username = decodeHtmlEntities(
        metaHtml.match(
          /name=["']twitter:title["']\s+content=["']([^"']+)["']/i
        )?.[1] || ''
      );
      caption = decodeHtmlEntities(
        metaHtml.match(
          /property=["']og:description["']\s+content=["']([^"']+)["']/i
        )?.[1] || ''
      );
    }
  } catch (_) {}

  const mediaItems = [];

  for (let batchStart = 1; batchStart <= 10; batchStart += 5) {
    const indices = [
      batchStart,
      batchStart + 1,
      batchStart + 2,
      batchStart + 3,
      batchStart + 4,
    ];
    const results = await Promise.all(
      indices.map(async (idx) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 7000);
          const r = await fetch(
            `https://eeinstagram.com/videos/${shortcode}/${idx}`,
            {
              redirect: 'manual',
              headers: { 'User-Agent': 'TelegramBot (like TwitterBot)' },
              signal: controller.signal,
            }
          );
          clearTimeout(timer);
          if (r.body) {
            try {
              await r.body.cancel();
            } catch (_) {}
          }
          const loc = r.headers.get('location');
          if (
            r.status >= 300 &&
            r.status < 400 &&
            loc &&
            loc.startsWith('http')
          ) {
            return { idx, url: decodeHtmlEntities(loc) };
          }
        } catch (_) {}
        return null;
      })
    );

    let hitEnd = false;
    for (const item of results) {
      if (!item) {
        hitEnd = true;
        break;
      }
      const isVideo =
        /\.mp4(\?|$)/i.test(item.url) ||
        item.url.includes('/o1/v/') ||
        item.url.includes('/t16.') ||
        item.url.includes('/t50.');

      mediaItems.push({
        index: mediaItems.length + 1,
        type: isVideo ? 'video' : 'photo',
        url: item.url,
        thumbnail: isVideo ? '' : item.url,
        variants: [
          {
            label: isVideo
              ? 'Instagram 原画无损视频 (Lossless MP4)'
              : 'Instagram 未压缩最高画质原图 (Lossless JPG)',
            quality: isVideo
              ? 'Original Reels / Video MP4'
              : 'Full Resolution Original',
            url: item.url,
            ext: isVideo ? 'mp4' : 'jpg',
            isBest: true,
          },
        ],
      });
    }
    if (hitEnd) break;
  }

  if (mediaItems.length === 0) {
    try {
      const fbRes = await fetch(`https://www.instagram.com/p/${shortcode}/`, {
        headers: {
          'User-Agent':
            'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        },
      });
      const fbHtml = await fbRes.text();
      const ogTitle = decodeHtmlEntities(
        fbHtml.match(
          /property=["']og:title["']\s+content=["']([^"']+)["']/i
        )?.[1] || ''
      );
      if (!caption && ogTitle) caption = ogTitle;

      const ogVideo = decodeHtmlEntities(
        fbHtml.match(
          /property=["']og:video["']\s+content=["']([^"']+)["']/i
        )?.[1] || ''
      );
      const ogImage = decodeHtmlEntities(
        fbHtml.match(
          /property=["']og:image["']\s+content=["']([^"']+)["']/i
        )?.[1] || ''
      );

      if (ogVideo) {
        mediaItems.push({
          index: 1,
          type: 'video',
          url: ogVideo,
          thumbnail: ogImage,
          variants: [
            {
              label: 'Instagram 原画无水印视频 (Lossless MP4)',
              quality: 'Original HD MP4',
              url: ogVideo,
              ext: 'mp4',
              isBest: true,
            },
          ],
        });
      } else if (ogImage) {
        mediaItems.push({
          index: 1,
          type: 'photo',
          url: ogImage,
          thumbnail: ogImage,
          variants: [
            {
              label: 'Instagram 无水印高清原图 (Original JPG)',
              quality: 'Original HD JPG',
              url: ogImage,
              ext: 'jpg',
              isBest: true,
            },
          ],
        });
      }
    } catch (_) {}
  }

  if (mediaItems.length === 0) {
    throw new Error('无法提取该 Instagram 链接，请确认该帖子/Reels 为公开状态');
  }

  const hasVideo = mediaItems.some((m) => m.type === 'video');
  return {
    platform: 'instagram',
    platformName: 'Instagram',
    id: shortcode,
    type: mediaItems.length > 1 ? 'gallery' : hasVideo ? 'video' : 'photo',
    title: caption || `Instagram Post #${shortcode}`,
    author: {
      name: username ? username.replace(/^@/, '') : 'Instagram Creator',
      username: username || '',
      avatar: '',
    },
    cover: mediaItems[0]?.thumbnail || mediaItems[0]?.url || '',
    mediaItems,
  };
}

/* ==========================================================================
   5. 得物 (DEWU / POIZON) PARSER - 种草社区动态 / 商品视频 / 无水印原图 / 实况
   ========================================================================== */

function toLosslessDewuImage(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const httpsUrl = rawUrl.replace(/^http:\/\//i, 'https://');
  try {
    const u = new URL(httpsUrl);
    if (
      u.hostname.includes('poizon.com') ||
      u.hostname.includes('dewu.com') ||
      u.hostname.includes('duapp.com') ||
      u.hostname.includes('shizhuang-inc.com')
    ) {
      u.search = '';
      return u.toString();
    }
  } catch (_) {}
  return httpsUrl;
}

function collectDewuMediaFromJson(
  obj,
  collected = {
    videos: [],
    images: [],
    livePhotos: [],
    titles: [],
    authors: [],
  },
  depth = 0
) {
  if (!obj || typeof obj !== 'object' || depth > 10) return collected;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      collectDewuMediaFromJson(item, collected, depth + 1);
    }
    return collected;
  }

  if (
    (obj.nickname || obj.userName || obj.authorName) &&
    (obj.avatar || obj.headImg || obj.userHeadImg)
  ) {
    collected.authors.push({
      name: obj.nickname || obj.userName || obj.authorName,
      avatar: obj.avatar || obj.headImg || obj.userHeadImg,
    });
  }

  for (const tKey of [
    'title',
    'content',
    'desc',
    'description',
    'shareTitle',
    'topicTitle',
  ]) {
    if (typeof obj[tKey] === 'string' && obj[tKey].trim().length > 2) {
      collected.titles.push(obj[tKey].trim());
    }
  }

  const imgCandidate =
    obj.url || obj.picUrl || obj.imgUrl || obj.imageUrl || obj.originUrl;
  const liveCandidate =
    obj.liveVideoUrl ||
    obj.liveUrl ||
    obj.motionPhotoVideoUrl ||
    obj.livePhotoUrl;
  if (
    typeof imgCandidate === 'string' &&
    typeof liveCandidate === 'string' &&
    /^https?:\/\//i.test(imgCandidate) &&
    /^https?:\/\//i.test(liveCandidate)
  ) {
    collected.livePhotos.push({
      imageUrl: toLosslessDewuImage(imgCandidate),
      videoUrl: liveCandidate.replace(/^http:\/\//i, 'https://'),
      width: obj.width || 0,
      height: obj.height || 0,
    });
  }

  for (const vKey of [
    'videoUrl',
    'playUrl',
    'mp4Url',
    'vodUrl',
    'originVideoUrl',
    'highUrl',
  ]) {
    if (
      typeof obj[vKey] === 'string' &&
      /^https?:\/\/[^\s"']+\.mp4/i.test(obj[vKey])
    ) {
      collected.videos.push({
        url: obj[vKey].replace(/^http:\/\//i, 'https://'),
        cover: toLosslessDewuImage(
          obj.coverUrl || obj.cover || obj.picUrl || ''
        ),
        width: obj.width || 0,
        height: obj.height || 0,
      });
    }
  }

  for (const iKey of [
    'url',
    'picUrl',
    'imgUrl',
    'imageUrl',
    'originUrl',
    'bigImgUrl',
  ]) {
    const val = obj[iKey];
    if (
      typeof val === 'string' &&
      /^https?:\/\/[^\s"']+\.(?:jpg|jpeg|png|webp|heic)/i.test(val) &&
      (val.includes('poizon.com') ||
        val.includes('dewu.com') ||
        val.includes('duapp.com') ||
        val.includes('shizhuang-inc.com')) &&
      !val.includes('avatar') &&
      !val.includes('icon') &&
      !val.includes('logo')
    ) {
      collected.images.push(toLosslessDewuImage(val));
    }
  }

  for (const key of Object.keys(obj)) {
    collectDewuMediaFromJson(obj[key], collected, depth + 1);
  }
  return collected;
}

async function parseDewu(inputUrl) {
  const resolvedUrl = await resolveRedirectUrl(inputUrl, {
    'User-Agent': MOBILE_UA,
  });

  const res = await fetch(resolvedUrl, {
    headers: {
      'User-Agent': MOBILE_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  });
  const html = await res.text();

  const collected = {
    videos: [],
    images: [],
    livePhotos: [],
    titles: [],
    authors: [],
  };

  const jsonScripts = [
    ...html.matchAll(
      /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi
    ),
    ...html.matchAll(
      /window\.(?:__INITIAL_STATE__|_SSR_DATA|__PRELOADED_STATE__)\s*=\s*(\{[\s\S]*?\})<\/script>/gi
    ),
  ];

  for (const match of jsonScripts) {
    try {
      const cleanJson = match[1].replace(/:\s*undefined\b/g, ':null');
      const parsed = JSON.parse(cleanJson);
      collectDewuMediaFromJson(parsed, collected);
    } catch (_) {}
  }

  const ogTitle = decodeHtmlEntities(
    html.match(
      /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i
    )?.[1] ||
      html.match(/<title>([^<]+)<\/title>/i)?.[1] ||
      ''
  ).trim();
  if (ogTitle) collected.titles.unshift(ogTitle);

  const rawMp4Matches =
    html.match(
      /https?:\\?\/\\?\/[^"'\s<>]+(?:poizon\.com|dewu\.com|duapp\.com|shizhuang-inc\.com)[^"'\s<>]+\.mp4[^"'\s<>]*/gi
    ) || [];
  for (const rawMp4 of rawMp4Matches) {
    const cleanMp4 = rawMp4
      .replace(/\\\//g, '/')
      .replace(/^http:\/\//i, 'https://');
    collected.videos.push({ url: cleanMp4, cover: '' });
  }

  const rawImgMatches =
    html.match(
      /https?:\\?\/\\?\/[^"'\s<>]+(?:poizon\.com|dewu\.com|duapp\.com|shizhuang-inc\.com)[^"'\s<>]+\.(?:jpg|jpeg|png|webp)/gi
    ) || [];
  for (const rawImg of rawImgMatches) {
    const cleanImg = rawImg.replace(/\\\//g, '/');
    if (!/avatar|icon|logo|default|placeholder/i.test(cleanImg)) {
      collected.images.push(toLosslessDewuImage(cleanImg));
    }
  }

  const mediaItems = [];
  const seenUrls = new Set();

  for (const lp of collected.livePhotos) {
    if (seenUrls.has(lp.imageUrl)) continue;
    seenUrls.add(lp.imageUrl);
    seenUrls.add(lp.videoUrl);
    mediaItems.push({
      index: mediaItems.length + 1,
      type: 'livephoto',
      url: lp.imageUrl,
      thumbnail: lp.imageUrl,
      width: lp.width,
      height: lp.height,
      liveVideoUrl: lp.videoUrl,
      variants: [
        {
          label: '得物实况无损静态原图 (Lossless Image)',
          quality: '去除 OSS 缩略与水印参数 · 原图',
          url: lp.imageUrl,
          ext: 'jpg',
          isBest: true,
        },
        {
          label: '得物实况动态视频 (Live Photo MP4)',
          quality: '原画动态视频流',
          url: lp.videoUrl,
          ext: 'mp4',
          isLiveVideo: true,
        },
      ],
    });
  }

  const cleanDewuVideos = collected.videos.filter(
    (v) => !/\/algorithm\/wm\/|watermark_/i.test(v.url)
  );
  const videosToUse =
    cleanDewuVideos.length > 0 ? cleanDewuVideos : collected.videos;

  for (const vid of videosToUse) {
    if (seenUrls.has(vid.url)) continue;
    seenUrls.add(vid.url);
    mediaItems.push({
      index: mediaItems.length + 1,
      type: 'video',
      url: vid.url,
      thumbnail: vid.cover || collected.images[0] || '',
      variants: [
        {
          label: '得物无水印原画视频 (Lossless MP4)',
          quality: 'Original CDN Master Stream',
          url: vid.url,
          ext: 'mp4',
          isBest: true,
        },
      ],
    });
  }

  const seenImagePaths = new Set();
  for (const imgUrl of collected.images) {
    let imgPathKey = imgUrl;
    try {
      imgPathKey = new URL(imgUrl).pathname;
    } catch (_) {}
    if (seenUrls.has(imgUrl) || seenImagePaths.has(imgPathKey)) continue;
    seenUrls.add(imgUrl);
    seenImagePaths.add(imgPathKey);
    const extMatch = imgUrl.match(/\.(png|jpg|jpeg|webp)$/i);
    const ext = extMatch
      ? extMatch[1].toLowerCase().replace('jpeg', 'jpg')
      : 'jpg';
    mediaItems.push({
      index: mediaItems.length + 1,
      type: 'photo',
      url: imgUrl,
      thumbnail: imgUrl,
      variants: [
        {
          label: '得物无损未压缩原图 (去水印参数)',
          quality: `Original ${ext.toUpperCase()} · 0 水印`,
          url: imgUrl,
          ext,
          isBest: true,
        },
      ],
    });
  }

  if (mediaItems.length === 0) {
    throw new Error(
      '未能从该得物链接中解析出视频或图片，请确认粘贴的是得物社区动态或商品详情分享链接（如 https://dw4.co/... 或 https://m.dewu.com/...）'
    );
  }

  const author = collected.authors[0] || {
    name: '得物 (Poizon)',
    username: '得物 App 创作者',
    avatar: '',
  };
  const title = collected.titles[0] || '得物 (Poizon) 无水印素材';
  const hasLive = mediaItems.some((m) => m.type === 'livephoto');
  const hasVideo = mediaItems.some((m) => m.type === 'video');

  return {
    platform: 'dewu',
    platformName: '得物 (Poizon)',
    id: String(Date.now()),
    type: hasLive
      ? 'livephoto'
      : mediaItems.length > 1
      ? 'gallery'
      : hasVideo
      ? 'video'
      : 'photo',
    title,
    author,
    cover: mediaItems[0]?.thumbnail || mediaItems[0]?.url || '',
    mediaItems,
  };
}

/**
 * Fetch JSON from domestic China API via en0 direct interface (bypasses TUN/VPN 412 blocks)
 */
async function fetchDomesticJson(url, headers = {}) {
  const u = new URL(url);
  const realIps = await resolveChinaDomesticIps(u.hostname);
  const args = [
    '-s',
    '--max-time',
    '10',
    '-H',
    `User-Agent: ${DESKTOP_UA}`,
    '-H',
    'Referer: https://www.bilibili.com/',
  ];
  if (realIps.length > 0) {
    args.push('--interface', 'en0', '--resolve', `${u.hostname}:443:${realIps[0]}`);
  }
  for (const [k, v] of Object.entries(headers)) {
    if (v) args.push('-H', `${k}: ${v}`);
  }
  args.push(url);
  const raw = await runCurl(args);
  return JSON.parse(raw);
}

/**
 * Bilibili (哔哩哔哩) Parser — supports b23.tv short links, BV & av URLs, and multi-part ?p=N
 */
async function parseBilibili(targetUrl) {
  let resolvedUrl = targetUrl;
  if (/b23\.tv|bili2233\.cn/i.test(resolvedUrl) || !/(BV[a-zA-Z0-9]{10}|av\d+)/i.test(resolvedUrl)) {
    resolvedUrl = await resolveRedirectUrl(resolvedUrl, { 'User-Agent': DESKTOP_UA });
  }

  const bvMatch = resolvedUrl.match(/(BV[a-zA-Z0-9]{10})/i);
  const avMatch = resolvedUrl.match(/\/av(\d+)/i);
  if (!bvMatch && !avMatch) {
    throw new Error('未识别到有效的 B站 视频 BV/AV 号，请确认粘贴的是哔哩哔哩视频链接');
  }

  let pageNum = 1;
  try {
    const pParam = Number(new URL(resolvedUrl).searchParams.get('p') || '1');
    if (Number.isFinite(pParam) && pParam >= 1) pageNum = Math.floor(pParam);
  } catch (_) {}

  let cookie = '';
  try {
    const spiRes = await fetchDomesticJson('https://api.bilibili.com/x/frontend/finger/spi');
    if (spiRes?.data?.b_3) {
      cookie = `buvid3=${spiRes.data.b_3}; buvid4=${spiRes.data.b_4 || ''}`;
    }
  } catch (_) {}

  const viewQuery = bvMatch ? `bvid=${bvMatch[1]}` : `aid=${avMatch[1]}`;
  const viewRes = await fetchDomesticJson(
    `https://api.bilibili.com/x/web-interface/view?${viewQuery}`,
    cookie ? { Cookie: cookie } : {}
  );

  if (viewRes?.code !== 0 || !viewRes?.data) {
    throw new Error(`B站接口解析失败: ${viewRes?.message || '视频不存在或需要登录'}`);
  }

  const info = viewRes.data;
  const pages = Array.isArray(info.pages) ? info.pages : [];
  const targetPage = pages[pageNum - 1] || pages[0];
  const cid = targetPage?.cid || info.cid;
  const title =
    pages.length > 1 && targetPage?.part
      ? `${info.title} - P${pageNum} ${targetPage.part}`
      : info.title || '哔哩哔哩无水印视频';
  const cover = (info.pic || '').replace(/^http:\/\//i, 'https://');
  const author = {
    name: info.owner?.name || 'B站 UP主',
    username: info.owner?.mid ? `UID: ${info.owner.mid}` : '哔哩哔哩',
    avatar: (info.owner?.face || '').replace(/^http:\/\//i, 'https://'),
  };

  let playRes = await fetchDomesticJson(
    `https://api.bilibili.com/x/player/playurl?bvid=${info.bvid}&cid=${cid}&qn=80&fnval=1&otype=json`,
    cookie ? { Cookie: cookie } : {}
  ).catch(() => null);

  if (!playRes?.data?.durl?.length) {
    playRes = await fetchDomesticJson(
      `https://api.bilibili.com/x/player/playurl?bvid=${info.bvid}&cid=${cid}&qn=80&fnval=1&platform=html5&high_quality=1`,
      cookie ? { Cookie: cookie } : {}
    ).catch(() => null);
  }

  const durl = playRes?.data?.durl;
  if (!Array.isArray(durl) || durl.length === 0 || !durl[0]?.url) {
    throw new Error('未能获取到 B站 视频播放流地址，请稍后重试');
  }

  const allStreamCandidates = [
    durl[0].url,
    ...(Array.isArray(durl[0].backup_url) ? durl[0].backup_url : []),
  ].filter(Boolean);
  const videoUrl =
    allStreamCandidates.find((u) => /bilivideo\.(com|cn)/i.test(u)) ||
    allStreamCandidates[0];
  const qualityNum = Number(playRes?.data?.quality || 64);
  const qualityLabel = qualityNum >= 80 ? '1080P 高清 · MP4' : qualityNum >= 64 ? '720P 高清 · MP4' : 'MP4 原画视频';

  return {
    platform: 'bilibili',
    platformName: '哔哩哔哩 (Bilibili)',
    id: info.bvid || String(info.aid),
    type: 'video',
    title,
    author,
    cover,
    mediaItems: [
      {
        index: 1,
        type: 'video',
        url: videoUrl,
        thumbnail: cover,
        variants: [
          {
            label: 'B站无水印原画视频 (MP4)',
            quality: qualityLabel,
            url: videoUrl,
            ext: 'mp4',
            isBest: true,
          },
        ],
      },
    ],
  };
}

/* ==========================================================================
   6. STREAM PROXY FOR ANTI-HOTLINKING & DIRECT MOBILE DOWNLOAD
   ========================================================================== */

function getRefererForHost(hostname) {
  const h = (hostname || '').toLowerCase();
  if (
    h.includes('douyin') ||
    h.includes('snssdk') ||
    h.includes('byte') ||
    h.includes('amemv') ||
    h.includes('tikwm') ||
    h.includes('tiktok')
  ) {
    return { referer: 'https://www.douyin.com/', ua: MOBILE_UA };
  }
  if (h.includes('xhscdn') || h.includes('xiaohongshu')) {
    return { referer: 'https://www.xiaohongshu.com/', ua: DESKTOP_UA };
  }
  if (
    h.includes('cdninstagram') ||
    h.includes('fbcdn') ||
    h.includes('instagram')
  ) {
    return { referer: 'https://www.instagram.com/', ua: DESKTOP_UA };
  }
  if (
    h.includes('poizon') ||
    h.includes('dewu') ||
    h.includes('duapp') ||
    h.includes('shizhuang-inc')
  ) {
    return { referer: 'https://www.dewu.com/', ua: MOBILE_UA };
  }
  if (
    h.includes('bilibili') ||
    h.includes('bilivideo') ||
    h.includes('hdslb') ||
    h.includes('biliapi') ||
    h.includes('akamaized')
  ) {
    return { referer: 'https://www.bilibili.com/', ua: DESKTOP_UA };
  }
  return { referer: 'https://x.com/', ua: DESKTOP_UA };
}

function handleProxyStream(req, res, queryUrl) {
  const targetUrl = queryUrl.searchParams.get('url');
  const filename = queryUrl.searchParams.get('filename') || 'puresave-media.mp4';
  const disposition = queryUrl.searchParams.get('disposition') || 'attachment';

  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '无效的媒体地址' }));
    return;
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '媒体 URL 格式错误' }));
    return;
  }

  const { referer, ua } = getRefererForHost(parsedTarget.hostname);
  const requestHeaders = {
    'User-Agent': ua,
    Accept: '*/*',
    Referer: referer,
  };

  if (req.headers.range) {
    requestHeaders.Range = req.headers.range;
  }

  const sendResponseHeaders = (statusCode, upstreamHeaders) => {
    const safeFilename = filename.replace(/[^\w.\-_]/g, '_');
    const encodedFilename = encodeURIComponent(filename);

    const responseHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type':
        upstreamHeaders['content-type'] || 'application/octet-stream',
      'Accept-Ranges': upstreamHeaders['accept-ranges'] || 'bytes',
    };

    if (upstreamHeaders['content-length']) {
      responseHeaders['Content-Length'] = upstreamHeaders['content-length'];
    }
    if (upstreamHeaders['content-range']) {
      responseHeaders['Content-Range'] = upstreamHeaders['content-range'];
    }

    if (disposition === 'attachment') {
      responseHeaders[
        'Content-Disposition'
      ] = `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`;
    } else {
      responseHeaders['Content-Disposition'] = 'inline';
    }

    res.writeHead(statusCode || 200, responseHeaders);
  };

  const nodeProxyFetch = (urlToFetch, redirectsLeft = 5) => {
    const u = new URL(urlToFetch);
    const client = u.protocol === 'https:' ? https : http;

    const upstreamReq = client.request(
      u,
      {
        method: 'GET',
        headers: {
          ...requestHeaders,
          Host: u.host,
        },
        timeout: 25000,
      },
      (upstreamRes) => {
        if (
          upstreamRes.statusCode >= 300 &&
          upstreamRes.statusCode < 400 &&
          upstreamRes.headers.location
        ) {
          upstreamRes.resume();
          const nextUrl = new URL(
            upstreamRes.headers.location,
            urlToFetch
          ).toString();
          proxyFetch(nextUrl, redirectsLeft - 1);
          return;
        }

        sendResponseHeaders(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );

    upstreamReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify({ error: `下载流代理失败: ${err.message}` }));
      }
    });

    req.on('close', () => {
      upstreamReq.destroy();
    });

    upstreamReq.end();
  };

  const proxyFetch = async (urlToFetch, redirectsLeft = 5) => {
    if (redirectsLeft <= 0) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Too many redirects');
      }
      return;
    }

    const u = new URL(urlToFetch);

    // Direct China Domestic Interface (en0) high-speed streaming for Douyin/XHS/Dewu CDNs
    if (isDomesticChinaHost(u.hostname)) {
      const realIps = await resolveChinaDomesticIps(u.hostname);
      if (realIps.length > 0) {
        const port = u.port || (u.protocol === 'https:' ? '443' : '80');
        const curlArgs = [
          '-s',
          '-i',
          '--http1.1',
          '--max-time',
          '120',
          '--interface',
          'en0',
          '--resolve',
          `${u.hostname}:${port}:${realIps[0]}`,
          '-H',
          `User-Agent: ${ua}`,
          '-H',
          `Referer: ${referer}`,
          '-H',
          'Accept: */*',
        ];
        if (req.headers.range) {
          curlArgs.push('-H', `Range: ${req.headers.range}`);
        }
        curlArgs.push(urlToFetch);

        const curlProc = spawn('curl', curlArgs);
        let headersParsed = false;
        let redirected = false;
        let headerBuf = Buffer.alloc(0);

        const onReqClose = () => {
          curlProc.kill('SIGKILL');
        };
        req.once('close', onReqClose);

        curlProc.stdout.on('data', (chunk) => {
          if (redirected) return;
          if (headersParsed) {
            res.write(chunk);
            return;
          }

          headerBuf = Buffer.concat([headerBuf, chunk]);
          while (true) {
            const sepIdx = headerBuf.indexOf('\r\n\r\n');
            if (sepIdx === -1) break;

            const rawHeaderBlock = headerBuf.slice(0, sepIdx).toString('utf-8');
            headerBuf = headerBuf.slice(sepIdx + 4);

            const lines = rawHeaderBlock.split('\r\n');
            const statusLine = lines[0] || '';
            const statusMatch = statusLine.match(/^HTTP\/\d+(?:\.\d+)?\s+(\d+)/i);
            const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 200;

            if (statusCode === 100) {
              continue;
            }

            const parsedHeaders = {};
            for (let i = 1; i < lines.length; i++) {
              const colonIdx = lines[i].indexOf(':');
              if (colonIdx > 0) {
                const k = lines[i].slice(0, colonIdx).trim().toLowerCase();
                const v = lines[i].slice(colonIdx + 1).trim();
                parsedHeaders[k] = v;
              }
            }

            if (
              statusCode >= 300 &&
              statusCode < 400 &&
              parsedHeaders.location
            ) {
              redirected = true;
              req.removeListener('close', onReqClose);
              curlProc.kill('SIGKILL');
              const nextUrl = new URL(
                parsedHeaders.location,
                urlToFetch
              ).toString();
              proxyFetch(nextUrl, redirectsLeft - 1);
              return;
            }

            headersParsed = true;
            sendResponseHeaders(statusCode, parsedHeaders);
            if (headerBuf.length > 0) {
              res.write(headerBuf);
              headerBuf = Buffer.alloc(0);
            }
            break;
          }
        });

        curlProc.on('close', () => {
          req.removeListener('close', onReqClose);
          if (redirected) return;
          if (!headersParsed && !res.headersSent) {
            nodeProxyFetch(urlToFetch, redirectsLeft);
          } else if (headersParsed) {
            res.end();
          }
        });

        curlProc.on('error', () => {
          req.removeListener('close', onReqClose);
          if (!headersParsed && !res.headersSent) {
            nodeProxyFetch(urlToFetch, redirectsLeft);
          }
        });

        return;
      }
    }

    nodeProxyFetch(urlToFetch, redirectsLeft);
  };

  proxyFetch(targetUrl);
}

/* ==========================================================================
   7. HTTP SERVER & ROUTES
   ========================================================================== */

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Allow-Private-Network': 'true',
};

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (reqUrl.pathname === '/api/status' && req.method === 'GET') {
    const publicUrl = getPublicTunnelUrl();
    const lanIp = getLanIp();
    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(
      JSON.stringify({
        ok: true,
        publicUrl,
        lanUrl: `http://${lanIp}:${PORT}`,
        localUrl: `http://localhost:${PORT}`,
        platforms: ['douyin', 'tiktok', 'xiaohongshu', 'x', 'instagram', 'dewu', 'bilibili'],
      })
    );
    return;
  }

  if (reqUrl.pathname === '/api/parse' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e5) req.destroy();
    });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');
        const rawInput = payload.input || payload.url || '';
        const extractedUrl = extractUrlFromText(rawInput);

        if (!extractedUrl) {
          res.writeHead(400, {
            ...CORS_HEADERS,
            'Content-Type': 'application/json; charset=utf-8',
          });
          res.end(
            JSON.stringify({
              ok: false,
              error:
                '未识别到有效链接，请直接粘贴 抖音 / TikTok / 小红书 / X / Instagram / 得物 / B站 的分享口令或网页链接',
            })
          );
          return;
        }

        let platform = detectPlatform(extractedUrl);
        let targetUrl = extractedUrl;

        if (platform === 'unknown') {
          targetUrl = await resolveRedirectUrl(extractedUrl);
          platform = detectPlatform(targetUrl);
        }

        let result;
        if (platform === 'douyin') {
          result = await parseDouyin(targetUrl);
        } else if (platform === 'tiktok') {
          result = await parseViaTikwm(targetUrl, 'tiktok');
        } else if (platform === 'xiaohongshu') {
          result = await parseXiaohongshu(targetUrl);
        } else if (platform === 'x') {
          result = await parseX(targetUrl);
        } else if (platform === 'instagram') {
          result = await parseInstagram(targetUrl);
        } else if (platform === 'dewu') {
          result = await parseDewu(targetUrl);
        } else if (platform === 'bilibili') {
          result = await parseBilibili(targetUrl);
        } else {
          throw new Error(
            `暂不支持该域名 (${new URL(extractedUrl).hostname})，目前支持：抖音、TikTok、小红书、X (Twitter)、Instagram、得物 (Poizon) 及 哔哩哔哩 (B站)`
          );
        }

        res.writeHead(200, {
          ...CORS_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(JSON.stringify({ ok: true, data: result }));
      } catch (err) {
        res.writeHead(422, {
          ...CORS_HEADERS,
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(
          JSON.stringify({
            ok: false,
            error: err.message || '解析失败，请稍后重试',
          })
        );
      }
    });
    return;
  }

  if (reqUrl.pathname === '/api/proxy' && req.method === 'GET') {
    handleProxyStream(req, res, reqUrl);
    return;
  }

  let filePath =
    reqUrl.pathname === '/'
      ? path.join(PUBLIC_DIR, 'index.html')
      : path.join(PUBLIC_DIR, path.normalize(reqUrl.pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const acceptEncoding = req.headers['accept-encoding'] || '';
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
      Vary: 'Accept-Encoding',
    };
    if (/\bgzip\b/.test(acceptEncoding) && /\.(html|css|js|json|svg)$/.test(ext)) {
      const compressed = zlib.gzipSync(content);
      headers['Content-Encoding'] = 'gzip';
      headers['Content-Length'] = compressed.length;
      res.writeHead(200, headers);
      res.end(compressed);
      return;
    }
    res.writeHead(200, headers);
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(
    `✨ PureSave 全平台无损无水印提取服务已启动: http://localhost:${PORT} (LAN: http://${getLanIp()}:${PORT})`
  );
});
