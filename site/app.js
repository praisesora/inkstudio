'use strict';

(() => {
  const REPO = 'praisesora/inkstudio';
  const RELEASES_PAGE_URL = `https://github.com/${REPO}/releases`;
  const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=8`;
  const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/`;
  const CACHE_KEY = 'inkstudio_releases_v1';
  const CACHE_TTL_MS = 10 * 60 * 1000;

  /* --------------------------------------------------------------------------
   * Utilities
   * -------------------------------------------------------------------------- */
  function safeReleaseUrl(raw) {
    if (typeof raw !== 'string') return RELEASES_PAGE_URL;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'https:' && parsed.href.startsWith(DOWNLOAD_PREFIX)) {
        return parsed.href;
      }
    } catch {
      // fall through
    }
    return RELEASES_PAGE_URL;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx += 1;
    }
    return `${value.toFixed(idx >= 2 ? 1 : 0)} ${units[idx]}`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }

  function detectVisitorOS() {
    const uaData = navigator.userAgentData && navigator.userAgentData.platform;
    const raw = (uaData || navigator.platform || navigator.userAgent || '').toLowerCase();
    if (raw.includes('win')) return 'windows';
    if (raw.includes('mac') || raw.includes('darwin')) return 'macos';
    if (raw.includes('linux') || raw.includes('x11')) return 'linux';
    return 'windows';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /* --------------------------------------------------------------------------
   * Release Asset Classification
   * -------------------------------------------------------------------------- */
  function isInternalUpdaterAsset(name) {
    const lower = name.toLowerCase();
    return (
      lower === 'latest.json' ||
      lower.endsWith('.sig') ||
      lower.endsWith('.nsis.zip') ||
      lower.endsWith('.msi.zip') ||
      lower.endsWith('.app.tar.gz') ||
      lower.endsWith('.appimage.tar.gz')
    );
  }

  function classifyAsset(asset) {
    const name = String(asset.name || '');
    const lower = name.toLowerCase();
    if (!name || isInternalUpdaterAsset(name)) return null;

    const url = safeReleaseUrl(asset.browser_download_url || asset.url);
    const size = Number(asset.size || 0);
    const downloads = Number(asset.download_count || 0);

    if (lower.endsWith('.exe')) {
      return {
        os: 'windows',
        priority: 1,
        label: 'Windows Installer (NSIS)',
        badge: 'Recommended · .exe',
        recommended: true,
        name,
        url,
        size,
        downloads,
      };
    }
    if (lower.endsWith('.msi')) {
      return {
        os: 'windows',
        priority: 2,
        label: 'Windows Installer (MSI)',
        badge: 'MSI · x64',
        recommended: false,
        name,
        url,
        size,
        downloads,
      };
    }
    if (lower.endsWith('.dmg')) {
      const isArm = lower.includes('aarch64') || lower.includes('arm64');
      const isIntel = lower.includes('x64') || lower.includes('x86_64');
      const arch = isArm ? 'Apple Silicon' : isIntel ? 'Intel x64' : 'Universal';
      return {
        os: 'macos',
        priority: isArm ? 1 : 2,
        label: `macOS Disk Image (${arch})`,
        badge: `${arch} · .dmg`,
        recommended: isArm || (!isArm && !isIntel),
        name,
        url,
        size,
        downloads,
      };
    }
    if (lower.endsWith('.appimage')) {
      return {
        os: 'linux',
        priority: 1,
        label: 'Linux AppImage',
        badge: 'Portable · .AppImage',
        recommended: true,
        name,
        url,
        size,
        downloads,
      };
    }
    if (lower.endsWith('.deb')) {
      return {
        os: 'linux',
        priority: 2,
        label: 'Debian / Ubuntu Package',
        badge: '.deb',
        recommended: false,
        name,
        url,
        size,
        downloads,
      };
    }
    if (lower.endsWith('.rpm')) {
      return {
        os: 'linux',
        priority: 3,
        label: 'Fedora / RHEL Package',
        badge: '.rpm',
        recommended: false,
        name,
        url,
        size,
        downloads,
      };
    }
    return null;
  }

  function normalizeReleases(rawList) {
    if (!Array.isArray(rawList)) return [];
    return rawList
      .filter((r) => r && !r.draft)
      .map((r) => {
        const assets = Array.isArray(r.assets)
          ? r.assets.map(classifyAsset).filter(Boolean).sort((a, b) => a.priority - b.priority)
          : [];
        return {
          tag: String(r.tag_name || r.tag || ''),
          name: String(r.name || r.tag_name || r.tag || 'Release'),
          publishedAt: String(r.published_at || r.publishedAt || ''),
          prerelease: Boolean(r.prerelease),
          url: safeReleaseUrl(r.html_url || r.url || RELEASES_PAGE_URL),
          body: String(r.body || '').trim(),
          assets,
        };
      })
      .filter((r) => r.tag);
  }

  /* --------------------------------------------------------------------------
   * Release Loader (Static Snapshot + Cached Live GitHub API Fallback)
   * -------------------------------------------------------------------------- */
  async function loadSnapshot() {
    try {
      const res = await fetch('./releases.json', { cache: 'no-cache' });
      if (!res.ok) return null;
      const data = await res.json();
      if (!data || !Array.isArray(data.releases)) return null;
      return {
        generatedAt: data.generatedAt || null,
        releases: normalizeReleases(data.releases),
      };
    } catch {
      return null;
    }
  }

  function readSessionCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || Date.now() - parsed.ts > CACHE_TTL_MS) return null;
      return normalizeReleases(parsed.releases);
    } catch {
      return null;
    }
  }

  function writeSessionCache(releases) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), releases }));
    } catch {
      // ignore storage quota errors
    }
  }

  async function loadLiveReleases() {
    const cached = readSessionCache();
    if (cached && cached.length > 0) return cached;

    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 6000);
      const res = await fetch(API_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      if (!res.ok) return null;
      const data = await res.json();
      const normalized = normalizeReleases(data);
      writeSessionCache(normalized);
      return normalized;
    } catch {
      return null;
    }
  }

  /* --------------------------------------------------------------------------
   * Release UI Rendering (Zero innerHTML with untrusted data)
   * -------------------------------------------------------------------------- */
  const releaseState = {
    releases: [],
    activeOs: detectVisitorOS(),
    source: 'snapshot',
  };

  function getLatestStable() {
    return (
      releaseState.releases.find((r) => !r.prerelease) ||
      releaseState.releases[0] ||
      null
    );
  }

  function renderHeaderAndHero() {
    const latest = getLatestStable();
    const heroPill = document.getElementById('hero-release-pill');
    const primaryBtn = document.getElementById('primary-download-btn');
    const primaryLabel = document.getElementById('primary-download-label');
    const primaryMeta = document.getElementById('primary-download-meta');
    const syncStatus = document.getElementById('sync-status');

    if (!latest) {
      if (heroPill) heroPill.textContent = 'Tauri + Rust';
      if (primaryBtn) primaryBtn.href = RELEASES_PAGE_URL;
      if (primaryLabel) primaryLabel.textContent = 'View GitHub Releases';
      if (primaryMeta) primaryMeta.textContent = 'No public release published yet · Build from source below';
      if (syncStatus) syncStatus.textContent = 'Waiting for first published release';
      return;
    }

    if (heroPill) heroPill.textContent = `${latest.tag} (${formatDate(latest.publishedAt) || 'Latest'})`;
    if (syncStatus) {
      syncStatus.textContent = `Latest: ${latest.tag} · ${formatDate(latest.publishedAt)}`;
    }

    const visitorOs = detectVisitorOS();
    const osAssets = latest.assets.filter((a) => a.os === visitorOs);
    const preferred = osAssets[0] || latest.assets[0] || null;

    if (preferred && primaryBtn && primaryLabel && primaryMeta) {
      primaryBtn.href = preferred.url;
      const osNames = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
      const osName = osNames[preferred.os] || 'Desktop';
      primaryLabel.textContent = `Download for ${osName} (${latest.tag})`;
      const parts = [preferred.name];
      if (preferred.size) parts.push(formatBytes(preferred.size));
      parts.push('Auto-updates built in');
      primaryMeta.textContent = parts.join(' · ');
    } else if (primaryBtn && primaryLabel && primaryMeta) {
      primaryBtn.href = latest.url;
      primaryLabel.textContent = `Download ${latest.tag}`;
      primaryMeta.textContent = `Published ${formatDate(latest.publishedAt)} · GitHub Releases`;
    }
  }

  function renderBuildFromSource(container, introText) {
    const wrap = el('div', 'download-empty');
    wrap.appendChild(el('p', 'muted', introText));

    const pre = el('pre', 'code-block');
    pre.textContent =
      'git clone https://github.com/praisesora/inkstudio.git\n' +
      'cd inkstudio\n' +
      'npm install && npm run tauri build';
    wrap.appendChild(pre);

    const req = el(
      'p',
      'muted',
      'Requires Node.js 22+, stable Rust toolchain, and Tauri v2 OS prerequisites.'
    );
    wrap.appendChild(req);
    container.appendChild(wrap);
  }

  function renderDownloadTab(osKey) {
    releaseState.activeOs = osKey;
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      const active = btn.dataset.os === osKey;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    const container = document.getElementById('download-content');
    if (!container) return;
    container.textContent = '';

    if (osKey === 'source') {
      renderBuildFromSource(
        container,
        'Compile native Windows, macOS, or Linux binaries directly from source:'
      );
      return;
    }

    const latest = getLatestStable();
    if (!latest) {
      const empty = el('div', 'download-empty');
      empty.appendChild(
        el(
          'p',
          'muted',
          'No published release artifacts found yet. Once a GitHub Release is published, installers appear here automatically.'
        )
      );
      const link = el('a', 'btn btn-secondary btn-sm', 'Open GitHub Releases');
      link.href = RELEASES_PAGE_URL;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.style.alignSelf = 'flex-start';
      empty.appendChild(link);
      container.appendChild(empty);
      return;
    }

    const matching = latest.assets.filter((a) => a.os === osKey);
    if (matching.length === 0) {
      const osLabel = osKey === 'macos' ? 'macOS' : osKey === 'linux' ? 'Linux' : 'Windows';
      renderBuildFromSource(
        container,
        `Prebuilt ${osLabel} binaries are not attached to ${latest.tag} yet. Build locally from source or check GitHub Releases:`
      );
      return;
    }

    const list = el('div', 'asset-list');
    for (const asset of matching) {
      const row = el('div', `asset-row${asset.recommended ? ' recommended' : ''}`);

      const info = el('div', 'asset-info');
      const titleLine = el('div', 'asset-title-line');
      titleLine.appendChild(el('span', 'asset-title', asset.label));
      titleLine.appendChild(
        el('span', `badge${asset.recommended ? ' badge-accent' : ''}`, asset.badge)
      );
      info.appendChild(titleLine);
      info.appendChild(el('span', 'asset-filename mono', asset.name));

      const actions = el('div', 'asset-actions');
      const metaParts = [];
      if (asset.size) metaParts.push(formatBytes(asset.size));
      if (asset.downloads > 0) metaParts.push(`${asset.downloads.toLocaleString()} dl`);
      if (metaParts.length) {
        actions.appendChild(el('span', 'asset-size mono', metaParts.join(' · ')));
      }

      const btn = el(
        'a',
        `btn ${asset.recommended ? 'btn-primary' : 'btn-secondary'} btn-sm`,
        'Download'
      );
      btn.href = asset.url;
      actions.appendChild(btn);

      row.appendChild(info);
      row.appendChild(actions);
      list.appendChild(row);
    }

    container.appendChild(list);
  }

  function appendInlineFormattedText(parent, text) {
    const tokens = String(text || '').split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    for (const token of tokens) {
      if (!token) continue;
      if (token.length >= 2 && token.startsWith('`') && token.endsWith('`')) {
        parent.appendChild(el('code', 'release-notes-code mono', token.slice(1, -1)));
      } else if (token.length >= 4 && token.startsWith('**') && token.endsWith('**')) {
        parent.appendChild(el('strong', 'release-notes-strong', token.slice(2, -2)));
      } else {
        parent.appendChild(document.createTextNode(token));
      }
    }
  }

  function renderReleaseNotesBody(body) {
    const container = el('div', 'release-notes');
    const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
    const headingToneMap = {
      new: 'new',
      improvements: 'improvements',
      'bug fixes': 'fixes',
      other: 'other',
    };

    let currentSection = null;
    let currentList = null;

    function ensureSection() {
      if (!currentSection) {
        currentSection = el('div', 'release-notes-section');
        container.appendChild(currentSection);
      }
      return currentSection;
    }

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        currentList = null;
        continue;
      }

      const headingMatch = /^#{2,4}\s+(.+)$/.exec(trimmed);
      if (headingMatch) {
        const title = headingMatch[1].trim();
        const tone = headingToneMap[title.toLowerCase()] || 'default';
        currentSection = el('div', 'release-notes-section');
        currentSection.appendChild(
          el('div', `release-notes-heading release-notes-heading--${tone}`, title)
        );
        container.appendChild(currentSection);
        currentList = null;
        continue;
      }

      const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed);
      if (bulletMatch) {
        const sec = ensureSection();
        if (!currentList) {
          currentList = el('ul', 'release-notes-list');
          sec.appendChild(currentList);
        }
        const li = el('li', '');
        appendInlineFormattedText(li, bulletMatch[1].trim());
        currentList.appendChild(li);
        continue;
      }

      currentList = null;
      const p = el('p', 'release-notes-para');
      appendInlineFormattedText(p, trimmed);
      ensureSection().appendChild(p);
    }

    return container;
  }

  function renderReleaseHistory() {
    const host = document.getElementById('release-history');
    if (!host) return;
    host.textContent = '';

    if (releaseState.releases.length === 0) {
      const card = el('div', 'release-item');
      card.appendChild(
        el(
          'p',
          'muted',
          'No published releases yet. Tag a release (v*) and publish it on GitHub to populate this feed automatically.'
        )
      );
      host.appendChild(card);
      return;
    }

    for (const rel of releaseState.releases.slice(0, 5)) {
      const card = el('article', 'release-item');
      const top = el('div', 'release-top');

      const titleGroup = el('div', 'release-title-group');
      const link = el('a', 'release-name', rel.name);
      link.href = rel.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      titleGroup.appendChild(link);
      titleGroup.appendChild(el('span', 'badge', rel.tag));
      if (rel.prerelease) {
        titleGroup.appendChild(el('span', 'badge', 'Pre-release'));
      }

      top.appendChild(titleGroup);
      top.appendChild(el('span', 'mono muted', formatDate(rel.publishedAt)));
      card.appendChild(top);

      if (rel.body) {
        card.appendChild(renderReleaseNotesBody(rel.body));
      }

      if (rel.assets.length > 0) {
        const assetsBar = el('div', 'release-assets-inline');
        for (const asset of rel.assets) {
          const pill = el('a', 'asset-pill mono');
          pill.href = asset.url;
          pill.appendChild(el('span', '', asset.name));
          if (asset.size) {
            pill.appendChild(el('span', 'muted', formatBytes(asset.size)));
          }
          assetsBar.appendChild(pill);
        }
        card.appendChild(assetsBar);
      }

      host.appendChild(card);
    }
  }

  async function initReleases() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => renderDownloadTab(btn.dataset.os));
    });

    const snapshot = await loadSnapshot();
    if (snapshot && snapshot.releases.length > 0) {
      releaseState.releases = snapshot.releases;
      releaseState.source = 'snapshot';
      renderHeaderAndHero();
      renderDownloadTab(releaseState.activeOs);
      renderReleaseHistory();
    }

    const snapshotAgeMs =
      snapshot && snapshot.generatedAt
        ? Date.now() - new Date(snapshot.generatedAt).getTime()
        : Infinity;

    if (!snapshot || snapshot.releases.length === 0 || snapshotAgeMs > 5 * 60 * 1000) {
      const live = await loadLiveReleases();
      if (live && live.length > 0) {
        releaseState.releases = live;
        releaseState.source = 'api';
      }
      renderHeaderAndHero();
      renderDownloadTab(releaseState.activeOs);
      renderReleaseHistory();
    }
  }

  /* --------------------------------------------------------------------------
   * Interactive Studio Canvas (Clean Empty Manga Manuscript + Blank Sheet)
   * -------------------------------------------------------------------------- */
  function initStudioCanvas() {
    const paperCanvas = document.getElementById('canvas-paper');
    const guidesCanvas = document.getElementById('canvas-guides');
    const panelsCanvas = document.getElementById('canvas-panels');
    const userCanvas = document.getElementById('canvas-user');
    if (!paperCanvas || !guidesCanvas || !panelsCanvas || !userCanvas) return;

    const W = userCanvas.width;
    const H = userCanvas.height;

    const layerMap = {
      paper: paperCanvas,
      guides: guidesCanvas,
      panels: panelsCanvas,
      user: userCanvas,
    };

    // 1. Clean manuscript paper base
    const pCtx = paperCanvas.getContext('2d');
    if (pCtx) {
      pCtx.fillStyle = '#fafaf8';
      pCtx.fillRect(0, 0, W, H);
    }

    // 2. Authentic manga manuscript print guides (non-photo blue bleed/trim + tombo crop marks)
    const gCtx = guidesCanvas.getContext('2d');
    if (gCtx) {
      // Subtle non-photo blue trim rectangle
      gCtx.strokeStyle = 'rgba(59, 130, 246, 0.22)';
      gCtx.lineWidth = 1;
      gCtx.strokeRect(30.5, 24.5, W - 61, H - 49);

      // Subtle inner safe-area frame (matches outer panel bounds)
      gCtx.strokeStyle = 'rgba(59, 130, 246, 0.14)';
      gCtx.setLineDash([4, 4]);
      gCtx.strokeRect(56.5, 48.5, W - 113, H - 97);
      gCtx.setLineDash([]);

      // Japanese-style manga corner registration marks (tombo)
      gCtx.strokeStyle = 'rgba(20, 20, 20, 0.24)';
      gCtx.lineWidth = 1;
      const mx = 22;
      const my = 18;
      const len = 10;
      const corners = [
        [mx, my, 1, 1],
        [W - mx, my, -1, 1],
        [mx, H - my, 1, -1],
        [W - mx, H - my, -1, -1],
      ];
      for (const [cx, cy, dx, dy] of corners) {
        gCtx.beginPath();
        gCtx.moveTo(cx + 0.5, cy + dy * len + 0.5);
        gCtx.lineTo(cx + 0.5, cy + 0.5);
        gCtx.lineTo(cx + dx * len + 0.5, cy + 0.5);
        gCtx.stroke();
      }

      // Subtle center-edge crop ticks
      gCtx.beginPath();
      gCtx.moveTo(W / 2 + 0.5, 10);
      gCtx.lineTo(W / 2 + 0.5, 20);
      gCtx.moveTo(W / 2 + 0.5, H - 20);
      gCtx.lineTo(W / 2 + 0.5, H - 10);
      gCtx.moveTo(12, H / 2 + 0.5);
      gCtx.lineTo(22, H / 2 + 0.5);
      gCtx.moveTo(W - 22, H / 2 + 0.5);
      gCtx.lineTo(W - 12, H / 2 + 0.5);
      gCtx.stroke();
    }

    // 3. Clean, completely empty manga panel frames
    const bCtx = panelsCanvas.getContext('2d');
    if (bCtx) {
      bCtx.strokeStyle = '#141414';
      bCtx.lineWidth = 2.5;
      bCtx.lineJoin = 'miter';

      // Balanced 4-panel manga page layout (empty frames ready to draw in)
      // Live area: x = 56..904 (848px), y = 48..552 (504px)
      const frames = [
        [56, 48, 498, 240],   // Top-left wide panel
        [56, 312, 240, 240],  // Bottom-left panel
        [314, 312, 240, 240], // Bottom-middle panel
        [572, 48, 332, 504],  // Right tall panel
      ];

      for (const [x, y, w, h] of frames) {
        bCtx.strokeRect(x, y, w, h);
      }
    }

    // 4. Interactive User Drawing Layer (smooth quadratic ink strokes)
    const ctx = userCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const state = {
      tool: 'brush',
      color: '#141414',
      size: 5,
      smooth: 0.5,
      opacity: 1,
      drawing: false,
      lastX: 0,
      lastY: 0,
      midX: 0,
      midY: 0,
      smoothX: 0,
      smoothY: 0,
      lastPressure: 0.5,
      history: [],
    };

    const statusTool = document.getElementById('status-tool');
    const statusSmooth = document.getElementById('status-smoothing');
    const statusCoords = document.getElementById('status-coords');
    const pressureFill = document.getElementById('pressure-fill');
    const pressureVal = document.getElementById('pressure-val');
    const sizeSlider = document.getElementById('brush-size');
    const smoothSlider = document.getElementById('brush-smooth');
    const opacitySlider = document.getElementById('brush-opacity');
    const sizeReadout = document.getElementById('size-readout');
    const smoothReadout = document.getElementById('smooth-readout');
    const opacityReadout = document.getElementById('opacity-readout');
    const swatchIndicator = document.getElementById('active-swatch-indicator');
    const panelsEyeBtn = document.querySelector('.layer-eye[data-layer="panels"]');
    const templateBtns = document.querySelectorAll('.template-btn[data-template]');

    function syncTemplateButtons() {
      const panelsVisible = panelsCanvas.style.visibility !== 'hidden';
      templateBtns.forEach((btn) => {
        const isActive =
          (btn.dataset.template === 'manga' && panelsVisible) ||
          (btn.dataset.template === 'blank' && !panelsVisible);
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
      });
    }

    function setPanelsVisible(visible) {
      panelsCanvas.style.visibility = visible ? 'visible' : 'hidden';
      if (panelsEyeBtn) {
        panelsEyeBtn.classList.toggle('active', visible);
      }
      syncTemplateButtons();
    }

    templateBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        setPanelsVisible(btn.dataset.template === 'manga');
      });
    });

    function pushHistory() {
      if (state.history.length >= 30) state.history.shift();
      state.history.push(ctx.getImageData(0, 0, W, H));
    }

    function undoStroke() {
      const prev = state.history.pop();
      if (prev) {
        ctx.putImageData(prev, 0, 0);
      } else {
        ctx.clearRect(0, 0, W, H);
      }
    }

    function setTool(tool) {
      state.tool = tool;
      document.querySelectorAll('.tool-btn[data-tool]').forEach((b) => {
        b.classList.toggle('active', b.dataset.tool === tool);
      });
      if (statusTool) statusTool.textContent = tool === 'eraser' ? 'Eraser' : 'Brush';
    }

    function setColor(hex) {
      state.color = hex;
      if (swatchIndicator) swatchIndicator.style.background = hex;
      document.querySelectorAll('.swatch').forEach((s) => {
        s.classList.toggle('active', s.dataset.color === hex);
      });
      if (state.tool === 'eraser') setTool('brush');
    }

    function getCanvasPoint(e) {
      const rect = userCanvas.getBoundingClientRect();
      return {
        x: ((e.clientX - rect.left) / rect.width) * W,
        y: ((e.clientY - rect.top) / rect.height) * H,
      };
    }

    let rafId = 0;
    let pendingStatus = null;
    function scheduleStatus(x, y, pressure) {
      pendingStatus = { x, y, pressure };
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        if (!pendingStatus) return;
        if (statusCoords) {
          statusCoords.textContent =
            pendingStatus.x !== null
              ? `${Math.round(pendingStatus.x)}, ${Math.round(pendingStatus.y)} px`
              : '— , —';
        }
        const pct = Math.round((pendingStatus.pressure || 0) * 100);
        if (pressureFill) pressureFill.style.width = `${pct}%`;
        if (pressureVal) pressureVal.textContent = `${pct}%`;
      });
    }

    function strokeCurve(x0, y0, cx, cy, x1, y1, pressure) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const widthScale = 0.35 + pressure * 0.9;
      ctx.lineWidth = Math.max(0.8, state.size * widthScale);

      if (state.tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
        ctx.globalAlpha = 1;
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = state.color;
        ctx.globalAlpha = state.opacity;
      }

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(cx, cy, x1, y1);
      ctx.stroke();
      ctx.restore();
    }

    userCanvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      userCanvas.setPointerCapture(e.pointerId);
      pushHistory();
      const pt = getCanvasPoint(e);
      const pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.65;
      state.drawing = true;
      state.lastX = pt.x;
      state.lastY = pt.y;
      state.midX = pt.x;
      state.midY = pt.y;
      state.smoothX = pt.x;
      state.smoothY = pt.y;
      state.lastPressure = pressure;
      strokeCurve(pt.x, pt.y, pt.x, pt.y, pt.x + 0.05, pt.y + 0.05, pressure);
      scheduleStatus(pt.x, pt.y, pressure);
    });

    userCanvas.addEventListener('pointermove', (e) => {
      const pt = getCanvasPoint(e);
      const rawPressure =
        e.pointerType === 'pen' && e.pressure > 0
          ? e.pressure
          : state.drawing
            ? 0.65
            : 0;

      if (!state.drawing) {
        scheduleStatus(pt.x, pt.y, 0);
        return;
      }

      const alpha = 1 - state.smooth * 0.82;
      const nextX = state.smoothX + (pt.x - state.smoothX) * alpha;
      const nextY = state.smoothY + (pt.y - state.smoothY) * alpha;
      const nextMidX = (state.lastX + nextX) * 0.5;
      const nextMidY = (state.lastY + nextY) * 0.5;
      const pressure = state.lastPressure * 0.6 + rawPressure * 0.4;

      strokeCurve(state.midX, state.midY, state.lastX, state.lastY, nextMidX, nextMidY, pressure);
      state.midX = nextMidX;
      state.midY = nextMidY;
      state.lastX = nextX;
      state.lastY = nextY;
      state.smoothX = nextX;
      state.smoothY = nextY;
      state.lastPressure = pressure;
      scheduleStatus(nextX, nextY, pressure);
    });

    const endStroke = () => {
      if (!state.drawing) return;
      strokeCurve(
        state.midX,
        state.midY,
        state.lastX,
        state.lastY,
        state.lastX,
        state.lastY,
        state.lastPressure
      );
      state.drawing = false;
      scheduleStatus(state.lastX, state.lastY, 0);
    };
    userCanvas.addEventListener('pointerup', endStroke);
    userCanvas.addEventListener('pointercancel', endStroke);
    userCanvas.addEventListener('pointerleave', () => {
      if (!state.drawing) scheduleStatus(null, null, 0);
    });

    // Controls wiring
    document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
      btn.addEventListener('click', () => setTool(btn.dataset.tool));
    });

    const undoBtn = document.getElementById('canvas-undo');
    if (undoBtn) undoBtn.addEventListener('click', undoStroke);

    const clearBtn = document.getElementById('canvas-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        pushHistory();
        ctx.clearRect(0, 0, W, H);
      });
    }

    document.querySelectorAll('.swatch').forEach((btn) => {
      btn.addEventListener('click', () => setColor(btn.dataset.color));
    });

    if (sizeSlider) {
      sizeSlider.addEventListener('input', () => {
        state.size = Number(sizeSlider.value);
        if (sizeReadout) sizeReadout.textContent = `${state.size} px`;
      });
    }

    if (smoothSlider) {
      smoothSlider.addEventListener('input', () => {
        const val = Number(smoothSlider.value);
        state.smooth = val / 100;
        if (smoothReadout) smoothReadout.textContent = `${val}%`;
        if (statusSmooth) statusSmooth.textContent = val > 0 ? 'Stabilized' : 'Direct';
      });
    }

    if (opacitySlider) {
      opacitySlider.addEventListener('input', () => {
        const val = Number(opacitySlider.value);
        state.opacity = val / 100;
        if (opacityReadout) opacityReadout.textContent = `${val}%`;
      });
    }

    document.querySelectorAll('.layer-eye').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.layer;
        const target = layerMap[key];
        if (!target) return;
        const visible = btn.classList.toggle('active');
        target.style.visibility = visible ? 'visible' : 'hidden';
        if (key === 'panels') syncTemplateButtons();
      });
    });

    // Keyboard shortcuts (ignored when typing in inputs)
    window.addEventListener('keydown', (e) => {
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undoStroke();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const key = e.key.toLowerCase();
      if (key === 'b') setTool('brush');
      else if (key === 'e') setTool('eraser');
      else if (key === '[' && sizeSlider) {
        sizeSlider.value = String(Math.max(1, state.size - 2));
        sizeSlider.dispatchEvent(new Event('input'));
      } else if (key === ']' && sizeSlider) {
        sizeSlider.value = String(Math.min(36, state.size + 2));
        sizeSlider.dispatchEvent(new Event('input'));
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initStudioCanvas();
    void initReleases();
  });
})();
