// Floating "Download this video" button, shown when the background worker
// detects a video/audio file or HLS stream on the page. Runs in every frame:
// videos inside frames (embedded players) and inside shadow DOM get their
// own button too.
(() => {
  if (window.__ezooDownload) return;
  window.__ezooDownload = true;
  const TOP = window.top === window;

  let items = [];
  // Options > File Types > "Download panel for web players"
  let panel = { enabled: true, skipSites: [] };
  const hostMatches = (host, p) => {
    p = String(p).replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
    if (!p) return false;
    if (p.includes("*")) return new RegExp("^" + p.replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$").test(host);
    return host === p || host.endsWith("." + p);
  };
  // the on / off switch of the add-in's window
  let switchedOn = true;
  const panelAllowed = () =>
    switchedOn && panel.enabled !== false && !(panel.skipSites || []).some((s) => hostMatches(location.hostname.toLowerCase(), s));

  const fmtSize = (n) => {
    if (!n) return "";
    const u = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  };
  const fmtLen = (s) => {
    s = Math.round(Number(s) || 0);
    if (!s) return "";
    const two = (n) => String(n).padStart(2, "0");
    return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
  };
  // the resolution in plain words (the app sends it; streams seen in the
  // player only have the height)
  const tagOf = (h) => (!h ? "" : h >= 4320 ? "8K" : h >= 2160 ? "4K" : h >= 1440 ? "2K" : h >= 1080 ? "Full HD" : h >= 720 ? "HD" : "SD");

  const cleanTitle = () =>
    (document.title || "video").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim().slice(0, 120) || "video";

  // --------------------------------------------------------------- videos
  // Videos of the page, also those inside shadow DOM (players built as web
  // components). The deep search is slower, so it runs every few rounds.
  let shadowVideos = [];
  let deepRound = 0;
  function collectShadow(root, out, depth) {
    if (depth > 6) return;
    for (const el of root.querySelectorAll("*")) {
      const sr = el.shadowRoot;
      if (!sr) continue;
      out.push(...sr.querySelectorAll("video"));
      collectShadow(sr, out, depth + 1);
    }
  }
  function allVideos() {
    const list = [...document.querySelectorAll("video")];
    if (deepRound++ % 4 === 0) {
      const found = [];
      try {
        collectShadow(document, found, 0);
      } catch (_) {
        /* a strange page: keep what we have */
      }
      shadowVideos = found;
    }
    for (const v of shadowVideos) if (v.isConnected && !list.includes(v)) list.push(v);
    return list;
  }

  // The video the user is watching: a playing one first, else the biggest
  // one on screen.
  function biggestVideo(videos = allVideos()) {
    let best = null;
    let score = 0;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      if (r.width < 200 || r.height < 100) continue;
      const visible = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (visible < 60) continue;
      const s = r.width * visible * (!v.paused && !v.ended ? 4 : 1);
      if (s > score) {
        best = v;
        score = s;
      }
    }
    return best;
  }
  const playing = (v) => !v.paused && !v.ended && v.duration > 3;

  // Pages that are one video: their own address is the best link for it.
  const VIDEO_PAGE = [
    /youtube\.com\/(watch|shorts\/|live\/|embed\/)/i,
    /youtube-nocookie\.com\/embed\//i,
    /tiktok\.com\/@[^/]+\/(video|photo)\//i,
    /instagram\.com\/(reels?|p|tv)\//i,
    /facebook\.com\/(.+\/videos\/|watch|reel\/|share\/[vr]\/|plugins\/video)/i,
    /fb\.watch\//i,
    /(twitter|x)\.com\/[^/]+\/status\//i,
    /vimeo\.com\/\d+/i,
    /player\.vimeo\.com\/video\//i,
    // (not the "geo.dailymotion.com/player/…" frame: that is only the player)
    /dailymotion\.com\/(video\/|embed\/video\/)/i,
    /dai\.ly\//i,
    /reddit\.com\/r\/[^/]+\/comments\//i,
    /twitch\.tv\/(videos\/|[^/]+\/clip\/)/i,
    /clips\.twitch\.tv\//i,
    /pinterest\.[a-z.]+\/pin\//i,
    /snapchat\.com\/(spotlight|add)\//i,
    /linkedin\.com\/(posts|feed\/update)\//i,
  ];
  const isVideoPage = (u) => VIDEO_PAGE.some((r) => r.test(u));
  const isNetflixWatch = () => /(^|\.)netflix\.com$/i.test(location.hostname) && /^\/watch(?:\/|$)/i.test(location.pathname || "");
  const NETFLIX_NOTICE = "Netflix playback is not supported by this downloader. Use Netflix’s official app on a supported device for offline viewing.";

  // In feeds (Facebook, Instagram, X...) the page shows many videos: look for
  // the post / reel link around the video being watched.
  function linkFor(video) {
    if (isVideoPage(location.href)) return location.href;
    return ownLink(video) || location.href;
  }

  // the post / video link next to this very video ("" = none found)
  function ownLink(video) {
    let el = video;
    for (let depth = 0; el && depth < 25; depth++) {
      const links = el.querySelectorAll ? el.querySelectorAll("a[href]") : [];
      for (const a of links) {
        if (isVideoPage(a.href)) return a.href.split("#")[0];
      }
      if (el.tagName === "ARTICLE") break;
      // out of a shadow root: on to the element that holds it
      el = el.parentElement || (el.parentNode && el.parentNode.host) || null;
    }
    // an embedded player: the frame's own address is the video
    if (!TOP && isVideoPage(location.href)) return location.href;
    return "";
  }

  let lastPage = "";
  let observedInitialPlayer = false;
  function watchVideos(playedVideo = null, playedAt = 0, observePlayback = false) {
    syncPage();
    const v = biggestVideo();
    if (!v) return;
    const initialObservation = !observedInitialPlayer;
    observedInitialPlayer = true;
    // A page may contain multiple already-loaded embedded players. Announce
    // the one the user actually starts, even if its URL has not changed.
    // Tiny short loops are not user-selected video playback.
    const activeSelection = playedVideo === v && !v.paused && !v.ended && (v.duration > 3 || !Number.isFinite(v.duration));
    // A player can already be running when this script is injected or the
    // worker restarts. Report this once, separately from an actual play event.
    // Short loops are ignored; the worker keeps explicit playback choices
    // ahead of these observations, including for muted autoplay.
    const observedPlaying = !TOP && (initialObservation || observePlayback) &&
      !v.paused && !v.ended && (v.duration > 3 || !Number.isFinite(v.duration));
    if (activeSelection) lastPage = "";
    const bubble = bubbles.get(v);
    const token = clientToken;
    if (bubble && syncVideo(bubble)) renderOne(bubble);
    syncMainVideo(v);
    // ignore tiny muted background loops that never play for long
    if (v.paused && !(v.duration > 3) && !v.currentSrc) return;
    // in a frame (an embedded player): its own address when it is a video
    // page (YouTube / Vimeo embeds), otherwise the page around it (the
    // add-in knows that one)
    const page = TOP ? linkFor(v) : isVideoPage(location.href) ? location.href : "";
    if (bubble && syncBubbleLink(bubble, TOP ? page : linkFor(v))) {
      if (token === clientToken) advanceMainPlayer();
      renderOne(bubble);
    }
    if (activeSelection || observePlayback || page !== lastPage || (!TOP && !lastPage)) {
      if (!TOP && lastPage === "frame:" + page) return;
      lastPage = TOP ? page : "frame:" + page;
      chrome.runtime.sendMessage({ type: "swiftget-video-seen", page, frame: !TOP, ...(TOP ? { clientToken } : { frameToken: clientToken }), ...(activeSelection ? { activeSelection: true, selectedAt: playedAt } : observedPlaying ? { observedPlaying: true } : {}) }).catch?.(() => {});
    }
  }

  // ---------------------------------------------------------------- bubbles
  // One "Download" bubble on every video of the page. The main video (the
  // one playing / the biggest) uses what the add-in found for the page; any
  // other video is looked up when its bubble is clicked. A bubble can be
  // dragged around its player and stays there while it remains visible.
  const bubbles = new Map(); // video -> bubble
  // YouTube's video ID identifies a watch page despite timestamp or playlist
  // changes. Other sites may use query strings and hashes as SPA routes.
  function pageIdentity(href) {
    try {
      const url = new URL(href);
      if (/(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(url.hostname)) {
        if (url.pathname === "/watch" && url.searchParams.has("v")) {
          return `${url.origin}/watch?v=${url.searchParams.get("v")}`;
        }
        if (/^\/(?:shorts|live|embed)\/[^/]+\/?$/i.test(url.pathname)) return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
      }
      return url.href;
    } catch (_) { return String(href); }
  }
  let currentPage = pageIdentity(location.href);
  let playerGeneration = 0;
  let mainVideo = null;
  let mainSource = "";
  let mainLinkPage = "";
  // This is an opaque freshness marker, not an authentication token. It
  // changes for each frame's player/page generation without sharing URLs.
  const documentNonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let clientToken = `${documentNonce}:0`;
  let lastMediaHandshake = 0;

  function advanceMainPlayer() {
    if (TOP) items = [];
    lastPage = "";
    clientToken = `${documentNonce}:${++playerGeneration}`;
    if (TOP) {
      try { chrome.runtime.sendMessage({ type: "swiftget-player-changed", generation: playerGeneration, clientToken }).catch?.(() => {}); } catch (_) {}
    }
  }

  function requestMedia() {
    const token = clientToken;
    chrome.runtime.sendMessage({ type: "swiftget-media-request", clientToken: token }, (res) => {
      if (!chrome.runtime.lastError && token === clientToken) update(res);
    });
  }

  // The player node can survive a single-page navigation. Tear down its
  // state before using a new page's formats, and make old callbacks inert.
  function syncPage() {
    const page = pageIdentity(location.href);
    if (page === currentPage) return false;
    currentPage = page;
    blockedLaneNode = null;
    advanceMainPlayer();
    mainVideo = null;
    mainSource = "";
    mainLinkPage = "";
    lastPage = "";
    for (const b of bubbles.values()) releaseBubble(b);
    bubbles.clear();
    restoreLane();
    return true;
  }

  const videoSource = (video) => video.currentSrc || video.src || "";
  // YouTube can replace its MediaSource blob while adapting the same video.
  // Its watch/embed URL identifies the video, so do not clear formats for
  // an ordinary blob-to-blob switch at that unchanged page URL.
  const sameYoutubeBlobVideo = (before, after) =>
    /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(location.hostname) &&
    isVideoPage(location.href) && /^blob:/i.test(before) && /^blob:/i.test(after);

  function invalidateBubble(b) {
    b.generation++;
    b.own = null;
    b.loading = false;
    b.open = false;
    b.help = false;
    b.focusMenu = false;
    b.dismissed = false;
  }

  // Feed players can be reused under a different post link even if a site
  // keeps the same MediaSource URL. Re-evaluate links on player observation
  // and on actions, not on every positioning frame.
  function syncBubbleLink(b, href = linkFor(b.video)) {
    const page = pageIdentity(href || location.href);
    if (page === b.linkPage) return false;
    b.linkPage = page;
    if (b.video === mainVideo) mainLinkPage = page;
    invalidateBubble(b);
    return true;
  }

  // A site can reuse the same element for another video without changing the
  // page URL. Do not interpret an empty transient source as a new video.
  function syncVideo(b) {
    const source = videoSource(b.video);
    if (!source || source === b.source) return false;
    if (!b.source) { b.source = source; return false; }
    if (sameYoutubeBlobVideo(b.source, source)) { b.source = source; return false; }
    b.source = source;
    invalidateBubble(b);
    if (!TOP) {
      advanceMainPlayer();
      if (mainVideo === b.video) mainSource = source;
    }
    return true;
  }

  function syncMainVideo(video = biggestVideo()) {
    if (!video) return;
    const source = videoSource(video);
    const sameSource = source && mainSource && (source === mainSource || sameYoutubeBlobVideo(mainSource, source));
    // Only inspect the nearby post link when the main element changes; this
    // distinguishes reused media URLs in feeds without scanning on idle ticks.
    const nextLink = video !== mainVideo ? pageIdentity(linkFor(video) || location.href) : mainLinkPage;
    const changedPost = !!(mainVideo && mainLinkPage && nextLink && mainLinkPage !== nextLink);
    if (mainVideo && ((video !== mainVideo && (!sameSource || changedPost)) || (source && mainSource && source !== mainSource && !sameSource))) {
      advanceMainPlayer();
    }
    if (video !== mainVideo) mainSource = "";
    mainVideo = video;
    mainLinkPage = nextLink;
    if (source) mainSource = source;
  }

  function currentBubble(b, generation, checkLink = generation != null) {
    syncPage();
    if (b.disposed || bubbles.get(b.video) !== b) return false;
    // A known source may disappear briefly while a player replaces or
    // reloads it. Block old actions until the source returns or a new one is
    // known, without treating ordinary buffering as a new video.
    if ((generation != null || checkLink) && b.source && !videoSource(b.video)) {
      b.open = false;
      b.help = false;
      b.focusMenu = false;
      renderOne(b);
      return false;
    }
    const token = clientToken;
    const changed = syncVideo(b);
    syncMainVideo();
    const linkChanged = checkLink && syncBubbleLink(b);
    if (linkChanged && (!TOP || isMain(b.video)) && token === clientToken) advanceMainPlayer();
    if (changed || linkChanged) renderOne(b);
    return generation == null || b.generation === generation;
  }
  // Scroll and resize invalidate cached hit tests; the existing placement
  // timer refreshes them occasionally for page changes without new polling.
  let placementEpoch = 0;
  let reservedLane = null, blockedLaneNode = null;
  // A parent can make an iframe fullscreen without changing the child's own
  // fullscreenElement. Ask the extension worker for the top frame's state;
  // never try to read a cross-origin parent document or accept page messages.
  // Start embedded frames hidden until the first query returns, preventing a
  // flash over a player that is already fullscreen when the frame loads.
  let topFullscreen = !TOP;
  let fullscreenQuery = 0;
  const localFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  function syncTopFullscreen() {
    if (TOP) return;
    const query = ++fullscreenQuery;
    // A state change is unknown until the top frame confirms it. Hide while
    // checking so a slow worker cannot briefly expose the widget fullscreen.
    if (!topFullscreen) {
      topFullscreen = true;
      placementEpoch++;
      bubbles.forEach((b) => placeOne(b));
    }
    // Top and child scripts can initialize in either order. Retry a small
    // bounded number of times; unavailable top frames stay hidden until a
    // later authenticated announcement or navigation supplies a valid state.
    function attempt(number) {
      if (query !== fullscreenQuery) return;
      let finished = false;
      const finish = (response) => {
        if (finished || query !== fullscreenQuery) return;
        finished = true;
        clearTimeout(timeout);
        if (typeof response?.fullscreen === "boolean") {
          if (topFullscreen !== response.fullscreen) {
            topFullscreen = response.fullscreen;
            placementEpoch++;
            bubbles.forEach((b) => placeOne(b));
          }
        } else if (number < 3) {
          setTimeout(() => attempt(number + 1), 200 * number);
        }
      };
      const timeout = setTimeout(() => finish(null), 1000);
      try {
        chrome.runtime.sendMessage({ type: "swiftget-query-top-fullscreen" }, (response) => {
          if (chrome.runtime.lastError) { finish(null); return; }
          finish(response);
        });
      } catch (_) { finish(null); }
    }
    attempt(1);
  }
  function notifyTopFullscreen() {
    if (!TOP) return;
    try { chrome.runtime.sendMessage({ type: "swiftget-top-fullscreen-changed" }).catch?.(() => {}); } catch (_) { /* extension may be reloading */ }
  }
  function removeAll() {
    for (const b of bubbles.values()) releaseBubble(b);
    bubbles.clear();
    restoreLane();
  }
  // size of the button: the slider in the add-in's menu (50% - 200%)
  const OLD_SIZES = { small: 0.85, normal: 1, large: 1.25 };
  const clampZoom = (z) => Math.min(2, Math.max(0.5, Number(z) || 1));
  let zoom = 1;
  const applyZoom = () => {
    for (const b of bubbles.values()) {
      b.host.style.setProperty("--z", String(zoom));
      placeOne(b);
    }
  };
  try {
    chrome.storage.local.get({ enabled: true }, (o) => {
      switchedOn = !o || o.enabled !== false;
      if (!switchedOn) removeAll();
    });
    chrome.storage.onChanged.addListener((ch) => {
      if (!ch.enabled) return;
      switchedOn = ch.enabled.newValue !== false;
      if (!switchedOn) removeAll();
      else requestMedia();
    });
  } catch (_) {
    // storage not reachable (add-in reloading): stays on
  }
  try {
    chrome.storage.local.get({ bubbleScale: null, bubbleSize: "normal" }, (o) => {
      zoom = clampZoom(o && o.bubbleScale != null ? o.bubbleScale : OLD_SIZES[o && o.bubbleSize]);
      applyZoom();
    });
    chrome.storage.onChanged.addListener((ch) => {
      if (ch.bubbleScale) zoom = clampZoom(ch.bubbleScale.newValue);
      else if (ch.bubbleSize) zoom = clampZoom(OLD_SIZES[ch.bubbleSize.newValue]);
      else return;
      applyZoom();
    });
  } catch (_) {
    // storage not reachable (add-in reloading): default size
  }
  const STYLE = `
    :host { all: initial; --ez-surface: #fff; --ez-group: #f5f5f7; --ez-text: #1d1d1f; --ez-secondary: #5a5a60;
      --ez-line: #d2d2d7; --ez-accent: #007aff; --ez-link: #0063cc; --ez-hover: #edf4ff;
      --ez-success: #248a3d; --ez-error: #d70015; --ez-shadow: rgba(0,0,0,.18); }
    @media (prefers-color-scheme: dark) {
      :host { --ez-surface: #2c2c2e; --ez-group: #1c1c1e; --ez-text: #f5f5f7; --ez-secondary: #a1a1a6;
        --ez-line: #48484a; --ez-accent: #0a84ff; --ez-link: #64b0ff; --ez-hover: #353d4a;
        --ez-success: #30d158; --ez-error: #ff6961; --ez-shadow: rgba(0,0,0,.42); }
    }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .wrap { position: relative; display: inline-flex; color-scheme: light dark; zoom: var(--z, 1);
      font: max(13px, calc(11px / var(--z, 1)))/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; color: var(--ez-text); }
    button { appearance: none; -webkit-appearance: none; font: inherit; color: inherit; margin: 0; cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--ez-accent); outline-offset: -3px; }
    .btn { display: inline-flex; align-items: center; justify-content: center; background: var(--ez-surface);
      border: 1px solid var(--ez-line); border-radius: 12px; box-shadow: 0 3px 12px -3px var(--ez-shadow);
      user-select: none; }
    .btn.open { border-color: var(--ez-accent); }
    .part { display: inline-flex; align-items: center; justify-content: center;
      width: max(40px, calc(28px / var(--z, 1))); height: max(40px, calc(28px / var(--z, 1)));
      padding: 0; background: transparent; border: 0; border-radius: 11px; cursor: grab; }
    .part:hover, .side:hover { background: var(--ez-group); }
    .btn.drag .part { cursor: grabbing; }
    .ico { width: max(18px, calc(14px / var(--z, 1))); height: max(18px, calc(14px / var(--z, 1))); flex: none; stroke: currentColor; fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
    .download-symbol { color: var(--ez-link); }
    .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .side { display: inline-flex; align-items: center; justify-content: center; min-width: max(30px, calc(24px / var(--z, 1))); height: max(30px, calc(24px / var(--z, 1)));
      background: transparent; border: 0; border-radius: 50%; color: var(--ez-secondary); }
    .spin { width: 16px; text-align: center; color: var(--ez-link); font-size: 17px; line-height: 16px; }
    .list { position: absolute; right: 0; top: calc(100% + 8px); width: max(340px, calc(250px / var(--z, 1))); max-width: calc(100vw - 16px);
      max-height: 440px; overflow: hidden;
      background: var(--ez-surface); color: var(--ez-text); border: 1px solid var(--ez-line); border-radius: 18px;
      box-shadow: 0 12px 30px -7px var(--ez-shadow); }
    .list-scroll { max-height: 438px; padding: 7px; overflow: auto; overscroll-behavior: contain;
      border-radius: 17px; scrollbar-width: thin; scrollbar-color: var(--ez-line) transparent; }
    .list.above { top: auto; bottom: calc(100% + 8px); }
    .list.align-start { left: 0; right: auto; }
    .head { display: flex; align-items: start; gap: 10px; padding: 9px 8px 11px; border-bottom: 1px solid var(--ez-line); margin-bottom: 4px; }
    .heading-body { min-width: 0; flex: 1; }
    .heading { font-size: max(14px, calc(12px / var(--z, 1))); font-weight: 650; line-height: 1.4; }
    .video-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      margin-top: 3px; font-size: max(12px, calc(11px / var(--z, 1))); line-height: 1.4; color: var(--ez-secondary); overflow-wrap: anywhere; }
    .group { margin: 0; }
    .group-title { margin: 0; padding: 10px 9px 5px; color: var(--ez-secondary); font-size: max(12px, calc(11px / var(--z, 1))); font-weight: 600; }
    .item { display: flex; align-items: center; gap: 10px; width: 100%; min-height: max(56px, calc(40px / var(--z, 1))); padding: 9px 8px; text-align: left;
      border: 0; border-radius: 10px; background: transparent; }
    .item:hover:not(:disabled), .item:focus-visible { background: var(--ez-hover); }
    .format-symbol { display: inline-flex; align-items: center; justify-content: center; width: max(34px, calc(28px / var(--z, 1))); height: max(34px, calc(28px / var(--z, 1)));
      border-radius: 10px; background: var(--ez-group); color: var(--ez-link); flex: none; }
    .body { display: block; flex: 1; min-width: 0; }
    .t { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: max(13px, calc(11px / var(--z, 1))); font-weight: 600; line-height: 1.4; }
    .s { display: block; color: var(--ez-secondary); font-size: max(12px, calc(11px / var(--z, 1))); margin-top: 3px; line-height: 1.4; overflow-wrap: anywhere; }
    .tag, .codec { display: inline-block; border: 1px solid var(--ez-line); border-radius: 4px; padding: 0 4px;
      font-size: max(10px, calc(10px / var(--z, 1))); font-weight: 600; line-height: 15px; color: var(--ez-secondary); white-space: nowrap; }
    .item > .accessory { color: var(--ez-link); }
    .all { color: var(--ez-link); font-weight: 600; }
    .item:disabled { cursor: default; }
    .item:disabled .format-symbol { opacity: .65; }
    .item:disabled .body { color: var(--ez-secondary); }
    .msg { display: flex; gap: 10px; padding: 14px 10px; font-size: max(13px, calc(11px / var(--z, 1))); line-height: 1.45; }
    .msg > .ico { margin-top: 2px; color: var(--ez-success); }
    .msg.err > .ico { color: var(--ez-error); }
    .msg.protected > .ico { color: var(--ez-secondary); }
    .msg.pending > .ico { color: var(--ez-link); }
    .msg-body { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .help { padding: 11px 10px; margin: 4px; border-radius: 8px; color: var(--ez-secondary); background: var(--ez-group); font-size: max(12px, calc(11px / var(--z, 1))); }
    .act { display: block; margin-top: 10px; min-height: 32px; border: 0; border-radius: 7px; padding: 6px 11px;
      background: #0063cc; color: #fff; font-weight: 600; }
    .act:hover { background: #0056b3; }
    @media (prefers-color-scheme: dark) { .act { background: #006bd6; } .act:hover { background: #005fbe; } }
    @media (prefers-contrast: more) { :host { --ez-line: var(--ez-secondary); } .btn, .list { border-width: 2px; } }
    @media (forced-colors: active) {
      .btn, .list { background: Canvas; color: CanvasText; border-color: CanvasText; box-shadow: none; }
      .item, .part, .side, .tag, .codec { color: CanvasText; }
      .item:focus-visible, button:focus-visible { outline-color: Highlight; }
      .act { background: Highlight; color: HighlightText; }
    }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  `;

  function isMain(video) {
    return TOP && video === biggestVideo();
  }

  function directSrc(video) {
    const src = video.currentSrc || video.src || "";
    return /^https?:/i.test(src) && !/\.m3u8|\.mpd/i.test(src) ? src : "";
  }

  // where the bubbles live: in full screen the player's own element (the
  // only thing the browser shows then)
  function layer() {
    const f = document.fullscreenElement || document.webkitFullscreenElement;
    return f && f.tagName !== "VIDEO" ? f : document.documentElement;
  }

  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "text") e.textContent = v;
      else e.setAttribute(k, v);
    }
    e.append(...kids);
    return e;
  };

  const ICON_PATHS = {
    download: "M12 3v11m-4-4 4 4 4-4M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4",
    info: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 11v6M12 7h.01",
    close: "m6.5 6.5 11 11m0-11-11 11",
    chevron: "m6 9 6 6 6-6",
    video: "M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm12 3 5-3v12l-5-3",
    audio: "M9 17V5l11-2v12M9 8l11-2M9 17c0 1.4-1.6 2.5-3.5 2.5S2 18.4 2 17s1.6-2.5 3.5-2.5S9 15.6 9 17Zm11-2c0 1.4-1.6 2.5-3.5 2.5S13 16.4 13 15s1.6-2.5 3.5-2.5S20 13.6 20 15Z",
    check: "m5 12 4 4L19 6",
    warning: "m12 3 10 18H2L12 3Zm0 6v5m0 3h.01",
    collection: "M8 3h11a2 2 0 0 1 2 2v11M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z",
    lock: "M7 10h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Zm1 0V7a4 4 0 0 1 8 0v3m-4 4v3",
  };
  function symbol(kind, className = "ico") {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", ICON_PATHS[kind] || ICON_PATHS.download);
    svg.append(path);
    return svg;
  }

  function focusChoice(b, which = 0) {
    const choices = [...b.root.querySelectorAll(".item:not(:disabled), .act")];
    if (!choices.length) return false;
    const target = choices[Math.max(0, Math.min(which, choices.length - 1))];
    target.focus({ preventScroll: true });
    const box = b.root.getElementById("list-content");
    const r = target.getBoundingClientRect(), br = box.getBoundingClientRect();
    if (r.top < br.top + 6) box.scrollTop -= (br.top + 6 - r.top) / b.actualZoom;
    else if (r.bottom > br.bottom - 6) box.scrollTop += (r.bottom - br.bottom + 6) / b.actualZoom;
    return true;
  }

  function closeOne(b, restoreFocus = false) {
    b.open = false;
    b.help = false;
    b.focusMenu = false;
    renderOne(b);
    if (restoreFocus && !b.dismissed) b.root.getElementById("grab").focus({ preventScroll: true });
  }

  function releaseBubble(b) {
    b.disposed = true;
    b.generation++;
    b.cleanup?.();
    b.host.remove();
  }

  function makeBubble(video) {
    const host = document.createElement("div");
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.zIndex = "2147483647";
    host.style.colorScheme = "light dark";
    host.style.setProperty("--z", String(zoom));
    const root = host.attachShadow({ mode: "closed" });
    const content = el("div", { class: "list-scroll", id: "list-content" });
    const list = el("section", { class: "list", id: "list", role: "dialog", "aria-label": "Video download options", "aria-modal": "false" }, content);
    list.hidden = true;
    const spin = el("span", { class: "spin", id: "spin", "aria-hidden": "true", text: "…" });
    spin.hidden = true;
    root.append(
      el("style", { text: STYLE }),
      el("div", { class: "wrap" },
        el("div", { class: "btn", id: "main", role: "toolbar", "aria-label": "Mac Downloader video downloads" },
          el("button", { type: "button", class: "part", id: "grab", "aria-haspopup": "dialog", "aria-controls": "list", "aria-expanded": "false", title: "Choose a video format. Drag to reposition." },
            symbol("download", "ico download-symbol"), spin, el("span", { class: "visually-hidden", id: "label", text: "Download" }), el("span", { class: "visually-hidden", id: "count", "aria-hidden": "true" }))
        ), list)
    );
    const b = { host, root, video, open: false, own: null, loading: false, dx: null, dy: null, help: false, focusMenu: false, actualZoom: zoom, source: videoSource(video), linkPage: pageIdentity(linkFor(video) || location.href), generation: 0, disposed: false };
    const grab = root.getElementById("grab");
    // Native button activation works for mouse, keyboard and assistive tech.
    // Dragging suppresses only the click generated by that same gesture.
    let down = null, suppressClick = false;
    grab.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const hr = host.getBoundingClientRect();
      down = { x: e.clientX, y: e.clientY, ox: e.clientX - hr.left, oy: e.clientY - hr.top, moved: false };
      suppressClick = false;
      grab.focus({ preventScroll: true });
      e.preventDefault();
    });
    const move = (e) => {
      if (!down) return;
      if (!down.moved && Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) < 5) return;
      down.moved = true;
      root.getElementById("main").classList.add("drag");
      const r = video.getBoundingClientRect();
      b.dx = e.clientX - down.ox - r.left;
      b.dy = e.clientY - down.oy - r.top;
      placeOne(b);
    };
    const up = () => {
      if (!down) return;
      suppressClick = down.moved;
      down = null;
      root.getElementById("main").classList.remove("drag");
      if (suppressClick) setTimeout(() => { suppressClick = false; }, 0);
    };
    addEventListener("mousemove", move);
    addEventListener("mouseup", up);
    b.cleanup = () => { down = null; removeEventListener("mousemove", move); removeEventListener("mouseup", up); };
    grab.addEventListener("click", (e) => {
      if (suppressClick && e.detail !== 0) return;
      clicked(b, e.detail === 0);
    });
    root.addEventListener("keydown", (e) => {
      if (!b.open) return;
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation(); closeOne(b, true); return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      const choices = [...root.querySelectorAll(".item:not(:disabled), .act")];
      if (!choices.length) return;
      const current = choices.indexOf(root.activeElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? choices.length - 1 : e.key === "ArrowDown" ? (current + 1) % choices.length : (current < 0 ? choices.length - 1 : (current + choices.length - 1) % choices.length);
      e.preventDefault(); e.stopPropagation(); focusChoice(b, next);
    });
    root.addEventListener("focusout", (e) => {
      // relatedTarget is null when a list update removes its focused item;
      // do not mistake that update for the user leaving the widget.
      if (b.open && e.relatedTarget && !root.contains(e.relatedTarget)) closeOne(b);
    });
    layer().appendChild(host);
    bubbles.set(video, b);
    renderOne(b);
    placeOne(b);
    return b;
  }

  function itemsOf(b) {
    if (b.own) return b.own;
    return isMain(b.video) ? items : [];
  }

  function isProtectedVideo(b, knownItems) {
    return isNetflixWatch() || (knownItems || itemsOf(b)).some((m) => m.protected || m.type === "protected");
  }

  function lookUp(b) {
    if (!currentBubble(b, undefined, true)) return;
    if (isProtectedVideo(b)) { b.loading = false; b.open = true; renderOne(b); return; }
    // another video on the page (or nothing found for it yet): look it up now
    b.loading = true;
    b.open = true;
    const generation = b.generation;
    renderOne(b, "Looking for the video qualities…");
    chrome.runtime.sendMessage(
      // its own post / video link, or its own file; the page only when
      // neither is there
      {
        type: "swiftget-resolve-video",
        ...(TOP ? { clientToken } : { frameToken: clientToken }),
        // in a frame that is only a player: the add-in uses the page around it
        page: ownLink(b.video) || (directSrc(b.video) || !TOP ? "" : location.href),
        src: directSrc(b.video),
        frame: !TOP,
      },
      (res) => {
        if (!currentBubble(b, generation)) return;
        b.loading = false;
        if (chrome.runtime.lastError || !res) return notRunning(b, () => lookUp(b));
        if (res.error) {
          if (/not running/i.test(res.error)) return notRunning(b, () => lookUp(b));
          return renderOne(b, res.error, true);
        }
        b.own = res.items || [];
        renderOne(b);
      }
    );
  }

  function clicked(b, keyboard = false) {
    if (!currentBubble(b, undefined, true)) return;
    for (const other of bubbles.values()) if (other !== b && other.open) closeOne(other);
    b.focusMenu = keyboard;
    const list = itemsOf(b);
    if (!isProtectedVideo(b, list) && !list.length && !b.loading) return lookUp(b);
    b.help = false;
    b.open = !b.open;
    renderOne(b);
  }

  // The app is closed: offer to open it, then do what the user wanted.
  function notRunning(b, retry) {
    if (!currentBubble(b)) return;
    const generation = b.generation;
    b.open = true;
    renderOne(b, "Mac Downloader is not running.", true, {
      text: "Open Mac Downloader",
      run: () => {
        if (!currentBubble(b, generation)) return;
        // the program registers "ezoo-download:" when it is installed
        const a = document.createElement("a");
        a.href = "ezoo-download://open";
        a.style.display = "none";
        document.documentElement.appendChild(a);
        a.click();
        a.remove();
        renderOne(b, "Opening Mac Downloader…");
        let tries = 0;
        const wait = setInterval(() => {
          if (!currentBubble(b, generation)) { clearInterval(wait); return; }
          tries++;
          chrome.runtime.sendMessage({ type: "swiftget-status" }, (res) => {
            if (!currentBubble(b, generation)) { clearInterval(wait); return; }
            if (chrome.runtime.lastError) return;
            if (res && res.ok) {
              clearInterval(wait);
              retry();
            } else if (tries >= 25) {
              clearInterval(wait);
              renderOne(b, "Mac Downloader did not start. Open the app from Applications or your app launcher, then try again.", true);
            }
          });
        }, 1000);
      },
    });
  }

  function heightOf(q) {
    const m = /^(\d{3,4})p/.exec(q || "");
    return m ? Number(m[1]) : 0;
  }

  // One line of the menu, in plain words: "MP4 file · 1080p [Full HD] AV1",
  // under it "12:34 · 2,500 kbps · 245 MB".
  function describe(m) {
    const y = m.yt;
    if (!y) return { main: m.label, tag: "", codec: "", sub: m.sub || "" };
    const audio = y.quality === "audio" || y.quality === "mp3" || /^audio\|/.test(y.key || "");
    const ext = (y.ext || "mp4").toUpperCase();
    const q = audio ? "" : y.quality || "";
    const tag = audio ? "" : y.tag || tagOf(heightOf(q));
    const codec = audio ? "" : y.codec || (/\bAV1\b/.test(m.label || "") ? "AV1" : "");
    const kbps = y.kbps || (y.size && y.duration ? Math.round((y.size * 8) / y.duration / 1000) : 0);
    const sub = [
      fmtLen(y.duration),
      kbps ? `${kbps.toLocaleString("en")} kbps` : "",
      y.size ? (y.quality === "mp3" ? "about " : "") + fmtSize(y.size) : "",
      y.quality === "mp3" ? "made into MP3 after the download" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const kind = audio ? `${ext} audio` : `${ext} file`;
    return { main: q ? `${kind} · ${q}` : kind, tag, codec, sub };
  }

  // "Download all": the whole playlist (YouTube list), or every file found
  function downloadAllOf(b, usable) {
    if (TOP && /youtube\.com/i.test(location.hostname) && /[?&]list=/.test(location.search)) {
      return { text: "Download all videos of this playlist", run: () => sendPlaylist(b) };
    }
    const files = usable.filter((m) => !m.yt && m.url);
    if (files.length >= 2) {
      return {
        text: `Download all (${files.length} files)`,
        run: () => files.forEach((m, i) => setTimeout(() => download(b, m), i * 300)),
      };
    }
    return null;
  }

  function sendPlaylist(b) {
    if (!currentBubble(b, undefined, true)) return;
    const generation = b.generation;
    chrome.runtime.sendMessage({ type: "swiftget-playlist", url: location.href }, (res) => {
      if (!currentBubble(b, generation)) return;
      if (chrome.runtime.lastError || !res || !res.ok) return notRunning(b, () => sendPlaylist(b));
      flashOne(b, "Playlist opened in Mac Downloader.", false);
    });
  }

  function renderOne(b, note, isError, action) {
    if (!currentBubble(b)) return;
    const list = itemsOf(b);
    const usable = list.filter((i) => !i.disabled);
    const busy = b.loading || (!usable.length && list.some((i) => i.disabled && /Getting/.test(i.label)));
    const trigger = b.root.getElementById("grab");
    const box = b.root.getElementById("list");
    const content = b.root.getElementById("list-content");
    const oldFocus = b.root.activeElement;
    const focusIndex = [...box.querySelectorAll(".item:not(:disabled), .act")].indexOf(oldFocus);
    const focusKey = oldFocus?.getAttribute?.("data-choice");
    const focusClose = oldFocus?.classList?.contains("popover-close");
    const headerFocus = ["help", "close"].includes(oldFocus?.getAttribute?.("id")) ? oldFocus.getAttribute("id") : "";
    const protectedVideo = isProtectedVideo(b, list);
    b.root.getElementById("label").textContent = protectedVideo ? "Protected video" : busy ? "Finding formats…" : "Download";
    const count = b.root.getElementById("count");
    count.textContent = String(usable.length);
    count.hidden = protectedVideo || busy || usable.length <= 1;
    b.root.getElementById("spin").hidden = protectedVideo || !busy;
    const mainSymbol = b.root.querySelector(".download-symbol");
    mainSymbol.style.display = !protectedVideo && busy ? "none" : "";
    mainSymbol.querySelector("path").setAttribute("d", protectedVideo ? ICON_PATHS.lock : ICON_PATHS.download);
    trigger.setAttribute("aria-expanded", String(b.open));
    trigger.setAttribute("aria-busy", String(!protectedVideo && busy));
    trigger.setAttribute("aria-label", protectedVideo ? "Netflix protected video information" : busy ? "Finding video download formats" : `Choose a video download format${usable.length ? `, ${usable.length} available` : ""}`);
    b.root.getElementById("main").classList.toggle("open", b.open);
    box.hidden = !b.open;
    content.replaceChildren();
    // Closed controls do not need to rebuild their hidden option lists.
    if (!b.open) return;
    const title = (list.find((m) => m.yt && m.yt.title) || {}).yt;
    const heading = el("div", { class: "head" },
      el("div", { class: "heading-body" }, el("div", { class: "heading", text: protectedVideo ? "Protected Video" : "Download Video" }),
        el("div", { class: "video-title", title: (title && title.title) || cleanTitle(), text: (title && title.title) || cleanTitle() })),
      el("button", { type: "button", class: "side", id: "help", title: "Widget help", "aria-label": "Widget help" }, symbol("info")),
      el("button", { type: "button", class: "side", id: "close", title: "Hide for this video", "aria-label": "Hide download widget for this video" }, symbol("close")),
      el("button", { type: "button", class: "side popover-close", title: "Close options", "aria-label": "Close download options" }, symbol("chevron")));
    heading.querySelector(".popover-close").addEventListener("click", () => closeOne(b, true));
    heading.querySelector("#help").addEventListener("click", (e) => {
      b.help = !b.help; b.focusMenu = e.detail === 0; renderOne(b);
    });
    heading.querySelector("#close").addEventListener("click", () => {
      b.dismissed = true; b.open = false; b.host.remove();
      if ([...bubbles.values()].every(other => other.dismissed)) restoreLane();
      if (b.video.tabIndex >= 0) b.video.focus({ preventScroll: true });
    });
    content.appendChild(heading);
    if (b.help) {
      content.appendChild(el("div", { class: "help", text: "Choose a format to send it to Mac Downloader. Drag the Download button to move it. Hide removes it for this video; use the browser extension menu to show it again or change its size. Keyboard: Tab to the controls, use arrow keys to choose, and Escape to close." }));
    }
    const finish = () => {
      placeOne(b);
      if (headerFocus) heading.querySelector(`#${headerFocus}`).focus({ preventScroll: true });
      else if (focusClose) heading.querySelector(".popover-close").focus({ preventScroll: true });
      else if (b.focusMenu || focusIndex >= 0) {
        const choices = [...box.querySelectorAll(".item:not(:disabled), .act")];
        const same = focusKey ? choices.findIndex((row) => row.getAttribute("data-choice") === focusKey) : -1;
        if (focusChoice(b, same >= 0 ? same : focusIndex >= 0 ? focusIndex : 0)) b.focusMenu = false;
        else trigger.focus({ preventScroll: true });
      }
    };
    if (protectedVideo) {
      content.appendChild(el("div", { class: "msg protected", role: "status" }, symbol("lock"), el("div", { class: "msg-body", text: NETFLIX_NOTICE })));
      finish();
      return;
    }
    if (note) {
      const body = el("div", { class: "msg-body", text: note });
      if (action) {
        const button = el("button", { type: "button", class: "act", text: action.text });
        button.addEventListener("click", action.run);
        body.appendChild(button);
      }
      content.appendChild(el("div", { class: "msg" + (isError ? " err" : busy ? " pending" : ""), role: "status", "aria-live": "polite" }, symbol(isError ? "warning" : busy ? "info" : "check"), body));
      finish();
      return;
    }
    if (!list.length) {
      content.appendChild(el("div", { class: "msg pending", role: "status", "aria-live": "polite" }, symbol("info"), el("div", { class: "msg-body", text: "Finding available video formats…" })));
      finish();
      return;
    }
    const all = downloadAllOf(b, usable);
    if (all) {
      const row = el("button", { type: "button", class: "item", "aria-label": all.text },
        el("span", { class: "format-symbol" }, symbol("collection")), el("span", { class: "body" }, el("span", { class: "t all", text: all.text })), symbol("download", "ico accessory"));
      row.addEventListener("click", all.run);
      content.appendChild(row);
    }
    const isAudio = (m) => (m.yt && (m.yt.quality === "audio" || m.yt.quality === "mp3" || /^audio\|/.test(m.yt.key || ""))) || /^audio\//i.test(m.label || "") || /^(?:mp3|m4a|aac|ogg|opus|flac|wav)$/i.test(m.ext || "");
    for (const audio of [false, true]) {
      const options = list.filter((m) => isAudio(m) === audio);
      if (!options.length) continue;
      const group = el("section", { class: "group", "aria-label": audio ? "Audio formats" : "Video formats" }, el("h3", { class: "group-title", text: audio ? "Audio" : "Video" }));
      for (const m of options) {
        const d = describe(m);
        const main = el("span", { class: "t" }, el("span", { text: d.main }));
        if (d.tag) main.appendChild(el("span", { class: "tag", text: d.tag }));
        if (d.codec) main.appendChild(el("span", { class: "codec", text: d.codec }));
        const sub = d.sub.length > 160 ? d.sub.slice(0, 160) + "…" : d.sub;
        const body = el("span", { class: "body" }, main);
        if (sub) body.appendChild(el("span", { class: "s", text: sub }));
        const row = el("button", { type: "button", class: "item", "data-choice": m.yt?.key || m.url || m.label || "", "aria-label": [d.main, d.tag, d.codec, d.sub].filter(Boolean).join(", ") }, el("span", { class: "format-symbol" }, symbol(audio ? "audio" : "video")), body);
        row.disabled = !!m.disabled;
        row.setAttribute("aria-disabled", String(!!m.disabled));
        if (!m.disabled) {
          row.appendChild(symbol("download", "ico accessory"));
          const generation = b.generation;
          row.addEventListener("click", () => { if (currentBubble(b, generation)) download(b, m); });
        }
        group.appendChild(row);
      }
      content.appendChild(group);
    }
    finish();
  }

  // Page content is untrusted. Only use fixed selectors for landmarks and
  // interactive/media elements, and never interpret attributes as code.
  const OCCUPIED = 'header, nav, aside, [role="banner"], [role="navigation"], [role="complementary"], [role="region"], [role="list"], [role="listitem"], a[href], button, input, select, textarea, [role="button"], [role="link"], h1, h2, h3, h4, h5, h6, p, img, svg, video, audio, iframe, canvas, [contenteditable="true"]';

  function intersects(rect, x, y, w, h) {
    return (rect.right == null || rect.right > x) && (rect.left == null || rect.left < x + w) &&
      rect.bottom > y && rect.top < y + h;
  }

  function movesWithPlayer(player, element, blocker) {
    let node = player?.contains?.(element) ? element : player?.contains?.(blocker) ? blocker : null;
    if (!node) return false;
    // Fixed or sticky descendants may remain in the projected lane even
    // though their containing player moves. Treat them as real blockers.
    while (node && node !== player) {
      try {
        const position = getComputedStyle(node).position;
        if (position === 'fixed' || position === 'sticky') return false;
      } catch (_) { return false; }
      node = node.parentElement;
    }
    return node === player;
  }

  function clearOutside(b, x, y, w, h, options = {}) {
    if (x < 4 || y < 4 || x + w > innerWidth - 4 || y + h > innerHeight - 4) return false;
    if (typeof document.elementsFromPoint !== "function") return true;
    const points = [[x + w / 2, y + h / 2], [x + 2, y + 2], [x + w - 2, y + h - 2]];
    for (const [px, py] of points) {
      for (const element of document.elementsFromPoint(px, py)) {
        if (element === b.host || element === b.video || element === document.documentElement || element === document.body) continue;
        const blocker = element.closest?.(OCCUPIED);
        if (!blocker || blocker === b.host || blocker === b.video || blocker.contains?.(b.video) || blocker.contains?.(b.host)) continue;
        if (options.movingPlayer && movesWithPlayer(options.movingPlayer, element, blocker)) continue;
        if (intersects(blocker.getBoundingClientRect(), x, y, w, h)) { options.onBlock?.(blocker); return false; }
      }
    }
    return true;
  }

  function blockerState(blocker) {
    if (!blocker) return '';
    try {
      const r = blocker.getBoundingClientRect();
      const style = getComputedStyle(blocker);
      return [blocker.isConnected, r.left, r.top, r.right, r.bottom,
        style.display, style.visibility, style.opacity, style.position, style.pointerEvents, style.zIndex].join('/');
    } catch (_) { return 'unavailable'; }
  }

  function pageHeaderBottom(x) {
    if (typeof document.elementsFromPoint !== "function") return 0;
    let bottom = 0;
    for (const element of document.elementsFromPoint(Math.max(0, Math.min(innerWidth - 1, x)), 4)) {
      const header = element.closest?.('header, nav, [role="banner"], [role="navigation"]');
      if (!header) continue;
      const rect = header.getBoundingClientRect();
      if (rect.top <= 4 && rect.bottom > 0 && rect.bottom < innerHeight / 2) bottom = Math.max(bottom, rect.bottom);
    }
    return bottom;
  }

  // The user requested a small space above YouTube's player when the page
  // has no safe external slot. Reserve flow space without modifying the
  // masthead, and restore only the inline property that we still own.
  function restoreLane() {
    if (!reservedLane) return;
    const { node, before, priority, applied, appliedPriority } = reservedLane;
    if (node.style.getPropertyValue('margin-top') === applied && node.style.getPropertyPriority('margin-top') === appliedPriority) {
      if (before) node.style.setProperty('margin-top', before, priority);
      else node.style.removeProperty('margin-top');
    }
    reservedLane = null;
  }

  function resizeLane(height) {
    if (!reservedLane) return false;
    const lane = reservedLane;
    if (lane.node.style.getPropertyValue('margin-top') !== lane.applied ||
        lane.node.style.getPropertyPriority('margin-top') !== lane.appliedPriority) {
      reservedLane = null;
      blockedLaneNode = lane.node;
      return false;
    }
    const size = Math.ceil(height + 8);
    if (size === lane.size) return true;
    const oldTop = lane.node.getBoundingClientRect().top;
    lane.node.style.setProperty('margin-top', `${lane.baseMargin + size}px`, lane.priority);
    lane.applied = lane.node.style.getPropertyValue('margin-top');
    lane.appliedPriority = lane.node.style.getPropertyPriority('margin-top');
    const shift = lane.node.getBoundingClientRect().top - oldTop;
    if (Math.abs(shift - (size - lane.size)) > 1) { restoreLane(); return false; }
    lane.size = size;
    return true;
  }

  function youtubeLane(b, w, h) {
    if (!TOP || b.video !== mainVideo || !/(^|\.)youtube\.com$/i.test(location.hostname) || typeof getComputedStyle !== 'function') return null;
    const player = b.video.closest?.('#player');
    if (!player || !player.isConnected || !player.style?.getPropertyValue || player === blockedLaneNode) return null;
    if (reservedLane && reservedLane.node !== player) restoreLane();
    if (reservedLane && (player.style.getPropertyValue('margin-top') !== reservedLane.applied ||
        player.style.getPropertyPriority('margin-top') !== reservedLane.appliedPriority)) {
      // The page or user changed this property. Never overwrite their change.
      reservedLane = null;
      blockedLaneNode = player;
      return null;
    }
    let created = false;
    if (!reservedLane) {
      const style = getComputedStyle(player);
      const margin = parseFloat(style.marginTop);
      if (!Number.isFinite(margin) || !/^-?\d+(?:\.\d+)?px$/.test(style.marginTop) ||
          style.display === 'none' || style.position === 'absolute' || style.position === 'fixed') return null;
      const before = player.style.getPropertyValue('margin-top');
      const priority = player.style.getPropertyPriority('margin-top');
      const beforeRect = player.getBoundingClientRect();
      const videoRect = b.video.getBoundingClientRect();
      const size = Math.ceil(h + 8);
      const fingerprint = [beforeRect.left, beforeRect.top, beforeRect.right, beforeRect.bottom,
        videoRect.left, videoRect.top, videoRect.right, videoRect.bottom, innerWidth, innerHeight,
        w, h, margin, before, priority].join('/');
      const oldTop = beforeRect.top;
      const x = Math.max(4, Math.min(innerWidth - w - 4, beforeRect.right - w - 8));
      const y = oldTop + size - h - 4;
      // A blocked predicted lane needs no page mutation. Recheck the
      // obstruction on the existing placement timer so removing it recovers.
      const clear = y >= 4 && y + h <= videoRect.top + size && clearOutside(b, x, y, w, h, { movingPlayer: player });
      if (b.failedLane?.player === player && b.failedLane.fingerprint === fingerprint &&
          ((b.failedLane.reason === 'preflight' && !clear) || b.failedLane.reason === 'layout' ||
           (b.failedLane.reason === 'blocked' && blockerState(b.failedLane.blocker) === b.failedLane.blockerState))) return null;
      if (!clear) { b.failedLane = { player, fingerprint, reason: 'preflight' }; return null; }
      b.failedLane = null;
      player.style.setProperty('margin-top', `${margin + size}px`, priority);
      reservedLane = { node: player, video: b.video, before, priority, applied: player.style.getPropertyValue('margin-top'),
        appliedPriority: player.style.getPropertyPriority('margin-top'), baseMargin: margin, size };
      created = true;
      if (Math.abs(player.getBoundingClientRect().top - oldTop - size) > 1) {
        restoreLane(); b.failedLane = { player, fingerprint, reason: 'layout' }; return null;
      }
      reservedLane.attemptFingerprint = fingerprint;
    }
    const r = player.getBoundingClientRect();
    const video = b.video.getBoundingClientRect();
    const x = Math.max(4, Math.min(innerWidth - w - 4, r.right - w - 8));
    const y = r.top - h - 4;
    let blocker = null;
    if (y < 4 || y + h > video.top || !clearOutside(b, x, y, w, h, { onBlock: node => { blocker = node; } })) {
      if (created) {
        const fingerprint = reservedLane.attemptFingerprint;
        restoreLane();
        b.failedLane = { player, fingerprint, reason: 'blocked', blocker, blockerState: blockerState(blocker) };
      }
      return null;
    }
    return { name: 'lane', x, y };
  }

  function placeOne(b) {
    const fs = document.fullscreenElement || document.webkitFullscreenElement;
    let r = b.video.getBoundingClientRect();
    const onScreen =
      r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth &&
      r.width >= 200 && r.height >= 100 && b.video.isConnected && innerWidth >= 36 && innerHeight >= 36 &&
      !fs && !topFullscreen && !b.video.webkitDisplayingFullscreen;
    b.host.style.display = onScreen ? "block" : "none";
    if (!onScreen) return;
    if (b.host.parentNode !== layer()) layer().appendChild(b.host);
    // Scale down only when the viewport is too small for the chosen size.
    b.actualZoom = Math.min(zoom, (innerWidth - 8) / 42, (innerHeight - 8) / 42);
    b.host.style.setProperty("--z", String(b.actualZoom));
    const w = b.host.getBoundingClientRect().width || 42 * b.actualZoom;
    const h = b.root.getElementById("main").getBoundingClientRect().height || 42 * b.actualZoom;
    if (reservedLane?.video === b.video) {
      resizeLane(h);
      r = b.video.getBoundingClientRect();
    }
    const visibleWidth = Math.min(innerWidth, r.right) - Math.max(0, r.left);
    if (visibleWidth < Math.min(w, 42)) { b.host.style.display = "none"; return; }
    let geometry = [r.left, r.top, r.right, r.bottom, innerWidth, innerHeight, w, h, b.dx, b.dy].join("/");
    let chosen;
    const age = b.placement ? Date.now() - b.placement.time : -1;
    if (b.placement && b.placement.geometry === geometry && b.placement.epoch === placementEpoch && age >= 0 && age < 2800) {
      chosen = b.placement.slot;
    } else {
      // Above is preferred; side gutters are a fallback only when the
      // candidate is truly outside the player, visible, and unobstructed.
      const minAboveX = Math.max(4, r.left + 4);
      const maxAboveX = Math.min(innerWidth - w - 4, r.right - w - 4);
      const aboveX = Math.max(minAboveX, Math.min(b.dx == null ? r.right - w - 8 : r.left + b.dx, maxAboveX));
      const above = maxAboveX >= minAboveX ? { name: "above", x: aboveX, y: r.top - h - 8 } : null;
      const side = (name, x) => {
        if (x < 4 || x + w > innerWidth - 4) return null;
        const headerBottom = pageHeaderBottom(x + w / 2);
        const visibleBottom = Math.min(innerHeight - 4, r.bottom - 4);
        const defaultTop = r.top < 0 ? Math.min(72, Math.max(4, visibleBottom - h)) : 4;
        const visibleTop = Math.max(4, r.top + 4, headerBottom ? headerBottom + 8 : defaultTop);
        if (visibleTop + h > visibleBottom) return null;
        const y = Math.max(visibleTop, Math.min(b.dy == null ? r.top + 8 : r.top + b.dy, visibleBottom - h));
        return { name, x, y };
      };
      const candidates = [above, side("right", r.right + 8), side("left", r.left - w - 8)].filter(Boolean);
      // Recheck the last safe slot first when page geometry is unchanged so
      // periodic media updates cannot make the control hop between gutters.
      if (b.placement?.geometry === geometry && b.placement.slot) {
        const index = candidates.findIndex((candidate) => candidate.name === b.placement.slot.name);
        if (index > 0) candidates.unshift(...candidates.splice(index, 1));
      }
      chosen = (reservedLane?.video === b.video && youtubeLane(b, w, h)) ||
        candidates.find((candidate) => clearOutside(b, candidate.x, candidate.y, w, h)) || youtubeLane(b, w, h);
      // Reserving the lane moves the player in flow; cache the new geometry.
      r = b.video.getBoundingClientRect();
      geometry = [r.left, r.top, r.right, r.bottom, innerWidth, innerHeight, w, h, b.dx, b.dy].join("/");
      b.placement = { geometry, epoch: placementEpoch, time: Date.now(), slot: chosen };
    }
    if (!chosen) { b.host.style.display = "none"; return; }
    b.host.style.left = `${chosen.x}px`;
    b.host.style.top = `${chosen.y}px`;
    if (b.open) {
      const box = b.root.getElementById("list");
      const content = b.root.getElementById("list-content");
      box.style.maxWidth = `${Math.max(1, (innerWidth - 16) / b.actualZoom)}px`;
      const hr = b.host.getBoundingClientRect();
      const width = box.getBoundingClientRect().width;
      const wanted = Math.min(440 * b.actualZoom, content.scrollHeight * b.actualZoom + 2 * b.actualZoom);
      const alignedX = Math.max(4, Math.min(hr.right - width, innerWidth - width - 4));
      const external = [];
      // Prefer room above the trigger, then either side of the player. A
      // bounded shorter menu remains scrollable if the available room is small.
      const spaceAbove = hr.top - 12;
      if (spaceAbove >= Math.min(wanted, 120) && hr.top <= r.top) {
        const height = Math.min(wanted, spaceAbove);
        external.push({ x: alignedX, y: hr.top - 8 - height, height });
      }
      for (const x of [r.right + 8, r.left - width - 8]) {
        if (x < 4 || x + width > innerWidth - 4) continue;
        const anchorInside = hr.left < x + width && hr.right > x;
        const top = anchorInside ? hr.bottom + 8 : Math.max(4, Math.min(r.top, innerHeight - 4));
        const available = innerHeight - 4 - top;
        if (available >= Math.min(wanted, 120)) external.push({ x, y: top, height: Math.min(wanted, available) });
      }
      const outside = external.find((candidate) => clearOutside(b, candidate.x, candidate.y, width, candidate.height));
      const below = Math.max(0, innerHeight - hr.bottom - 12), above = Math.max(0, hr.top - 12);
      const aboveMenu = below < Math.min(wanted, 300) && above > below;
      const height = outside ? outside.height : Math.min(wanted, aboveMenu ? above : below);
      const menuLeft = outside ? outside.x : alignedX;
      const menuTop = outside ? outside.y : aboveMenu ? hr.top - 8 - height : hr.bottom + 8;
      const maxHeight = Math.max(1, height / b.actualZoom);
      box.style.maxHeight = `${maxHeight}px`;
      content.style.maxHeight = `${Math.max(0, maxHeight - 2)}px`;
      box.classList.remove("above");
      box.style.right = "auto";
      box.style.left = `${(menuLeft - hr.left) / b.actualZoom}px`;
      box.style.bottom = "auto";
      box.style.top = `${(menuTop - hr.top) / b.actualZoom}px`;
    }
  }

  function place() {
    syncPage();
    if (!panelAllowed()) { restoreLane(); return; }
    const videos = allVideos();
    const main = biggestVideo(videos);
    if (reservedLane) {
      const lane = reservedLane;
      if (lane.node.style.getPropertyValue('margin-top') !== lane.applied ||
          lane.node.style.getPropertyPriority('margin-top') !== lane.appliedPriority) {
        reservedLane = null;
        blockedLaneNode = lane.node;
        placementEpoch++;
      } else if (!lane.node.isConnected || !lane.video.isConnected || (main && lane.video !== main)) {
        restoreLane();
        placementEpoch++;
      }
    }
    syncMainVideo(main);
    const vids = videos.filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width >= 200 && r.height >= 100;
    });
    // bubbles of videos that went away
    for (const [v, b] of bubbles) {
      if (!v.isConnected) {
        releaseBubble(b);
        bubbles.delete(v);
      }
    }
    if (!bubbles.size) restoreLane();
    // the main video once the add-in found media or it plays (then it shows
    // "looking for qualities"), any other one as soon as it is a real player
    for (const v of vids.slice(0, 12)) {
      let b = bubbles.get(v);
      if (!b) {
        const show = TOP && v === main ? items.length || playing(v) : !(v.paused && !(v.duration > 3) && !directSrc(v));
        if (!show) continue;
        b = makeBubble(v);
      }
      if (syncVideo(b)) renderOne(b);
      if (!b.dismissed) placeOne(b);
    }
  }

  function flashOne(b, text, isError) {
    if (!currentBubble(b)) return;
    const generation = b.generation;
    b.open = true;
    renderOne(b, text, isError);
    setTimeout(() => {
      if (!currentBubble(b, generation)) return;
      b.open = false;
      renderOne(b);
    }, 2500);
  }

  function download(b, m) {
    if (!currentBubble(b, undefined, true) || !itemsOf(b).includes(m)) return;
    if (isProtectedVideo(b) || m.protected || m.type === "protected") { b.open = true; renderOne(b); return; }
    const generation = b.generation;
    const fileName = `${cleanTitle()}.${m.ext || "mp4"}`;
    chrome.runtime.sendMessage(
      { type: "swiftget-download", item: m, title: document.title, fileName, referrer: location.href, ...(TOP ? { clientToken } : { frameToken: clientToken }) },
      (res) => {
        if (!currentBubble(b, generation)) return;
        if (chrome.runtime.lastError || !res || !res.ok) notRunning(b, () => download(b, m));
        else flashOne(b, "Sent to Mac Downloader.", false);
      }
    );
  }

  function update(newItems) {
    if (!TOP) return; // frames look up their own videos
    syncPage();
    items = newItems || [];
    if (!items.length) {
      // The worker may temporarily have no formats while a player loads or
      // changes. Keep its control visible but invalidate old choices and any
      // pending callbacks until current formats become available.
      for (const b of bubbles.values()) {
        // A player can have independently resolved formats or a lookup in
        // progress. An empty global list does not invalidate that work while
        // the player's page, source, and generation still match.
        if ((b.own || b.loading) && currentBubble(b, b.generation, true)) continue;
        b.generation++;
        b.own = null;
        b.loading = false;
        b.open = false;
        b.help = false;
        b.focusMenu = false;
        renderOne(b);
      }
      return;
    }
    if (!panelAllowed()) return;
    place();
    for (const b of bubbles.values()) if (!b.own && !b.loading) renderOne(b);
  }

  // magnet links of torrents go to Mac Downloader (Alt + click: to the browser)
  addEventListener(
    "click",
    (e) => {
      if (e.button !== 0 || e.altKey || e.defaultPrevented || !switchedOn) return;
      const a = e.composedPath ? e.composedPath().find((n) => n && n.tagName === "A" && n.href) : null;
      const href = a ? String(a.href) : "";
      if (!/^magnet:\?/i.test(href) || !/xt=urn:bt[im]h:/i.test(href)) return;
      e.preventDefault();
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: "swiftget-magnet", url: href }, (res) => {
        // not taken (the app is closed, or sending is off): the browser's way
        if (chrome.runtime.lastError || !res || !res.ok) location.href = href;
      });
    },
    true
  );

  // a click anywhere else closes an open menu
  addEventListener(
    "mousedown",
    (e) => {
      const path = e.composedPath ? e.composedPath() : [];
      for (const b of bubbles.values()) {
        if (b.open && !path.includes(b.host)) {
          closeOne(b);
        }
      }
    },
    true
  );
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const b of bubbles.values()) {
      if (b.open) {
        closeOne(b, !!b.root.activeElement);
      }
    }
  });
  for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) {
    document.addEventListener(ev, () => {
      placementEpoch++;
      if (localFullscreen()) restoreLane();
      bubbles.forEach((b) => placeOne(b));
      notifyTopFullscreen();
      setTimeout(() => bubbles.forEach((b) => placeOne(b)), 50);
    });
  }
  for (const ev of ["webkitbeginfullscreen", "webkitendfullscreen"]) {
    document.addEventListener(ev, () => {
      placementEpoch++;
      if (ev === 'webkitbeginfullscreen') restoreLane();
      setTimeout(() => bubbles.forEach((b) => placeOne(b)), 50);
    }, true);
  }

  // every link of the page (or the selection) for "Download all links"
  function collectLinks(selectionOnly) {
    const sel = selectionOnly ? getSelection() : null;
    const inSel = (el) => !sel || (sel.rangeCount > 0 && sel.containsNode(el, true));
    const out = [];
    const seen = new Set();
    const add = (url, text) => {
      if (!url || !/^https?:/i.test(url)) return;
      url = url.split("#")[0];
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ url, text: (text || "").replace(/\s+/g, " ").trim().slice(0, 200) });
    };
    for (const a of document.querySelectorAll("a[href]")) if (inSel(a)) add(a.href, a.innerText || a.title);
    for (const el of document.querySelectorAll("img[src], video[src], audio[src], source[src], embed[src]")) {
      if (inSel(el)) add(el.src, el.alt || el.title || "");
    }
    return { page: location.href, links: out };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only a message from this extension's background context can request or
    // announce fullscreen state. Pages and other content scripts cannot.
    const fromBackground = typeof chrome.runtime.id === "string" && !!chrome.runtime.id && sender?.id === chrome.runtime.id && !sender.tab;
    if (msg.type === "swiftget-request-client-token") {
      if (TOP && fromBackground) { syncPage(); syncMainVideo(); sendResponse({ clientToken }); }
      return false;
    }
    if (msg.type === "swiftget-request-frame-generation") {
      if (fromBackground) { syncPage(); syncMainVideo(); sendResponse({ frameToken: clientToken }); }
      return false;
    }
    if (msg.type === "swiftget-refresh-current-player") {
      if (fromBackground) { lastPage = ""; watchVideos(null, 0, true); }
      return false;
    }
    if (msg.type === "swiftget-read-top-fullscreen") {
      if (TOP && fromBackground) sendResponse({ fullscreen: localFullscreen() });
      return false;
    }
    if (msg.type === "swiftget-refresh-top-fullscreen") {
      if (!TOP && fromBackground) syncTopFullscreen();
      return false;
    }
    if (msg.type === "swiftget-media") {
      syncPage();
      syncMainVideo();
      if (msg.clientToken === clientToken) update(msg.items);
      else if (TOP && fromBackground && !msg.clientToken && Date.now() - lastMediaHandshake >= 2000) {
        // A restarted worker has forgotten its in-memory token. Ignore the
        // untagged data and perform a bounded same-generation handshake.
        lastMediaHandshake = Date.now();
        requestMedia();
      }
    }
    if (msg.type === "swiftget-collect-links") {
      if (!TOP) return false; // the page itself answers
      sendResponse(collectLinks(!!msg.selection));
      return true;
    }
    if (msg.type === "swiftget-open-panel") {
      // A user explicitly opening the extension is a bounded opportunity to
      // recover after a temporarily unavailable top frame or worker. Remain
      // hidden unless an authenticated query confirms fullscreen has ended.
      if (!TOP && fromBackground && topFullscreen) syncTopFullscreen();
      const v = biggestVideo();
      if (!v) return false;
      let b = bubbles.get(v);
      if (!b) b = makeBubble(v);
      b.dismissed = false;
      layer().appendChild(b.host);
      for (const other of bubbles.values()) if (other !== b && other.open) closeOne(other);
      b.open = true;
      if (!itemsOf(b).length) lookUp(b);
      else renderOne(b);
      placeOne(b);
    }
    return false;
  });
  if (TOP) notifyTopFullscreen();
  else syncTopFullscreen();
  chrome.runtime.sendMessage({ type: "swiftget-config" }, (res) => {
    if (!chrome.runtime.lastError && res) {
      panel = res;
      if (!panelAllowed()) {
        for (const b of bubbles.values()) releaseBubble(b);
        bubbles.clear();
        restoreLane();
      }
    }
  });
  if (TOP) {
    // keys held while clicking a link: Alt = let the browser download it, etc.
    addEventListener(
      "mousedown",
      (e) => {
        chrome.runtime.sendMessage({ type: "swiftget-keys", alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey }).catch?.(() => {});
      },
      true
    );
    // media detected before this script loaded
    requestMedia();
  }

  // Scroll/resize events can arrive in bursts, including from nested page
  // scrollers. Recheck placement at most once per paint using the newest
  // geometry; fullscreen events above still hide controls immediately.
  let viewportFramePending = false;
  const viewportChanged = () => {
    placementEpoch++;
    if (viewportFramePending) return;
    viewportFramePending = true;
    requestAnimationFrame(() => {
      viewportFramePending = false;
      place();
    });
  };
  addEventListener("scroll", viewportChanged, { passive: true, capture: true });
  addEventListener("resize", viewportChanged, { passive: true });
  setInterval(place, 700);
  setInterval(watchVideos, 1500);
  document.addEventListener("play", (event) => {
    const path = event.composedPath?.() || [event.target];
    const playedVideo = path.find((node) => node?.tagName === "VIDEO") || null;
    const playedAt = Date.now();
    setTimeout(() => (watchVideos(playedVideo, playedAt), place()), 300);
  }, true);
  addEventListener("popstate", () => { syncPage(); setTimeout(watchVideos, 500); });
  document.addEventListener("yt-navigate-finish", () => { syncPage(); watchVideos(); place(); });
})();
