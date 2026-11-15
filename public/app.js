(() => {
  const parseForm = document.getElementById('parseForm');
  const urlInput = document.getElementById('urlInput');
  const detectedBadge = document.getElementById('detectedBadge');
  const pasteBtn = document.getElementById('pasteBtn');
  const clearBtn = document.getElementById('clearBtn');
  const submitBtn = document.getElementById('submitBtn');
  const btnText = submitBtn.querySelector('.btn-text');
  const btnSpinner = submitBtn.querySelector('.btn-spinner');

  const demoDouyinBtn = document.getElementById('demoDouyinBtn');
  const demoTiktokBtn = document.getElementById('demoTiktokBtn');
  const demoInsBtn = document.getElementById('demoInsBtn');
  const demoXBtn = document.getElementById('demoXBtn');
  const demoLiveBtn = document.getElementById('demoLiveBtn');

  const publicUrlBanner = document.getElementById('publicUrlBanner');
  const bannerPublicLink = document.getElementById('bannerPublicLink');
  const copyPublicUrlBtn = document.getElementById('copyPublicUrlBtn');
  const showQrModalBtn = document.getElementById('showQrModalBtn');
  const mobileAccessBtn = document.getElementById('mobileAccessBtn');

  const mobileModal = document.getElementById('mobileModal');
  const closeModalBtn = document.getElementById('closeModalBtn');
  const qrCodeImg = document.getElementById('qrCodeImg');
  const modalPublicUrl = document.getElementById('modalPublicUrl');
  const modalLanUrl = document.getElementById('modalLanUrl');
  const modalCopyPublicBtn = document.getElementById('modalCopyPublicBtn');
  const modalCopyLanBtn = document.getElementById('modalCopyLanBtn');

  const errorBanner = document.getElementById('errorBanner');
  const errorText = document.getElementById('errorText');

  const resultSection = document.getElementById('resultSection');
  const authorAvatar = document.getElementById('authorAvatar');
  const authorName = document.getElementById('authorName');
  const authorHandle = document.getElementById('authorHandle');
  const platformBadge = document.getElementById('platformBadge');
  const mediaTitle = document.getElementById('mediaTitle');
  const batchDownloadBtn = document.getElementById('batchDownloadBtn');
  const batchCount = document.getElementById('batchCount');
  const musicDownloadBtn = document.getElementById('musicDownloadBtn');
  const coverDownloadBtn = document.getElementById('coverDownloadBtn');
  const mediaGrid = document.getElementById('mediaGrid');

  const historySection = document.getElementById('historySection');
  const historyList = document.getElementById('historyList');
  const historyCount = document.getElementById('historyCount');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');

  const HISTORY_KEY = 'puresave_history_v2';
  const DEFAULT_TUNNEL_API =
    'https://airlines-environments-environments-friends.trycloudflare.com';
  const isStaticPagesHost = /github\.io|pages\.dev|vercel\.app|netlify\.app/i.test(
    window.location.hostname
  );
  let apiBase = isStaticPagesHost ? DEFAULT_TUNNEL_API : '';
  let serverStatus = { publicUrl: null, lanUrl: window.location.origin };

  function getCandidateApiBases() {
    if (!isStaticPagesHost) return [''];
    const saved = localStorage.getItem('puresave_api_base');
    return [
      ...new Set(
        [
          'http://localhost:3456',
          'http://127.0.0.1:3456',
          DEFAULT_TUNNEL_API,
          saved,
        ].filter(Boolean)
      ),
    ];
  }

  function buildProxyUrl(remoteUrl, filename, disposition = 'attachment') {
    if (!remoteUrl) return '';
    const params = new URLSearchParams({
      url: remoteUrl,
      filename: filename || 'puresave-media',
      disposition,
    });
    return `${apiBase}/api/proxy?${params.toString()}`;
  }

  function extractUrlClient(input) {
    if (!input || typeof input !== 'string') return null;
    const m = input.trim().match(/https?:\/\/[^\s"'<>，。！？；：）】\]）]+/i);
    return m ? m[0].replace(/[.,!?;:)'"\]）】>]+$/, '') : null;
  }

  async function parseClientSideFallback(rawInput) {
    const url = extractUrlClient(rawInput);
    if (!url) {
      throw new Error('未识别到有效链接，请粘贴包含 http/https 的分享口令或链接');
    }

    // 1. X / Twitter direct browser CORS API
    const xMatch = url.match(/(?:x\.com|twitter\.com)\/[^/]+\/status\/(\d+)/i);
    if (xMatch) {
      const statusId = xMatch[1];
      const res = await fetch(
        `https://api.vxtwitter.com/Twitter/status/${statusId}`
      );
      if (res.ok) {
        const vx = await res.json();
        const mediaList = vx.media_extended || [];
        if (mediaList.length > 0) {
          const mediaItems = mediaList.map((m, idx) => {
            const isVideo = m.type === 'video' || m.type === 'gif';
            const bestUrl = isVideo
              ? m.url
              : m.url.includes('twimg.com')
              ? `${m.url.split('?')[0]}?format=jpg&name=orig`
              : m.url;
            return {
              index: idx + 1,
              type: isVideo ? 'video' : 'photo',
              url: bestUrl,
              thumbnail: m.thumbnail_url || bestUrl,
              variants: [
                {
                  label: isVideo
                    ? '最高码率无损原画 (Lossless MP4)'
                    : '无损未压缩原图 (:orig 4K)',
                  quality:
                    m.size?.width && m.size?.height
                      ? `${m.size.width}x${m.size.height} · 原画`
                      : 'Original Lossless',
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
            author: {
              name: vx.user_name || 'X Creator',
              username: vx.user_screen_name ? `@${vx.user_screen_name}` : '',
              avatar: vx.user_profile_image_url || '',
            },
            cover: mediaItems[0]?.thumbnail || '',
            mediaItems,
          };
        }
      }
    }

    // 2. TikTok / Douyin direct browser CORS API (TikWM)
    if (/tiktok\.com|douyin\.com|iesdouyin\.com/i.test(url)) {
      const isTiktok = /tiktok\.com/i.test(url);
      const res = await fetch(
        `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`
      );
      const json = await res.json();
      if (json && json.code === 0 && json.data) {
        const d = json.data;
        const author = {
          name: d.author?.nickname || '创作者',
          username: d.author?.unique_id ? `@${d.author.unique_id}` : '',
          avatar: d.author?.avatar || '',
        };
        if (Array.isArray(d.images) && d.images.length > 0) {
          return {
            platform: isTiktok ? 'tiktok' : 'douyin',
            platformName: isTiktok ? 'TikTok' : '抖音 (Douyin)',
            id: d.id || String(Date.now()),
            type: 'gallery',
            title: d.title || '无水印图集作品',
            author,
            cover: d.origin_cover || d.images[0],
            musicUrl: d.music || '',
            mediaItems: d.images.map((imgUrl, idx) => ({
              index: idx + 1,
              type: 'photo',
              url: imgUrl,
              thumbnail: imgUrl,
              variants: [
                {
                  label: '无损无水印原图 (Lossless JPG)',
                  quality: 'Original HD JPG',
                  url: imgUrl,
                  ext: 'jpg',
                  isBest: true,
                },
              ],
            })),
          };
        }
        const hdUrl = d.hdplay || d.play;
        return {
          platform: isTiktok ? 'tiktok' : 'douyin',
          platformName: isTiktok ? 'TikTok' : '抖音 (Douyin)',
          id: d.id || String(Date.now()),
          type: 'video',
          title: d.title || '无水印原画视频',
          author,
          cover: d.origin_cover || d.cover || '',
          musicUrl: d.music || '',
          mediaItems: [
            {
              index: 1,
              type: 'video',
              url: hdUrl,
              thumbnail: d.origin_cover || d.cover || '',
              variants: [
                {
                  label: '原画无损无水印 (HD Lossless)',
                  quality: '1080P 原画最高码率',
                  url: hdUrl,
                  ext: 'mp4',
                  isBest: true,
                },
              ],
            },
          ],
        };
      }
    }

    throw new Error('请检查链接是否有效，或确保本地/隧道解析后端在线');
  }

  function sanitizeFilename(str, fallback = 'media') {
    const clean = (str || '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[#@/?<>\\:*|"\n\r\t]+/g, ' ')
      .trim()
      .slice(0, 40)
      .trim();
    return clean || fallback;
  }

  function getBadgeClass(platform) {
    const map = {
      douyin: 'detected-douyin',
      xiaohongshu: 'detected-xiaohongshu',
      x: 'detected-x',
      instagram: 'detected-instagram',
      dewu: 'detected-dewu',
      tiktok: 'detected-tiktok',
    };
    return map[platform] || 'detected-x';
  }

  function updateInputBadge() {
    const val = urlInput.value.trim();
    clearBtn.classList.toggle('hidden', !val);

    if (!val) {
      detectedBadge.className = 'detected-badge hidden';
      return;
    }

    if (/douyin\.com|iesdouyin\.com/i.test(val) || /^\d{18,20}$/.test(val)) {
      detectedBadge.textContent = '已识别：抖音 (Douyin) 分享链接';
      detectedBadge.className = 'detected-badge detected-douyin';
    } else if (/xiaohongshu\.com|xhslink\.com|xhslink\.cn|rednote\.com/i.test(val)) {
      detectedBadge.textContent = '已识别：小红书 (RED) 分享链接';
      detectedBadge.className = 'detected-badge detected-xiaohongshu';
    } else if (/instagram\.com|instagr\.am/i.test(val)) {
      detectedBadge.textContent = '已识别：Instagram 帖子 / Reels';
      detectedBadge.className = 'detected-badge detected-instagram';
    } else if (/dewu\.com|poizon\.com|dw4\.co|duapp\.com/i.test(val)) {
      detectedBadge.textContent = '已识别：得物 (Poizon) 分享链接';
      detectedBadge.className = 'detected-badge detected-dewu';
    } else if (/x\.com|twitter\.com|vxtwitter\.com|fxtwitter\.com|t\.co/i.test(val)) {
      detectedBadge.textContent = '已识别：X (Twitter) 推文链接';
      detectedBadge.className = 'detected-badge detected-x';
    } else if (/tiktok\.com/i.test(val)) {
      detectedBadge.textContent = '已识别：TikTok 链接';
      detectedBadge.className = 'detected-badge detected-tiktok';
    } else if (/https?:\/\//i.test(val)) {
      detectedBadge.textContent = '已识别：分享网址（将自动追踪重定向）';
      detectedBadge.className = 'detected-badge detected-x';
    } else {
      detectedBadge.className = 'detected-badge hidden';
    }
  }

  urlInput.addEventListener('input', updateInputBadge);

  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      parseForm.requestSubmit();
    }
  });

  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        urlInput.value = text;
        updateInputBadge();
        parseForm.requestSubmit();
      }
    } catch (_) {
      urlInput.focus();
      showError('请直接在输入框长按选择「粘贴」或按 Cmd+V / Ctrl+V');
    }
  });

  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    updateInputBadge();
    hideError();
    urlInput.focus();
  });

  // Quick verification buttons
  if (demoDouyinBtn) {
    demoDouyinBtn.addEventListener('click', () => {
      urlInput.value =
        '3.84 复制打开抖音，看看【lucien！的图文作品】哪有那么多意难平，你骑S5你也行。# cervel... https://v.douyin.com/llcLPjSA2wM/';
      updateInputBadge();
      parseForm.requestSubmit();
    });
  }

  if (demoTiktokBtn) {
    demoTiktokBtn.addEventListener('click', () => {
      urlInput.value = 'https://www.tiktok.com/@tiktok/video/7106594312292453675';
      updateInputBadge();
      parseForm.requestSubmit();
    });
  }

  demoInsBtn.addEventListener('click', () => {
    urlInput.value = 'https://www.instagram.com/p/CmUv48DLvxd/';
    updateInputBadge();
    parseForm.requestSubmit();
  });

  demoXBtn.addEventListener('click', () => {
    urlInput.value = 'https://x.com/TheEllenShow/status/440322224407314432';
    updateInputBadge();
    parseForm.requestSubmit();
  });

  demoLiveBtn.addEventListener('click', () => {
    urlInput.value =
      '先来几个实况吧 https://xhslink.cn/o/5z9RHPxbH4g 这篇内容在【小红书】候着你~';
    updateInputBadge();
    parseForm.requestSubmit();
  });

  function showError(msg) {
    errorText.textContent = msg;
    errorBanner.classList.remove('hidden');
  }

  function hideError() {
    errorBanner.classList.add('hidden');
  }

  function setLoading(loading) {
    submitBtn.disabled = loading;
    btnText.textContent = loading
      ? '正在深度无损解析原片源...'
      : '⚡ 立即无损去水印提取';
    btnSpinner.classList.toggle('hidden', !loading);
  }

  function triggerDownload(proxyUrl) {
    const a = document.createElement('a');
    a.href = proxyUrl;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1500);
  }

  /**
   * Native mobile share-to-photos helper (for iOS Safari / Android Chrome)
   */
  async function shareOrSaveToMobilePhotos(proxyUrl, filename, ext, btnEl) {
    const origText = btnEl.textContent;
    try {
      btnEl.textContent = '准备中...';
      btnEl.disabled = true;
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error('下载失败');
      const blob = await res.blob();
      const mimeType =
        ext === 'mp4'
          ? 'video/mp4'
          : ext === 'mov'
          ? 'video/quicktime'
          : ext === 'png'
          ? 'image/png'
          : ext === 'webp'
          ? 'image/webp'
          : 'image/jpeg';
      const file = new File([blob], filename, { type: mimeType });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: filename,
        });
        btnEl.textContent = '已呼出相册 ✓';
      } else {
        triggerDownload(proxyUrl);
        btnEl.textContent = '已开始下载 ✓';
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        triggerDownload(proxyUrl);
      }
      btnEl.textContent = origText;
    } finally {
      btnEl.disabled = false;
      setTimeout(() => {
        btnEl.textContent = origText;
      }, 2000);
    }
  }

  function renderResult(data) {
    resultSection.classList.remove('hidden');

    authorAvatar.referrerPolicy = 'no-referrer';
    authorAvatar.src =
      data.author?.avatar ||
      'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="100%" height="100%" fill="%23334155"/></svg>';
    authorAvatar.onerror = () => {
      if (data.author?.avatar && !authorAvatar.dataset.proxied) {
        authorAvatar.dataset.proxied = '1';
        authorAvatar.src = buildProxyUrl(
          data.author.avatar,
          'avatar.jpg',
          'inline'
        );
      }
    };
    authorName.textContent = data.author?.name || '创作者';
    authorHandle.textContent = data.author?.username || '';

    platformBadge.textContent =
      data.platformName || (data.platform || '').toUpperCase();
    platformBadge.className =
      'platform-badge ' + getBadgeClass(data.platform);

    mediaTitle.textContent = data.title || '';

    const baseFilePrefix = `${data.platform}_${sanitizeFilename(
      data.title,
      data.id
    )}`;

    const items = data.mediaItems || [];
    const liveItems = items.filter(
      (it) => it.type === 'livephoto' || Boolean(it.liveVideoUrl)
    );
    if (liveItems.length > 0) {
      batchDownloadBtn.innerHTML = `🔊 一键下载全部带声音实况 ( <span id="batchCount">${liveItems.length}</span> )`;
      batchDownloadBtn.classList.remove('hidden');
      batchDownloadBtn.onclick = () => {
        liveItems.forEach((item, idx) => {
          const liveVar =
            item.variants?.find((v) => v.isLiveVideo) ||
            item.variants?.[0] || {
              url: item.liveVideoUrl || item.url,
              ext: 'mp4',
            };
          const fname = `${baseFilePrefix}_实况带声音_${idx + 1}.${
            liveVar.ext || 'mp4'
          }`;
          setTimeout(() => {
            triggerDownload(buildProxyUrl(liveVar.url, fname, 'attachment'));
          }, idx * 450);
        });
      };
    } else if (items.length > 1) {
      batchDownloadBtn.innerHTML = `📦 一键保存全部 ( <span id="batchCount">${items.length}</span> )`;
      batchDownloadBtn.classList.remove('hidden');
      batchDownloadBtn.onclick = () => {
        items.forEach((item, idx) => {
          const best = item.variants?.[0] || { url: item.url, ext: 'jpg' };
          const fname = `${baseFilePrefix}_${idx + 1}.${best.ext || 'jpg'}`;
          setTimeout(() => {
            triggerDownload(buildProxyUrl(best.url, fname, 'attachment'));
          }, idx * 450);
        });
      };
    } else {
      batchDownloadBtn.classList.add('hidden');
    }

    if (data.musicUrl) {
      musicDownloadBtn.classList.remove('hidden');
      musicDownloadBtn.onclick = () => {
        triggerDownload(
          buildProxyUrl(data.musicUrl, `${baseFilePrefix}_BGM.mp3`, 'attachment')
        );
      };
    } else {
      musicDownloadBtn.classList.add('hidden');
    }

    if (data.cover) {
      coverDownloadBtn.classList.remove('hidden');
      coverDownloadBtn.onclick = () => {
        triggerDownload(
          buildProxyUrl(
            data.cover,
            `${baseFilePrefix}_cover.jpg`,
            'attachment'
          )
        );
      };
    } else {
      coverDownloadBtn.classList.add('hidden');
    }

    mediaGrid.innerHTML = '';

    items.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'media-item-card';

      const previewBox = document.createElement('div');
      previewBox.className = 'media-preview-box';

      const tag = document.createElement('span');
      tag.className = 'media-type-tag';
      const isLivePhoto = item.type === 'livephoto' || Boolean(item.liveVideoUrl);

      if (isLivePhoto) {
        tag.textContent =
          items.length > 1 ? `📸 实况图 #${idx + 1}` : '📸 实况 LivePhoto';
      } else if (item.type === 'video') {
        tag.textContent =
          items.length > 1 ? `🎬 视频 #${idx + 1}` : '🎬 无水印原画视频';
      } else if (item.type === 'gif') {
        tag.textContent = '🎞️ 动图 GIF (MP4)';
      } else {
        tag.textContent =
          items.length > 1 ? `🖼️ 无损原图 #${idx + 1}` : '🖼️ 无损原图';
      }
      previewBox.appendChild(tag);

      if (item.type === 'video' || item.type === 'gif') {
        const videoEl = document.createElement('video');
        videoEl.controls = true;
        videoEl.playsInline = true;
        videoEl.preload = 'metadata';
        if (item.thumbnail) {
          videoEl.poster = item.thumbnail;
        }
        videoEl.src = item.url;
        videoEl.onerror = () => {
          if (!videoEl.dataset.proxied) {
            videoEl.dataset.proxied = '1';
            videoEl.src = buildProxyUrl(item.url, 'preview.mp4', 'inline');
          }
        };
        previewBox.appendChild(videoEl);
      } else {
        const imgEl = document.createElement('img');
        imgEl.loading = 'lazy';
        imgEl.referrerPolicy = 'no-referrer';
        imgEl.alt = `Media ${idx + 1}`;
        imgEl.src = item.url;
        imgEl.onerror = () => {
          if (!imgEl.dataset.proxied) {
            imgEl.dataset.proxied = '1';
            imgEl.src = buildProxyUrl(item.url, 'preview.jpg', 'inline');
          }
        };
        previewBox.appendChild(imgEl);

        // If Live Photo, add interactive video overlay + LIVE badge with sound
        if (isLivePhoto && item.liveVideoUrl) {
          const liveVideoEl = document.createElement('video');
          liveVideoEl.className = 'livephoto-video-overlay';
          liveVideoEl.playsInline = true;
          liveVideoEl.loop = true;
          liveVideoEl.muted = false;
          liveVideoEl.preload = 'metadata';
          liveVideoEl.src = buildProxyUrl(
            item.liveVideoUrl,
            'livephoto.mp4',
            'inline'
          );

          const liveBadge = document.createElement('button');
          liveBadge.type = 'button';
          liveBadge.className = 'live-photo-badge';
          liveBadge.innerHTML =
            '<span class="live-rings"></span><span>🔊 LIVE 实况 · 点击播放原声</span>';

          let playing = false;
          const toggleLive = (forceState) => {
            playing = typeof forceState === 'boolean' ? forceState : !playing;
            if (playing) {
              previewBox.classList.add('is-playing-live');
              liveBadge.innerHTML =
                '<span class="live-rings"></span><span>🔊 LIVE 原声播放中 (点击暂停)</span>';
              liveVideoEl.muted = false;
              liveVideoEl.currentTime = 0;
              liveVideoEl.play().catch(() => {
                liveVideoEl.muted = true;
                liveVideoEl.play().catch(() => {});
              });
            } else {
              previewBox.classList.remove('is-playing-live');
              liveBadge.innerHTML =
                '<span class="live-rings"></span><span>🔊 LIVE 实况 · 点击播放原声</span>';
              liveVideoEl.pause();
            }
          };

          liveBadge.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleLive();
          });

          previewBox.addEventListener('click', () => {
            toggleLive();
          });

          previewBox.appendChild(liveVideoEl);
          previewBox.appendChild(liveBadge);
        }
      }

      const infoBody = document.createElement('div');
      infoBody.className = 'media-info-body';

      const variantsList = document.createElement('div');
      variantsList.className = 'variants-list';

      const variants = item.variants || [
        {
          label: '无损原件 (Lossless)',
          quality: 'Original',
          url: item.url,
          ext: item.type === 'video' ? 'mp4' : 'jpg',
          isBest: true,
        },
      ];

      variants.forEach((v, vIdx) => {
        const row = document.createElement('div');
        row.className =
          'variant-row' +
          (v.isLiveVideo
            ? ' live-variant'
            : v.isBest || vIdx === 0
            ? ' best-variant'
            : '');

        const meta = document.createElement('div');
        meta.className = 'variant-meta';

        const labelEl = document.createElement('div');
        labelEl.className = 'variant-label';
        labelEl.textContent = v.label;

        if (v.isLiveVideo) {
          const pill = document.createElement('span');
          pill.className = 'live-pill';
          pill.textContent = '🔊 含原声实况';
          labelEl.appendChild(pill);
        } else if (v.isBest || vIdx === 0) {
          const pill = document.createElement('span');
          pill.className = 'lossless-pill';
          pill.textContent = '无损无水印';
          labelEl.appendChild(pill);
        }

        const qualEl = document.createElement('div');
        qualEl.className = 'variant-quality';
        qualEl.textContent = v.quality || v.ext?.toUpperCase() || '';

        meta.appendChild(labelEl);
        meta.appendChild(qualEl);

        const btns = document.createElement('div');
        btns.className = 'variant-btns';

        const ext = v.ext || (item.type === 'video' ? 'mp4' : 'jpg');
        const suffix = v.isLiveVideo ? '_live' : '';
        const dlFilename =
          items.length > 1
            ? `${baseFilePrefix}_${idx + 1}${suffix}.${ext}`
            : `${baseFilePrefix}${suffix}.${ext}`;
        const proxyDownloadUrl = buildProxyUrl(v.url, dlFilename, 'attachment');

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn-copy-url';
        copyBtn.textContent = '复制直链';
        copyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(v.url);
            copyBtn.textContent = '已复制 ✓';
            setTimeout(() => {
              copyBtn.textContent = '复制直链';
            }, 1500);
          } catch (_) {}
        };

        const shareMobileBtn = document.createElement('button');
        shareMobileBtn.type = 'button';
        shareMobileBtn.className = 'btn-share-mobile';
        shareMobileBtn.textContent = v.isLiveVideo
          ? '📲 实况存手机相册'
          : '📲 存入手机相册';
        shareMobileBtn.onclick = () => {
          shareOrSaveToMobilePhotos(
            proxyDownloadUrl,
            dlFilename,
            ext,
            shareMobileBtn
          );
        };

        const dlBtn = document.createElement('a');
        dlBtn.className = 'btn-download';
        dlBtn.href = proxyDownloadUrl;
        dlBtn.setAttribute('download', dlFilename);
        dlBtn.innerHTML = v.isLiveVideo
          ? `🔊 下载带声音 .${ext}`
          : `⬇ 下载 .${ext}`;

        btns.appendChild(copyBtn);
        btns.appendChild(shareMobileBtn);
        btns.appendChild(dlBtn);

        row.appendChild(meta);
        row.appendChild(btns);
        variantsList.appendChild(row);
      });

      infoBody.appendChild(variantsList);
      card.appendChild(previewBox);
      card.appendChild(infoBody);
      mediaGrid.appendChild(card);
    });
  }

  // Local History Management
  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function saveToHistory(data) {
    const list = loadHistory().filter((item) => item.id !== data.id);
    list.unshift({
      id: data.id,
      platform: data.platform,
      platformName: data.platformName,
      title: data.title,
      author: data.author,
      cover: data.cover,
      musicUrl: data.musicUrl,
      mediaItems: data.mediaItems,
      savedAt: Date.now(),
    });
    const trimmed = list.slice(0, 12);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
    } catch (_) {}
    renderHistory();
  }

  function renderHistory() {
    const list = loadHistory();
    if (list.length === 0) {
      historySection.classList.add('hidden');
      return;
    }
    historySection.classList.remove('hidden');
    historyCount.textContent = `(${list.length})`;
    historyList.innerHTML = '';

    list.forEach((entry) => {
      const el = document.createElement('div');
      el.className = 'history-item';

      const thumb = document.createElement('img');
      thumb.className = 'history-thumb';
      thumb.referrerPolicy = 'no-referrer';
      thumb.src =
        entry.cover ||
        'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="100%" height="100%" fill="%231e293b"/></svg>';
      thumb.onerror = () => {
        if (entry.cover && !thumb.dataset.proxied) {
          thumb.dataset.proxied = '1';
          thumb.src = buildProxyUrl(entry.cover, 'thumb.jpg', 'inline');
        }
      };

      const meta = document.createElement('div');
      meta.className = 'history-meta';

      const title = document.createElement('div');
      title.className = 'history-title';
      title.textContent = entry.title || entry.id;

      const sub = document.createElement('div');
      sub.className = 'history-sub';
      sub.textContent = `${entry.platformName} · ${
        entry.author?.name || ''
      } · ${entry.mediaItems?.length || 1} 项媒体`;

      meta.appendChild(title);
      meta.appendChild(sub);
      el.appendChild(thumb);
      el.appendChild(meta);

      el.onclick = () => {
        renderResult(entry);
        resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };

      historyList.appendChild(el);
    });
  }

  clearHistoryBtn.addEventListener('click', () => {
    localStorage.removeItem(HISTORY_KEY);
    renderHistory();
  });

  parseForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = urlInput.value.trim();
    if (!raw) {
      showError('请先粘贴 抖音 / TikTok / 小红书 / X / Instagram / 得物 的分享口令或链接');
      urlInput.focus();
      return;
    }

    hideError();
    setLoading(true);

    try {
      let parsedData = null;

      // On GitHub Pages, try ultra-fast direct browser CORS API first for TikTok & X
      if (isStaticPagesHost && /tiktok\.com|x\.com|twitter\.com/i.test(raw)) {
        try {
          parsedData = await parseClientSideFallback(raw);
        } catch (_) {}
      }

      if (!parsedData) {
        let lastBackendErr = null;
        const candidates = getCandidateApiBases();
        for (const base of candidates) {
          try {
            const res = await fetch(`${base}/api/parse`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ input: raw }),
            });
            const json = await res.json();
            if (!res.ok || !json.ok) {
              lastBackendErr = new Error(
                json.error || '解析失败，请检查链接是否公开有效'
              );
              if (res.status === 422 || res.status === 400) {
                break;
              }
              continue;
            }
            apiBase = base;
            parsedData = json.data;
            break;
          } catch (err) {
            lastBackendErr = err;
          }
        }
        if (!parsedData) {
          parsedData = await parseClientSideFallback(raw).catch(() => {
            throw (
              lastBackendErr ||
              new Error('解析失败，请检查链接是否公开有效')
            );
          });
        }
      }

      renderResult(parsedData);
      saveToHistory(parsedData);
    } catch (err) {
      showError(err.message);
    } finally {
      setLoading(false);
    }
  });

  // Public Tunnel & Mobile QR Code Modal Logic
  async function fetchServerStatus() {
    const candidates = getCandidateApiBases();
    for (const base of candidates) {
      try {
        const res = await fetch(`${base}/api/status`);
        const data = await res.json();
        if (data.ok) {
          apiBase = base;
          serverStatus = data;
          if (data.publicUrl) {
            try {
              localStorage.setItem('puresave_api_base', data.publicUrl);
            } catch (_) {}
          }
          const primaryUrl =
            data.publicUrl || data.lanUrl || window.location.origin;

          if (data.publicUrl) {
            publicUrlBanner.classList.remove('hidden');
            bannerPublicLink.href = data.publicUrl;
            bannerPublicLink.textContent = data.publicUrl;
          }

          modalPublicUrl.value = data.publicUrl || '正在生成公网隧道...';
          modalLanUrl.value = data.lanUrl || window.location.origin;
          qrCodeImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=8&data=${encodeURIComponent(
            primaryUrl
          )}`;
          break;
        }
      } catch (_) {}
    }
  }

  function openMobileModal() {
    fetchServerStatus();
    mobileModal.classList.remove('hidden');
  }

  mobileAccessBtn.addEventListener('click', openMobileModal);
  showQrModalBtn.addEventListener('click', openMobileModal);
  closeModalBtn.addEventListener('click', () => {
    mobileModal.classList.add('hidden');
  });
  mobileModal.addEventListener('click', (e) => {
    if (e.target === mobileModal) mobileModal.classList.add('hidden');
  });

  copyPublicUrlBtn.addEventListener('click', async () => {
    const url = serverStatus.publicUrl || window.location.origin;
    try {
      await navigator.clipboard.writeText(url);
      copyPublicUrlBtn.textContent = '已复制 ✓';
      setTimeout(() => {
        copyPublicUrlBtn.textContent = '复制公网链接';
      }, 1500);
    } catch (_) {}
  });

  modalCopyPublicBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(modalPublicUrl.value);
      modalCopyPublicBtn.textContent = '已复制 ✓';
      setTimeout(() => {
        modalCopyPublicBtn.textContent = '复制';
      }, 1500);
    } catch (_) {}
  });

  modalCopyLanBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(modalLanUrl.value);
      modalCopyLanBtn.textContent = '已复制 ✓';
      setTimeout(() => {
        modalCopyLanBtn.textContent = '复制';
      }, 1500);
    } catch (_) {}
  });

  fetchServerStatus();
  renderHistory();
})();
