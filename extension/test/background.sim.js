// Runs background.js with a fake `chrome` API and a fake SwiftGet app.
// node extension/test/background.sim.js
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");
const dir = path.join(__dirname, "..");
const listeners = {}; const on = (n) => ({ addListener: (f) => (listeners[n] = f) });
const session = {}; const localStore = {}; let reloads = 0; let pingExt = null; const sent = []; const tabMsgs = []; let tabUrl = "https://www.youtube.com/watch?v=AAAAAAAAAAA";
const canceled = []; const erased = []; const dataRequests = [];
let runtimeOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
let runtimeVersion = "1.0.4";
const readiness = [];
const fullscreenTrace = []; let topFullscreen = false; let topFullscreenUnavailable = false; let topClientToken = null; const frameTokens = new Map();
let preparedConfig;
let preparedConfigReads = 0;
const chrome = {
  storage: {
    onChanged: on("store"),
    local: { get: async (d) => (typeof d === "string" ? (d in localStore ? { [d]: localStore[d] } : {}) : { ...d, ...localStore }), set: async (o) => Object.assign(localStore, o) },
    session: {
      get: async (k) => { const ks = Array.isArray(k) ? k : [k]; const o = {}; for (const x of ks) if (x in session) o[x] = JSON.parse(JSON.stringify(session[x])); return o; },
      set: async (o) => Object.assign(session, JSON.parse(JSON.stringify(o))),
      remove: async (k) => { for (const x of [].concat(k)) delete session[x]; },
    },
  },
  downloads: { onCreated: on("dl"), cancel: async (id) => canceled.push(id), erase: async (query) => erased.push(query.id), download: (o) => browserDl.push(o.url) },
  webRequest: { onHeadersReceived: on("headers"), onBeforeRequest: on("before") },
  tabs: { onUpdated: on("upd"), onRemoved: on("rm"), get: async (id) => ({ id, url: tabUrl }), query: async () => [{ id: 7 }],
          sendMessage: async (id, m, options) => {
            if (m.type === 'swiftget-request-client-token') return topClientToken ? { clientToken: topClientToken } : undefined;
            if (m.type === 'swiftget-request-frame-generation') return { frameToken: frameTokens.get(`${id}:${options?.frameId}`) };
            if (m.type === 'swiftget-read-top-fullscreen') {
              fullscreenTrace.push({ id, type: m.type, options });
              if (topFullscreenUnavailable) throw new Error('top frame unavailable');
              return { fullscreen: topFullscreen };
            }
            if (m.type === 'swiftget-refresh-top-fullscreen') { fullscreenTrace.push({ id, type: m.type, options }); return; }
            return tabMsgs.push(m);
          } },
  action: { setBadgeBackgroundColor: () => {}, setBadgeText: async () => {} },
  runtime: { id: 'synthetic-extension', onInstalled: on("inst"), onStartup: on("start"), onMessage: on("msg"), getManifest: () => ({ version: runtimeVersion }), getURL: (part) => `${runtimeOrigin}/${part}`, reload: () => { reloads++; } },
  contextMenus: { removeAll: () => {}, create: () => {}, onClicked: on("ctx") },
  cookies: { getAll: async () => [] },
};
const ytCalls = []; const browserDl = []; let appDown = false;
const batches = []; const cookieQueries = []; let collectedLinks = null;
chrome.cookies.getAll = async ({ url }) => { cookieQueries.push(url); return [{ name: "session", value: "synthetic" }]; };
const originalTabMessage = chrome.tabs.sendMessage;
chrome.tabs.sendMessage = async (id, message, options) => message.type === "swiftget-collect-links" ? collectedLinks : originalTabMessage(id, message, options);
const fetch = async (url, opts = {}) => {
  if (/\/(add|resolve|playlist|links)$/.test(url)) dataRequests.push(url);
  if (url.endsWith("/app-connection.json")) {
    preparedConfigReads++;
    return preparedConfig === undefined ? { ok: false, status: 404 } : {
      ok: true, status: 200, text: async () => typeof preparedConfig === "string" ? preparedConfig : JSON.stringify(preparedConfig),
    };
  }
  if (url.endsWith("/extension/ready")) {
    if (appDown) throw new TypeError("Failed to fetch");
    readiness.push({ url, method: opts.method, headers: opts.headers, body: JSON.parse(opts.body) });
  }
  if (url.endsWith("/links")) batches.push(JSON.parse(opts.body));
  if (url.endsWith("/ping") && pingExt) return { ok: true, status: 200, json: async () => ({ ext: pingExt }) };
  if (url.endsWith("/add")) { if (appDown) throw new TypeError("Failed to fetch"); sent.push(JSON.parse(opts.body)); }
  if (url.endsWith("/resolve")) {
    ytCalls.push(JSON.parse(opts.body));
    await new Promise((r) => setTimeout(r, 30)); // yt-dlp takes a moment
    return { ok: true, status: 200, json: async () => ({ ok: true, title: "Real: Title", options: [
      { key: "1080p|MP4", label: "1080p · MP4", sub: "94 MB", quality: "1080p", videoUrl: "https://gv/137", audioUrl: "https://gv/140", ext: "mp4", size: 94e6, headers: [["User-Agent", "YtDlpUA"]] },
      { key: "audio|M4A", label: "Audio only · M4A 130k", sub: "4 MB", quality: "audio", videoUrl: "https://gv/140", audioUrl: null, ext: "m4a", size: 4e6, headers: [] } ] }) };
  }
  return { ok: true, status: 200 };
};
const ctx = { chrome, fetch, AbortController, setTimeout, clearTimeout, navigator: { userAgent: "TestUA" }, console, URL,
  importScripts: (...f) => f.forEach((x) => vm.runInContext(fs.readFileSync(path.join(dir, x), "utf8"), ctx)) };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(dir, "background.js"), "utf8"), ctx);

const gv = (itag, mime, clen, dur, r) => `https://rr1---sn-x.googlevideo.com/videoplayback?expire=9&itag=${itag}&mime=${encodeURIComponent(mime)}&clen=${clen}&dur=${dur}&pot=T&range=${r}&rn=1`;
const tick = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  {
    const top = { id: 'synthetic-extension', tab: { id: 41 }, frameId: 0 };
    const child = { id: 'synthetic-extension', tab: { id: 41 }, frameId: 3 };
    const otherTab = { id: 'synthetic-extension', tab: { id: 42 }, frameId: 9 };
    listeners.msg({ type: 'swiftget-top-fullscreen-changed' }, top, () => {});
    await tick();
    assert(fullscreenTrace.some((m) => m.id === 41 && m.type === 'swiftget-refresh-top-fullscreen'), 'top frame broadcasts only to its own tab');
    const before = fullscreenTrace.length;
    listeners.msg({ type: 'swiftget-top-fullscreen-changed' }, child, () => {});
    listeners.msg({ type: 'swiftget-top-fullscreen-changed' }, { ...top, id: 'other-extension' }, () => {});
    listeners.msg({ type: 'swiftget-top-fullscreen-changed' }, { id: 'synthetic-extension', frameId: 0 }, () => {});
    assert.strictEqual(fullscreenTrace.length, before, 'child, foreign, and missing-tab notifications are ignored');
    topFullscreen = true;
    const query = (sender) => new Promise((resolve) => listeners.msg({ type: 'swiftget-query-top-fullscreen' }, sender, resolve));
    assert.strictEqual((await query(child)).fullscreen, true, 'new child queries current fullscreen state without a prior notification');
    const read = fullscreenTrace.at(-1);
    assert.strictEqual(read.id, 41); assert.strictEqual(read.options.frameId, 0, 'query reaches only the top frame');
    topFullscreen = false;
    assert.strictEqual((await query(child)).fullscreen, false, 'exit and navigation read current state rather than a stale worker cache');
    assert.strictEqual((await query(otherTab)).fullscreen, false, 'queries stay in the requesting tab');
    assert.strictEqual(fullscreenTrace.at(-1).id, 42);
    topFullscreenUnavailable = true;
    assert.deepStrictEqual(Object.keys(await query(child)), [], 'an unavailable top frame yields no fabricated state');
    topFullscreenUnavailable = false;
    let spoofReply = false;
    assert.strictEqual(listeners.msg({ type: 'swiftget-query-top-fullscreen' }, { ...child, id: 'other-extension' }, () => { spoofReply = true; }), false);
    assert.strictEqual(spoofReply, false, 'foreign queries are ignored');
    console.log('fullscreen relay: same-tab, top-frame authenticated, stateless queries passed');
  }
  // Only a dedicated extension POST registers readiness, without site data or
  // cookie/profile inspection. A popup check bypasses cached startup checks.
  {
    await tick();
    assert(readiness.length >= 1, "worker startup announces readiness");
    const initial = readiness[0];
    assert.strictEqual(initial.method, "POST");
    assert.strictEqual(initial.headers["X-SwiftGet"], "1");
    assert.deepStrictEqual(Object.keys(initial.body).sort(), ["browser", "enabled", "extensionOrigin", "version"]);
    assert.strictEqual(initial.body.extensionOrigin, runtimeOrigin);
    const beforePing = readiness.length;
    await fetch("http://127.0.0.1:9614/ping", { headers: { "X-SwiftGet": "1" } });
    assert.strictEqual(readiness.length, beforePing, "a bare app ping is not an extension announcement");
    await ctx.announceExtensionReady();
    assert.strictEqual(readiness.length, beforePing, "normal readiness traffic is throttled");
    session.versionCheckAt = Date.now();
    const beforeCookies = cookieQueries.length;
    const status = await new Promise((resolve) => listeners.msg({ type: "swiftget-status" }, {}, resolve));
    assert.strictEqual(status.ok, true);
    assert.strictEqual(readiness.length, beforePing + 1, "opening the popup refreshes readiness despite a cached version check");
    assert.strictEqual(cookieQueries.length, beforeCookies, "setup readiness never reads website cookies");
    const oldAgent = ctx.navigator.userAgent;
    for (const [agent, expected] of [["Chrome/130.0 Edg/130.0", "Edge"], ["Chrome/130.0 OPR/110.0", "Opera"], ["Chrome/130.0", "Chrome"]]) {
      ctx.navigator.userAgent = agent;
      await ctx.announceExtensionReady(true);
      assert.strictEqual(readiness.at(-1).body.browser, expected);
    }
    ctx.navigator.brave = { isBrave: async () => true };
    await ctx.announceExtensionReady(true);
    assert.strictEqual(readiness.at(-1).body.browser, "Brave");
    delete ctx.navigator.brave;
    ctx.navigator.userAgent = "Firefox/140.0";
    runtimeOrigin = "moz-extension://12345678-1234-1234-1234-123456789abc";
    await ctx.announceExtensionReady(true);
    assert.strictEqual(readiness.at(-1).body.browser, "Firefox");
    assert.strictEqual(readiness.at(-1).body.extensionOrigin, runtimeOrigin);
    const validCount = readiness.length;
    runtimeOrigin = "https://untrusted.example";
    assert.strictEqual(await ctx.announceExtensionReady(true), false);
    runtimeOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    runtimeVersion = "1".repeat(33);
    assert.strictEqual(await ctx.announceExtensionReady(true), false);
    runtimeVersion = "1.0.4\nforged";
    assert.strictEqual(await ctx.announceExtensionReady(true), false);
    assert.strictEqual(readiness.length, validCount, "invalid origins and unbounded versions are not announced");
    runtimeVersion = "1.0.4";
    ctx.navigator.userAgent = oldAgent;
    localStore.enabled = false;
    await ctx.announceExtensionReady(true);
    assert.strictEqual(readiness.at(-1).body.enabled, false, "paused capture remains distinguishable from ready capture");
    delete localStore.enabled;
    console.log("extension readiness: explicit, bounded, browser-specific, and cookie-free");
  }
  // Stable setup copies can supply the app port without changing preferences.
  {
    const resetPrepared = () => vm.runInContext("preparedPortPromise = null", ctx);
    preparedConfig = { port: 19718 };
    resetPrepared();
    const reads = preparedConfigReads;
    assert.strictEqual((await ctx.getOpts()).port, 19718);
    assert.strictEqual((await ctx.getOpts()).port, 19718);
    assert.strictEqual(preparedConfigReads, reads + 1, "prepared metadata is cached for the worker lifetime");
    preparedConfig = { port: 19720 };
    assert.strictEqual((await ctx.getOpts()).port, 19718, "a running worker retains the cached prepared port");
    assert.strictEqual(await ctx.appAlive(true), true);
    assert.strictEqual((await ctx.getOpts()).port, 19720, "opening the popup refreshes a changed prepared port");
    assert.strictEqual(readiness.at(-1).url, "http://127.0.0.1:19720/extension/ready", "readiness reaches the restarted app's new port");
    localStore.port = 19719;
    assert.strictEqual((await ctx.getOpts()).port, 19719, "explicit saved options override the prepared default");
    preparedConfig = { port: 19721 };
    await ctx.appAlive(true);
    assert.strictEqual(readiness.at(-1).url, "http://127.0.0.1:19719/extension/ready", "forced refresh preserves an explicit saved port");
    delete localStore.port;
    for (const port of [1, 65535]) {
      preparedConfig = { port };
      resetPrepared();
      assert.strictEqual((await ctx.getOpts()).port, port, "valid boundary ports are accepted");
    }
    for (const invalid of [{ port: 0 }, { port: 65536 }, { port: 1.5 }, { port: "19718" }, null, "invalid JSON", " ".repeat(1025)]) {
      preparedConfig = invalid;
      resetPrepared();
      assert.strictEqual((await ctx.getOpts()).port, 9614, "invalid prepared ports use the normal default");
    }
    preparedConfig = undefined;
    resetPrepared();
    assert.strictEqual((await ctx.getOpts()).port, 9614, "missing bundled metadata keeps the normal default");
    console.log("prepared connection: cached, validated, optional, and overridden by explicit options");
  }
  // Bulk downloads retain the page scope; foreign-only lists need no page cookies.
  {
    const page = "https://members.example/private?token=synthetic";
    collectedLinks = { page, links: [{ url: "https://files.example/file.pdf", text: "foreign" }] };
    const beforeCookies = cookieQueries.length;
    await ctx.sendAllLinks({ id: 7, url: page }, false);
    assert.strictEqual(cookieQueries.length, beforeCookies, "foreign-only list never reads page cookies");
    assert.strictEqual(batches[batches.length - 1].cookies, null);
    collectedLinks.links.push({ url: "https://members.example/file.pdf", text: "own" });
    await ctx.sendAllLinks({ id: 7, url: page }, false);
    const batch = batches[batches.length - 1];
    assert.strictEqual(batch.page, page, "desktop receives cookie protection scope");
    assert.strictEqual(batch.cookies, "session=synthetic");
    assert.strictEqual(batch.links.length, 2, "mixed-origin links remain selectable");
    collectedLinks = null;
  }
  // player loads an ad, then the real video in many pieces
  listeners.before({ tabId: 7, url: gv(136, "video/mp4", 5e6, "15.0", "0-1000") });
  await tick();
  for (const r of ["0-1000", "1001-2000", "2001-3000"]) {
    listeners.before({ tabId: 7, url: gv(137, "video/mp4", 150e6, "300.5", r) }); await tick();
    listeners.before({ tabId: 7, url: gv(140, "audio/mp4", 4e6, "300.5", r) }); await tick();
  }
  const last = tabMsgs[tabMsgs.length - 1];
  assert.strictEqual(last.type, "swiftget-media");
  assert.strictEqual(last.items[0].label, "1080p Full HD · MP4");
  assert.strictEqual(last.items[0].yt.tag, "Full HD");
  console.log("button shows:", last.items.map((i) => i.label).join(" | "));

  // user clicks 1080p on the page
  const res = await new Promise((resolve) =>
    listeners.msg({ type: "swiftget-download", item: last.items[0], title: "(2) Cool video - YouTube" }, { tab: { id: 7, url: tabUrl } }, resolve));
  assert.strictEqual(res.ok, true);
  const req = sent[0];
  assert(req.url.includes("itag=137") && !req.url.includes("range="));
  assert(req.audioUrl.includes("itag=140"));
  assert.strictEqual(req.fileName, "Cool video [1080p].mp4");
  assert.strictEqual(req.userAgent, "TestUA");
  console.log("sent to app:", req.fileName, "| audio:", !!req.audioUrl);

  // navigating to another video clears the list
  tabUrl = "https://www.youtube.com/watch?v=BBBBBBBBBBB";
  await listeners.upd(7, { url: tabUrl }, { id: 7, url: tabUrl }); await tick();
  const afterNav = tabMsgs[tabMsgs.length - 1].items;
  assert(!afterNav.some((i) => i.label === "1080p · MP4" && i.yt && i.yt.videoUrl.includes("itag=137")), "old video's items gone");

  // ---- SABR video: no usable stream URL, the app (yt-dlp) gives the qualities
  listeners.before({ tabId: 7, url: "https://rr1---sn-x.googlevideo.com/videoplayback?expire=9&sabr=1&ump=1" });
  await listeners.upd(7, { url: tabUrl, status: "complete" }, { id: 7, url: tabUrl });
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(ytCalls.length, 1, "asked the app once");
  assert.strictEqual(ytCalls[0].url, "https://www.youtube.com/watch?v=BBBBBBBBBBB");
  assert(Array.isArray(ytCalls[0].cookieList), "sends the site's cookies as a list");
  const labels = tabMsgs.map((m) => (m.items[0] || {}).label);
  assert(labels.includes("Getting video qualities…"), "shows progress while resolving");
  const final = tabMsgs[tabMsgs.length - 1].items;
  assert.strictEqual(final[0].label, "1080p · MP4");
  const res2 = await new Promise((resolve) =>
    listeners.msg({ type: "swiftget-download", item: final[0], title: "ignored - YouTube" }, { tab: { id: 7, url: tabUrl } }, resolve));
  assert.strictEqual(res2.ok, true);
  const req2 = sent[sent.length - 1];
  assert.strictEqual(req2.fileName, "Real_ Title [1080p].mp4");
  assert.strictEqual(req2.sourcePage, "https://www.youtube.com/watch?v=BBBBBBBBBBB");
  assert.strictEqual(req2.sourceKey, "1080p|MP4");
  assert.strictEqual(req2.audioUrl, "https://gv/140");
  assert.strictEqual(req2.headers[0][1], "YtDlpUA");
  console.log("SABR video via app:", req2.fileName, "| key:", req2.sourceKey);

  // ---- any other site: a reel in an Instagram feed
  tabUrl = "https://www.instagram.com/";
  await listeners.upd(8, { url: tabUrl, status: "loading" }, { id: 8, url: tabUrl });
  tabMsgs.length = 0;
  listeners.msg({ type: "swiftget-video-seen", page: "https://www.instagram.com/reel/C1abcDEF/" }, { tab: { id: 8, url: tabUrl } }, () => {});
  await new Promise((r) => setTimeout(r, 150));
  const igCall = ytCalls[ytCalls.length - 1];
  assert.strictEqual(igCall.url, "https://www.instagram.com/reel/C1abcDEF/");
  const igItems = tabMsgs[tabMsgs.length - 1].items;
  assert.strictEqual(igItems[0].label, "1080p · MP4");
  const res3 = await new Promise((resolve) =>
    listeners.msg({ type: "swiftget-download", item: igItems[0], title: "x" }, { tab: { id: 8, url: tabUrl } }, resolve));
  assert.strictEqual(res3.ok, true);
  const req3 = sent[sent.length - 1];
  assert.strictEqual(req3.sourcePage, "https://www.instagram.com/reel/C1abcDEF/");
  assert.strictEqual(req3.referrer, "https://www.instagram.com/reel/C1abcDEF/");
  console.log("Instagram reel via app:", req3.fileName);
  // browser downloads: only new ones, each once, no loop when the app fails
  const now = new Date().toISOString();
  const dl = async (o) => { await listeners.dl({ id: Math.random(), state: "in_progress", startTime: now, ...o }); await tick(); };
  let before = sent.length;
  await dl({ url: "https://example.com/old.pdf", startTime: new Date(Date.now() - 3600e3).toISOString() });
  await dl({ url: "https://example.com/done.pdf", state: "complete" });
  await dl({ url: "https://example.com/ext.pdf", byExtensionId: "other" });
  assert.strictEqual(sent.length, before, "restored / finished / extension downloads are left alone");
  await dl({ url: "https://example.com/new.pdf" });
  await dl({ url: "https://example.com/new.pdf" });
  assert.strictEqual(sent.length, before + 1, "a new download goes to the app once");
  appDown = true;
  await dl({ url: "https://example.com/fail.pdf" });
  assert.deepStrictEqual(browserDl, ["https://example.com/fail.pdf"], "given back to the browser once");
  await dl({ url: "https://example.com/fail.pdf", byExtensionId: "self" });
  await dl({ url: "https://example.com/fail.pdf" }); // same address right after: the browser keeps it
  assert.strictEqual(browserDl.length, 1, "no loop");
  appDown = false;
  console.log("browser downloads: restored ones ignored, no repeats, no loop");
  // add-in reloads itself once when the program brings a newer one
  pingExt = "1.0.5"; delete session.versionCheckAt;
  await ctx.followAppVersion(); await tick();
  assert.strictEqual(reloads, 1, "reloads for the new version");
  delete session.versionCheckAt;
  await ctx.followAppVersion(); await tick();
  assert.strictEqual(reloads, 1, "only once per version");
  pingExt = "1.0.4"; delete session.versionCheckAt;
  await ctx.followAppVersion();
  assert.strictEqual(reloads, 1, "same version: nothing");
  pingExt = null;
  console.log("self update: reloads once when the program has a newer add-in");
  // a player inside a frame (Dailymotion's "geo.dailymotion.com/player/…"):
  // the page around it is looked up, its qualities are offered
  {
    const page = "https://www.dailymotion.com/video/xac78kk";
    const n = ytCalls.length;
    const res = await new Promise((resolve) =>
      listeners.msg({ type: "swiftget-resolve-video", page: "", src: "", frame: true }, { tab: { id: 21, url: page }, frameId: 4 }, resolve));
    assert(res.items && res.items.length >= 2, "qualities of the page: " + JSON.stringify(res));
    assert.strictEqual(ytCalls[n].url, page, "the page, not the player frame");
    assert(!ytCalls.slice(n).some((c) => /geo\.dailymotion\.com/.test(c.url)));
    console.log("player in a frame: uses the page's qualities");
  }
  // the on / off switch of the add-in's window
  {
    localStore.enabled = false;
    listeners.store({ enabled: { newValue: false } }, "local");
    const before = sent.length;
    await dl({ url: "https://example.com/while-off.zip" });
    assert.strictEqual(sent.length, before, "off: the browser keeps its downloads");
    const cfg = await new Promise((r) => listeners.msg({ type: "swiftget-config" }, { tab: { id: 7, url: tabUrl } }, r));
    assert.strictEqual(cfg.enabled, false, "off: no buttons on videos");
    const n = tabMsgs.length;
    await ctx.pushToTab(7);
    assert.strictEqual(tabMsgs.slice(n).pop().items.length, 0, "off: nothing offered on the page");
    localStore.enabled = true;
    await dl({ url: "https://example.com/while-on.zip" });
    assert.strictEqual(sent.length, before + 1, "on again: back to the app");
    console.log("on / off switch: off leaves everything to the browser");
  }
  // Protected playback is explanatory UI, never a fragment download or a
  // request to extract Netflix credentials. Public and lookalike sites stay usable.
  {
    const protectedMessage = "Netflix playback is not supported by this downloader. Use Netflix’s official app on a supported device for offline viewing.";
    const watch = "https://www.netflix.com/watch/80000000?trackId=synthetic";
    const fragment = "https://ipv4-c001.example.nflxvideo.net/range/0-999?token=synthetic";
    const normal = "https://files.example/public.mp4";
    const sender = { tab: { id: 31, url: watch }, frameId: 4 };
    const expected = [{ disabled: true, protected: true, label: "Protected video", sub: protectedMessage, type: "protected", url: null }];
    for (const url of [watch, "https://netflix.com/watch/1", "https://WWW.NETFLIX.COM.:443/watch/2", "https://player.netflix.com/watch/3", fragment]) {
      assert.strictEqual(ctx.isProtectedPlayback(url), true, url);
    }
    const ordinary = [
      "https://netflix.com.example/watch/1", "https://notnetflix.com/watch/1",
      "https://netflix.com@ordinary.example/watch/1", "https://nflxvideo.net.example/file.mp4",
      "https://notnflxvideo.net/file.mp4", "https://ordinary.example/?next=https://netflix.com/watch/1",
      "https://www.netflix.com/title/1", "https://www.netflix.com/browse", "https://www.netflix.com/watchlist",
    ];
    for (const url of ordinary) assert.strictEqual(ctx.isProtectedPlayback(url), false, url);
    const previousTab = tabUrl;
    tabUrl = watch;
    session.media_31 = [{ url: fragment, type: "video/mp4", size: 800000, ext: "mp4" }, { url: normal, type: "video/mp4", ext: "mp4" }];
    session.res_31 = { page: watch, resolved: { options: [{ label: "Stale format", videoUrl: fragment }] } };
    const baseline = { cookies: cookieQueries.length, requests: dataRequests.length, canceled: canceled.length, erased: erased.length, browser: browserDl.length };
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await ctx.itemsForTab(31))), expected, "watch pages replace even cached fragment/quality choices with one explanation");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await ctx.resolveOneVideo({ page: normal, src: normal, frame: true }, sender.tab))), { items: expected });
    await ctx.resolvePage(31, normal, true);
    await ctx.resolveYoutube(31, "https://www.youtube.com/watch?v=AAAAAAAAAAA");
    for (const operation of [
      () => ctx.sendToApp({ url: watch }),
      () => ctx.sendToApp({ url: fragment }),
      () => ctx.sendToApp({ url: normal, referrer: watch }),
      () => ctx.sendToApp({ url: normal, audioUrl: fragment }),
      () => ctx.sendToApp({ url: normal, sourcePage: watch }),
      () => ctx.sendToApp({ url: normal, headers: [["Referer", watch]] }),
      () => ctx.downloadVideo({ videoUrl: normal, quality: "HD", ext: "mp4" }, "Synthetic", watch),
      () => ctx.downloadVideo({ videoUrl: fragment, quality: "HD", ext: "mp4" }, "Synthetic", "https://ordinary.example/"),
      () => ctx.askApp(watch), () => ctx.askApp(fragment),
      () => ctx.cookieHeader(watch), () => ctx.cookieList(watch),
      () => ctx.sendPlaylist(watch), () => ctx.sendAllLinks(sender.tab, false),
    ]) await assert.rejects(operation, (error) => error.message === protectedMessage);
    const refused = await new Promise((resolve) => listeners.msg({ type: "swiftget-download", referrer: normal, item: { url: normal } }, sender, resolve));
    assert.strictEqual(refused.ok, false, "a frame referrer cannot override the protected top-page context");
    assert.strictEqual(refused.error, protectedMessage);
    const playlist = await new Promise((resolve) => listeners.msg({ type: "swiftget-playlist", url: "https://www.youtube.com/playlist?list=synthetic" }, sender, resolve));
    assert.strictEqual(playlist.ok, false);
    listeners.msg({ type: "swiftget-video-seen", page: normal, frame: true }, sender, () => {});
    listeners.ctx({ menuItemId: "swiftget-link", linkUrl: normal, pageUrl: watch }, sender.tab);
    await dl({ url: fragment, referrer: watch, mime: "video/mp4", totalBytes: 800000 });
    listeners.headers({ tabId: 31, url: fragment, statusCode: 200, responseHeaders: [{ name: "content-type", value: "video/mp4" }, { name: "content-length", value: "800000" }] });
    await ctx.addMedia(31, { url: normal, type: "video/mp4" });
    await tick();
    assert.deepStrictEqual({ cookies: cookieQueries.length, requests: dataRequests.length, canceled: canceled.length, erased: erased.length, browser: browserDl.length }, baseline, "blocked playback never reads cookies, contacts download/extraction APIs, cancels downloads, or recreates browser downloads");
    assert.strictEqual(session.media_31.length, 2, "new encrypted/cross-frame fragments are not added to the cache");

    // Outside watch pages, cached fragments are filtered without suppressing
    // normal files, and a public Netflix page is not blanket-blocked.
    tabUrl = "https://ordinary.example/videos";
    session.media_32 = [{ url: fragment, type: "video/mp4" }, { url: normal, type: "video/mp4" }];
    session.mediaOwner_32 = tabUrl;
    const publicItems = await ctx.itemsForTab(32);
    assert.strictEqual(publicItems.length, 1);
    assert.strictEqual(publicItems[0].url, normal);
    const beforeNormal = sent.length;
    await ctx.sendToApp({ url: normal, referrer: "https://www.netflix.com/title/1" });
    await ctx.sendToApp({ url: "https://notnetflix.com/watch/public.mp4", referrer: "https://ordinary.example/" });
    assert.strictEqual(sent.length, beforeNormal + 2, "ordinary media and domain lookalikes still reach the app");
    delete session.media_31; delete session.res_31; delete session.media_32; delete session.mediaOwner_32;
    tabUrl = previousTab;
    console.log("protected playback: Netflix fragments/watch pages stay cookie-free; public and lookalike sites remain usable");
  }
  // Same-page navigation must not show a previously resolved YouTube video.
  {
    const previousTab = tabUrl, A = "https://www.youtube.com/watch?v=AAAAAAAAAAA", B = "https://www.youtube.com/watch?v=BBBBBBBBBBB";
    tabUrl = B;
    session.yt_70 = { videoId: "AAAAAAAAAAA", sabr: false, streams: {}, resolved: { title: "old video", options: [{ label: "old format", videoUrl: "https://synthetic.example/a" }] } };
    assert(!(await ctx.itemsForTab(70)).some(i => i.label === "old format"), "a mismatched cached video never appears");
    await ctx.addYoutubeStream(70, { itag: 137, dur: "30", type: "video", url: "https://synthetic.example/b" });
    assert.strictEqual(session.yt_70.videoId, "BBBBBBBBBBB");
    assert(!session.yt_70.resolved, "a stream for a new video cannot retain the previous resolved formats");
    await ctx.addYoutubeStream(80, { itag: 137, dur: "30", type: "video", url: "https://synthetic.example/old-frame" }, "https://www.youtube.com/embed/AAAAAAAAAAA", 4);
    assert(!session.yt_80, "a previous YouTube iframe cannot contribute its streams to the current video");

    // Hold a storage write across a navigation; the queued clear/new state
    // must win even if the older write completes last in wall-clock time.
    let entered, release;
    const writeEntered = new Promise(r => { entered = r; });
    const hold = new Promise(r => { release = r; });
    const normalSet = chrome.storage.session.set;
    chrome.storage.session.set = async (obj) => {
      if (obj.yt_71?.videoId === "AAAAAAAAAAA") { entered(); await hold; }
      return normalSet(obj);
    };
    tabUrl = A;
    const old = ctx.addYoutubeStream(71, { itag: 137, dur: "31", type: "video", url: "https://synthetic.example/a" });
    await writeEntered;
    tabUrl = B;
    const navigation = listeners.upd(71, { url: B }, { id: 71, url: B });
    await tick(); release(); await Promise.all([old, navigation]); await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(session.yt_71?.videoId, "BBBBBBBBBBB", "a delayed old stream cannot overwrite the new visit");
    chrome.storage.session.set = normalSet;

    // Generic media discovered under the old page must not reappear after an
    // SPA URL update, including when its storage write was already pending.
    let mediaEntered, releaseMedia;
    const enteredMedia = new Promise(r => { mediaEntered = r; });
    const holdMedia = new Promise(r => { releaseMedia = r; });
    chrome.storage.session.set = async (obj) => {
      if (obj.media_72) { mediaEntered(); await holdMedia; }
      return normalSet(obj);
    };
    const oldPage = "https://ordinary.example/old", newPage = "https://ordinary.example/new";
    tabUrl = oldPage;
    const oldMedia = ctx.addMedia(72, { url: "https://synthetic.example/old.mp4", type: "video/mp4" });
    await enteredMedia;
    tabUrl = newPage;
    const newPageNav = listeners.upd(72, { url: newPage }, { id: 72, url: newPage });
    await tick(); releaseMedia(); await Promise.all([oldMedia, newPageNav]);
    assert.deepStrictEqual(Array.from(await ctx.itemsForTab(72)), [], "old page media cannot reappear after navigation");
    chrome.storage.session.set = normalSet;

    let oldResultEntered, releaseOldResult, held = false;
    const enteredResult = new Promise(r => { oldResultEntered = r; });
    const holdResult = new Promise(r => { releaseOldResult = r; });
    const embeddedA = "https://video.example/a", embeddedB = "https://video.example/b";
    chrome.storage.session.set = async (obj) => {
      if (!held && obj.res_77?.page === embeddedA && obj.res_77.resolving === false) { held = true; oldResultEntered(); await holdResult; }
      return normalSet(obj);
    };
    tabUrl = "https://ordinary.example/feed";
    const oldResolution = ctx.resolvePage(77, embeddedA, true);
    await enteredResult;
    const newResolution = ctx.resolvePage(77, embeddedB, true);
    await tick(); releaseOldResult(); await Promise.all([oldResolution, newResolution]);
    assert.strictEqual(session.res_77?.page, embeddedB, "a late embedded resolver write cannot replace the current frame");
    chrome.storage.session.set = normalSet;

    // A different embedded player must not reuse another frame's tab-wide
    // cached formats just because both live on the same containing page.
    tabUrl = "https://ordinary.example/feed";
    session.res_75 = { page: "https://video.example/old", ownerPage: tabUrl, resolved: { options: [{ label: "old frame", videoUrl: "https://synthetic.example/old" }] } };
    const frameResult = await ctx.resolveOneVideo({ frame: true, page: "https://video.example/new", src: "https://synthetic.example/new.mp4" }, { id: 75, url: tabUrl });
    assert(!frameResult.items.some(i => i.label === "old frame"), "a different embedded player cannot reuse the old frame's formats");
    assert.strictEqual(ytCalls.at(-1).url, "https://video.example/new", "the new frame is resolved independently");

    assert.notStrictEqual(ctx.pageIdentity("https://first.example/watch?v=same"), ctx.pageIdentity("https://second.example/watch?v=same"), "ordinary sites' v parameters are not YouTube IDs");
    assert.notStrictEqual(ctx.pageIdentity("https://ordinary.example/#/one"), ctx.pageIdentity("https://ordinary.example/#/two"), "hash-router video routes remain distinct");
    const normalTabGet = chrome.tabs.get;
    chrome.tabs.get = async (id) => { if (id === 76) throw new Error("closed tab"); return normalTabGet(id); };
    session.yt_76 = { videoId: "AAAAAAAAAAA", resolved: { options: [{ label: "orphan", videoUrl: "https://synthetic.example/orphan" }] } };
    assert.deepStrictEqual(Array.from(await ctx.itemsForTab(76)), [], "an unavailable tab must never expose cached video formats");
    chrome.tabs.get = normalTabGet;

    // An A→B→A visit is a new generation, not permission for the first A's
    // asynchronous resolver to overwrite the latest visit.
    const normalFetch = ctx.fetch;
    let firstEntered, secondEntered, releaseFirst, releaseSecond, aCount = 0;
    const firstStarted = new Promise(r => { firstEntered = r; });
    const secondStarted = new Promise(r => { secondEntered = r; });
    const firstHold = new Promise(r => { releaseFirst = r; });
    const secondHold = new Promise(r => { releaseSecond = r; });
    ctx.fetch = async (url, opts = {}) => {
      if (!url.endsWith("/resolve")) return normalFetch(url, opts);
      const page = JSON.parse(opts.body).url;
      let title = "new B";
      if (page.includes("AAAAAAAAAAA")) {
        if (++aCount === 1) { firstEntered(); await firstHold; title = "old A"; }
        else { secondEntered(); await secondHold; title = "new A"; }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, title, options: [{ key: "q", label: title, quality: "720p", videoUrl: "https://synthetic.example/video", ext: "mp4" }] }) };
    };
    tabUrl = A; const oldA = ctx.resolveYoutube(73, A); await firstStarted;
    tabUrl = B; await listeners.upd(73, { url: B }, { id: 73, url: B }); await tick();
    tabUrl = A; await listeners.upd(73, { url: A }, { id: 73, url: A }); await secondStarted;
    releaseFirst(); await oldA; await tick();
    assert.notStrictEqual(session.yt_73?.resolved?.title, "old A", "an old A result cannot overwrite a later A visit");
    releaseSecond(); await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(session.yt_73?.resolved?.title, "new A");
    ctx.fetch = normalFetch;
    tabUrl = previousTab;
    console.log("navigation generations: stale results and late writes are rejected");
  }
  // Popup actions are bound to the visible page AND player generation. A
  // same-URL player replacement must invalidate old rows before a click.
  {
    const previousTab = tabUrl;
    tabUrl = "https://www.youtube.com/watch?v=CCCCCCCCCCC";
    const top = { id: chrome.runtime.id, frameId: 0, tab: { id: 74, url: tabUrl } };
    const popup = { id: chrome.runtime.id, url: chrome.runtime.getURL("popup.html") };
    const request = (message, sender) => new Promise(resolve => listeners.msg(message, sender, resolve));
    topClientToken = "synthetic-document:1";
    await request({ type: "swiftget-media-request", clientToken: "synthetic-document:1" }, top);
    await new Promise(r => setTimeout(r, 100));
    const snapshot = await request({ type: "swiftget-get-media", tabId: 74, snapshot: true }, popup);
    assert.strictEqual(snapshot.tabId, 74);
    assert.strictEqual(snapshot.clientToken, "synthetic-document:1");
    assert(snapshot.items.some(i => i.yt), "the current video yields popup formats");
    const oldItem = snapshot.items.find(i => i.yt);
    topClientToken = "synthetic-document:2";
    const before = sent.length;
    const early = await request({ type: "swiftget-download", tabId: 74, clientToken: snapshot.clientToken, selectionVersion: snapshot.selectionVersion, referrer: tabUrl, item: oldItem }, popup);
    assert.strictEqual(early.ok, false, "the live player token blocks stale clicks even before the background sees the change");
    listeners.msg({ type: "swiftget-player-changed", clientToken: "synthetic-document:2" }, top, () => {});
    const stale = await request({ type: "swiftget-download", tabId: 74, clientToken: snapshot.clientToken, selectionVersion: snapshot.selectionVersion, referrer: tabUrl, item: oldItem }, popup);
    assert.strictEqual(stale.ok, false, "a same-URL player replacement invalidates an old popup row");
    assert.strictEqual(sent.length, before, "a rejected stale row never reaches the app");
    const stalePlaylist = await request({ type: "swiftget-playlist", tabId: 74, clientToken: snapshot.clientToken, selectionVersion: snapshot.selectionVersion, url: tabUrl }, popup);
    assert.strictEqual(stalePlaylist.ok, false, "a stale popup playlist action is rejected too");
    listeners.msg({ type: "swiftget-player-changed", clientToken: "synthetic-document:1" }, top, () => {});
    await new Promise(r => setTimeout(r, 100));
    const newer = await request({ type: "swiftget-get-media", tabId: 74, snapshot: true }, popup);
    assert.strictEqual(newer.clientToken, "synthetic-document:2", "a delayed earlier token cannot roll generation backward");
    // A late message from a different (replaced) document is rejected by the
    // live frame-0 handshake, even when both documents have the same URL.
    topClientToken = "synthetic-document:2";
    listeners.msg({ type: "swiftget-player-changed", clientToken: "old-document:99" }, top, () => {});
    await tick();
    assert.strictEqual((await request({ type: "swiftget-get-media", tabId: 74, snapshot: true }, popup)).clientToken, "synthetic-document:2", "a replaced document cannot regain the active generation");
    const live = await request({ type: "swiftget-download", tabId: 74, clientToken: newer.clientToken, selectionVersion: newer.selectionVersion, referrer: tabUrl, item: newer.items.find(i => i.yt) }, popup);
    assert.strictEqual(live.ok, true, "a current popup format still downloads");
    listeners.msg({ type: "swiftget-player-changed", clientToken: "synthetic-document:3" }, { ...top, id: "different-extension" }, () => {});
    await tick();
    assert.strictEqual((await request({ type: "swiftget-get-media", tabId: 74, snapshot: true }, popup)).clientToken, "synthetic-document:2", "another extension cannot change this tab's player generation");
    // A worker restart loses the in-memory token, so the popup asks the
    // trusted top frame and reconstructs the current generation.
    vm.runInContext("tabClientTokens.delete(74)", ctx);
    topClientToken = "synthetic-document:2";
    const recovered = await request({ type: "swiftget-get-media", tabId: 74, snapshot: true }, popup);
    assert.strictEqual(recovered.clientToken, topClientToken, "popup re-establishes its token after a worker restart");
    topClientToken = null;

    // A generic direct video can be observed before document_idle registers
    // the content script. Keep only this worker's newly observed resources,
    // not unmarked prior-session media from the very same URL.
    const generic = "https://ordinary.example/direct-video";
    tabUrl = generic;
    const genericTop = { id: chrome.runtime.id, frameId: 0, tab: { id: 78, url: generic } };
    session.media_78 = [{ url: "https://synthetic.example/stale.mp4", type: "video/mp4" }];
    session.mediaOwner_78 = generic;
    await ctx.addMedia(78, { url: "https://synthetic.example/fresh.mp4", type: "video/mp4" }, generic, 0);
    await listeners.upd(78, { url: generic }, { id: 78, url: generic });
    topClientToken = "generic-document:0";
    await request({ type: "swiftget-media-request", clientToken: topClientToken }, genericTop);
    const genericSnapshot = await request({ type: "swiftget-get-media", tabId: 78, snapshot: true }, popup);
    assert(genericSnapshot.items.some(i => i.url === "https://synthetic.example/fresh.mp4"), "fresh pre-handshake direct media remains available");
    assert(!genericSnapshot.items.some(i => i.url === "https://synthetic.example/stale.mp4"), "unmarked persisted media is not trusted after a worker restart");
    const refreshBefore = tabMsgs.filter(m => m.type === "swiftget-refresh-current-player").length;
    tabUrl = "https://ordinary.example/direct-video-next";
    await listeners.upd(78, { url: tabUrl }, { id: 78, url: tabUrl });
    assert.strictEqual(tabMsgs.filter(m => m.type === "swiftget-refresh-current-player").length, refreshBefore + 1, "generic SPA navigation re-announces the live player even if browser metadata lagged");

    const many = "https://ordinary.example/many";
    tabUrl = many;
    for (let i = 0; i < 25; i++) await ctx.addMedia(81, { url: `https://synthetic.example/${i}.mp4`, type: "video/mp4" }, many, 0);
    assert.strictEqual(vm.runInContext("freshMedia.get(81).urls.size", ctx), 15, "pre-handshake tracking remains bounded to the media ring size");
    assert.strictEqual(session.media_81.length, 15);
    topClientToken = "many-document:0";
    await request({ type: "swiftget-media-request", clientToken: topClientToken }, { id: chrome.runtime.id, frameId: 0, tab: { id: 81, url: many } });
    assert.strictEqual(session.media_81.length, 15, "bounded fresh media remains available after handshake");
    assert.strictEqual(session.media_81[0].url, "https://synthetic.example/10.mp4");
    tabUrl = generic;

    // The generic current player is re-announced once after a reset, allowing
    // an already open page to resolve again when its worker has restarted.
    const priorSend = chrome.tabs.sendMessage;
    let refreshes = 0;
    chrome.tabs.sendMessage = async (id, message, options) => {
      if (id === 79 && message.type === "swiftget-refresh-current-player") {
        refreshes++;
        listeners.msg({ type: "swiftget-video-seen", page: generic, frame: false, clientToken: topClientToken }, { id: chrome.runtime.id, frameId: 0, tab: { id, url: generic } }, () => {});
        return;
      }
      return priorSend(id, message, options);
    };
    session.res_79 = { page: generic, ownerPage: generic, resolved: { title: "stale", options: [{ label: "old", videoUrl: "https://synthetic.example/old" }] } };
    topClientToken = "restarted-document:0";
    await request({ type: "swiftget-get-media", tabId: 79, snapshot: true }, popup);
    await new Promise(r => setTimeout(r, 120));
    const refreshed = await request({ type: "swiftget-get-media", tabId: 79, snapshot: true }, popup);
    assert.strictEqual(refreshes, 1, "generic reset requests exactly one current-player re-announcement");
    assert(refreshed.items.some(i => i.yt?.title === "Real: Title"), "generic player is resolved again after worker restart");
    assert(!refreshed.items.some(i => i.label === "old"), "ambiguous old same-URL cache is not displayed");
    chrome.tabs.sendMessage = priorSend;
    topClientToken = null;

    // A frame can navigate or reuse its player without changing the top URL.
    // Challenge the live frame before presenting or dispatching its formats.
    const parentPage = "https://ordinary.example/embedded";
    tabUrl = parentPage;
    const frame = { id: chrome.runtime.id, frameId: 5, tab: { id: 82, url: parentPage } };
    const firstFrame = "frame-document:1", nextFrame = "frame-document:2";
    frameTokens.set("82:5", firstFrame);
    listeners.msg({ type: "swiftget-video-seen", page: "https://video.example/frame-one", frame: true, frameToken: firstFrame }, frame, () => {});
    await new Promise(r => setTimeout(r, 120));
    assert.strictEqual(session.res_82?.frameToken, firstFrame, "current embedded frame is resolved with its provenance");
    assert((await ctx.itemsForTab(82)).some(i => i.frameToken === firstFrame), "live embedded formats remain available");
    frameTokens.set("82:5", nextFrame);
    assert(!(await ctx.itemsForTab(82)).some(i => i.frameToken === firstFrame || i.yt), "old embedded formats disappear before an old frame can be chosen");
    const beforeStaleFrame = ytCalls.length;
    listeners.msg({ type: "swiftget-video-seen", page: "https://video.example/frame-one", frame: true, frameToken: firstFrame }, frame, () => {});
    await tick();
    assert.strictEqual(ytCalls.length, beforeStaleFrame, "a delayed old-frame announcement cannot start a resolution");
    const oldFrameAction = await request({ type: "swiftget-download", frameToken: firstFrame, item: { url: "https://synthetic.example/old.mp4" } }, frame);
    assert.strictEqual(oldFrameAction.ok, false, "old frame cannot dispatch a stale download");
    listeners.msg({ type: "swiftget-video-seen", page: "https://video.example/frame-two", frame: true, frameToken: nextFrame }, frame, () => {});
    await new Promise(r => setTimeout(r, 120));
    assert.strictEqual(session.res_82?.frameToken, nextFrame);
    assert((await ctx.itemsForTab(82)).some(i => i.frameToken === nextFrame), "replacement frame formats become available");
    const newFrameAction = await request({ type: "swiftget-download", frameToken: nextFrame, item: { url: "https://synthetic.example/new.mp4" } }, frame);
    assert.strictEqual(newFrameAction.ok, true, "a current embedded frame can still download");
    frameTokens.delete("82:5");
    tabUrl = previousTab;
    // Passive preloaded frames must not replace a playing frame, while a
    // later actual play selects another frame and invalidates popup actions.
    const pick = (id, page, at, active, playing) => ctx.selectFrame(85, id, `selection-frame:${id}`, page, at, active, playing);
    const paused = pick(1, "https://video.example/one", 0, false, false);
    const playing = pick(2, "https://video.example/two", 0, false, true);
    assert(playing && playing.version > paused.version, "initial playing frame replaces a passive paused frame");
    assert.strictEqual(pick(1, "https://video.example/one", 0, false, false), null, "passive preload cannot displace the playing frame");
    assert.strictEqual(pick(2, "https://video.example/two", 0, false, true).version, playing.version, "repeated observations do not invalidate the selection");
    const chosen = pick(1, "https://video.example/one", 100, true, false);
    assert(chosen && chosen.version > playing.version, "a real play event selects another frame");
    assert.strictEqual(pick(2, "https://video.example/two", 0, false, true), null, "initial playing observations cannot displace an explicit selection");
    assert.strictEqual(pick(2, "https://video.example/two", 50, true, false), null, "delayed older play cannot undo a newer selection");
    console.log("popup actions: old video generations cannot be downloaded");
  }
  console.log("background simulation: all checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
