import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabaseClient';

const PDFJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const RENDER_WINDOW = 2;
const CACHE_LIMIT = 10;

let pdfjsLoadPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsLoadPromise) {
    pdfjsLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PDFJS_SRC;
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;
        resolve(window.pdfjsLib);
      };
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  return pdfjsLoadPromise;
}

// Asks the Netlify function for a short-lived signed URL to this book's PDF.
// The function re-checks entitlement (enrollment / student_books) server-side
// with the service-role key — the real storage path never reaches the browser.
async function fetchSignedBookUrl(bookId) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch('/api/get-book-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ bookId }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Could not open book');
  return json.url;
}

// A full-screen page-flip PDF reader: table of contents, in-book search,
// drag/click/keyboard page turns, and a synthesized page-flip sound
// (falls back automatically if /assets/page-flip.mp3 isn't present).
export default function BookReader({ book, onClose }) {
  const rootRef = useRef(null);

  useEffect(() => {
    const root = rootRef.current;
    const $ = (sel) => root.querySelector(sel);

    let pdfDoc = null, totalPages = 0, current = 0;
    let leaves = [], renderedSet = new Set(), pageTextCache = new Map();
    let animatingLeaf = null, dragLeaf = null, dragDir = null;
    let searchMatches = [], searchIdx = -1, currentQuery = '';
    let dragging = false, moved = false, startX = 0, startY = 0;
    let audioCtx = null, audioFileReady = false;
    let resolutionTimer = null;
    let destroyed = false;

    const bookEl = $('#ath-book');
    const stageEl = $('#ath-stage');
    const flipAudioEl = $('#ath-flipAudio');

    flipAudioEl.addEventListener('canplaythrough', () => { audioFileReady = true; });
    flipAudioEl.addEventListener('error', () => { audioFileReady = false; });

    function setLoading(on, label) {
      const overlay = $('#ath-loadingOverlay');
      if (label) $('#ath-loadingLabel').textContent = label;
      overlay.classList.toggle('hidden-fade', !on);
    }

    function bulgeFor(angle) { return 1 - 0.22 * Math.abs(Math.sin(angle * Math.PI / 180)); }
    function shadeFor(angle) { return 0.55 * Math.abs(Math.sin(angle * Math.PI / 180)); }
    function applyAngle(leaf, angle) {
      leaf.style.transform = `rotateY(${angle}deg) scaleX(${bulgeFor(angle)})`;
      const crease = leaf.querySelector('.crease');
      if (crease) crease.style.opacity = shadeFor(angle);
    }
    function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
    function animateTo(leaf, from, to, duration, onDone) {
      const start = performance.now();
      function step(now) {
        if (destroyed) return;
        const t = Math.min(1, (now - start) / duration);
        applyAngle(leaf, from + (to - from) * easeInOutCubic(t));
        if (t < 1) requestAnimationFrame(step); else onDone && onDone();
      }
      requestAnimationFrame(step);
    }

    function buildLeaves() {
      bookEl.innerHTML = '';
      leaves = []; renderedSet.clear(); pageTextCache.clear();
      const spine = document.createElement('div');
      spine.className = 'spine';
      bookEl.appendChild(spine);
      for (let i = 0; i < totalPages; i++) {
        const leaf = document.createElement('div');
        leaf.className = 'leaf';
        leaf.dataset.index = i;
        leaf.style.zIndex = totalPages - i;
        leaf.innerHTML =
          `<div class="leaf-face"><div class="page-content"><div class="page-placeholder">Page ${i + 1}</div></div></div>` +
          `<div class="crease"></div>` +
          `<div class="page-chip">${String(i + 1).padStart(3, '0')} / ${String(totalPages).padStart(3, '0')}</div>`;
        bookEl.appendChild(leaf);
        leaves.push(leaf);
      }
    }

    function layoutLeaves() {
      leaves.forEach((leaf, i) => {
        leaf.style.transformOrigin = i < current ? 'left center' : 'right center';
        applyAngle(leaf, i < current ? -180 : 0);
        leaf.style.zIndex = i < current ? 100 + i : 100 - i;
      });
    }

    async function ensureRendered(centerIdx) {
      const from = Math.max(0, centerIdx - RENDER_WINDOW);
      const to = Math.min(totalPages - 1, centerIdx + RENDER_WINDOW);
      const jobs = [];
      for (let i = from; i <= to; i++) if (!renderedSet.has(i)) jobs.push(renderLeaf(i));
      await Promise.all(jobs);
      evictFar(centerIdx);
    }

    async function renderLeaf(idx) {
      if (renderedSet.has(idx) || destroyed) return;
      renderedSet.add(idx);
      const leaf = leaves[idx];
      const content = leaf.querySelector('.page-content');
      const page = await pdfDoc.getPage(idx + 1);
      if (destroyed) return;

      const cssWidth = content.clientWidth || bookEl.clientWidth || 600;
      const cssHeight = content.clientHeight || bookEl.clientHeight || 800;
      const baseVp = page.getViewport({ scale: 1 });
      const cssScale = cssWidth / baseVp.width;
      const dpr = Math.min(window.devicePixelRatio || 1, 4);
      const vvScale = (window.visualViewport && window.visualViewport.scale) || 1;
      const renderVp = page.getViewport({ scale: cssScale * dpr * vvScale });
      const cssVp = page.getViewport({ scale: cssScale });

      const canvas = document.createElement('canvas');
      canvas.width = renderVp.width;
      canvas.height = renderVp.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: renderVp }).promise;
      if (destroyed) return;

      const textLayer = document.createElement('div');
      textLayer.className = 'text-layer';
      textLayer.style.width = cssVp.width + 'px';
      textLayer.style.height = cssVp.height + 'px';
      const textContent = await page.getTextContent();
      buildTextLayer(textContent, cssVp, textLayer);

      content.innerHTML = '';
      content.appendChild(canvas);
      content.appendChild(textLayer);
    }

    function buildTextLayer(textContent, viewport, container) {
      const frag = document.createDocumentFragment();
      textContent.items.forEach((item) => {
        if (!item.str) return;
        const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
        const angle = Math.atan2(tx[1], tx[0]);
        const fontHeight = Math.hypot(tx[2], tx[3]);
        const span = document.createElement('span');
        span.textContent = item.str;
        span.style.left = tx[4] + 'px';
        span.style.top = (tx[5] - fontHeight) + 'px';
        span.style.fontSize = fontHeight + 'px';
        span.style.fontFamily = 'sans-serif';
        if (angle) span.style.transform = 'rotate(' + angle + 'rad)';
        frag.appendChild(span);
      });
      container.appendChild(frag);
    }

    async function rerenderAtCurrentResolution() {
      const idxs = Array.from(renderedSet);
      renderedSet.clear();
      await Promise.all(idxs.map((i) => renderLeaf(i)));
    }

    function evictFar(centerIdx) {
      if (renderedSet.size <= CACHE_LIMIT) return;
      const sorted = Array.from(renderedSet).sort((a, b) => Math.abs(b - centerIdx) - Math.abs(a - centerIdx));
      while (renderedSet.size > CACHE_LIMIT) {
        const idx = sorted.shift();
        if (Math.abs(idx - centerIdx) <= RENDER_WINDOW) break;
        renderedSet.delete(idx);
        const leaf = leaves[idx];
        if (leaf) leaf.querySelector('.page-content').innerHTML = `<div class="page-placeholder">Page ${idx + 1}</div>`;
      }
    }

    async function next() {
      if (animatingLeaf || current >= totalPages - 1) return;
      playFlipSound();
      const leaf = leaves[current];
      await ensureRendered(current + 1);
      current++;
      animatingLeaf = leaf;
      leaf.style.zIndex = 500;
      leaf.style.transformOrigin = 'left center';
      animateTo(leaf, 0, -180, 700, () => { animatingLeaf = null; layoutLeaves(); ensureRendered(current); });
      updateChrome();
    }
    async function prev() {
      if (animatingLeaf || current <= 0) return;
      playFlipSound();
      current--;
      const leaf = leaves[current];
      await ensureRendered(current);
      animatingLeaf = leaf;
      leaf.style.zIndex = 500;
      leaf.style.transformOrigin = 'right center';
      animateTo(leaf, -180, 0, 700, () => { animatingLeaf = null; layoutLeaves(); ensureRendered(current); });
      updateChrome();
    }
    async function goTo(idx) {
      if (animatingLeaf) return;
      idx = Math.max(0, Math.min(totalPages - 1, idx));
      if (idx === current) return;
      current = idx;
      await ensureRendered(idx);
      layoutLeaves();
      updateChrome();
    }

    function updateChrome() {
      $('#ath-pageIndicator').textContent = (current + 1) + ' / ' + totalPages;
      $('#ath-progressFill').style.width = ((current / Math.max(1, totalPages - 1)) * 100) + '%';
      $('#ath-ribbon').style.height = (((current + 1) / totalPages) * 100) + '%';
      $('#ath-prevBtn').disabled = current === 0;
      $('#ath-nextBtn').disabled = current === totalPages - 1;
    }

    function dragStart(x, y) { startX = x; startY = y; dragging = true; moved = false; dragDir = null; dragLeaf = null; }
    function dragMove(x, y) {
      if (!dragging || animatingLeaf) return;
      const dx = x - startX, dy = y - startY;
      if (Math.abs(dx) < 4) return;
      if (Math.abs(dy) > Math.abs(dx)) return;
      if (dragDir === null) {
        if (dx < 0 && current < totalPages - 1) {
          dragDir = 'forward'; dragLeaf = leaves[current];
          dragLeaf.style.transformOrigin = 'left center'; dragLeaf.style.zIndex = 500;
          ensureRendered(current + 1);
        } else if (dx > 0 && current > 0) {
          dragDir = 'back'; dragLeaf = leaves[current - 1];
          dragLeaf.style.transformOrigin = 'right center'; dragLeaf.style.zIndex = 500;
          ensureRendered(current - 1);
        } else return;
      }
      if (!dragLeaf) return;
      moved = true;
      const w = stageEl.clientWidth;
      const angle = dragDir === 'forward'
        ? Math.max(-180, Math.min(0, (dx / w) * 180))
        : Math.max(-180, Math.min(0, -180 + (dx / w) * 180));
      applyAngle(dragLeaf, angle);
    }
    function dragEnd(x) {
      if (!dragging) return;
      dragging = false;
      if (!dragLeaf) { dragDir = null; return; }
      const dx = x - startX;
      const w = stageEl.clientWidth;
      const threshold = w * 0.28;
      const currentAngle = dragDir === 'forward'
        ? Math.max(-180, Math.min(0, (dx / w) * 180))
        : Math.max(-180, Math.min(0, -180 + (dx / w) * 180));
      const completing = dragDir === 'forward' ? dx < -threshold : dx > threshold;
      const targetAngle = dragDir === 'forward' ? (completing ? -180 : 0) : (completing ? 0 : -180);
      if (completing) playFlipSound();
      if (dragDir === 'forward' && completing) current++;
      if (dragDir === 'back' && completing) current--;
      const leaf = dragLeaf;
      animatingLeaf = leaf; dragLeaf = null; dragDir = null;
      layoutLeaves();
      const remain = Math.abs(targetAngle - currentAngle) / 180;
      animateTo(leaf, currentAngle, targetAngle, Math.max(220, 700 * remain), () => {
        animatingLeaf = null; layoutLeaves(); ensureRendered(current); updateChrome();
      });
      updateChrome();
    }

    async function buildTOC() {
      const list = $('#ath-tocList');
      list.innerHTML = '';
      let outline = null;
      try { outline = await pdfDoc.getOutline(); } catch { outline = null; }
      if (outline && outline.length) {
        const rows = await flattenOutline(outline, 0);
        rows.forEach((row) => list.appendChild(tocRow(row.title, row.pageIndex, row.depth)));
      } else {
        for (let i = 0; i < totalPages; i++) list.appendChild(tocRow('Page ' + (i + 1), i, 0));
      }
    }
    async function flattenOutline(items, depth) {
      let rows = [];
      for (const item of items) {
        let pageIndex = null;
        try {
          let dest = item.dest;
          if (typeof dest === 'string') dest = await pdfDoc.getDestination(dest);
          if (dest) pageIndex = await pdfDoc.getPageIndex(dest[0]);
        } catch { /* unresolvable destination — skip linking, keep label */ }
        rows.push({ title: item.title, pageIndex, depth });
        if (item.items && item.items.length) rows = rows.concat(await flattenOutline(item.items, depth + 1));
      }
      return rows;
    }
    function tocRow(title, pageIndex, depth) {
      const btn = document.createElement('button');
      btn.className = 'w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 flex items-center gap-2 text-sm text-parchment2/85';
      btn.style.paddingLeft = (12 + depth * 16) + 'px';
      btn.innerHTML = `<span class="truncate">${title}</span>`;
      btn.addEventListener('click', () => { if (pageIndex !== null) goTo(pageIndex); closeSidebar(); });
      return btn;
    }

    async function getPageText(idx) {
      if (pageTextCache.has(idx)) return pageTextCache.get(idx);
      const page = await pdfDoc.getPage(idx + 1);
      const tc = await page.getTextContent();
      const str = tc.items.map((i) => i.str).join(' ');
      pageTextCache.set(idx, str);
      return str;
    }
    async function runSearch(query) {
      currentQuery = query.trim().toLowerCase();
      const status = $('#ath-searchStatus');
      clearHighlights();
      if (!currentQuery) { status.textContent = ''; searchMatches = []; return; }
      status.textContent = 'Searching…';
      searchMatches = [];
      for (let i = 0; i < totalPages; i++) {
        const text = (await getPageText(i)).toLowerCase();
        if (text.includes(currentQuery)) searchMatches.push(i);
      }
      searchIdx = 0;
      if (!searchMatches.length) { status.textContent = 'No matches'; return; }
      await jumpToMatch();
    }
    async function jumpToMatch() {
      if (!searchMatches.length) return;
      const idx = searchMatches[searchIdx];
      await goTo(idx);
      await ensureRendered(idx);
      highlightOnLeaf(idx);
      $('#ath-searchStatus').textContent = (searchIdx + 1) + ' of ' + searchMatches.length;
    }
    function nextMatch() { if (!searchMatches.length) return; searchIdx = (searchIdx + 1) % searchMatches.length; jumpToMatch(); }
    function prevMatch() { if (!searchMatches.length) return; searchIdx = (searchIdx - 1 + searchMatches.length) % searchMatches.length; jumpToMatch(); }
    function highlightOnLeaf(idx) {
      clearHighlights();
      const leaf = leaves[idx];
      if (!leaf) return;
      leaf.querySelectorAll('.text-layer span').forEach((span) => {
        if (span.textContent.toLowerCase().includes(currentQuery)) span.classList.add('hit');
      });
    }
    function clearHighlights() { root.querySelectorAll('.text-layer span.hit').forEach((s) => s.classList.remove('hit')); }

    function playSynthFlip() {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const dur = 0.26;
        const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * dur, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
        const noise = audioCtx.createBufferSource();
        noise.buffer = buffer;
        const bp = audioCtx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.setValueAtTime(1100, audioCtx.currentTime);
        bp.frequency.exponentialRampToValueAtTime(2500, audioCtx.currentTime + dur * 0.6);
        bp.Q.value = 0.6;
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.45, audioCtx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
        noise.connect(bp); bp.connect(gain); gain.connect(audioCtx.destination);
        noise.start(); noise.stop(audioCtx.currentTime + dur);
      } catch { /* Web Audio unsupported — stay silent rather than throw */ }
    }
    function playFlipSound() {
      if (audioFileReady) { flipAudioEl.currentTime = 0; flipAudioEl.play().catch(() => playSynthFlip()); }
      else playSynthFlip();
    }

    function openSidebar() { $('#ath-tocSidebar').classList.add('open'); $('#ath-sidebarScrim').classList.add('open'); }
    function closeSidebar() { $('#ath-tocSidebar').classList.remove('open'); $('#ath-sidebarScrim').classList.remove('open'); }
    function openSearch() {
      const bar = $('#ath-searchBar');
      bar.classList.add('open');
      const input = $('#ath-searchInput');
      input.value = ''; $('#ath-searchStatus').textContent = '';
      setTimeout(() => input.focus(), 250);
    }
    function closeSearch() { $('#ath-searchBar').classList.remove('open'); clearHighlights(); }

    async function loadBook() {
      setLoading(true, 'Fetching book…');
      try {
        const url = await fetchSignedBookUrl(book.id);
        if (destroyed) return;
        $('#ath-readerTitle').textContent = book.book_name;

        setLoading(true, 'Opening PDF…');
        await loadPdfJs();
        if (destroyed) return;
        const loadingTask = window.pdfjsLib.getDocument(url);
        pdfDoc = await loadingTask.promise;
        if (destroyed) return;
        totalPages = pdfDoc.numPages;

        const firstPage = await pdfDoc.getPage(1);
        const vp1 = firstPage.getViewport({ scale: 1 });
        bookEl.style.setProperty('--book-ratio', vp1.width + ' / ' + vp1.height);

        buildLeaves();
        current = 0;
        await ensureRendered(0);
        layoutLeaves();
        buildTOC();
        updateChrome();
        setLoading(false);
      } catch (err) {
        console.error('Failed to load book:', err);
        $('#ath-loadingLabel').textContent = err.message || 'Could not load this book — try again.';
      }
    }

    // ---- wire up events -------------------------------------------------
    $('#ath-closeBtn').addEventListener('click', onClose);
    $('#ath-hamburgerBtn').addEventListener('click', openSidebar);
    $('#ath-sidebarCloseBtn').addEventListener('click', closeSidebar);
    $('#ath-sidebarScrim').addEventListener('click', closeSidebar);
    $('#ath-searchBtn').addEventListener('click', () => {
      $('#ath-searchBar').classList.contains('open') ? closeSearch() : openSearch();
    });
    const onSearchKeydown = (e) => { if (e.key === 'Enter') runSearch(e.target.value); if (e.key === 'Escape') closeSearch(); };
    $('#ath-searchInput').addEventListener('keydown', onSearchKeydown);
    $('#ath-searchNext').addEventListener('click', nextMatch);
    $('#ath-searchPrev').addEventListener('click', prevMatch);
    $('#ath-jumpPageBtn').addEventListener('click', () => {
      const v = parseInt($('#ath-jumpPageInput').value, 10);
      if (!isNaN(v)) { goTo(v - 1); closeSidebar(); }
    });
    $('#ath-prevBtn').addEventListener('click', prev);
    $('#ath-nextBtn').addEventListener('click', next);

    const onTouchStart = (e) => { const t = e.changedTouches[0]; dragStart(t.clientX, t.clientY); };
    const onTouchMove = (e) => { const t = e.changedTouches[0]; dragMove(t.clientX, t.clientY); };
    const onTouchEnd = (e) => { const t = e.changedTouches[0]; dragEnd(t.clientX); };
    const onMouseDown = (e) => dragStart(e.clientX, e.clientY);
    const onMouseMove = (e) => { if (dragging) dragMove(e.clientX, e.clientY); };
    const onMouseUp = (e) => { if (dragging) dragEnd(e.clientX); };
    const onBookClick = (e) => { if (moved) return; const w = window.innerWidth; if (e.clientX > w * 0.5) next(); else prev(); };
    const onKeydown = (e) => {
      if (e.key === 'ArrowRight') next();
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'Escape') onClose();
    };
    const onResize = () => { if (totalPages) layoutLeaves(); scheduleResolutionRefresh(); };
    function scheduleResolutionRefresh() {
      if (!totalPages) return;
      clearTimeout(resolutionTimer);
      resolutionTimer = setTimeout(() => { rerenderAtCurrentResolution(); }, 220);
    }

    stageEl.addEventListener('touchstart', onTouchStart, { passive: true });
    stageEl.addEventListener('touchmove', onTouchMove, { passive: true });
    stageEl.addEventListener('touchend', onTouchEnd, { passive: true });
    stageEl.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    bookEl.addEventListener('click', onBookClick);
    document.addEventListener('keydown', onKeydown);
    window.addEventListener('resize', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResolutionRefresh);

    loadBook();

    return () => {
      destroyed = true;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keydown', onKeydown);
      window.removeEventListener('resize', onResize);
      if (window.visualViewport) window.visualViewport.removeEventListener('resize', scheduleResolutionRefresh);
      clearTimeout(resolutionTimer);
      if (pdfDoc) pdfDoc.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id]);

  return (
    <div ref={rootRef} className="ath-reader fixed inset-0 z-50">
      <style>{ATH_STYLES}</style>
      <div id="ath-readerBg" className="absolute inset-0" />

      <header className="glass fixed top-0 left-0 right-0 z-30 flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-2">
          <button id="ath-hamburgerBtn" className="icon-btn" aria-label="Table of contents">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          <button id="ath-searchBtn" className="icon-btn" aria-label="Search in book">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          </button>
        </div>
        <div className="absolute left-1/2 -translate-x-1/2 text-center hidden sm:block">
          <p id="ath-readerTitle" className="font-display text-sm text-parchment2/90 truncate max-w-[40vw]">Loading…</p>
        </div>
        <div className="flex items-center gap-2">
          <span id="ath-pageIndicator" className="font-mono text-[11px] text-brasslight/70 hidden sm:inline">— / —</span>
          <button id="ath-closeBtn" className="icon-btn" aria-label="Close reader">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
      </header>

      <div id="ath-searchBar" className="glass fixed top-16 left-1/2 -translate-x-1/2 z-30 w-[min(92vw,420px)] rounded-full px-4 py-2 flex items-center gap-2 border border-white/10 shadow-card">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8C6F42" strokeWidth="2" strokeLinecap="round" className="shrink-0"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
        <input id="ath-searchInput" type="text" placeholder="Search this book…" className="flex-1 bg-transparent outline-none text-sm text-parchment placeholder:text-parchment2/40" />
        <span id="ath-searchStatus" className="font-mono text-[10px] text-brasslight/60 whitespace-nowrap" />
        <button id="ath-searchPrev" className="icon-btn !w-7 !h-7" aria-label="Previous match">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <button id="ath-searchNext" className="icon-btn !w-7 !h-7" aria-label="Next match">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </div>

      <div id="ath-sidebarScrim" className="fixed inset-0 z-30 bg-black/50" />
      <aside id="ath-tocSidebar" className="fixed top-0 left-0 bottom-0 z-40 w-[min(84vw,320px)] bg-ink2 border-r border-white/10 flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <p className="font-mono text-[11px] tracking-[.2em] text-brass uppercase">Contents</p>
          <button id="ath-sidebarCloseBtn" className="icon-btn !w-8 !h-8" aria-label="Close contents">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="font-mono text-[10px] text-parchment2/40 uppercase tracking-wide">Jump to</span>
          <input id="ath-jumpPageInput" type="number" min="1" placeholder="#" className="w-16 bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-brasslight outline-none focus:border-brass/60" />
          <button id="ath-jumpPageBtn" className="text-xs text-brass hover:text-brasslight">Go</button>
        </div>
        <div id="ath-tocList" className="brass-scroll flex-1 overflow-y-auto px-2 py-2" />
      </aside>

      <div id="ath-stage" className="absolute inset-0 flex items-center justify-center px-4" style={{ paddingTop: 96, paddingBottom: 84 }}>
        <div className="book" id="ath-book" style={{ height: 'min(78vh, 880px)' }} />
      </div>

      <div id="ath-loadingOverlay" className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4">
        <svg className="spinner" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#B08D57" strokeWidth="2.4">
          <circle cx="12" cy="12" r="9" strokeOpacity=".25" />
          <path d="M21 12a9 9 0 0 0-9-9" />
        </svg>
        <p id="ath-loadingLabel" className="font-mono text-[11px] tracking-[.15em] text-brasslight/70 uppercase">Fetching book…</p>
      </div>

      <footer className="glass fixed bottom-0 left-0 right-0 z-30 border-t border-white/5 px-4 py-3">
        <div className="flex items-center justify-center gap-5">
          <button id="ath-prevBtn" className="icon-btn" aria-label="Previous page">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M15 5l-7 7 7 7" /></svg>
          </button>
          <div className="w-[min(50vw,320px)] h-[3px] rounded-full bg-white/10 relative overflow-hidden">
            <div id="ath-progressFill" className="absolute inset-y-0 left-0 bg-brass" style={{ width: '0%' }} />
          </div>
          <button id="ath-nextBtn" className="icon-btn" aria-label="Next page">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M9 5l7 7-7 7" /></svg>
          </button>
        </div>
      </footer>

      <div className="fixed right-0 top-16 bottom-16 z-30 w-[3px] bg-white/5">
        <div id="ath-ribbon" className="absolute top-0 left-0 w-full" style={{ height: '0%' }} />
      </div>

      <audio id="ath-flipAudio" preload="auto">
        <source src="/assets/page-flip.mp3" type="audio/mpeg" />
      </audio>
    </div>
  );
}

// Scoped, self-contained CSS (colors/fonts hard-coded so this never depends on
// the app's Tailwind config) — ported from the original Athenaeum stylesheet.
const ATH_STYLES = `
.ath-reader{ --book-ratio: 3 / 4; font-family: Inter, ui-sans-serif, sans-serif; }
.ath-reader .font-display{ font-family: 'Fraunces', ui-serif, serif; }
.ath-reader .font-mono{ font-family: 'JetBrains Mono', ui-monospace, monospace; }
.ath-reader .text-parchment{ color:#F6EFDD; }
.ath-reader .text-parchment2\\/90{ color:rgba(234,224,196,.9); }
.ath-reader .text-parchment2\\/40{ color:rgba(234,224,196,.4); }
.ath-reader .text-parchment2\\/85{ color:rgba(234,224,196,.85); }
.ath-reader .placeholder\\:text-parchment2\\/40::placeholder{ color:rgba(234,224,196,.4); }
.ath-reader .text-brass{ color:#B08D57; }
.ath-reader .text-brasslight{ color:#D7BA84; }
.ath-reader .text-brasslight\\/70{ color:rgba(215,186,132,.7); }
.ath-reader .text-brasslight\\/60{ color:rgba(215,186,132,.6); }
.ath-reader .bg-brass{ background:#B08D57; }
.ath-reader .bg-ink2{ background:#1C1811; }
.ath-reader .border-brass\\/60:focus{ border-color:rgba(176,141,87,.6); }
.ath-reader .icon-btn{ width:38px; height:38px; border-radius:9999px; display:flex; align-items:center; justify-content:center; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.12); color:#D7BA84; transition:background .15s, transform .1s; }
.ath-reader .icon-btn:hover{ background:rgba(255,255,255,.12); }
.ath-reader .icon-btn:active{ transform:scale(.94); }
.ath-reader .icon-btn:disabled{ opacity:.35; }
.ath-reader .glass{ background:rgba(20,17,13,.72); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); }
.ath-reader .shadow-card{ box-shadow:0 30px 60px -20px rgba(0,0,0,.6); }
.ath-reader .spinner{ animation:ath-spin 1s linear infinite; }
@keyframes ath-spin{ to{ transform:rotate(360deg); } }
.ath-reader .fade{ transition:opacity .35s ease; }
.ath-reader .hidden-fade{ opacity:0; pointer-events:none; }
.ath-reader .brass-scroll::-webkit-scrollbar{ width:6px; }
.ath-reader .brass-scroll::-webkit-scrollbar-thumb{ background:#8C6F42; border-radius:99px; }
.ath-reader .brass-scroll::-webkit-scrollbar-track{ background:transparent; }

#ath-stage{ perspective: 2400px; }
.ath-reader .book{ position:relative; aspect-ratio: var(--book-ratio); transform-style: preserve-3d; }
.ath-reader .leaf{ position:absolute; inset:0; transform-style:preserve-3d; backface-visibility:hidden; transform-origin:left center; background:#F6EFDD; border-radius:2px; overflow:hidden; }
.ath-reader .leaf .leaf-face{ position:absolute; inset:0; background: repeating-linear-gradient(135deg, rgba(176,141,87,.05) 0 2px, transparent 2px 6px), #F6EFDD; }
.ath-reader .leaf .page-content{ position:absolute; top:0; bottom:0; left:5mm; right:5mm; overflow:hidden; display:flex; align-items:center; justify-content:center; }
.ath-reader .leaf .page-content::before{ content:''; position:absolute; top:0; bottom:0; left:-5mm; width:5mm; background:linear-gradient(90deg, rgba(0,0,0,.16), transparent); pointer-events:none; }
.ath-reader .leaf canvas{ display:block; width:100%; height:100%; object-fit:contain; }
.ath-reader .leaf .text-layer{ position:absolute; inset:0; line-height:1; overflow:hidden; opacity:1; }
.ath-reader .leaf .text-layer span{ position:absolute; white-space:pre; color:transparent; transform-origin:0% 0%; cursor:text; }
.ath-reader .leaf .text-layer span.hit{ background:rgba(168,50,50,.38); border-radius:2px; }
.ath-reader .leaf .crease{ position:absolute; inset:0; z-index:5; pointer-events:none; background:linear-gradient(90deg, transparent 0%, rgba(0,0,0,.55) 48%, rgba(0,0,0,.55) 52%, transparent 100%); opacity:0; mix-blend-mode:multiply; }
.ath-reader .leaf .page-chip{ position:absolute; bottom:10px; right:14px; font-family:'JetBrains Mono',monospace; font-size:10px; color:#8C6F42; letter-spacing:.05em; }
.ath-reader .leaf .page-placeholder{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#8C6F4266; font-family:'JetBrains Mono',monospace; font-size:11px; }
.ath-reader .spine{ position:absolute; top:-1.5%; bottom:-1.5%; left:-9px; width:20px; border-radius:4px 1px 1px 4px; background:linear-gradient(90deg, #100D09 0%, #241F16 30%, #1C1811 55%, #0d0a07 100%); box-shadow: inset -5px 0 12px rgba(0,0,0,.65), inset 2px 0 3px rgba(255,255,255,.04), -6px 0 20px rgba(0,0,0,.55); z-index:1000; pointer-events:none; }
.ath-reader .spine::after{ content:''; position:absolute; top:6%; bottom:6%; left:52%; width:2px; background:linear-gradient(180deg, transparent, #B08D57 12%, #B08D57 88%, transparent); opacity:.55; }
#ath-readerBg{ background: radial-gradient(ellipse 60% 50% at 50% 38%, #241F16 0%, #14110D 62%), #14110D; }
#ath-tocSidebar{ transform:translateX(-100%); transition:transform .35s cubic-bezier(.65,0,.35,1); }
#ath-tocSidebar.open{ transform:translateX(0); }
#ath-sidebarScrim{ opacity:0; pointer-events:none; transition:opacity .3s; }
#ath-sidebarScrim.open{ opacity:1; pointer-events:auto; }
#ath-searchBar{ transform:translateY(-140%); opacity:0; transition:transform .3s ease, opacity .25s ease; }
#ath-searchBar.open{ transform:translateY(0); opacity:1; }
#ath-ribbon{ background:linear-gradient(to bottom, #B08D57, #8C6F42); box-shadow:0 0 14px rgba(176,141,87,.5); }
@media (prefers-reduced-motion: reduce){ .ath-reader .leaf, #ath-tocSidebar, #ath-searchBar{ transition:none !important; } }
`;
