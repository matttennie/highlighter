(() => {
  'use strict';
  // If the same version is already loaded, skip. 
  // If a different version (e.g. after reload) is loaded, we allow this one to 
  // take over but we try to avoid double-initializing as much as possible.
  if (window.__highlighterTtsExtensionId === chrome.runtime.id) {
    return;
  }
  window.__highlighterTtsExtensionId = chrome.runtime.id;
  window.__highlighterTtsContentLoaded = true;

  // ── Constants ──────────────────────────────────────────────────────
  const DEFAULT_VOICE_ID = 'bf_emma';
  const CURSOR_SIZE      = 22;
  const LINE_TOLERANCE   = 14;  // for END line detection (confirmed working)
  // Kokoro's supported synthesis range. 16 detents in 0.1 increments.
  // Math.round avoids float-arithmetic drift (0.5 + 7*0.1 !== 1.2 in
  // IEEE 754) that would break SPEEDS.indexOf checks.
  const SPEEDS = Array.from({ length: 16 }, (_, i) => Math.round((0.5 + i * 0.1) * 100) / 100);
  const SPEED_DEFAULT_INDEX = SPEEDS.indexOf(1.2); // 7
  const TTS_TIMEOUT_MS   = 35000; // FIX 7: response timeout
  const AUDIO_START_TIMEOUT_MS = 8000;
  const BASE64_CHUNK_SIZE = 8192;
  const LOG_PREFIX       = '[Highlighter TTS]';
  const PREFETCH_LOOKAHEAD = 1;     // sentences after the currently-playing one
  const SKIP_DEBOUNCE_MS = 250;     // collapse rapid skip taps into one synth call
  const AUDIO_CACHE_LIMIT = 12;     // LRU bound on cached sentence audio
  // Kokoro truncates synthesis around 512 phoneme tokens (~450 chars); we cap
  // well below that so worst-case per-request synth stays roughly 10-14s on slow
  // CPUs. Longer sentences are split at clause boundaries so nothing is lost;
  // the chunks share the original sentence's Range, so highlighting is unaffected.
  const SENTENCE_CHUNK_LIMIT = 160;
  // Natural playback pacing: brief pause between sentences, longer at
  // paragraph breaks. Applies only to automatic advancement (onAudioEnded) —
  // user-initiated skip/play remain instant.
  const SENTENCE_PAUSE_MS = 250;
  const PARAGRAPH_PAUSE_MS = 500;

  // ── State ──────────────────────────────────────────────────────────
  let highlightMode = false;
  let isPainting    = false;
  let strokePoints  = [];

  // Playback state: sentences resolved from the last stroke
  let pbSentences   = [];   // [{text, range, startLineY, endLineY}]
  let pbIndex       = 0;    // which sentence skip-back/fwd navigates

  // Suppress the click event that fires immediately after a stroke mouseup,
  // so it doesn't dismiss the player we just showed.
  let suppressNextClick = false;

  // Article mode — filters nav/ads/footer from sentence collection
  let articleModeEnabled = true; // default matches popup toggle (checked)

  // ── Audio playback state ──────────────────────────────────────────
  let pbAudio       = null;   // current Audio element
  let pbAudioObjectUrl = null;
  let pbState       = 'idle'; // 'idle' | 'loading' | 'playing' | 'paused' | 'error'
  let pbRequestId   = 0;      // monotonic counter to discard stale TTS responses
  let cachedVoice   = DEFAULT_VOICE_ID; // FIX 8: use constant
  let cachedSpeed   = 1.2;

  // Wave B: request-cancellation protocol. Every tts-request carries a unique
  // clientRequestId; when a request is superseded (skip, new stroke, timeout,
  // voice/speed change) we tell the offscreen synth queue to skip it so it never
  // spends 3-7s synthesizing audio nobody is waiting for.
  let ttsClientSeq = 0;
  // Ids must be unique across content-script reloads in the same tab —
  // the offscreen document's cancelled-id set outlives this script (up to
  // 15 min), and ttsClientSeq resets to 0 on every load. Composing a
  // per-load nonce into the id stops a fresh id from colliding with a
  // lingering cancelled one after a same-tab navigation.
  const ttsSessionNonce = Math.random().toString(36).slice(2, 8);
  const inflightTtsIds = new Set();

  // Wave B (I2): when a cancel reaches the CURRENT still-wanted request (a
  // voice/speed change that cancelled a queued foreground load), re-issue
  // rather than stall in 'loading'. Bounded so a genuinely stuck engine
  // falls back to the system voice instead of looping forever.
  let cancelledRetryCount = 0;

  // Session-level fallback policy (A4): after two engine failures (timeout or
  // error) in one reading session, stop hitting the engine and read the rest
  // with the system voice. Reset on a new stroke and on a successful Kokoro
  // response. sessionFallbackToastShown makes the "using system voice" notice
  // fire at most once per session.
  let sessionFallbackCount = 0;
  let sessionFallbackToastShown = false;

  // ── Audio cache + prefetch ────────────────────────────────────────
  // Per-sentence cache so skip-back / pre-fetched-N+1 don't burn extra synth calls.
  // Insertion-ordered Map gives us cheap LRU when we delete the oldest entry on overflow.
  const audioCache = new Map();      // sentenceIdx → { audioDataUrl, voice, speed }
  const pendingPrefetch = new Map(); // sentenceIdx → { token: { cancelled }, voice, speed, waiter }
  let prefetchGeneration = 0;        // bumped on voice/speed change to drop stale results
  let skipDebounceTimer = 0;
  let pendingSkipTarget = -1;
  let advanceTimer = 0; // scheduled auto-advance during a between-sentence pause

  function logDebug(event, details = {}) {
    const payload = {
      page: location.href,
      state: pbState,
      requestId: pbRequestId,
      ...details,
    };
    console.log(`${LOG_PREFIX} ${event}`, payload);
    persistDebugEvent('content', event, payload);
  }

  function persistDebugEvent(source, event, details = {}) {
    if (!chrome?.runtime?.sendMessage) return;
    try {
      chrome.runtime.sendMessage(
        {
          type: 'debug-event',
          entry: {
            ts: new Date().toISOString(),
            source,
            event,
            details,
          },
        },
        () => {
          // Suppress "receiving end does not exist" noise if the worker is asleep/reloading.
          void chrome.runtime.lastError;
        }
      );
    } catch (e) {
      // Extension context invalidated — silent fail to avoid console noise
    }
  }

  // ── Load settings and listen for changes ──────────────────────────
  chrome.storage.local.get(
    ['articleMode', 'defaultVoice', 'defaultSpeed'],
    (data) => {
      const storageError = chrome.runtime.lastError?.message || null;
      if (storageError) {
        logDebug('settings-load-failed', { error: storageError });
        return;
      }
      if (data.articleMode !== undefined) articleModeEnabled = data.articleMode;
      if (data.defaultVoice) cachedVoice = data.defaultVoice;
      if (data.defaultSpeed) cachedSpeed = parseFloat(data.defaultSpeed) || 1.0;
      logDebug('settings-loaded', {
        articleModeEnabled,
        cachedVoice,
        cachedSpeed,
      });
    }
  );
  chrome.storage.onChanged.addListener((changes) => {
    const relevantChangedKeys = [];

    if (changes.articleMode) {
      articleModeEnabled = changes.articleMode.newValue;
      relevantChangedKeys.push('articleMode');
    }
    if (changes.defaultVoice) {
      cachedVoice = changes.defaultVoice.newValue;
      relevantChangedKeys.push('defaultVoice');
    }
    if (changes.defaultSpeed) {
      cachedSpeed = parseFloat(changes.defaultSpeed.newValue) || 1.0;
      relevantChangedKeys.push('defaultSpeed');
    }

    if (!relevantChangedKeys.length) return;

    logDebug('settings-changed', {
      changedKeys: relevantChangedKeys,
      cachedVoice,
      cachedSpeed,
      articleModeEnabled,
    });
  });

  // ── DOM elements (lazily created) ──────────────────────────────────
  let cursorEl      = null;
  let strokeOverlay = null;
  let strokePath    = null;
  let indicatorEl   = null;
  let playerEl      = null;
  let menuPanelEl   = null;
  let toastEl       = null;
  let toastTimer    = 0;

  // ── Initialization ─────────────────────────────────────────────────
  function ensureElements() {
    if (cursorEl) return;

    cursorEl = document.createElement('div');
    cursorEl.className = 'highlighter-cursor';
    cursorEl.style.width  = CURSOR_SIZE + 'px';
    cursorEl.style.height = CURSOR_SIZE + 'px';
    document.documentElement.appendChild(cursorEl);

    strokeOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    strokeOverlay.classList.add('highlighter-stroke-overlay');
    document.documentElement.appendChild(strokeOverlay);

    strokePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    strokePath.setAttribute('fill', 'none');
    strokePath.setAttribute('stroke', 'rgba(180, 130, 255, 0.5)');
    strokePath.setAttribute('stroke-width', CURSOR_SIZE.toString());
    strokePath.setAttribute('stroke-linecap', 'round');
    strokePath.setAttribute('stroke-linejoin', 'round');
    strokeOverlay.appendChild(strokePath);

    indicatorEl = document.createElement('div');
    indicatorEl.className = 'highlighter-indicator';
    indicatorEl.textContent = 'Highlight Mode';
    document.documentElement.appendChild(indicatorEl);

    buildPlayer();

    toastEl = document.createElement('div');
    toastEl.className = 'hltr-toast';
    document.documentElement.appendChild(toastEl);
  }

  // ── Mode toggle ────────────────────────────────────────────────────
  function enterHighlightMode() {
    if (highlightMode) return;
    ensureElements();
    highlightMode = true;
    document.documentElement.classList.add('highlighter-mode');
    indicatorEl.classList.add('visible');
    logDebug('highlight-mode-entered');
  }

  function exitHighlightMode() {
    if (!highlightMode) return;
    highlightMode = false;
    isPainting    = false;
    strokePoints  = [];
    document.documentElement.classList.remove('highlighter-mode');
    if (indicatorEl) indicatorEl.classList.remove('visible');
    clearStroke();
    logDebug('highlight-mode-exited');
  }

  function toggleHighlightMode() {
    highlightMode ? exitHighlightMode() : enterHighlightMode();
  }

  // ── Stroke rendering ───────────────────────────────────────────────
  function buildPathData(points) {
    if (!points.length) return '';
    if (points.length === 1) {
      return `M${points[0].x},${points[0].y}L${points[0].x + 0.1},${points[0].y}`;
    }
    let d = `M${points[0].x},${points[0].y}`;
    for (let i = 1; i < points.length; i++) d += `L${points[i].x},${points[i].y}`;
    return d;
  }

  function renderStroke() {
    if (strokePath) strokePath.setAttribute('d', buildPathData(strokePoints));
  }

  function clearStroke() {
    strokePoints = [];
    if (strokePath) strokePath.setAttribute('d', '');
  }

  // ── Text selection resolution ──────────────────────────────────────
  function estimateLineHeight(pt) {
    const el = document.elementFromPoint(pt.x, pt.y);
    if (!el) return 24;
    const style = window.getComputedStyle(el);
    const lh = parseFloat(style.lineHeight);
    // Cap at 48px — large headings can report huge line heights that would
    // make the start-tolerance so wide it reaches lines far above the stroke.
    if (!isNaN(lh) && lh >= 8 && lh <= 48) return lh;
    const fs = parseFloat(style.fontSize) || 16;
    return Math.min(fs * 1.5, 48);
  }

  // ── DOM range hit-test for stroke start ───────────────────────────
  /**
   * Returns the index of the first sentence the stroke start point falls on.
   *
   * Three paths:
   *   1. Reliable caret  — caretRangeFromPoint snapped to the correct line;
   *                        use Range.compareBoundaryPoints for exact match.
   *   2. Blank space     — caret snapped to a line ABOVE topPt (inter-paragraph
   *                        gap); find first sentence just at/after topPt.y.
   *   3. No caret        — geometry fallback with estimated lineHeight tolerance.
   */
  function findFirstSentenceIdx(sentences, topPt, lineHeight) {
    let caretRange = null;
    if (document.caretRangeFromPoint) {
      caretRange = document.caretRangeFromPoint(topPt.x, topPt.y);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(topPt.x, topPt.y);
      if (pos) {
        caretRange = document.createRange();
        caretRange.setStart(pos.offsetNode, pos.offset);
        caretRange.collapse(true);
      }
    }

    if (caretRange) {
      const rects  = caretRange.getClientRects();
      const caretY = rects.length ? rects[0].top : null;

      if (caretY !== null) {
        // Line height of the element the caret actually snapped to
        const node  = caretRange.startContainer;
        const el    = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        const style = el ? window.getComputedStyle(el) : null;
        const lh    = style ? parseFloat(style.lineHeight) : NaN;
        const fs    = style ? parseFloat(style.fontSize)   : NaN;
        const caretLH = (!isNaN(lh) && lh > 0) ? lh
                      : ((!isNaN(fs) && fs > 0) ? fs * 1.4 : 24);

        if (caretY <= topPt.y + 4 && topPt.y < caretY + caretLH) {
          // ── Path 1: caret on the correct line ─────────────────────────
          for (let i = 0; i < sentences.length; i++) {
            try {
              const startCmp = sentences[i].range.compareBoundaryPoints(
                Range.START_TO_START, caretRange);
              const endCmp   = sentences[i].range.compareBoundaryPoints(
                Range.END_TO_START, caretRange);
              if (startCmp <= 0 && endCmp >= 0) return i;
            } catch { continue; }
          }
          // Caret is past all sentence content — return first sentence after caret
          for (let i = 0; i < sentences.length; i++) {
            try {
              if (sentences[i].range.compareBoundaryPoints(
                  Range.START_TO_START, caretRange) >= 0) return i;
            } catch { continue; }
          }
          return sentences.length - 1;
        }

        if (topPt.y >= caretY + caretLH) {
          // ── Path 2: caret snapped to line ABOVE topPt (blank space) ───
          // Do NOT use wide lineHeight tolerance here — that's the bug.
          // Find the first sentence at or just below topPt.y.
          const idx = sentences.findIndex(s => s.startLineY >= topPt.y - 6);
          return idx !== -1 ? idx : sentences.length - 1;
        }
      }
    }

    // ── Path 3: no caret available — geometry fallback ────────────────
    const tol = Math.min(lineHeight - 1, 47);
    return sentences.findIndex(s => s.startLineY >= topPt.y - tol);
  }

  function resolveAndSelect(startPt, endPt) {
    stopPlayback(); // A1: a new stroke retires the previous reading session —
    // bump pbRequestId so late/in-flight TTS responses from the old highlight are
    // discarded (they can't poison the freshly-cleared cache via a stale closure
    // idx, and can't play old text over the new selection); also release the
    // audio element and cancel any system-voice speech that was mid-utterance.
    const topPt = startPt.y <= endPt.y ? startPt : endPt;
    const botPt = startPt.y <= endPt.y ? endPt   : startPt;

    const sentences = collectSentences();
    if (!sentences.length) return;

    const lineHeight = estimateLineHeight(topPt);

    const firstIdx = findFirstSentenceIdx(sentences, topPt, lineHeight);
    if (firstIdx === -1) return;

    const botY = getLineTopAtPoint(botPt);

    let lastIdx = -1;
    for (let i = firstIdx; i < sentences.length; i++) {
      if (sentences[i].endLineY > botY + LINE_TOLERANCE) break;
      if (sentences[i].endLineY <= botY + LINE_TOLERANCE) lastIdx = i;
    }
    if (lastIdx === -1) return;

    const selected = sentences.slice(firstIdx, lastIdx + 1);
    try {
      const range = document.createRange();
      range.setStart(selected[0].range.startContainer, selected[0].range.startOffset);
      range.setEnd(selected[selected.length - 1].range.endContainer,
                   selected[selected.length - 1].range.endOffset);

      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);

      // Store sentences for playback navigation
      pbSentences = selected.flatMap(splitLongSentence);
      pbIndex     = 0;
      // New stroke = entirely different sentence array; old cache is meaningless.
      cancelSkipDebounce();
      invalidateAudioCache('new-stroke');
      // A4: fresh session — clear the fallback policy so the engine gets a clean
      // chance on this highlight even if the previous one gave up on it.
      sessionFallbackCount = 0;
      sessionFallbackToastShown = false;
      cancelledRetryCount = 0;

      showPlayer();
    } catch (e) {
      console.error('[Highlighter] Selection error:', e);
    }
  }

  function getLineTopAtPoint(pt) {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(pt.x, pt.y);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(pt.x, pt.y);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
        range.collapse(true);
      }
    }
    if (range) {
      const rects = range.getClientRects();
      if (rects.length) return rects[0].top;
    }
    const el = document.elementFromPoint(pt.x, pt.y);
    return el ? el.getBoundingClientRect().top : pt.y;
  }

  // ── Article mode helpers ──────────────────────────────────────────
  function getContentRoot() {
    return document.querySelector('main, [role="main"], article') || document.body;
  }

  function isNonContent(el) {
    return el.closest(
      'nav, header, footer, aside, ' +
      '[role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]'
    ) !== null;
  }

  // Split text into chunks of at most `limit` chars, preferring clause
  // boundaries (,;:—) and falling back to the last space before the limit.
  // Exposed shape mirrors tests/test-tts.js#splitLongSentenceText.
  function splitLongSentenceText(text, limit) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (trimmed.length <= limit) return trimmed ? [trimmed] : [];
    const chunks = [];
    let rest = trimmed;
    while (rest.length > limit) {
      const window = rest.slice(0, limit);
      let cut = -1;
      for (const m of window.matchAll(/[,;:—]/g)) cut = m.index;
      if (cut < 1) cut = window.lastIndexOf(' ');
      if (cut < 1) cut = limit - 1; // no boundary at all — hard split
      chunks.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) chunks.push(rest);
    return chunks.filter(Boolean);
  }

  // A sentence longer than the synth limit becomes several playback entries
  // sharing the original Range, so highlighting still covers the full
  // sentence while its chunks play back-to-back.
  function splitLongSentence(sentence) {
    if (!sentence || typeof sentence.text !== 'string' || sentence.text.length <= SENTENCE_CHUNK_LIMIT) {
      return [sentence];
    }
    return splitLongSentenceText(sentence.text, SENTENCE_CHUNK_LIMIT)
      .map((chunkText, chunkIndex) => ({ ...sentence, text: chunkText, continuation: chunkIndex > 0 }));
  }

  // ── Sentence collection ────────────────────────────────────────────
  function collectSentences() {
    const results = [];
    const seen    = new Set();
    // Per-block counter — sentences from the same block share this value so
    // pauseBeforeNext can tell a paragraph break from a sentence boundary.
    let blockIdx  = 0;

    const root = articleModeEnabled ? getContentRoot() : document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (!textNode.textContent.trim()) continue;
      const block = nearestLeafBlock(textNode);
      if (!block || seen.has(block)) continue;
      seen.add(block);
      if (!isElementVisible(block)) continue;
      if (articleModeEnabled && isNonContent(block)) continue;
      const sents = extractSentencesFromBlock(block);
      if (!sents.length) continue;
      for (const s of sents) { s.blockIdx = blockIdx; results.push(s); }
      blockIdx++;
    }

    results.sort((a, b) => a.startLineY - b.startLineY);
    return results;
  }

  const BLOCK_DISPLAYS = new Set([
    'block', 'flex', 'grid', 'list-item',
    'table', 'table-row', 'table-cell', 'table-caption',
  ]);

  function nearestLeafBlock(textNode) {
    let el = textNode.parentElement;
    while (el && el !== document.body) {
      const display = window.getComputedStyle(el).display;
      if (BLOCK_DISPLAYS.has(display)) {
        let hasBlockChild = false;
        for (const child of el.children) {
          if (BLOCK_DISPLAYS.has(window.getComputedStyle(child).display)) {
            hasBlockChild = true;
            break;
          }
        }
        if (!hasBlockChild) return el;
        return textNode.parentElement;
      }
      el = el.parentElement;
    }
    return textNode.parentElement;
  }

  function isElementVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function extractSentencesFromBlock(el) {
    const text = el.textContent;
    if (!text.trim()) return [];

    const results    = [];
    // `.` is a terminator EXCEPT when it sits between two digits — that keeps
    // version numbers (3.1.56), decimals (3.14), IPs, and currency intact.
    const sentenceRe = /[^!?…]*?(?:[!?…]+|\.(?!\d)|(?<!\d)\.)+["'”’]?\s*/g;
    let match, consumed = 0;

    while ((match = sentenceRe.exec(text)) !== null) {
      const raw = match[0];
      const trimmed = stripLeadingNoise(raw.trim());
      if (!hasReadableContent(trimmed)) { consumed = match.index + raw.length; continue; }
      const charStart = match.index;
      const charEnd   = match.index + raw.length;
      consumed = charEnd;

      const range = charOffsetsToRange(el, charStart, charEnd);
      if (!range) continue;
      const rects = range.getClientRects();
      if (!rects.length) continue;

      results.push({
        text: trimmed,
        range,
        startLineY: rects[0].top,
        endLineY:   rects[rects.length - 1].top,
      });
    }

    const tail = stripLeadingNoise(text.slice(consumed).trim());
    // Skip pure-punctuation tails (e.g. ":)" left after a paragraph) — TTS
    // engines either error or pronounce them literally ("colon close-paren").
    if (hasReadableContent(tail)) {
      const range = charOffsetsToRange(el, consumed, text.length);
      if (range) {
        const rects = range.getClientRects();
        if (rects.length) {
          results.push({
            text: tail,
            range,
            startLineY: rects[0].top,
            endLineY:   rects[rects.length - 1].top,
          });
        }
      }
    }

    return results;
  }

  // True when the string contains at least one letter or digit. Used to drop
  // punctuation-only "sentences" before they reach the TTS engine.
  function hasReadableContent(text) {
    return /[\p{L}\p{N}]/u.test(text);
  }

  // Strip leading non-word noise (smileys like ":)", em-dashes, arrows, stray
  // punctuation that survived a paragraph break) but preserve opening quotes
  // and parens so quoted/parenthetical sentences still read naturally.
  function stripLeadingNoise(text) {
    return text.replace(/^[^\p{L}\p{N}"'(\[«„“‘]+/u, '');
  }

  function charOffsetsToRange(container, charStart, charEnd) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let pos = 0, startNode = null, startOff = 0, endNode = null, endOff = 0, node;

    while ((node = walker.nextNode())) {
      const len = node.textContent.length;
      if (!startNode && pos + len > charStart) {
        startNode = node;
        startOff  = charStart - pos;
      }
      if (!endNode && pos + len >= charEnd) {
        endNode = node;
        endOff  = charEnd - pos;
        break;
      }
      pos += len;
    }

    if (!startNode || !endNode) return null;
    try {
      const range = document.createRange();
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      return range;
    } catch { return null; }
  }

  // ── Floating player ────────────────────────────────────────────────
  function buildPlayer() {
    // ── Player pill ──
    playerEl = document.createElement('div');
    playerEl.className = 'hltr-player';
    playerEl.innerHTML = `
      <button class="hltr-btn hltr-highlight-btn" title="Toggle highlight mode">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M15.2 3.2a2.5 2.5 0 0 1 3.54 0l2.06 2.06a2.5 2.5 0 0 1 0 3.54l-8.95 8.95-4.66 1.12 1.12-4.66zM6.5 19.5h11v2h-11z"/>
        </svg>
      </button>
      <button class="hltr-btn hltr-skip-back" title="Previous sentence">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor">
          <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>
        </svg>
      </button>
      <button class="hltr-btn hltr-play-pause" title="Play">
        <svg class="hltr-icon-play" viewBox="0 0 24 24" width="21" height="21" fill="currentColor">
          <path d="M8 5v14l11-7z"/>
        </svg>
        <svg class="hltr-icon-pause" viewBox="0 0 24 24" width="21" height="21" fill="currentColor" style="display:none">
          <path d="M6 19h4V5H6zm8-14v14h4V5z"/>
        </svg>
      </button>
      <button class="hltr-btn hltr-skip-fwd" title="Next sentence">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor">
          <path d="M6 18l8.5-6L6 6v12zm2-8.14L11.03 12 8 14.14V9.86zM16 6h2v12h-2z"/>
        </svg>
      </button>
      <div class="hltr-divider"></div>
      <button class="hltr-btn hltr-menu-btn" title="Settings">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor">
          <circle cx="5" cy="12" r="1.8"/>
          <circle cx="12" cy="12" r="1.8"/>
          <circle cx="19" cy="12" r="1.8"/>
        </svg>
      </button>
      <button class="hltr-btn hltr-close-btn" title="Close player">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
          <path d="M18.3 5.71 12 12l6.3 6.29-1.41 1.41L10.59 13.4 4.29 19.7 2.88 18.29 9.17 12 2.88 5.71 4.29 4.29l6.3 6.3 6.29-6.3z"/>
        </svg>
      </button>
    `;
    document.documentElement.appendChild(playerEl);

    // ── Menu panel ──
    menuPanelEl = document.createElement('div');
    menuPanelEl.className = 'hltr-menu-panel';
    menuPanelEl.innerHTML = `
      <div class="hltr-menu-row">
        <label class="hltr-menu-label">Voice</label>
        <select class="hltr-voice-select"></select>
      </div>
      <div class="hltr-menu-row">
        <label class="hltr-menu-label">Speed</label>
        <div class="hltr-speed-row">
          <input type="range" class="hltr-speed-slider" min="0" max="${SPEEDS.length - 1}" step="1" value="${SPEED_DEFAULT_INDEX}">
          <span class="hltr-speed-label">1.2x</span>
        </div>
      </div>
    `;
    document.documentElement.appendChild(menuPanelEl);

    // Load saved settings into menu controls
    chrome.storage.local.get(['defaultVoice', 'defaultSpeed'], (data) => {
      const storageError = chrome.runtime.lastError?.message || null;
      if (storageError) {
        logDebug('player-settings-load-failed', { error: storageError });
        return;
      }
      const voiceSelect = menuPanelEl.querySelector('.hltr-voice-select');
      ensureVoiceOption(voiceSelect, data.defaultVoice || cachedVoice, 'Configured voice');
      loadVoiceOptions(voiceSelect, data.defaultVoice || cachedVoice);

      if (data.defaultVoice) {
        if (voiceSelect) voiceSelect.value = data.defaultVoice;
      }
      if (data.defaultSpeed) {
        // Snap any saved value (legacy or current) to the nearest 0.05 detent.
        const saved = parseFloat(data.defaultSpeed);
        if (Number.isFinite(saved)) {
          const idx = nearestSpeedIndex(saved);
          menuPanelEl.querySelector('.hltr-speed-slider').value = idx;
          menuPanelEl.querySelector('.hltr-speed-label').textContent = formatSpeedLabel(SPEEDS[idx]);
        }
      }
    });

    // Button wiring
    playerEl.querySelector('.hltr-skip-back').addEventListener('click', (e) => {
      e.stopPropagation();
      navigateSentence(-1);
    });
    playerEl.querySelector('.hltr-highlight-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHighlightMode();
    });
    playerEl.querySelector('.hltr-play-pause').addEventListener('click', (e) => {
      e.stopPropagation();
      onPlayPause();
    });
    playerEl.querySelector('.hltr-skip-fwd').addEventListener('click', (e) => {
      e.stopPropagation();
      navigateSentence(+1);
    });
    playerEl.querySelector('.hltr-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMenu();
    });
    playerEl.querySelector('.hltr-close-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      window.getSelection()?.removeAllRanges();
      hidePlayer();
    });

    // Speed slider
    const slider = menuPanelEl.querySelector('.hltr-speed-slider');
    const speedLbl = menuPanelEl.querySelector('.hltr-speed-label');
    slider.addEventListener('input', () => {
      const speed = SPEEDS[parseInt(slider.value)];
      const changed = speed !== cachedSpeed;
      if (changed) invalidateAudioCache('speed-changed');
      cachedSpeed = speed;
      speedLbl.textContent = formatSpeedLabel(speed);
      // I2(b): invalidation cancelled any queued foreground load; if we were
      // mid-load, re-issue immediately with the new speed so the cancelled
      // request is replaced rather than left stalling in 'loading'.
      if (changed && pbState === 'loading') playSentence(pbIndex);
      chrome.storage.local.set({ defaultSpeed: speed.toString() }, () => {
        const storageError = chrome.runtime.lastError?.message || null;
        if (storageError) logDebug('speed-save-failed', { error: storageError });
      });
    });

    // Voice select
    menuPanelEl.querySelector('.hltr-voice-select').addEventListener('change', (e) => {
      const changed = e.target.value !== cachedVoice;
      if (changed) invalidateAudioCache('voice-changed');
      cachedVoice = e.target.value;
      // I2(b): same as the speed slider — replace a cancelled queued load with
      // the new voice instead of stalling in 'loading'.
      if (changed && pbState === 'loading') playSentence(pbIndex);
      chrome.storage.local.set({ defaultVoice: e.target.value }, () => {
        const storageError = chrome.runtime.lastError?.message || null;
        if (storageError) logDebug('voice-save-failed', { error: storageError });
      });
    });

    // Drag
    playerEl.addEventListener('mousedown', onPlayerDragStart);

    // Close menu when clicking outside
    document.addEventListener('mousedown', (e) => {
      if (menuPanelEl.classList.contains('hltr-visible') &&
          !menuPanelEl.contains(e.target) &&
          !playerEl.contains(e.target)) {
        closeMenu();
      }
    }, true);
  }

  // ── Player positioning & visibility ───────────────────────────────
  function showPlayer() {
    if (!playerEl) return;
    // Restore saved position, or default to top-right (near the indicator badge)
    chrome.storage.local.get('playerPos', (data) => {
      const storageError = chrome.runtime.lastError?.message || null;
      if (storageError) {
        logDebug('player-position-load-failed', { error: storageError });
        data = {};
      }
      const pw = playerEl.offsetWidth  || 200;
      const ph = playerEl.offsetHeight || 54;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const margin = 12;

      let left, top;
      if (data.playerPos) {
        // Clamp saved position in case viewport size changed
        left = Math.max(margin, Math.min(data.playerPos.left, vw - pw - margin));
        top  = Math.max(margin, Math.min(data.playerPos.top,  vh - ph - margin));
      } else {
        // Default: top-right, same corner as the "Highlight Mode" badge
        left = vw - pw - margin;
        top  = margin;
      }

      playerEl.style.left = left + 'px';
      playerEl.style.top  = top  + 'px';
      playerEl.classList.add('hltr-visible');
      logDebug('player-shown', {
        left,
        top,
        sentenceCount: pbSentences.length,
      });
    });
  }

  function hidePlayer() {
    if (!playerEl) return;
    logDebug('player-hidden');
    stopPlayback();
    cancelSkipDebounce();
    invalidateAudioCache('player-hidden');
    playerEl.classList.remove('hltr-visible');
    closeMenu();
    pbSentences = [];
    pbIndex     = 0;
  }

  // ── Menu ───────────────────────────────────────────────────────────
  function toggleMenu() {
    menuPanelEl.classList.contains('hltr-visible') ? closeMenu() : openMenu();
  }

  function openMenu() {
    if (!playerEl || !menuPanelEl) return;
    const pr  = playerEl.getBoundingClientRect();
    const mpw = 230;
    const mph = menuPanelEl.offsetHeight || 110;
    const vw  = window.innerWidth;
    const vh  = window.innerHeight;

    let top  = pr.top - mph - 8;
    if (top < 8) top = pr.bottom + 8;
    top = Math.max(8, Math.min(top, vh - mph - 8));

    let left = pr.left + (pr.width - mpw) / 2;
    left = Math.max(8, Math.min(left, vw - mpw - 8));

    menuPanelEl.style.left  = left + 'px';
    menuPanelEl.style.top   = top  + 'px';
    menuPanelEl.style.width = mpw  + 'px';
    menuPanelEl.classList.add('hltr-visible');
  }

  function closeMenu() {
    if (menuPanelEl) menuPanelEl.classList.remove('hltr-visible');
  }

  // ── Player drag ────────────────────────────────────────────────────
  let _dragOffX = 0, _dragOffY = 0;

  function onPlayerDragStart(e) {
    // Don't start drag if clicking a button
    if (e.target.closest('.hltr-btn')) return;
    e.preventDefault();
    playerEl.classList.add('hltr-dragging');
    const rect = playerEl.getBoundingClientRect();
    _dragOffX = e.clientX - rect.left;
    _dragOffY = e.clientY - rect.top;
    document.addEventListener('mousemove', onPlayerDragMove, true);
    document.addEventListener('mouseup',   onPlayerDragEnd,  true);
  }

  function onPlayerDragMove(e) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = playerEl.offsetWidth;
    const ph = playerEl.offsetHeight;
    let left = e.clientX - _dragOffX;
    let top  = e.clientY - _dragOffY;
    left = Math.max(0, Math.min(left, vw - pw));
    top  = Math.max(0, Math.min(top,  vh - ph));
    playerEl.style.left = left + 'px';
    playerEl.style.top  = top  + 'px';
    // Reposition menu if open
    if (menuPanelEl.classList.contains('hltr-visible')) openMenu();
  }

  function onPlayerDragEnd() {
    playerEl.classList.remove('hltr-dragging');
    document.removeEventListener('mousemove', onPlayerDragMove, true);
    document.removeEventListener('mouseup',   onPlayerDragEnd,  true);
    // Persist position so it survives page reloads and new Chrome sessions
    chrome.storage.local.set({
      playerPos: {
        left: parseInt(playerEl.style.left, 10),
        top:  parseInt(playerEl.style.top,  10),
      }
    }, () => {
      const storageError = chrome.runtime.lastError?.message || null;
      if (storageError) logDebug('player-position-save-failed', { error: storageError });
    });
  }

  // ── Sentence navigation ────────────────────────────────────────────
  function navigateSentence(delta) {
    if (!pbSentences.length) return;
    const newIdx = Math.max(0, Math.min(pbSentences.length - 1, pbIndex + delta));
    if (newIdx === pbIndex) return;

    // Visual feedback is immediate even if audio waits for debounce.
    pbIndex = newIdx;
    highlightSentence(newIdx);

    // Don't trigger playback unless we were already in an active session.
    if (pbState !== 'playing' && pbState !== 'loading') return;

    const voice = currentVoiceForPlayback();
    const speed = currentSpeedForPlayback();

    // Cache hit → play immediately, no debounce gap.
    if (getCachedAudio(newIdx, voice, speed)) {
      cancelSkipDebounce();
      playSentence(newIdx);
      return;
    }

    // Cache miss → debounce so rapid skips only fire one synth call (the destination).
    releaseCurrentAudioElement();
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    pbRequestId++; // invalidate any in-flight playback request
    // Wave B: cancel the superseded synth now, BEFORE the debounced settle path
    // mints a new clientRequestId in playSentence — so we skip the request we're
    // abandoning without ever cancelling the one we're about to send.
    cancelInflightTts();
    setPlaybackState('loading');

    pendingSkipTarget = newIdx;
    if (skipDebounceTimer) clearTimeout(skipDebounceTimer);
    skipDebounceTimer = setTimeout(() => {
      skipDebounceTimer = 0;
      // If user kept skipping past this target, abandon this firing.
      if (pendingSkipTarget !== pbIndex) return;
      pendingSkipTarget = -1;
      logDebug('skip-settled', { idx: pbIndex });
      playSentence(pbIndex);
    }, SKIP_DEBOUNCE_MS);
  }

  function cancelSkipDebounce() {
    if (skipDebounceTimer) {
      clearTimeout(skipDebounceTimer);
      skipDebounceTimer = 0;
    }
    pendingSkipTarget = -1;
  }

  // ── Cache helpers ─────────────────────────────────────────────────
  function getCachedAudio(idx, voice, speed) {
    const entry = audioCache.get(idx);
    if (!entry) return null;
    if (entry.voice !== voice || entry.speed !== speed) return null;
    // Re-insert to mark as most-recently-used.
    audioCache.delete(idx);
    audioCache.set(idx, entry);
    return entry.audioDataUrl;
  }

  function setCachedAudio(idx, voice, speed, audioDataUrl) {
    if (!audioDataUrl) return;
    audioCache.set(idx, { audioDataUrl, voice, speed });
    while (audioCache.size > AUDIO_CACHE_LIMIT) {
      const oldestKey = audioCache.keys().next().value;
      audioCache.delete(oldestKey);
    }
  }

  function invalidateAudioCache(reason) {
    // Any synth still in flight for the old voice/speed/stroke is now stale —
    // cancel it before the early-return, since the cache/prefetch maps can be
    // empty while a foreground playSentence request is still queued offscreen.
    cancelInflightTts();
    if (audioCache.size === 0 && pendingPrefetch.size === 0) return;
    logDebug('audio-cache-invalidated', { reason, cached: audioCache.size, pending: pendingPrefetch.size });
    audioCache.clear();
    cancelAllPrefetches();
  }

  function cancelAllPrefetches() {
    prefetchGeneration++; // any in-flight prefetch responses will check this and discard
    // Release any playSentence that joined a prefetch we're dropping: mark the
    // token cancelled (so the waiter treats this as a teardown, not a retry —
    // the caller owns the next request) and resolve the waiter with null so it
    // clears its timeout and never hangs in 'loading'.
    for (const entry of pendingPrefetch.values()) {
      entry.token.cancelled = true;
      const waiter = entry.waiter;
      entry.waiter = null;
      if (waiter) waiter(null);
    }
    pendingPrefetch.clear();
  }

  // Wave B: tell the offscreen synth queue to skip requests we no longer want.
  // Fire-and-forget — the background drops the cancel entirely if the offscreen
  // document isn't running, and a stale/duplicate id is harmless on the far end.
  function cancelInflightTts() {
    if (inflightTtsIds.size === 0) return;
    const clientRequestIds = [...inflightTtsIds];
    inflightTtsIds.clear();
    try {
      chrome.runtime.sendMessage({ type: 'tts-cancel', clientRequestIds }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      // Extension context invalidated — nothing left to cancel against.
    }
  }

  function currentVoiceForPlayback() {
    return menuPanelEl
      ? (menuPanelEl.querySelector('.hltr-voice-select')?.value || cachedVoice)
      : cachedVoice;
  }

  function currentSpeedForPlayback() {
    const slider = menuPanelEl ? menuPanelEl.querySelector('.hltr-speed-slider') : null;
    if (!slider) return cachedSpeed;
    const idx = parseInt(slider.value, 10);
    return SPEEDS[idx] ?? cachedSpeed;
  }

  function prefetchSentence(idx, voice, speed) {
    if (idx < 0 || idx >= pbSentences.length) return;
    // A4: policy engaged — don't queue engine work the session won't use.
    if (sessionFallbackCount >= 2) return;
    if (audioCache.has(idx)) return;
    if (pendingPrefetch.has(idx)) return;
    if (!pbSentences[idx] || !pbSentences[idx].text) return;

    const myGen = prefetchGeneration;
    const token = { cancelled: false };
    // Entry records voice/speed so a cache-missed playSentence can JOIN this
    // in-flight synth (identical params) instead of firing a duplicate
    // tts-request the serial offscreen queue would only run after we finish.
    // `waiter` is the single joined callback (null until a playSentence joins).
    const entry = { token, voice, speed, waiter: null };
    pendingPrefetch.set(idx, entry);

    const text = pbSentences[idx].text;
    const startedAt = performance.now();
    const clientRequestId = `${ttsSessionNonce}:${++ttsClientSeq}`;
    inflightTtsIds.add(clientRequestId);
    logDebug('prefetch-start', { idx, voice, speed, textLength: text.length });

    chrome.runtime.sendMessage(
      { type: 'tts-request', text, voice, speed, clientRequestId },
      (response) => {
        inflightTtsIds.delete(clientRequestId);
        pendingPrefetch.delete(idx);
        // Hand our result to a playSentence that joined this prefetch, if any.
        // Resolve exactly once: null on any failure/cancel/stale, the audio url
        // on success. A superseded joiner is filtered by its own requestId guard.
        const waiter = entry.waiter;
        entry.waiter = null;
        const elapsedMs = Math.round(performance.now() - startedAt);
        if (token.cancelled || myGen !== prefetchGeneration) {
          logDebug('prefetch-discarded', { idx, elapsedMs, reason: token.cancelled ? 'cancelled' : 'stale-gen' });
          if (waiter) waiter(null);
          return;
        }
        if (chrome.runtime.lastError || !response?.ok || !response.audioDataUrl) {
          // A7: a cancelled request is expected and quiet (forward-compat with
          // Wave B) — don't log it as a failure, don't touch the session policy.
          if (response?.error === 'cancelled') {
            logDebug('prefetch-cancelled', { idx, elapsedMs });
            if (waiter) waiter(null);
            return;
          }
          logDebug('prefetch-failed', {
            idx,
            elapsedMs,
            error: response?.error || chrome.runtime.lastError?.message || 'no-response',
            status: response?.status || null,
          });
          if (waiter) waiter(null);
          return;
        }
        setCachedAudio(idx, voice, speed, response.audioDataUrl);
        logDebug('prefetch-cached', { idx, elapsedMs, audioBase64Length: response.audioDataUrl.length });
        if (waiter) waiter(response.audioDataUrl);
      }
    );
  }

  function maybePrefetchAhead(currentIdx, voice, speed) {
    for (let off = 1; off <= PREFETCH_LOOKAHEAD; off++) {
      prefetchSentence(currentIdx + off, voice, speed);
    }
  }

  function highlightSentence(idx) {
    const s = pbSentences[idx];
    if (!s) return;
    try {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(s.range.cloneRange());
    } catch { /* ignore */ }
  }

  // ── Audio playback ────────────────────────────────────────────────
  // A6: while loading, poll the engine once a second; when it's downloading the
  // voice model, surface the percentage on the play button's tooltip (title
  // only — no new DOM). The poller lives exactly as long as the 'loading' state.
  let loadingStatusPoller = 0;

  function startLoadingStatusPoll() {
    if (loadingStatusPoller) return; // already polling
    loadingStatusPoller = setInterval(() => {
      if (pbState !== 'loading') { stopLoadingStatusPoll(); return; }
      chrome.runtime.sendMessage({ type: 'engine-status-request' }, (status) => {
        void chrome.runtime.lastError;
        if (pbState !== 'loading' || !playerEl) return;
        const playBtn = playerEl.querySelector('.hltr-play-pause');
        if (!playBtn) return;
        if (status?.status === 'downloading' && typeof status.progress === 'number') {
          // Warm weights come from disk cache — that's a wake-up, not a download.
          playBtn.title = status.warm
            ? `Waking up voice engine — ${status.progress}%`
            : `Downloading voice model — ${status.progress}%`;
        }
      });
    }, 1000);
  }

  function stopLoadingStatusPoll() {
    if (loadingStatusPoller) {
      clearInterval(loadingStatusPoller);
      loadingStatusPoller = 0;
    }
  }

  function setPlaybackState(state) {
    const prevState = pbState;
    pbState = state;
    logDebug('playback-state', { from: prevState, to: state });

    // A6: run the download-progress poller only while loading; every other state
    // (including the idle set by stopPlayback/hidePlayer) tears it down.
    if (state === 'loading') startLoadingStatusPoll();
    else stopLoadingStatusPoll();

    if (!playerEl) return;

    const playIcon  = playerEl.querySelector('.hltr-icon-play');
    const pauseIcon = playerEl.querySelector('.hltr-icon-pause');
    const playBtn   = playerEl.querySelector('.hltr-play-pause');

    playerEl.classList.remove('hltr-error');
    playBtn.classList.remove('hltr-loading');

    switch (state) {
      case 'idle':
        playIcon.style.display  = '';
        pauseIcon.style.display = 'none';
        playBtn.title = 'Play';
        break;
      case 'loading':
        playIcon.style.display  = 'none';
        pauseIcon.style.display = 'none';
        playBtn.classList.add('hltr-loading');
        playBtn.title = 'Loading\u2026';
        break;
      case 'playing':
        playIcon.style.display  = 'none';
        pauseIcon.style.display = '';
        playBtn.title = 'Pause';
        break;
      case 'paused':
        playIcon.style.display  = '';
        pauseIcon.style.display = 'none';
        playBtn.title = 'Resume';
        break;
      case 'error':
        playIcon.style.display  = '';
        pauseIcon.style.display = 'none';
        playerEl.classList.add('hltr-error');
        playBtn.title = 'Retry';
        break;
    }
  }

  function onPlayPause() {
    switch (pbState) {
      case 'idle':
      case 'error':
        if (!pbSentences.length) return;
        playSentence(pbIndex);
        break;
      case 'loading':
        stopPlayback();
        break;
      case 'playing':
        pausePlayback();
        break;
      case 'paused':
        resumePlayback();
        break;
    }
  }

  function playSentence(idx) {
    const startedAt = performance.now();
    // FIX 2: Cancel any active speechSynthesis before starting a new sentence
    if (window.speechSynthesis) window.speechSynthesis.cancel();

    // FIX 3: Stop any current audio and properly release resources
    releaseCurrentAudioElement();

    if (idx < 0 || idx >= pbSentences.length) {
      setPlaybackState('idle');
      return;
    }

    cancelSkipDebounce();
    pbIndex = idx;
    highlightSentence(idx);
    setPlaybackState('loading');

    const requestId = ++pbRequestId;

    // Read current voice/speed from the in-page menu controls
    const voice = currentVoiceForPlayback();
    const speed = currentSpeedForPlayback();
    const text = pbSentences[idx].text;

    // Cache hit → skip the network roundtrip entirely. Cached audio is real
    // Kokoro output that was already synthesized, so we play it even when the
    // session fallback policy is engaged (it's free and correct).
    const cachedUrl = getCachedAudio(idx, voice, speed);
    if (cachedUrl) {
      logDebug('tts-cache-hit', { idx, voice, speed });
      cancelledRetryCount = 0; // a real (cached) Kokoro response is playing
      playAudioDataUrl(cachedUrl, requestId, speed, text);
      maybePrefetchAhead(idx, voice, speed);
      return;
    }

    // A4: session fallback policy — after two engine failures this session, skip
    // the round-trip entirely and read with the system voice. requestId is
    // already the fresh, current pbRequestId, so fallback's own guard passes.
    if (sessionFallbackCount >= 2) {
      if (!sessionFallbackToastShown) {
        sessionFallbackToastShown = true;
        showPlayerWarning('Using system voice for the rest of this reading');
      }
      logDebug('session-fallback-engaged', { idx, sessionFallbackCount });
      fallbackSpeechSynthesis(text, speed, requestId);
      return;
    }

    logDebug('tts-request-start', {
      idx,
      voice,
      speed,
      textLength: text.length,
    });

    // FIX 7: Set a timeout so we don't hang in 'loading' forever if the
    // background worker dies or the network request stalls.
    const responseTimeout = setTimeout(() => {
      // Staleness guard: if the user already skipped/re-stroked, this timeout
      // belongs to an abandoned request — do nothing.
      if (requestId !== pbRequestId) return;
      logDebug('tts-request-timeout', {
        idx,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      // A2: invalidate the in-flight request NOW. The original tts-request's
      // sendMessage callback may still fire late with real Kokoro audio; bumping
      // here means the response handler's staleness guard discards it instead of
      // playing it over the system-voice fallback. The late response is dropped
      // entirely — deliberately NOT cache-warmed, because its stale closure `idx`
      // indexes the OLD pbSentences and would poison the cache after a new stroke.
      pbRequestId++;
      cancelInflightTts(); // Wave B: skip the timed-out synth if it is still queued offscreen
      const fallbackId = pbRequestId;
      // A3: honest toast — ask the engine why it's slow (~100ms round-trip is
      // fine), then read with the system voice under the freshly-bumped id.
      chrome.runtime.sendMessage({ type: 'engine-status-request' }, (status) => {
        void chrome.runtime.lastError;
        // User moved on during the status round-trip — abandon this fallback.
        if (fallbackId !== pbRequestId) return;
        const isDownloading = status?.status === 'downloading';
        // I3: a transient model download is fast and self-resolving — falling
        // back this sentence is fine, but don't latch the whole session onto the
        // system voice for it (that would stop probing and mask recovery). Only
        // count genuine slowness (engine already ready) toward the policy.
        if (!isDownloading) sessionFallbackCount++;
        const msg = (isDownloading &&
                     typeof status.progress === 'number' && status.progress > 0)
          ? `Downloading voice model (${status.progress}%) — reading with system voice`
          : 'Voice engine is taking longer than usual — reading with system voice';
        showPlayerWarning(msg);
        fallbackSpeechSynthesis(text, speed, fallbackId);
      });
    }, TTS_TIMEOUT_MS);

    // ── Latency fix: JOIN an in-flight prefetch instead of double-synthesizing ──
    // If a prefetch for this exact sentence is already synthesizing (measured:
    // sentence N ends while prefetch(N+1) is still in flight), wait on it rather
    // than firing a second identical tts-request the serial offscreen queue would
    // only process AFTER the prefetch finishes — the bug behind the 13-27s
    // inter-sentence gaps. Only join when voice+speed match; otherwise the
    // prefetch's result is cache-key-mismatched and useless to us.
    const pending = pendingPrefetch.get(idx);
    if (pending && pending.voice === voice && pending.speed === speed) {
      logDebug('tts-join-prefetch', { idx, voice, speed });
      // Overwriting any prior waiter is safe: it belonged to a superseded
      // playSentence whose requestId guard will discard its resolution.
      pending.waiter = (audioDataUrl) => {
        // Whichever fires first — this resolution or the shared timeout — wins;
        // clear the timeout so a delivered join doesn't later trip the fallback.
        clearTimeout(responseTimeout);
        // Superseded (skip / new stroke / menu change bumped pbRequestId) — the
        // newer request owns playback; discard exactly like the sendMessage guard.
        if (requestId !== pbRequestId) return;
        if (audioDataUrl) {
          // The prefetch delivered real Kokoro audio — engine healthy, and it
          // already ran setCachedAudio, so just play and prefetch ahead.
          sessionFallbackCount = 0;
          sessionFallbackToastShown = false;
          cancelledRetryCount = 0;
          playAudioDataUrl(audioDataUrl, requestId, speed, text);
          maybePrefetchAhead(idx, voice, speed);
        } else if (pending.token.cancelled) {
          // Teardown nulled the prefetch (a voice/speed change re-issues on its
          // own; stop/hide already went idle) — the caller owns the next
          // request; firing one here would resurrect the duplicate-synth bug.
        } else {
          // The prefetch's OWN request failed — retry once through the front
          // door. The failed entry is already deleted, so this won't re-join.
          playSentence(idx);
        }
      };
      return;
    }

    const clientRequestId = `${ttsSessionNonce}:${++ttsClientSeq}`;
    inflightTtsIds.add(clientRequestId);
    chrome.runtime.sendMessage(
      { type: 'tts-request', text, voice, speed, clientRequestId },
      (response) => {
        inflightTtsIds.delete(clientRequestId);
        // FIX 7: Clear the timeout — we got a response
        clearTimeout(responseTimeout);

        // Discard stale responses (user skipped or cancelled)
        if (requestId !== pbRequestId) return;

        logDebug('tts-response', {
          idx,
          ok: Boolean(response?.ok),
          error: response?.error || null,
          status: response?.status || null,
          elapsedMs: Math.round(performance.now() - startedAt),
          runtimeError: chrome.runtime.lastError?.message || null,
        });

        if (chrome.runtime.lastError || !response || !response.ok) {
          // I2(a): reaching the 'cancelled' branch here means the staleness
          // guard above already passed (requestId === pbRequestId), so a cancel
          // caught the CURRENT, still-wanted request — the known path is a
          // voice/speed change cancelling a queued foreground load. Re-issue
          // with a fresh id rather than stalling in 'loading'; cap the retries
          // so a genuinely stuck engine still falls back to the system voice.
          if (response?.error === 'cancelled') {
            logDebug('tts-cancelled-current', { idx, retries: cancelledRetryCount });
            if (cancelledRetryCount < 2) {
              cancelledRetryCount++;
              playSentence(idx);
            } else {
              showPlayerWarning('Voice engine busy — using system voice');
              fallbackSpeechSynthesis(text, speed, ++pbRequestId);
            }
            return;
          }
          console.error('[Highlighter TTS] Response failure:', {
            runtimeError: chrome.runtime.lastError?.message || null,
            response,
          });
          const runtimeError = chrome.runtime.lastError?.message || null;
          const errMsg = runtimeError
            ? 'Extension error: ' + runtimeError
            : getErrorMessage(response);
          const details = buildErrorDetails(response, {
            voice, speed, requestId, runtimeError,
          });
          console.warn(LOG_PREFIX, errMsg, '— falling back to speechSynthesis');
          // A4: engine round-trip failed — count it toward the session policy.
          // I3: except 'model-loading' — that's fast and self-resolving, so we
          // fall back for THIS sentence but don't latch the whole session onto
          // the system voice (which would stop probing and hide recovery).
          if (response?.error !== 'model-loading') sessionFallbackCount++;
          showPlayerWarning(errMsg, details);
          fallbackSpeechSynthesis(text, speed, requestId);
          return;
        }

        // FIX 4: Validate audioDataUrl before attempting playback
        if (!response.audioDataUrl) {
          showPlayerError('Empty audio response', buildErrorDetails(response, { voice, speed, requestId }));
          return;
        }

        // A4: a fresh Kokoro response succeeded — the engine is healthy, so clear
        // the session fallback policy and re-arm its one-shot toast.
        sessionFallbackCount = 0;
        sessionFallbackToastShown = false;
        cancelledRetryCount = 0; // engine delivered — reset the I2 retry budget

        // Stash for skip-back / replay; no extra round-trip if we revisit.
        setCachedAudio(idx, voice, speed, response.audioDataUrl);
        playAudioDataUrl(response.audioDataUrl, requestId, speed, text);
        maybePrefetchAhead(idx, voice, speed);
      }
    );
  }

  function pausePlayback() {
    if (pbAudio) pbAudio.pause();
    else if (window.speechSynthesis) window.speechSynthesis.pause();
    setPlaybackState('paused');
  }

  function resumePlayback() {
    if (pbAudio) {
      pbAudio.play()
        .then(() => setPlaybackState('playing'))
        .catch(() => showPlayerError('Playback failed'));
    } else if (window.speechSynthesis && window.speechSynthesis.paused) {
      window.speechSynthesis.resume();
      setPlaybackState('playing');
    } else {
      playSentence(pbIndex);
    }
  }

  function playAudioDataUrl(dataUrl, requestId, speed, text) {
    // FIX 1: Capture requestId in closure so the ended handler can check staleness
    const capturedId = requestId;
    const audioUrl = audioDataUrlToObjectUrl(dataUrl) || dataUrl;
    pbAudioObjectUrl = audioUrl.startsWith('blob:') ? audioUrl : null;
    pbAudio = new Audio(audioUrl);
    // Speed is applied by Kokoro during synthesis; double-applying
    // playbackRate here would compound the rate and degrade pitch.
    pbAudio.playbackRate = 1.0;

    let started = false;
    let usingFallback = false;
    const audioStartTimeout = setTimeout(() => {
      if (capturedId !== pbRequestId || started || usingFallback) return;
      usingFallback = true;
      logDebug('audio-start-timeout', {
        requestId: capturedId,
        readyState: pbAudio?.readyState ?? null,
      });
      releaseCurrentAudioElement();
      fallbackSpeechSynthesis(text, speed, capturedId);
    }, AUDIO_START_TIMEOUT_MS);

    pbAudio.addEventListener('loadedmetadata', () => {
      if (capturedId !== pbRequestId || usingFallback || !pbAudio) return;
      logDebug('audio-loadedmetadata', {
        requestId: capturedId,
        duration: Number.isFinite(pbAudio.duration) ? Math.round(pbAudio.duration * 1000) / 1000 : null,
        readyState: pbAudio.readyState,
      });
    });

    pbAudio.addEventListener('canplay', () => {
      if (capturedId !== pbRequestId || usingFallback || !pbAudio) return;
      logDebug('audio-canplay', { requestId: capturedId, readyState: pbAudio.readyState });
    });

    pbAudio.addEventListener('playing', () => {
      if (capturedId !== pbRequestId || usingFallback) return;
      started = true;
      clearTimeout(audioStartTimeout);
      logDebug('audio-playing', { requestId: capturedId });
      setPlaybackState('playing');
    }, { once: true });

    // FIX 1: Stale-request guard on ended event prevents double-advance on skip
    pbAudio.addEventListener('ended', () => {
      if (capturedId !== pbRequestId || usingFallback) return;
      clearTimeout(audioStartTimeout);
      logDebug('audio-ended', { requestId: capturedId });
      releaseAudioObjectUrl();
      onAudioEnded();
    }, { once: true });

    // FIX 5: Fall back to speechSynthesis on Audio error (CSP pages)
    // On strict-CSP pages, data: URI audio fails. Instead of just showing
    // an error, fall back to the browser's built-in speech synthesis.
    pbAudio.addEventListener('error', () => {
      if (capturedId !== pbRequestId || usingFallback) return;
      usingFallback = true;
      clearTimeout(audioStartTimeout);
      const errCode = pbAudio?.error?.code ?? null;
      const errMessage = pbAudio?.error?.message || null;
      logDebug('audio-error', {
        requestId: capturedId,
        code: errCode,
        message: errMessage,
        readyState: pbAudio?.readyState ?? null,
        srcKind: pbAudioObjectUrl ? 'blob' : 'data',
      });
      // Surface diagnostics so we can tell a CSP block apart from a malformed payload.
      const details = buildErrorDetails(
        { error: 'audio-element-error', detail: errMessage || `MediaError code ${errCode}` },
        { voice: cachedVoice, speed, requestId: capturedId, audioErrorCode: errCode, srcKind: pbAudioObjectUrl ? 'blob' : 'data' }
      );
      showPlayerWarning('Site security restricted audio; using system voice', details);
      releaseCurrentAudioElement();
      fallbackSpeechSynthesis(text, speed, capturedId);
    }, { once: true });

    pbAudio.play()
      .then(() => {
        if (capturedId !== pbRequestId || usingFallback || !pbAudio) return;
        started = true;
        clearTimeout(audioStartTimeout);
        logDebug('audio-play-resolved', { requestId: capturedId });
        if (pbState === 'loading') setPlaybackState('playing');
      })
      .catch((err) => {
        if (capturedId !== pbRequestId || usingFallback) return;
        usingFallback = true;
        clearTimeout(audioStartTimeout);
        logDebug('audio-play-rejected', {
          requestId: capturedId,
          message: err?.message || String(err),
          name: err?.name || null,
        });
        // FIX 5: Also fall back on play() promise rejection (another CSP vector)
        const details = buildErrorDetails(
          { error: 'audio-play-rejected', detail: err?.message || String(err) },
          { voice: cachedVoice, speed, requestId: capturedId, errorName: err?.name || null }
        );
        showPlayerWarning('Playback restricted; using system voice', details);
        releaseCurrentAudioElement();
        fallbackSpeechSynthesis(text, speed, capturedId);
      });
  }

  function audioDataUrlToObjectUrl(dataUrl) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl || '');
    if (!match) return null;

    try {
      const mimeType = match[1];
      const base64 = match[2];
      const binary = atob(base64);
      const chunks = [];
      for (let i = 0; i < binary.length; i += BASE64_CHUNK_SIZE) {
        const slice = binary.slice(i, i + BASE64_CHUNK_SIZE);
        const bytes = new Uint8Array(slice.length);
        for (let j = 0; j < slice.length; j++) bytes[j] = slice.charCodeAt(j);
        chunks.push(bytes);
      }
      return URL.createObjectURL(new Blob(chunks, { type: mimeType }));
    } catch (err) {
      logDebug('audio-blob-url-failed', { message: err?.message || String(err) });
      return null;
    }
  }

  function fallbackSpeechSynthesis(text, speed, requestId) {
    if (requestId !== pbRequestId) return;
    if (!window.speechSynthesis) {
      showPlayerError('No TTS available');
      return;
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = typeof speed === 'number' ? speed : 1.0;
    utter.onend = () => {
      if (requestId !== pbRequestId) return;
      onAudioEnded();
    };
    utter.onerror = (e) => {
      if (requestId !== pbRequestId) return;
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      showPlayerError('Speech synthesis error');
    };
    utter.onstart = () => {
      if (requestId !== pbRequestId) return;
      logDebug('speech-synthesis-started', { requestId });
      setPlaybackState('playing');
    };
    window.speechSynthesis.speak(utter);
  }

  function stopPlayback() {
    logDebug('playback-stop');
    pbRequestId++; // invalidate in-flight requests
    // Belt and braces on top of the requestId guard: also cancel any pause
    // scheduled by onAudioEnded so it can't fire after playback has stopped.
    clearTimeout(advanceTimer); advanceTimer = 0;
    cancelInflightTts(); // Wave B: skip any still-queued offscreen synths
    // FIX 3: Properly release audio resources
    releaseCurrentAudioElement();
    // FIX 2: Also cancel speechSynthesis when stopping
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setPlaybackState('idle');
  }

  function releaseAudioObjectUrl() {
    if (!pbAudioObjectUrl) return;
    URL.revokeObjectURL(pbAudioObjectUrl);
    pbAudioObjectUrl = null;
  }

  function releaseCurrentAudioElement() {
    if (pbAudio) {
      pbAudio.pause();
      pbAudio.onended = null;
      pbAudio.onerror = null;
      pbAudio.onplaying = null;
      pbAudio.oncanplay = null;
      pbAudio.onloadstart = null;
      pbAudio.removeAttribute('src');
      pbAudio.load();
      pbAudio = null;
    }
    releaseAudioObjectUrl();
  }

  // Pause inserted before auto-advancing to the next entry: none inside a
  // split long sentence, longer at paragraph boundaries.
  function pauseBeforeNext(prev, next) {
    if (!prev || !next) return 0;
    if (next.continuation) return 0;
    if (prev.blockIdx !== next.blockIdx) return PARAGRAPH_PAUSE_MS;
    return SENTENCE_PAUSE_MS;
  }

  function onAudioEnded() {
    if (pbIndex < pbSentences.length - 1) {
      const pause = pauseBeforeNext(pbSentences[pbIndex], pbSentences[pbIndex + 1]);
      if (!pause) {
        playSentence(pbIndex + 1);
        return;
      }
      // Between-sentence/paragraph pause: schedule the advance, but re-check
      // pbRequestId when it fires — the user may skip, stop, re-stroke, or
      // change voice/speed during the pause window, and every one of those
      // paths (except a mid-'playing' voice/speed change, which intentionally
      // falls through to synthesize the next sentence in the new voice) bumps
      // pbRequestId.
      const reqAtEnd = pbRequestId;
      clearTimeout(advanceTimer);
      advanceTimer = setTimeout(() => {
        advanceTimer = 0;
        if (reqAtEnd !== pbRequestId) return; // superseded during the pause
        playSentence(pbIndex + 1);
      }, pause);
    } else {
      // All sentences done — reset
      setPlaybackState('idle');
    }
  }

  function getErrorMessage(response) {
    if (!response) return 'No response from background';
    switch (response.error) {
      case 'empty-text':        return 'Select some text before playing';
      case 'text-too-long':     return response.detail || 'Text exceeds maximum length';
      case 'model-loading':     return typeof response.progress === 'number' && response.progress > 0
        ? `Voice model downloading (${response.progress}%) — using system voice meanwhile`
        : 'Voice model loading — using system voice meanwhile';
      case 'engine-error':      return response.detail
        ? `Voice engine error\n${truncateDetail(response.detail)}`
        : 'Voice engine error — using system voice';
      case 'synthesis-failed':  return response.detail
        ? `Synthesis failed\n${truncateDetail(response.detail)}`
        : 'Synthesis failed — using system voice';
      case 'timeout':           return 'Request timed out — try again';
      case 'no-response':       return 'Voice engine did not respond — using system voice';
      case 'cancelled':         return 'Cancelled';
      default:                  return response.error || 'Unknown error';
    }
  }

  function normalizePlaybackRate(speed) {
    const parsed = parseFloat(speed);
    if (!Number.isFinite(parsed)) return 1.0;
    return Math.max(0.5, Math.min(2.0, parsed));
  }

  function nearestSpeedIndex(speed) {
    const clamped = Math.max(SPEEDS[0], Math.min(SPEEDS[SPEEDS.length - 1], speed));
    let bestIdx = SPEED_DEFAULT_INDEX;
    let bestDelta = Infinity;
    for (let i = 0; i < SPEEDS.length; i++) {
      const d = Math.abs(SPEEDS[i] - clamped);
      if (d < bestDelta) { bestDelta = d; bestIdx = i; }
    }
    return bestIdx;
  }

  // Show 1 decimal for round-tenth values (1.0x, 1.5x), 2 decimals for fine ones (1.05x).
  function formatSpeedLabel(speed) {
    const tenths = speed * 10;
    const isTenth = Math.abs(tenths - Math.round(tenths)) < 1e-9;
    return (isTenth ? speed.toFixed(1) : speed.toFixed(2)) + 'x';
  }

  function ensureVoiceOption(selectEl, voiceId, label) {
    if (!selectEl || !voiceId) return;
    const existing = Array.from(selectEl.options).find((option) => option.value === voiceId);
    if (existing) {
      existing.textContent = label || existing.textContent;
      selectEl.value = voiceId;
      return;
    }

    const option = document.createElement('option');
    option.value = voiceId;
    option.textContent = label || voiceId;
    selectEl.appendChild(option);
    selectEl.value = voiceId;
  }

  function loadVoiceOptions(selectEl, selectedVoice) {
    if (!selectEl) return;
    const startedAt = performance.now();
    logDebug('voices-request-start', { selectedVoice });
    chrome.runtime.sendMessage({ type: 'voices-request' }, (response) => {
      logDebug('voices-response', {
        ok: Boolean(response?.ok),
        error: response?.error || null,
        status: response?.status || null,
        voiceCount: response?.voices?.length || 0,
        elapsedMs: Math.round(performance.now() - startedAt),
        runtimeError: chrome.runtime.lastError?.message || null,
      });
      if (chrome.runtime.lastError || !response || !response.ok || !response.voices?.length) {
        ensureVoiceOption(selectEl, selectedVoice || cachedVoice, 'Configured voice');
        return;
      }

      const groups = new Map();
      for (const voice of response.voices) {
        const category = voice.category || 'Other';
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(voice);
      }

      const fragment = document.createDocumentFragment();
      for (const [category, voices] of groups) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = category;
        for (const voice of voices) {
          const option = document.createElement('option');
          option.value = voice.voiceId;
          option.textContent = voice.name;
          optgroup.appendChild(option);
        }
        fragment.appendChild(optgroup);
      }

      selectEl.replaceChildren(fragment);
      selectEl.value = selectedVoice || cachedVoice;
      if (!selectEl.value) ensureVoiceOption(selectEl, selectedVoice || cachedVoice, 'Configured voice');
    });
  }

  function truncateDetail(detail) {
    const text = typeof detail === 'string' ? detail.trim() : '';
    if (!text) return 'Unknown upstream error';
    return text.length > 140 ? text.slice(0, 137) + '...' : text;
  }

  function buildErrorDetails(response, ctx = {}) {
    const lines = [];
    if (ctx.voice) lines.push(`Voice: ${ctx.voice}`);
    if (ctx.speed !== undefined && ctx.speed !== null) lines.push(`Speed: ${ctx.speed}`);
    if (ctx.requestId !== undefined) lines.push(`Request: #${ctx.requestId}`);
    if (response?.status) lines.push(`HTTP status: ${response.status}`);
    if (response?.error) lines.push(`Error code: ${response.error}`);
    if (response?.detail) lines.push(`Detail: ${response.detail}`);
    if (ctx.audioErrorCode !== undefined && ctx.audioErrorCode !== null) {
      lines.push(`Audio MediaError code: ${ctx.audioErrorCode}`);
    }
    if (ctx.srcKind) lines.push(`Audio src kind: ${ctx.srcKind}`);
    if (ctx.errorName) lines.push(`Error name: ${ctx.errorName}`);
    if (ctx.runtimeError) lines.push(`Runtime error: ${ctx.runtimeError}`);
    lines.push(`Page: ${location.href}`);
    lines.push(`Time: ${new Date().toISOString()}`);
    lines.push(`UA: ${navigator.userAgent}`);
    return lines.join('\n');
  }

  function showPlayerError(msg, details) {
    setPlaybackState('error');
    console.warn(LOG_PREFIX, msg, details || '');
    showToast(msg, true, details);
    setTimeout(() => {
      if (pbState === 'error') setPlaybackState('idle');
    }, 4000);
  }

  // Flash error tooltip without blocking playback (used before fallback)
  function showPlayerWarning(msg, details) {
    showToast(msg, false, details);
  }

  function showToast(msg, isError, details) {
    if (!toastEl) return;
    clearTimeout(toastTimer);
    toastEl.replaceChildren();

    const msgEl = document.createElement('div');
    msgEl.className = 'hltr-toast-msg';
    msgEl.textContent = msg;
    toastEl.appendChild(msgEl);

    if (details) {
      const pre = document.createElement('pre');
      pre.className = 'hltr-toast-details';
      pre.textContent = details;
      toastEl.appendChild(pre);

      const actions = document.createElement('div');
      actions.className = 'hltr-toast-actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'hltr-toast-copy';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const payload = `${msg}\n\n${details}`;
        try {
          await navigator.clipboard.writeText(payload);
          copyBtn.textContent = 'Copied';
        } catch {
          // Some sites block clipboard writes. Fall back to a selectable textarea.
          const ta = document.createElement('textarea');
          ta.value = payload;
          ta.style.position = 'fixed';
          ta.style.top = '-1000px';
          document.documentElement.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); copyBtn.textContent = 'Copied'; }
          catch { copyBtn.textContent = 'Copy failed'; }
          ta.remove();
        }
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
      });
      actions.appendChild(copyBtn);

      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'hltr-toast-dismiss';
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        clearTimeout(toastTimer);
        toastTimer = 0;
        toastEl.classList.remove('hltr-visible', 'hltr-error');
      });
      actions.appendChild(dismissBtn);

      toastEl.appendChild(actions);
    }

    toastEl.classList.toggle('hltr-visible', true);
    toastEl.classList.toggle('hltr-error', isError);
    toastEl.classList.toggle('hltr-toast-detailed', Boolean(details));
    positionToast();

    const dismissMs = details ? 15000 : 4000;
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('hltr-visible', 'hltr-error', 'hltr-toast-detailed');
      toastTimer = 0;
    }, dismissMs);

    // Pause auto-dismiss while the user reads/interacts.
    toastEl.onmouseenter = () => { if (toastTimer) { clearTimeout(toastTimer); toastTimer = 0; } };
    toastEl.onmouseleave = () => {
      if (!toastEl.classList.contains('hltr-visible')) return;
      toastTimer = setTimeout(() => {
        toastEl.classList.remove('hltr-visible', 'hltr-error', 'hltr-toast-detailed');
        toastTimer = 0;
      }, 4000);
    };
  }

  function positionToast() {
    if (!toastEl || !playerEl) return;
    const margin = 12;
    const playerRect = playerEl.getBoundingClientRect();
    const toastWidth = Math.min(420, window.innerWidth - margin * 2);
    toastEl.style.maxWidth = toastWidth + 'px';
    toastEl.style.width = toastWidth + 'px';

    const measuredHeight = toastEl.offsetHeight || 72;
    let left = playerRect.left + (playerRect.width - toastWidth) / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - toastWidth - margin));

    let top = playerRect.bottom + 8;
    if (top + measuredHeight > window.innerHeight - margin) {
      top = Math.max(margin, playerRect.top - measuredHeight - 8);
    }

    toastEl.style.left = left + 'px';
    toastEl.style.top = top + 'px';
  }

  // ── Mouse handling ─────────────────────────────────────────────────
  function onMouseMove(e) {
    if (!highlightMode) return;
    if (cursorEl) {
      cursorEl.style.left = e.clientX + 'px';
      cursorEl.style.top  = e.clientY + 'px';
    }
    if (isPainting) {
      strokePoints.push({ x: e.clientX, y: e.clientY });
      renderStroke();
    }
  }

  function onMouseDown(e) {
    if (!highlightMode) return;
    if (e.button !== 0) return;
    // Don't start a stroke if clicking the player or settings menu
    if (playerEl && playerEl.contains(e.target)) return;
    if (menuPanelEl && menuPanelEl.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    isPainting   = true;
    strokePoints = [{ x: e.clientX, y: e.clientY }];
    renderStroke();
  }

  function onMouseUp(e) {
    if (!highlightMode) return;
    if (!isPainting) return;
    e.preventDefault();
    e.stopPropagation();
    isPainting = false;

    // FIX 6: Guard against empty strokePoints before accessing indices
    if (!strokePoints.length) return;

    const startPt = strokePoints[0];
    const endPt   = strokePoints[strokePoints.length - 1];

    resolveAndSelect(startPt, endPt);
    suppressNextClick = true;   // prevent the trailing click from dismissing the player
    setTimeout(() => { suppressNextClick = false; }, 500);  // safety: clear if click never fires
    setTimeout(() => clearStroke(), 150);

    if (!e.shiftKey && !e.metaKey && !e.ctrlKey) exitHighlightMode();
  }

  function onClickCapture(e) {
    // The click that immediately follows a stroke mouseup should be swallowed —
    // it would otherwise dismiss the player we just showed.
    if (suppressNextClick) {
      suppressNextClick = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Let clicks through to the player/menu
    if (playerEl   && playerEl.contains(e.target))    return;
    if (menuPanelEl && menuPanelEl.contains(e.target)) return;

    if (!highlightMode) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  // ── Keyboard handling ──────────────────────────────────────────────
  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (highlightMode) exitHighlightMode();
    }
  }

  // ── Event listeners ────────────────────────────────────────────────
  document.addEventListener('mousemove', onMouseMove,    true);
  document.addEventListener('mousedown', onMouseDown,    true);
  document.addEventListener('mouseup',   onMouseUp,      true);
  document.addEventListener('click',     onClickCapture, true);
  document.addEventListener('keydown',   onKeyDown,      true);

  // ── Message listener ───────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'toggleHighlightMode') {
      toggleHighlightMode();
      sendResponse({ ok: true, highlightMode });
    }
  });
})();
