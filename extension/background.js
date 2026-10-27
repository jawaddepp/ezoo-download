// Mac Downloader browser integration (Manifest V3 service worker)
//  1. takes over browser downloads and hands them to the Mac Downloader app
//     together with cookies + referrer, so links behind a login still work
//  2. watches network responses for video/audio and HLS streams and offers
//     a "Download this video" button on the page
//  3. Videos on web pages: the app finds the qualities with yt-dlp,
//     downloads video + audio with many connections and joins them
//  4. adds "Download with Mac Downloader", "Download all links with Mac
//     Downloader" and "Download video with Mac Downloader" to the right-click menu
//  5. follows the app's Options: file types to take, sites to leave alone,
//     the keys that skip / force Mac Downloader, the video panel

// Chrome / Edge / Opera load yt-core.js here; Firefox lists it in its manifest
if (typeof importScripts === "function") importScripts("yt-core.js");

// enabled: the on / off switch of the add-in's window (off = the browser
// keeps its downloads and no buttons are shown on videos)
const DEFAULTS = { port: 9614, intercept: true, minSizeKB: 0, enabled: true };
let preparedPortPromise = null;

// The desktop setup flow can prepare a stable extension copy with its port.
// Missing metadata is normal for bundled/source/store copies. Read it only
// once per worker; explicit options saved by the user always take precedence.
async function preparedAppPort() {
  if (!preparedPortPromise) {
    preparedPortPromise = (async () => {
      try {
        if (typeof chrome.runtime.getURL !== "function") return DEFAULTS.port;
        const response = await fetchWithTimeout(chrome.runtime.getURL("app-connection.json"), {}, 800);
        if (!response.ok || typeof response.text !== "function") return DEFAULTS.port;
        const text = await response.text();
        if (text.length > 1024) return DEFAULTS.port;
        const config = JSON.parse(text);
        return config && Number.isInteger(config.port) && config.port >= 1 && config.port <= 65535 ? config.port : DEFAULTS.port;
      } catch {
        return DEFAULTS.port;
      }
    })();
  }
  return preparedPortPromise;
}

async function getOpts() {
  const defaults = { ...DEFAULTS, port: await preparedAppPort() };
  return Object.assign({}, defaults, await chrome.storage.local.get(defaults));
}

function apiUrl(port, path) {
  return `http://127.0.0.1:${port}${path}`;
}

async function fetchWithTimeout(url, opts = {}, ms = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- setup readiness
// A dedicated extension announcement lets the setup window distinguish an
// installed add-on from an ordinary app ping. This is UX feedback, not auth.
let readinessAt = 0;
let readinessIdentity = "";
let readinessPending = null;
let readinessSucceeded = false;

async function browserFamily() {
  const ua = navigator.userAgent || "";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/Edg(?:e|A|iOS)?\//i.test(ua)) return "Edge";
  if (/(?:OPR|Opera)\//i.test(ua)) return "Opera";
  try {
    if (navigator.brave && typeof navigator.brave.isBrave === "function" && await navigator.brave.isBrave()) return "Brave";
  } catch { /* identifying the browser is optional */ }
  return /(?:Chrome|CriOS)\//i.test(ua) ? "Chrome" : "Chromium";
}

async function announceExtensionReady(force = false) {
  const opts = await getOpts();
  const version = String(chrome.runtime.getManifest().version || "");
  if (!/^[0-9][A-Za-z0-9._+-]{0,31}$/.test(version) || typeof chrome.runtime.getURL !== "function") return false;
  let extensionOrigin;
  try {
    const root = new URL(chrome.runtime.getURL(""));
    if (!["chrome-extension:", "moz-extension:", "extension:"].includes(root.protocol) || !/^[A-Za-z0-9-]{1,128}$/.test(root.hostname)) return false;
    extensionOrigin = `${root.protocol}//${root.hostname}`;
  } catch { return false; }
  const identity = `${opts.port}|${opts.enabled !== false}|${version}|${extensionOrigin}`;
  if (!force && identity === readinessIdentity && Date.now() - readinessAt < 15000) return readinessSucceeded;
  if (readinessPending) return readinessPending;
  readinessAt = Date.now();
  readinessIdentity = identity;
  readinessPending = (async () => {
    try {
      const r = await fetchWithTimeout(apiUrl(opts.port, "/extension/ready"), {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-SwiftGet": "1" },
        body: JSON.stringify({ browser: await browserFamily(), version, extensionOrigin, enabled: opts.enabled !== false }),
      }, 800);
      readinessSucceeded = r.ok;
      return readinessSucceeded;
    } catch {
      readinessSucceeded = false;
      return false; // the app may not be running yet
    } finally {
      readinessPending = null;
    }
  })();
  return readinessPending;
}

// ---------------------------------------------------------------- self update
// The add-in is loaded from the program's own folder. When the program
// updates itself it brings newer add-in files along; the browser only reads
// them after a reload, so the add-in reloads itself once per new version.
async function followAppVersion() {
  const last = (await chrome.storage.session.get("versionCheckAt")).versionCheckAt || 0;
  if (Date.now() - last < 60000) return;
  await chrome.storage.session.set({ versionCheckAt: Date.now() });
  const { port } = await getOpts();
  try {
    const r = await fetchWithTimeout(apiUrl(port, "/ping"), { headers: { "X-SwiftGet": "1" } }, 800);
    if (!r.ok || typeof r.json !== "function") return;
    announceExtensionReady();
    const want = (await r.json()).ext;
    const have = chrome.runtime.getManifest().version;
    if (!want || want === have) return;
    // only once per version: if the files on disk did not change (the add-in
    // was loaded from somewhere else) it must not keep reloading
    const done = (await chrome.storage.local.get("reloadedFor")).reloadedFor;
    if (done === want) return;
    await chrome.storage.local.set({ reloadedFor: want });
    chrome.runtime.reload();
  } catch {
    /* the program is not running */
  }
}
followAppVersion();
announceExtensionReady();

async function appAlive(forceReady = false) {
  // Opening the popup also picks up a newly prepared port after an app
  // restart, without requiring the browser to restart its existing worker.
  if (forceReady) preparedPortPromise = null;
  const { port } = await getOpts();
  try {
    const r = await fetchWithTimeout(apiUrl(port, "/ping"), { headers: { "X-SwiftGet": "1" } }, 800);
    if (r.ok) {
      // The popup's explicit status check must announce even when the worker's
      // cached version check would otherwise skip its startup request.
      await announceExtensionReady(forceReady);
      followAppVersion();
    }
    return r.ok;
  } catch {
    return false;
  }
}

async function cookieHeader(url) {
  assertSupportedPlayback(url);
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

/** The site's cookies for the app, only used if the site asks for a login. */
async function cookieList(url) {
  assertSupportedPlayback(url);
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => ({
      domain: c.domain,
      name: c.name,
      value: c.value,
      path: c.path || "/",
      secure: !!c.secure,
      expirationDate: c.expirationDate || null,
    }));
  } catch {
    return [];
  }
}

function isYoutube(url) {
  try {
    return /(^|\.)youtube\.com$|^youtu\.be$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Netflix's encrypted playback fragments are not standalone video files.
// Recognize real host boundaries so unrelated/public pages remain supported.
const PROTECTED_VIDEO_MESSAGE = "Netflix playback is not supported by this downloader. Use Netflix’s official app on a supported device for offline viewing.";

function protectedHost(url, domain) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    return host === domain || host.endsWith(`.${domain}`) ? parsed : null;
  } catch { return null; }
}

function isNetflixWatch(url) {
  const parsed = protectedHost(url, "netflix.com");
  return !!parsed && /^\/watch(?:\/|$)/i.test(parsed.pathname);
}

function isProtectedPlayback(...urls) {
  return urls.some((url) => isNetflixWatch(url) || !!protectedHost(url, "nflxvideo.net"));
}

function protectedVideoItem() {
  return { disabled: true, protected: true, label: "Protected video", sub: PROTECTED_VIDEO_MESSAGE, type: "protected", url: null };
}

function assertSupportedPlayback(...urls) {
  if (isProtectedPlayback(...urls)) throw new Error(PROTECTED_VIDEO_MESSAGE);
}

function suppliedReferrers(headers) {
  return (headers || []).filter((header) => Array.isArray(header) && /^(referer|referrer)$/i.test(header[0])).map((header) => header[1]);
}

async function sendToApp({ url, audioUrl, referrer, fileName, headers, sourcePage, sourceKey }) {
  assertSupportedPlayback(url, audioUrl, referrer, sourcePage, ...suppliedReferrers(headers));
  const { port } = await getOpts();
  const body = {
    url,
    audioUrl: audioUrl || null,
    headers: headers || null,
    sourcePage: sourcePage || null,
    sourceKey: sourceKey || null,
    referrer: referrer || null,
    cookies: await cookieHeader(url),
    userAgent: navigator.userAgent,
    fileName: fileName || null,
  };
  const r = await fetchWithTimeout(
    apiUrl(port, "/add"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SwiftGet": "1" },
      body: JSON.stringify(body),
    },
    3000
  );
  if (!r.ok) throw new Error(`Mac Downloader answered HTTP ${r.status}`);
}

// ---------------------------------------------------------------- app options

let appConfig = null;
let configAt = 0;

/** Options > File Types / General of the app (cached for a minute). */
async function getConfig() {
  if (appConfig && Date.now() - configAt < 60000) return appConfig;
  const { port } = await getOpts();
  try {
    const r = await fetchWithTimeout(apiUrl(port, "/config"), { headers: { "X-SwiftGet": "1" } }, 1000);
    if (r.ok) {
      appConfig = await r.json();
      configAt = Date.now();
    }
  } catch {
    /* app not running or older version: keep the last one */
  }
  return appConfig;
}

/** "*" matches anything, "?" one character (case-insensitive). */
function wildcard(pattern, text) {
  const re = new RegExp(
    "^" + pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return re.test(text.toLowerCase());
}

function hostMatches(host, pattern) {
  const p = pattern.replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  if (!p) return false;
  if (p.includes("*")) return wildcard(p, host);
  return host === p || host.endsWith("." + p);
}

function extensionOf(name) {
  const clean = (name || "").split(/[?#]/)[0];
  const last = clean.split(/[\\/]/).pop() || "";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : "";
}

/** Should Mac Downloader take this browser download? (Options > File Types rules) */
function wanted(cfg, url, fileName, mime, keys) {
  if (!cfg) return true; // old app: take everything like before
  if (cfg.skipKey && cfg.skipKey !== "none" && keys[cfg.skipKey]) return false;
  if (cfg.forceKey && cfg.forceKey !== "none" && keys[cfg.forceKey]) return true;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if ((cfg.skipSites || []).some((s) => hostMatches(host, s))) return false;
  if ((cfg.skipAddresses || []).some((a) => wildcard(a, url))) return false;
  const exts = cfg.captureExts || [];
  if (!exts.length) return true;
  let ext = extensionOf(fileName) || extensionOf(new URL(url).pathname);
  // script addresses (download.php?id=…) say nothing about the file
  if (/^(php\d?|aspx?|jsp|cgi|pl|cfm|do|action|html?)$/.test(ext) && !extensionOf(fileName)) ext = "";
  if (!ext) {
    // no extension (download.php?id=…): go by the type the server sends
    return !!mime && !/^(text\/html|image\/|text\/plain)/i.test(mime);
  }
  return exts.some((e) => wildcard(e, ext));
}

// keys held when the user clicked the link (sent by the page)
let lastKeys = { alt: false, ctrl: false, shift: false, at: 0 };
function currentKeys() {
  return Date.now() - lastKeys.at < 4000 ? lastKeys : { alt: false, ctrl: false, shift: false };
}

function baseName(path) {
  if (!path) return null;
  const name = path.split(/[\\/]/).pop();
  return name || null;
}

// ---------------------------------------------------------------- 1. downloads

// Remembered in session storage, not in memory: the browser stops this
// service worker whenever it likes, and a lost "let the browser keep it"
// mark made the same file come back over and over.
const BYPASS_KEY = "bypassUrls";
const RECENT_KEY = "recentSends";

async function takeBypass(url) {
  const list = (await chrome.storage.session.get(BYPASS_KEY))[BYPASS_KEY] || [];
  const now = Date.now();
  const fresh = list.filter((b) => now - b.at < 120000);
  const hit = fresh.some((b) => b.url === url);
  await chrome.storage.session.set({ [BYPASS_KEY]: fresh.filter((b) => b.url !== url) });
  return hit;
}

async function addBypass(url) {
  const list = (await chrome.storage.session.get(BYPASS_KEY))[BYPASS_KEY] || [];
  list.push({ url, at: Date.now() });
  await chrome.storage.session.set({ [BYPASS_KEY]: list.slice(-50) });
}

/** The same address handed to the app a moment ago (pages and the browser can fire twice). */
async function sentRecently(url) {
  const list = (await chrome.storage.session.get(RECENT_KEY))[RECENT_KEY] || [];
  const now = Date.now();
  const fresh = list.filter((r) => now - r.at < 15000);
  const hit = fresh.some((r) => r.url === url);
  if (!hit) fresh.push({ url, at: now });
  await chrome.storage.session.set({ [RECENT_KEY]: fresh.slice(-50) });
  return hit;
}

/** The app's "Download with the browser" button: leave this one to the browser. */
async function appSaysBrowser(urls) {
  const { port } = await getOpts();
  try {
    const r = await fetchWithTimeout(
      apiUrl(port, "/browser"),
      { method: "POST", headers: { "Content-Type": "application/json", "X-SwiftGet": "1" }, body: JSON.stringify({ urls }) },
      800
    );
    if (!r.ok || typeof r.json !== "function") return false;
    return !!(await r.json()).browser;
  } catch {
    return false;
  }
}

/** Only downloads the user starts now: not ones the browser restores or resumes at start-up. */
function isNewDownload(item) {
  if (item.state && item.state !== "in_progress") return false;
  // ours (given back to the browser) and other extensions' downloads stay in the browser
  if (item.byExtensionId) return false;
  const started = Date.parse(item.startTime || "");
  if (!Number.isNaN(started) && Date.now() - started > 30000) return false;
  return true;
}

chrome.downloads.onCreated.addListener(async (item) => {
  const opts = await getOpts();
  if (!opts.enabled || !opts.intercept) return;
  const url = item.finalUrl || item.url;
  if (!url || !/^https?:/i.test(url)) return; // blob:, data:, file: stay in the browser
  if (isProtectedPlayback(url, item.url, item.referrer)) return;
  if (!isNewDownload(item)) return;
  if (await takeBypass(url)) return;
  if (opts.minSizeKB > 0 && item.totalBytes > 0 && item.totalBytes < opts.minSizeKB * 1024) return;
  if (!(await appAlive())) return; // app not running: let the browser handle it
  const cfg = await getConfig();
  if (!wanted(cfg, url, baseName(item.filename), item.mime, currentKeys())) return;
  if (await appSaysBrowser([item.url, url])) return; // the user chose the browser for it

  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch (_) {
    /* already finished or gone */
  }
  if (await sentRecently(url)) return;
  try {
    await sendToApp({ url, referrer: item.referrer, fileName: baseName(item.filename) });
  } catch (e) {
    // the app may have got it anyway (it was only slow to answer): never
    // hand it to the browser as well, that showed the file twice
    if (e && e.name === "AbortError") return;
    // the app could not be reached: give the download back to the browser, once
    await addBypass(url);
    chrome.downloads.download({ url });
  }
});

// ---------------------------------------------------------------- per-tab state
// media_<tab>: generic files found on the page
// yt_<tab>:    { videoId, sabr, streams: { "<itag>_<dur>": stream }, resolved... }
// res_<tab>:   any other site: { page, resolving, resolved, resolveError }

// Serialize writes per tab: an old request may already be inside storage.set
// when navigation arrives. A queued clear must run after that write and before
// any state for the new page, even if storage operations resolve out of order.
const tabWrites = new Map();
const tabEpochs = new Map();
const tabPages = new Map();
const tabClientTokens = new Map();
const tabHandshakes = new Map();
const freshMedia = new Map();
const tabSelections = new Map();
const selectionVersions = new Map();
const topSelections = new Set();
const selectionTimes = new Map();
function selectionVersionOf(tabId) { return selectionVersions.get(tabId) || 0; }
function clearSelection(tabId) {
  tabSelections.delete(tabId);
  topSelections.delete(tabId);
  selectionTimes.delete(tabId);
  selectionVersions.set(tabId, selectionVersionOf(tabId) + 1);
}
function selectFrame(tabId, frameId, frameToken, page, selectedAt, activeSelection, observedPlaying) {
  const previous = tabSelections.get(tabId);
  const identity = pageIdentity(page);
  const latest = selectionTimes.get(tabId) || 0;
  if (activeSelection && selectedAt && selectedAt < latest) return null;
  if (previous && previous.frameId === frameId && previous.frameToken === frameToken && previous.page === identity) {
    if (activeSelection && selectedAt) { selectionTimes.set(tabId, selectedAt); previous.selectedAt = selectedAt; }
    if (activeSelection) previous.explicit = true;
    return previous;
  }
  // A preloaded, paused frame must not displace a different actively chosen
  // player. A real play event can select it; stale older play events cannot.
  if (topSelections.has(tabId) && !activeSelection) return null;
  if (previous && previous.frameId !== frameId && !activeSelection && !(observedPlaying && !previous.explicit && !previous.observedPlaying)) return null;
  if (activeSelection) { topSelections.delete(tabId); if (selectedAt) selectionTimes.set(tabId, selectedAt); }
  const selection = { frameId, frameToken, page: identity, selectedAt: selectedAt || previous?.selectedAt || 0, explicit: !!activeSelection, observedPlaying: !!observedPlaying, version: selectionVersionOf(tabId) + 1 };
  selectionVersions.set(tabId, selection.version);
  tabSelections.set(tabId, selection);
  notifyPopup(tabId);
  return selection;
}
function selectedFrameIsCurrent(tabId, frame) {
  const selected = tabSelections.get(tabId);
  return !!selected && selected.version === frame.selectionVersion && selected.frameId === frame.frameId && selected.frameToken === frame.frameToken;
}
function epochOf(tabId) { return tabEpochs.get(tabId) || 0; }
function advanceTab(tabId) { const next = epochOf(tabId) + 1; tabEpochs.set(tabId, next); return next; }
function writeTab(tabId, operation) {
  const previous = tabWrites.get(tabId) || Promise.resolve();
  const task = previous.catch(() => {}).then(operation);
  tabWrites.set(tabId, task);
  task.finally(() => { if (tabWrites.get(tabId) === task) tabWrites.delete(tabId); }).catch(() => {});
  return task;
}
function pageIdentity(url) {
  const id = isYoutube(url) ? videoIdOf(url) : null;
  if (id) return `youtube:${id}`;
  // Generic SPAs often use hash routes to identify different videos.
  try { return new URL(url).href; } catch (_) { return ""; }
}
function currentWork(tabId, epoch, token) {
  return epochOf(tabId) === epoch && tabClientTokens.get(tabId) === token;
}
function validClientToken(value) { return typeof value === "string" && value.length > 0 && value.length <= 128; }
async function currentFrame(tabId, frameId, token) {
  if (!Number.isInteger(tabId) || !Number.isInteger(frameId) || frameId <= 0 || !validClientToken(token)) return false;
  try {
    const current = await chrome.tabs.sendMessage(tabId, { type: "swiftget-request-frame-generation" }, { frameId });
    return current?.frameToken === token;
  } catch (_) { return false; }
}
function notifyPopup(tabId) {
  try { chrome.runtime.sendMessage?.({ type: "swiftget-popup-media-changed", tabId, clientToken: tabClientTokens.get(tabId) || null, selectionVersion: selectionVersionOf(tabId) })?.catch?.(() => {}); } catch (_) {}
}
async function waitTabWrites(tabId) {
  // A newer clear may have been queued while an earlier write was pending.
  for (;;) {
    const pending = tabWrites.get(tabId);
    if (!pending) return;
    await pending.catch(() => {});
    if (!tabWrites.has(tabId) || tabWrites.get(tabId) === pending) return;
  }
}

async function readTab(tabId) {
  const keys = [`media_${tabId}`, `yt_${tabId}`, `res_${tabId}`, `mediaOwner_${tabId}`];
  const r = await chrome.storage.session.get(keys);
  return { media: r[keys[0]] || [], yt: r[keys[1]] || null, res: r[keys[2]] || null, mediaOwner: r[keys[3]] || "" };
}

function optionItems(resolved, source) {
  return resolved.options.filter((o) => !isProtectedPlayback(source, o.source, o.videoUrl, o.audioUrl)).map((o) => ({
    label: o.label,
    sub: o.sub,
    yt: { ...o, title: resolved.title, source },
  }));
}

/** Everything the page button and the popup show, in one list. */
async function itemsForTab(tabId) {
  const epoch = epochOf(tabId), token = tabClientTokens.get(tabId);
  const selectionVersion = selectionVersionOf(tabId), selection = tabSelections.get(tabId);
  await waitTabWrites(tabId);
  if (!currentWork(tabId, epoch, token) || selectionVersionOf(tabId) !== selectionVersion) return [];
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !currentWork(tabId, epoch, token) || selectionVersionOf(tabId) !== selectionVersion) return [];
  if (isNetflixWatch(tab && tab.url)) return [protectedVideoItem()];
  const { media: storedMedia, mediaOwner, yt: storedYt, res: storedRes } = await readTab(tabId);
  if (!currentWork(tabId, epoch, token) || selectionVersionOf(tabId) !== selectionVersion) return [];
  // Never present resolved formats for an earlier YouTube video, even while
  // navigation cleanup is still in flight.
  const id = tab && isYoutube(tab.url) ? videoIdOf(tab.url) : null;
  const yt = !selection && storedYt && (!tab?.url || (id && storedYt.videoId === id)) ? storedYt : null;
  let res = storedRes && (!tab?.url || pageIdentity(storedRes.ownerPage || storedRes.page) === pageIdentity(tab.url)) ? storedRes : null;
  if (selection && (!res || res.frameId !== selection.frameId || res.frameToken !== selection.frameToken || res.selectionVersion !== selection.version)) res = null;
  // A cached embed is usable only while the same frame generation remains.
  if (res?.frameToken && !await currentFrame(tabId, res.frameId, res.frameToken)) res = null;
  if (!currentWork(tabId, epoch, token) || selectionVersionOf(tabId) !== selectionVersion) return [];
  const ownedMedia = !tab?.url || mediaOwner === pageIdentity(tab.url) ? storedMedia : [];
  const media = selection ? ownedMedia.filter((item) => item.sourceFrameId === selection.frameId) : ownedMedia;
  const items = [];
  if (selection && !res) items.push({ label: "Getting video qualities…", sub: "This takes a few seconds", disabled: true });
  if (res && !yt) {
    if (res.resolved && res.resolved.options.length) {
      const options = optionItems(res.resolved, res.page);
      items.push(...(res.frameToken ? options.map((item) => ({ ...item, frameId: res.frameId, frameToken: res.frameToken })) : options));
    } else if (res.resolving) {
      items.push({ label: "Getting video qualities…", sub: "This takes a few seconds", disabled: true });
    } else if (res.resolveError && !media.length) {
      items.push({ label: "Can't get this video", sub: res.resolveError, disabled: true });
    }
  }
  if (yt) {
    if (yt.resolved && yt.resolved.options.length) {
      // qualities found by the app (yt-dlp): works with every stream format
      items.push(...optionItems(yt.resolved, `https://www.youtube.com/watch?v=${yt.videoId}`));
    } else {
      // fallback: streams captured from the player itself
      for (const o of buildOptions(yt.streams)) items.push({ label: o.label, sub: o.sub, yt: o });
      if (!items.length) {
        if (yt.resolving) {
          items.push({ label: "Getting video qualities…", sub: "This takes a few seconds", disabled: true });
        } else if (yt.resolveError) {
          items.push({ label: "Can't get this video", sub: yt.resolveError, disabled: true });
        } else if (yt.sabr) {
          items.push({
            label: "This video needs Mac Downloader",
            sub: "Open Mac Downloader with yt-dlp installed and reload the page",
            disabled: true,
          });
        }
      }
    }
  }
  const resolvedFound = items.some((i) => i.yt);
  for (const m of media) {
    if (isProtectedPlayback(m.url)) continue;
    // when the app already found the real qualities, raw streams are noise
    if (resolvedFound && /HLS|video/i.test(m.type)) continue;
    items.push({
      label: `${m.type}${m.size ? " · " + fmtSize(m.size) : ""}`,
      sub: m.url,
      url: m.url,
      ext: m.ext,
      ...(selection ? { frameId: selection.frameId, frameToken: selection.frameToken } : {}),
    });
  }
  return items;
}

async function pushToTab(tabId) {
  const epoch = epochOf(tabId), token = tabClientTokens.get(tabId);
  const selectionVersion = selectionVersionOf(tabId);
  const { enabled } = await getOpts();
  if (!currentWork(tabId, epoch, token) || selectionVersionOf(tabId) !== selectionVersion) return;
  if (!enabled) {
    // switched off: no buttons on the page, "off" on the add-in's icon
    chrome.action.setBadgeBackgroundColor({ color: "#8a94a3" });
    chrome.action.setBadgeText({ tabId, text: "off" }).catch(() => {});
    chrome.tabs.sendMessage(tabId, { type: "swiftget-media", items: [], clientToken: token }).catch(() => {});
    notifyPopup(tabId);
    return;
  }
  const items = await itemsForTab(tabId);
  if (!currentWork(tabId, epoch, token) || selectionVersionOf(tabId) !== selectionVersion) return;
  const count = items.filter((i) => !i.disabled).length;
  chrome.action.setBadgeBackgroundColor({ color: "#1f6feb" });
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" }).catch(() => {});
  chrome.tabs.sendMessage(tabId, { type: "swiftget-media", items, clientToken: token }).catch(() => {});
  notifyPopup(tabId);
}

async function clearTab(tabId, epoch = epochOf(tabId), preserveMedia = null) {
  const token = tabClientTokens.get(tabId);
  await writeTab(tabId, async () => {
    if (!currentWork(tabId, epoch, token)) return;
    let kept = [];
    if (preserveMedia) {
      const saved = await chrome.storage.session.get([`media_${tabId}`, `mediaOwner_${tabId}`]);
      if (saved[`mediaOwner_${tabId}`] === preserveMedia.owner) {
        kept = (saved[`media_${tabId}`] || []).filter((item) => preserveMedia.urls.has(item.url));
      }
    }
    if (!currentWork(tabId, epoch, token)) return;
    await chrome.storage.session.remove([`media_${tabId}`, `yt_${tabId}`, `res_${tabId}`, `mediaOwner_${tabId}`]);
    if (kept.length && currentWork(tabId, epoch, token)) {
      await chrome.storage.session.set({ [`media_${tabId}`]: kept, [`mediaOwner_${tabId}`]: preserveMedia.owner });
    }
  });
  if (!currentWork(tabId, epoch, token)) return;
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  chrome.tabs.sendMessage(tabId, { type: "swiftget-media", items: [], clientToken: token }).catch(() => {});
  notifyPopup(tabId);
}

// ---------------------------------------------------------------- 2. media sniffer

const MEDIA_TYPE = /^(video|audio)\//i;
const HLS_TYPE = /mpegurl/i;

function headerMap(list) {
  const out = {};
  for (const h of list || []) out[h.name.toLowerCase()] = h.value || "";
  return out;
}

async function addMedia(tabId, item, documentUrl = "", frameId = 0) {
  const epoch = epochOf(tabId), token = tabClientTokens.get(tabId);
  if (isProtectedPlayback(item.url)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!currentWork(tabId, epoch, token) || isNetflixWatch(tab && tab.url)) return;
  if (tab && frameId === 0 && documentUrl && pageIdentity(documentUrl) !== pageIdentity(tab.url)) return;
  const key = `media_${tabId}`;
  const ownerKey = `mediaOwner_${tabId}`;
  const owner = pageIdentity(tab?.url || "");
  if (owner && !tabPages.has(tabId)) tabPages.set(tabId, owner);
  if (!token && owner) {
    let fresh = freshMedia.get(tabId);
    if (!fresh || fresh.epoch !== epoch || fresh.owner !== owner) {
      fresh = { epoch, owner, urls: new Set() };
      freshMedia.set(tabId, fresh);
    }
    fresh.urls.add(item.url);
    while (fresh.urls.size > 15) fresh.urls.delete(fresh.urls.values().next().value);
  }
  const changed = await writeTab(tabId, async () => {
    if (!currentWork(tabId, epoch, token)) return false;
    const saved = await chrome.storage.session.get([key, ownerKey]);
    const current = saved[ownerKey] === owner ? saved[key] || [] : [];
    if (!currentWork(tabId, epoch, token) || current.some((m) => m.url === item.url)) return false;
    current.push({ ...item, sourceFrameId: frameId });
    while (current.length > 15) current.shift();
    await chrome.storage.session.set({ [key]: current, [ownerKey]: owner });
    return currentWork(tabId, epoch, token);
  });
  if (changed) pushToTab(tabId);
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode < 200 || d.statusCode >= 300) return;
    const url = d.url;
    if (!/^https?:/i.test(url)) return;
    if (isProtectedPlayback(url, d.documentUrl, d.initiator, d.originUrl)) return;
    if (/googlevideo\.com/i.test(url)) return; // YouTube has its own handler below
    const h = headerMap(d.responseHeaders);
    const type = (h["content-type"] || "").toLowerCase();
    const isHls = HLS_TYPE.test(type) || /\.m3u8(\?|$)/i.test(url);
    const isMedia = MEDIA_TYPE.test(type) && !type.includes("mp2t"); // skip HLS chunks
    if (!isHls && !isMedia) return;
    // byte-range pieces of a bigger stream can't be saved as a file
    if (/[?&](range|bytestart)=/i.test(url)) return;

    let size = 0;
    const cr = /\/(\d+)\s*$/.exec(h["content-range"] || "");
    if (cr) size = Number(cr[1]);
    else if (h["content-length"]) size = Number(h["content-length"]);
    if (isMedia && size > 0 && size < 300 * 1024) return; // tiny clips, ads, sounds

    addMedia(d.tabId, {
      url,
      type: isHls ? "HLS stream" : type.split(";")[0],
      size,
      ext: isHls ? "ts" : (type.split("/")[1] || "mp4").split(";")[0].replace("x-matroska", "mkv").replace("mpeg", "mp3"),
    }, d.documentUrl || "", d.frameId || 0);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ---------------------------------------------------------------- 3. YouTube

// The player asks for many small pieces of the same stream; we only need to
// store each stream once per tab.
const seenStreams = new Map(); // tabId -> Set("<itag>_<dur>")

async function addYoutubeStream(tabId, stream, documentUrl = "") {
  const epoch = epochOf(tabId), token = tabClientTokens.get(tabId);
  const key = `yt_${tabId}`;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!currentWork(tabId, epoch, token)) return;
  const videoId = tab ? videoIdOf(tab.url) : null;
  if (!videoId) return;
  const requestVideoId = documentUrl && isYoutube(documentUrl) && videoIdOf(documentUrl);
  if (requestVideoId && requestVideoId !== videoId) return;
  const sk = stream.sabr ? "sabr" : `${stream.itag}_${stream.dur}${stream.lang ? "_" + stream.lang : ""}`;
  let seen = seenStreams.get(tabId);
  if (!seen) seenStreams.set(tabId, (seen = new Set()));
  if (seen.has(sk)) return;
  seen.add(sk);
  if (!tabPages.has(tabId)) tabPages.set(tabId, pageIdentity(tab.url));
  const changed = await writeTab(tabId, async () => {
    if (!currentWork(tabId, epoch, token)) return false;
    let state = (await chrome.storage.session.get(key))[key];
    if (!currentWork(tabId, epoch, token)) return false;
    // A different video gets a fresh state including resolved/error fields.
    if (!state || state.videoId !== videoId) state = { videoId, sabr: false, streams: {} };
    if (stream.sabr) {
      if (state.sabr) return false;
      state.sabr = true;
    } else {
      const sk = `${stream.itag}_${stream.dur}${stream.lang ? "_" + stream.lang : ""}`;
      state.streams[sk] = stream;
      const ids = Object.keys(state.streams);
      if (ids.length > 60) delete state.streams[ids[0]];
    }
    await chrome.storage.session.set({ [key]: state });
    return currentWork(tabId, epoch, token);
  });
  if (changed) pushToTab(tabId);
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const stream = parseStream(d.url);
    if (!stream) return;
    addYoutubeStream(d.tabId, stream, d.documentUrl || "");
  },
  { urls: ["*://*.googlevideo.com/videoplayback*"] }
);

async function downloadVideo(option, pageTitle, pageUrl) {
  assertSupportedPlayback(option.videoUrl, option.audioUrl, option.source, pageUrl);
  const title = cleanYoutubeTitle(option.title || pageTitle);
  const name = option.quality === "mp3" ? `${title}.mp3` : `${title} [${option.quality}].${option.ext}`;
  await sendToApp({
    url: option.videoUrl,
    audioUrl: option.audioUrl,
    referrer: option.source && !isYoutube(option.source) ? option.source : pageUrl || "https://www.youtube.com/",
    fileName: name,
    headers: option.headers,
    sourcePage: option.source,
    sourceKey: option.key,
  });
}

async function sendPlaylist(url) {
  assertSupportedPlayback(url);
  if (!/^https?:/i.test(url || "")) throw new Error("bad address");
  const { port } = await getOpts();
  const r = await fetchWithTimeout(
    apiUrl(port, "/playlist"),
    { method: "POST", headers: { "Content-Type": "application/json", "X-SwiftGet": "1" }, body: JSON.stringify({ url }) },
    5000
  );
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

// The on / off switch: every tab shows it at once.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && (ch.enabled || ch.port)) announceExtensionReady(true);
  if (area !== "local" || !ch.enabled) return;
  chrome.action.setBadgeText({ text: ch.enabled.newValue === false ? "off" : "" }).catch(() => {});
  chrome.tabs.query({}).then((tabs) => tabs.forEach((t) => t.id != null && pushToTab(t.id))).catch(() => {});
});

// Ask the app (yt-dlp) for the qualities of a video page.
const resolving = new Map(); // tabId -> page being resolved

async function askApp(page) {
  assertSupportedPlayback(page);
  const { port } = await getOpts();
  const r = await fetchWithTimeout(
    apiUrl(port, "/resolve"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SwiftGet": "1" },
      body: JSON.stringify({ url: page, cookieList: await cookieList(page) }),
    },
    90000
  );
  const data = await r.json();
  return data.ok
    ? { resolved: { title: data.title, site: data.site, options: data.options } }
    : { resolveError: data.error || "unknown error" };
}

async function patchYt(tabId, videoId, change, epoch = epochOf(tabId), token = tabClientTokens.get(tabId)) {
  const key = `yt_${tabId}`;
  const changed = await writeTab(tabId, async () => {
    if (!currentWork(tabId, epoch, token)) return false;
    let state = (await chrome.storage.session.get(key))[key];
    if (!currentWork(tabId, epoch, token)) return false;
    if (!state || state.videoId !== videoId) state = { videoId, sabr: false, streams: {} };
    Object.assign(state, change);
    await chrome.storage.session.set({ [key]: state });
    return currentWork(tabId, epoch, token);
  });
  if (changed) pushToTab(tabId);
  return changed;
}

async function resolveYoutube(tabId, pageUrl) {
  const epoch = epochOf(tabId), token = tabClientTokens.get(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!currentWork(tabId, epoch, token)) return;
  if (isProtectedPlayback(pageUrl, tab && tab.url)) return;
  const videoId = videoIdOf(pageUrl);
  if (!videoId || !tab || videoIdOf(tab.url) !== videoId || !/(^|\.)youtube\.com$/i.test(new URL(pageUrl).hostname)) return;
  if (!tabPages.has(tabId)) tabPages.set(tabId, pageIdentity(tab.url));
  const key = `yt_${tabId}`;
  const state = (await chrome.storage.session.get(key))[key];
  if (!currentWork(tabId, epoch, token)) return;
  if (state && state.videoId === videoId && (state.resolved || state.resolveError)) return;
  const resolution = `${epoch}:${videoId}`;
  if (resolving.get(tabId) === resolution) return;
  resolving.set(tabId, resolution);
  if (!await patchYt(tabId, videoId, { resolving: true, resolveError: null }, epoch, token)) {
    if (resolving.get(tabId) === resolution) resolving.delete(tabId);
    return;
  }
  let change;
  try {
    change = await askApp(`https://www.youtube.com/watch?v=${videoId}`);
  } catch (e) {
    change = { resolveError: (await appAlive()) ? String((e && e.message) || e) : "Mac Downloader is not running" };
  } finally {
    if (resolving.get(tabId) === resolution) resolving.delete(tabId);
  }
  // the user may have moved on to another video meanwhile
  const now = await chrome.tabs.get(tabId).catch(() => null);
  if (currentWork(tabId, epoch, token) && now && videoIdOf(now.url) === videoId) await patchYt(tabId, videoId, { resolving: false, ...change }, epoch, token);
}

/**
 * Any other site: the page (or the post / reel / video link next to the
 * video the user is watching) is handed to yt-dlp, which knows Facebook,
 * Instagram, TikTok, X, Vimeo, Dailymotion and ~1800 more sites.
 */
async function resolvePage(tabId, page, embedded = false, frame = null) {
  const epoch = epochOf(tabId), token = tabClientTokens.get(tabId);
  const active = () => currentWork(tabId, epoch, token) && (!frame || selectedFrameIsCurrent(tabId, frame));
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!active() || !tab) return;
  if (frame && !await currentFrame(tabId, frame.frameId, frame.frameToken)) return;
  if (!active()) return;
  if (isProtectedPlayback(page, tab && tab.url)) {
    pushToTab(tabId);
    return;
  }
  // YouTube's own pages have their own way (resolveYoutube); a YouTube
  // player embedded in another site goes this way
  if (!page || !/^https?:/i.test(page) || (isYoutube(page) && !embedded)) return;
  if (!tabPages.has(tabId)) tabPages.set(tabId, pageIdentity(tab.url));
  const key = `res_${tabId}`;
  const resolution = `${epoch}:${page}:${frame?.frameId || 0}:${frame?.frameToken || ""}:${frame?.selectionVersion || 0}`;
  if (resolving.get(tabId) === resolution) return;
  const started = await writeTab(tabId, async () => {
    if (!active()) return false;
    const state = (await chrome.storage.session.get(key))[key];
    if (!active()) return false;
    if (state && state.page === page && pageIdentity(state.ownerPage || state.page) === pageIdentity(tab.url) && (!frame || (state.frameId === frame.frameId && state.frameToken === frame.frameToken && state.selectionVersion === frame.selectionVersion)) && (state.resolved || state.resolving || state.resolveError)) return false;
    await chrome.storage.session.set({ [key]: { page, ownerPage: tab.url, ...(frame || {}), resolving: true } });
    return active();
  });
  if (!started) return;
  resolving.set(tabId, resolution);
  pushToTab(tabId);
  let change;
  try {
    change = await askApp(page);
  } catch (e) {
    change = { resolveError: (await appAlive()) ? String((e && e.message) || e) : "Mac Downloader is not running" };
  } finally {
    if (resolving.get(tabId) === resolution) resolving.delete(tabId);
  }
  if (frame && !await currentFrame(tabId, frame.frameId, frame.frameToken)) return;
  const changed = await writeTab(tabId, async () => {
    if (!active()) return false;
    const now = (await chrome.storage.session.get(key))[key];
    if (!active() || !now || now.page !== page || pageIdentity(now.ownerPage || now.page) !== pageIdentity(tab.url) || (frame && (now.frameId !== frame.frameId || now.frameToken !== frame.frameToken || now.selectionVersion !== frame.selectionVersion))) return false;
    await chrome.storage.session.set({ [key]: { page, ownerPage: tab.url, ...(frame || {}), resolving: false, ...change } });
    return active();
  });
  if (changed) pushToTab(tabId);
}

/** The bubble of a video that is not the page's main one was clicked. */
async function resolveOneVideo(msg, tab) {
  if (isProtectedPlayback(msg.src, msg.page, tab && tab.url)) return { items: [protectedVideoItem()] };
  // a player in a frame (Dailymotion, news sites...): what was found for the
  // whole page (its qualities, its streams) is what this player plays
  if (msg.frame && tab) {
    if (!msg.page && !isYoutube(tab.url)) {
      await resolvePage(tab.id, tab.url).catch(() => {});
      // it may have been started already (the player was seen): wait for it
      for (let i = 0; i < 180; i++) {
        const { res } = await readTab(tab.id);
        if (!res || !res.resolving) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const state = await readTab(tab.id);
    const samePage = !msg.page || pageIdentity(msg.page) === pageIdentity(tab.url);
    const sameResolvedFrame = msg.page && !state.yt && state.res && pageIdentity(state.res.page) === pageIdentity(msg.page);
    if (samePage || sameResolvedFrame) {
      const found = (await itemsForTab(tab.id)).filter((i) => !i.disabled);
      if (found.length) return { items: found };
    }
  }
  const items = [];
  if (msg.src && /^https?:/i.test(msg.src)) {
    items.push({ label: "Video file", sub: msg.src, url: msg.src, ext: (/\.(\w{2,4})(\?|$)/.exec(msg.src) || [])[1] || "mp4" });
  }
  const page = msg.page || (msg.src && !msg.frame ? "" : tab && tab.url);
  if (page && /^https?:/i.test(page)) {
    try {
      const r = await askApp(page);
      if (r.resolved && r.resolved.options.length) items.unshift(...optionItems(r.resolved, page));
      else if (!items.length) return { error: r.resolveError || "Can't get this video" };
    } catch (e) {
      if (!items.length) return { error: (await appAlive()) ? String((e && e.message) || e) : "Mac Downloader is not running" };
    }
  }
  return items.length ? { items } : { error: "Can't get this video" };
}

// ---------------------------------------------------------------- tab lifecycle

function resetForClient(tabId, token) {
  const previous = tabHandshakes.get(tabId) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => resetForClientSerial(tabId, token));
  tabHandshakes.set(tabId, task);
  task.finally(() => { if (tabHandshakes.get(tabId) === task) tabHandshakes.delete(tabId); }).catch(() => {});
  return task;
}

async function resetForClientSerial(tabId, token) {
  if (!validClientToken(token) || tabClientTokens.get(tabId) === token) return;
  const priorToken = tabClientTokens.get(tabId);
  // Every generation is challenged against the live top frame. This also
  // rejects late same-nonce messages from a document that has been replaced.
  let current;
  try { current = await chrome.tabs.sendMessage(tabId, { type: "swiftget-request-client-token" }, { frameId: 0 }); } catch (_) {}
  if (current?.clientToken !== token || tabClientTokens.get(tabId) !== priorToken) return;
  const tabBefore = await chrome.tabs.get(tabId).catch(() => null);
  if (!tabBefore?.url || tabClientTokens.get(tabId) !== priorToken) return;
  const fresh = !priorToken && freshMedia.get(tabId);
  const preserve = fresh && fresh.epoch === epochOf(tabId) && fresh.owner === pageIdentity(tabBefore.url) ? fresh : null;
  tabClientTokens.set(tabId, token);
  const epoch = advanceTab(tabId);
  clearSelection(tabId);
  seenStreams.delete(tabId);
  resolving.delete(tabId);
  await clearTab(tabId, epoch, preserve);
  freshMedia.delete(tabId);
  if (!currentWork(tabId, epoch, token)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!currentWork(tabId, epoch, token) || !tab?.url) return;
  tabPages.set(tabId, pageIdentity(tab.url));
  if (preserve) pushToTab(tabId);
  if (videoIdOf(tab.url) && isYoutube(tab.url)) resolveYoutube(tabId, tab.url);
  chrome.tabs.sendMessage(tabId, { type: "swiftget-refresh-current-player" }).catch(() => {});
}

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!info.url) return;
  announceExtensionReady();
  const identity = pageIdentity(info.url);
  if (identity && tabPages.get(tabId) === identity) return;
  tabPages.set(tabId, identity);
  // Advance before any await, including for A→B→A: an old A resolver must
  // never be accepted as the new visit just because its video ID matches.
  const epoch = advanceTab(tabId);
  clearSelection(tabId);
  freshMedia.delete(tabId);
  const newId = videoIdOf(info.url);
  seenStreams.delete(tabId);
  await clearTab(tabId, epoch);
  if (epochOf(tabId) !== epoch) return;
  if (newId && isYoutube(info.url)) resolveYoutube(tabId, info.url);
  else if (validClientToken(tabClientTokens.get(tabId))) {
    // The page script may have announced its player before Chrome published
    // the new SPA URL. Ask it once to announce the current player again.
    chrome.tabs.sendMessage(tabId, { type: "swiftget-refresh-current-player" }).catch(() => {});
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  const epoch = advanceTab(tabId);
  clearSelection(tabId);
  freshMedia.delete(tabId);
  seenStreams.delete(tabId);
  resolving.delete(tabId);
  clearTab(tabId, epoch).finally(() => {
    if (epochOf(tabId) === epoch) { tabPages.delete(tabId); tabClientTokens.delete(tabId); }
  });
});

// ---------------------------------------------------------------- 4. context menu

function makeMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "swiftget-link", title: "Download with Mac Downloader", contexts: ["link"] });
    chrome.contextMenus.create({
      id: "swiftget-media",
      title: "Download this media with Mac Downloader",
      contexts: ["video", "audio", "image"],
    });
    chrome.contextMenus.create({
      id: "swiftget-video",
      title: "Download video with Mac Downloader",
      contexts: ["page", "video", "frame"],
    });
    chrome.contextMenus.create({
      id: "swiftget-all",
      title: "Download all links with Mac Downloader",
      contexts: ["page", "frame", "link", "image"],
    });
    chrome.contextMenus.create({
      id: "swiftget-selected",
      title: "Download selected links with Mac Downloader",
      contexts: ["selection"],
    });
  });
}
chrome.runtime.onInstalled.addListener(() => { makeMenus(); announceExtensionReady(true); });
chrome.runtime.onStartup.addListener(() => { makeMenus(); announceExtensionReady(true); });

/** Every link of the page (or of the selection) to the app's "Download all links". */
async function sendAllLinks(tab, selection) {
  assertSupportedPlayback(tab && tab.url);
  const res = await chrome.tabs.sendMessage(tab.id, { type: "swiftget-collect-links", selection }).catch(() => null);
  if (!res || !res.links || !res.links.length) return;
  const page = res.page || tab.url;
  assertSupportedPlayback(page);
  // Ignore protected fragments mixed into a public page's ordinary links.
  const links = res.links.filter((link) => !isProtectedPlayback(link.url));
  if (!links.length) return;
  // Page cookies can only help links from that origin. The desktop app also
  // preserves this scope and filters each link in a mixed-origin batch.
  let needsCookies = false;
  try {
    const origin = new URL(page).origin;
    needsCookies = links.some((link) => {
      try { return new URL(link.url).origin === origin; } catch { return false; }
    });
  } catch { /* invalid page: no credentials */ }
  const { port } = await getOpts();
  await fetchWithTimeout(
    apiUrl(port, "/links"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-SwiftGet": "1" },
      body: JSON.stringify({
        page,
        links,
        cookies: needsCookies ? await cookieHeader(page) : null,
        userAgent: navigator.userAgent,
      }),
    },
    5000
  );
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (isProtectedPlayback(tab && tab.url, info.pageUrl, info.frameUrl, info.linkUrl, info.srcUrl)) {
    if (tab && info.menuItemId === "swiftget-video") {
      chrome.tabs.sendMessage(tab.id, { type: "swiftget-open-panel" }).catch(() => {});
      pushToTab(tab.id);
    }
    return;
  }
  if (info.menuItemId === "swiftget-all" || info.menuItemId === "swiftget-selected") {
    if (tab) sendAllLinks(tab, info.menuItemId === "swiftget-selected").catch((e) => console.warn("Mac Downloader:", e));
    return;
  }
  if (info.menuItemId === "swiftget-video") {
    if (!tab) return;
    // find the qualities and open the panel on the page
    if (isYoutube(tab.url)) resolveYoutube(tab.id, tab.url);
    else resolvePage(tab.id, info.frameUrl && info.frameUrl !== tab.url ? tab.url : tab.url);
    chrome.tabs.sendMessage(tab.id, { type: "swiftget-open-panel" }).catch(() => {});
    pushToTab(tab.id);
    return;
  }
  const url = info.linkUrl || info.srcUrl;
  if (!url || !/^https?:/i.test(url)) return;
  sendToApp({ url, referrer: info.pageUrl }).catch((e) => console.warn("Mac Downloader:", e));
});

// ---------------------------------------------------------------- messages from page/popup

function reply(promise, sendResponse) {
  promise
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
}

function isPopupSender(sender) {
  try { return !sender.tab && sender.id === chrome.runtime.id && sender.url?.split("?")[0] === chrome.runtime.getURL("popup.html"); }
  catch (_) { return false; }
}

// A popup can remain open across navigation. Bind its action to both the tab
// and the specific player generation whose rows it displayed.
async function validatePopupAction(msg, sender, expectedPage) {
  if (sender.tab || (msg.tabId == null && !isPopupSender(sender))) return null;
  if (sender.id !== chrome.runtime.id || !Number.isInteger(msg.tabId) || !validClientToken(msg.clientToken) || !Number.isSafeInteger(msg.selectionVersion)) {
    throw new Error("The video changed. Please choose its format again.");
  }
  const epoch = epochOf(msg.tabId), token = tabClientTokens.get(msg.tabId);
  const selectionVersion = selectionVersionOf(msg.tabId);
  if (token !== msg.clientToken || selectionVersion !== msg.selectionVersion) throw new Error("The video changed. Please choose its format again.");
  const [tab, top] = await Promise.all([
    chrome.tabs.get(msg.tabId).catch(() => null),
    chrome.tabs.sendMessage(msg.tabId, { type: "swiftget-request-client-token" }, { frameId: 0 }).catch(() => null),
  ]);
  if (!currentWork(msg.tabId, epoch, token) || selectionVersionOf(msg.tabId) !== selectionVersion || top?.clientToken !== msg.clientToken || !tab?.url || !expectedPage || pageIdentity(tab.url) !== pageIdentity(expectedPage)) {
    throw new Error("The video changed. Please choose its format again.");
  }
  return tab;
}

async function popupSnapshot(tabId) {
  const empty = () => ({ items: [], clientToken: null, tabId, selectionVersion: selectionVersionOf(tabId) });
  if (!Number.isInteger(tabId)) return empty();
  let tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return empty();
  // A service worker may have restarted while the page remained open. Ask
  // the trusted top content script for its opaque generation token.
  if (!validClientToken(tabClientTokens.get(tabId))) {
    const beforeEpoch = epochOf(tabId), beforeToken = tabClientTokens.get(tabId);
    let response;
    try { response = await chrome.tabs.sendMessage(tabId, { type: "swiftget-request-client-token" }, { frameId: 0 }); } catch (_) {}
    if (!currentWork(tabId, beforeEpoch, beforeToken) || !validClientToken(response?.clientToken)) return empty();
    await resetForClient(tabId, response.clientToken);
    tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url) return empty();
  }
  const epoch = epochOf(tabId), token = tabClientTokens.get(tabId);
  const selectionVersion = selectionVersionOf(tabId);
  const items = await itemsForTab(tabId);
  if (!currentWork(tabId, epoch, token) || selectionVersionOf(tabId) !== selectionVersion) return empty();
  return { items, clientToken: token, tabId, selectionVersion };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "swiftget-top-fullscreen-changed":
      // Only the extension's own top-frame script may announce a change.
      // Send a signal, not page data, to scripts in this same tab.
      if (typeof chrome.runtime.id !== "string" || !chrome.runtime.id || sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id) || sender.frameId !== 0) return false;
      chrome.tabs.sendMessage(sender.tab.id, { type: "swiftget-refresh-top-fullscreen" }).catch(() => {});
      return false;
    case "swiftget-query-top-fullscreen":
      // Read the current top-frame state rather than caching it in the worker:
      // a new iframe, a navigation, or a restarted worker gets fresh state.
      if (typeof chrome.runtime.id !== "string" || !chrome.runtime.id || sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id) || !Number.isInteger(sender.frameId) || sender.frameId <= 0) return false;
      chrome.tabs.sendMessage(sender.tab.id, { type: "swiftget-read-top-fullscreen" }, { frameId: 0 })
        .then((response) => sendResponse(typeof response?.fullscreen === "boolean" ? { fullscreen: response.fullscreen } : {}))
        .catch(() => sendResponse({}));
      return true;
    case "swiftget-download": {
      const item = msg.item || {};
      if (sender.tab && validClientToken(msg.clientToken) && tabClientTokens.get(sender.tab.id) !== msg.clientToken) {
        sendResponse({ ok: false, error: "The video changed. Please choose its format again." });
        return false;
      }
      const activeVideo = sender.tab && isYoutube(sender.tab.url) ? videoIdOf(sender.tab.url) : null;
      const optionVideo = item.yt?.source && isYoutube(item.yt.source) ? videoIdOf(item.yt.source) : null;
      if (activeVideo && optionVideo && activeVideo !== optionVideo) {
        sendResponse({ ok: false, error: "The video changed. Please choose its format again." });
        return false;
      }
      if (item.protected || item.type === "protected" || isProtectedPlayback(sender.tab && sender.tab.url, msg.referrer)) {
        sendResponse({ ok: false, error: PROTECTED_VIDEO_MESSAGE });
        return false;
      }
      return reply((async () => {
        const popupTab = await validatePopupAction(msg, sender, msg.referrer);
        const currentVideo = popupTab && isYoutube(popupTab.url) ? videoIdOf(popupTab.url) : null;
        if (currentVideo && optionVideo && currentVideo !== optionVideo) throw new Error("The video changed. Please choose its format again.");
        const frameTab = sender.tab?.id ?? popupTab?.id;
        const frameId = sender.tab ? sender.frameId : item.frameId;
        const frameToken = sender.tab ? msg.frameToken : item.frameToken;
        if (frameToken) {
          const epoch = epochOf(frameTab), token = tabClientTokens.get(frameTab);
          if ((sender.tab && sender.id !== chrome.runtime.id) || !await currentFrame(frameTab, frameId, frameToken) || !currentWork(frameTab, epoch, token)) {
            throw new Error("The video changed. Please choose its format again.");
          }
        }
        if (popupTab && selectionVersionOf(frameTab) !== msg.selectionVersion) {
          throw new Error("The video changed. Please choose its format again.");
        }
        // a video inside a frame (embedded player): that frame's page
        const referrer = sender.frameId && msg.referrer ? msg.referrer : sender.tab ? sender.tab.url : msg.referrer;
        if (item.yt) return downloadVideo(item.yt, msg.title, referrer);
        return sendToApp({ url: item.url, referrer, fileName: msg.fileName });
      })(), sendResponse);
    }
    case "swiftget-get-media":
      if (msg.snapshot && (sender.tab || sender.id !== chrome.runtime.id)) {
        sendResponse({ items: [], clientToken: null, tabId: msg.tabId, selectionVersion: 0 }); return false;
      }
      (msg.snapshot ? popupSnapshot(msg.tabId) : itemsForTab(msg.tabId)).then(sendResponse).catch(() => sendResponse(msg.snapshot ? { items: [], clientToken: null, tabId: msg.tabId, selectionVersion: 0 } : []));
      return true;
    case "swiftget-media-request":
      if (!sender.tab) return false;
      (async () => {
        if (sender.frameId === 0 && sender.id === chrome.runtime.id && validClientToken(msg.clientToken)) {
          await resetForClient(sender.tab.id, msg.clientToken);
          if (tabClientTokens.get(sender.tab.id) !== msg.clientToken) return [];
        }
        if (sender.tab.url && videoIdOf(sender.tab.url)) resolveYoutube(sender.tab.id, sender.tab.url);
        return itemsForTab(sender.tab.id);
      })().then(sendResponse).catch(() => sendResponse([]));
      return true;
    case "swiftget-player-changed":
      if (!sender.tab || sender.frameId !== 0 || sender.id !== chrome.runtime.id || !validClientToken(msg.clientToken)) return false;
      resetForClient(sender.tab.id, msg.clientToken).catch(() => {});
      return false;
    case "swiftget-video-seen":
      // the page shows a video: find its qualities
      if (!sender.tab) return false;
      if (isProtectedPlayback(sender.tab.url, msg.page, msg.src)) {
        pushToTab(sender.tab.id);
        return false;
      }
      {
      const senderPage = pageIdentity(sender.tab.url);
      const frame = msg.frameToken ? { frameId: sender.frameId, frameToken: msg.frameToken } : null;
      if (frame && (sender.id !== chrome.runtime.id || !Number.isInteger(frame.frameId) || frame.frameId <= 0 || !validClientToken(frame.frameToken))) return false;
      const selectedAt = Number.isFinite(msg.selectedAt) && msg.selectedAt > 0 ? msg.selectedAt : 0;
      if (frame) {
        // Invalidate the old popup selection synchronously, before the new
        // frame's token challenge or resolver can finish.
        const selection = selectFrame(sender.tab.id, frame.frameId, frame.frameToken, msg.page || "", selectedAt, !!msg.activeSelection, !!msg.observedPlaying);
        if (!selection) return false;
        frame.selectionVersion = selection.version;
      } else if (sender.frameId === 0 && sender.id === chrome.runtime.id && msg.activeSelection && validClientToken(msg.clientToken) && tabClientTokens.get(sender.tab.id) === msg.clientToken) {
        const last = selectionTimes.get(sender.tab.id) || 0;
        if (!selectedAt || selectedAt >= last) {
          if (tabSelections.has(sender.tab.id)) {
            clearSelection(sender.tab.id);
            notifyPopup(sender.tab.id);
          }
          topSelections.add(sender.tab.id);
          if (selectedAt) selectionTimes.set(sender.tab.id, selectedAt);
        }
      }
      getOpts().then(async (o) => {
        if (!o.enabled) return;
        if (sender.frameId === 0 && sender.id === chrome.runtime.id && validClientToken(msg.clientToken)) {
          await resetForClient(sender.tab.id, msg.clientToken);
          if (tabClientTokens.get(sender.tab.id) !== msg.clientToken) return;
        }
        const epoch = epochOf(sender.tab.id), token = tabClientTokens.get(sender.tab.id);
        const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
        if (!currentWork(sender.tab.id, epoch, token) || !tab || pageIdentity(tab.url) !== senderPage) return;
        if (frame && !await currentFrame(tab.id, frame.frameId, frame.frameToken)) return;
        if (!currentWork(sender.tab.id, epoch, token) || (frame && !selectedFrameIsCurrent(tab.id, frame))) return;
        if (frame) resolvePage(tab.id, msg.page || tab.url, true, frame);
        else if (isYoutube(tab.url)) resolveYoutube(tab.id, tab.url);
        else resolvePage(tab.id, msg.page || tab.url, !!msg.frame);
      });
      }
      return false;
    case "swiftget-resolve-video":
      // one of several videos on the page: its own file, or its own link
      if (validClientToken(msg.clientToken) && tabClientTokens.get(sender.tab?.id) !== msg.clientToken) {
        sendResponse({ items: [] }); return false;
      }
      {
      const tabId = sender.tab?.id, epoch = epochOf(tabId), token = tabClientTokens.get(tabId);
      const frame = msg.frameToken ? { frameId: sender.frameId, frameToken: msg.frameToken } : null;
      (async () => {
        if (frame && (sender.id !== chrome.runtime.id || !await currentFrame(tabId, frame.frameId, frame.frameToken))) return { items: [] };
        const result = await resolveOneVideo(msg, sender.tab);
        if (!currentWork(tabId, epoch, token) || (frame && !await currentFrame(tabId, frame.frameId, frame.frameToken))) return { items: [] };
        return currentWork(tabId, epoch, token) ? result : { items: [] };
      })().then(sendResponse).catch(() => sendResponse({ items: [] }));
      }
      return true;
    case "swiftget-magnet":
      // a torrent's magnet link clicked on a page
      return reply(
        getOpts().then((o) => {
          if (!o.enabled || !o.intercept) throw new Error("sending is off");
          return sendToApp({ url: msg.url, referrer: sender.tab ? sender.tab.url : "" });
        }),
        sendResponse
      );
    case "swiftget-playlist":
      // "Download all" on a playlist page: the app's playlist window
      if (isProtectedPlayback(sender.tab && sender.tab.url, msg.url)) {
        sendResponse({ ok: false, error: PROTECTED_VIDEO_MESSAGE });
        return false;
      }
      return reply((async () => { await validatePopupAction(msg, sender, msg.url); return sendPlaylist(msg.url); })(), sendResponse);
    case "swiftget-status":
      appAlive(true).then((ok) => sendResponse({ ok }));
      return true;
    case "swiftget-keys":
      lastKeys = { alt: !!msg.alt, ctrl: !!msg.ctrl, shift: !!msg.shift, at: Date.now() };
      return false;
    case "swiftget-config":
      Promise.all([getConfig(), getOpts()]).then(([cfg, o]) => {
        const panel = (cfg && cfg.panel) || { enabled: true, skipSites: [] };
        sendResponse(o.enabled ? panel : { ...panel, enabled: false });
      });
      return true;
    default:
      return false;
  }
});
