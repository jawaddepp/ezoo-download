// Behavior tests for the content-script widget, using a small DOM test double.
// No browser profile, cookies, network traffic, or third-party packages.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function fixture({ url = 'https://example.test/watch', items = formats(), appRunning = true, topFrame = true, topFullscreen = false, topAvailable = true, deferFullscreen = false, deferResolve = false, initialSource = 'https://cdn.example.test/clip.mp4', initialLink = '' } = {}) {
  const events = new Map(), intervals = new Map(), timeouts = [], frames = [], messages = [], storageListeners = [], runtimeListeners = [];
  const pendingFullscreen = [];
  const pendingResolves = [];
  let reportedTopFullscreen = topFullscreen, reportedTopAvailable = topAvailable;
  let document;
  const addGlobal = (type, fn) => { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn); };
  const emitGlobal = (type, e = {}) => { for (const fn of [...(events.get(type) || [])]) fn(event(e)); };
  function event(data) { return { button: 0, detail: 1, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, composedPath() { return []; }, ...data }; }
  function matches(node, selector) {
    const enabled = selector.includes(':not(:disabled)');
    selector = selector.replace(':not(:disabled)', '');
    if (enabled && node.disabled) return false;
    if (selector === '*') return true;
    if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    if (selector === 'a[href]') return node.tagName === 'A' && !!node.href;
    return node.tagName.toLowerCase() === selector.toLowerCase();
  }
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.parentNode = null;
      this.style = { setProperty(k, v) { this[k] = v; } }; this.hidden = false; this.disabled = false; this.scrollTop = 0;
      this.listeners = new Map(); this._text = ''; this.tabIndex = -1;
      this.classList = {
        contains: (c) => (this.attributes.class || '').split(/\s+/).includes(c),
        add: (c) => { if (!this.classList.contains(c)) this.attributes.class = ((this.attributes.class || '') + ' ' + c).trim(); },
        remove: (c) => { this.attributes.class = (this.attributes.class || '').split(/\s+/).filter(x => x !== c).join(' '); },
        toggle: (c, v) => { const want = v === undefined ? !this.classList.contains(c) : v; want ? this.classList.add(c) : this.classList.remove(c); return want; },
      };
    }
    get id() { return this.attributes.id; }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    set textContent(v) { this._text = String(v); this.replaceChildren(); }
    get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
    get isConnected() { return this === document.documentElement || !!this.parentNode?.isConnected; }
    get scrollHeight() { return 320; }
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    appendChild(node) { node.remove(); this.children.push(node); node.parentNode = this; return node; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; }
    replaceChildren(...nodes) { for (const n of this.children) n.parentNode = null; this.children = []; this.append(...nodes); }
    contains(node) { return node === this || this.children.some(c => c.contains(node)); }
    querySelectorAll(selector) {
      const selectors = selector.split(',').map(x => x.trim()); const found = [];
      const walk = (node) => { for (const child of node.children) { if (selectors.some(s => matches(child, s))) found.push(child); walk(child); } };
      walk(this); return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getElementById(id) { return this.querySelector('#' + id); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    emit(type, data = {}) { const e = event({ target: this, ...data }); for (const f of this.listeners.get(type) || []) f(e); return e; }
    click() { if (!this.disabled) this.emit('click'); }
    focus() {
      let node = this; while (node && !node.host) node = node.parentNode;
      if (node) { node.activeElement = this; document.activeElement = node.host; }
    }
    attachShadow() { const root = new Element('shadowroot'); root.host = this; this._shadow = root; return root; }
    closest() { return null; }
    getBoundingClientRect() {
      if (this.tagName === 'VIDEO') return this.rect || { left: 100, top: 80, right: 740, bottom: 440, width: 640, height: 360 };
      let node = this; while (node.parentNode) node = node.parentNode;
      const host = node.host || this; const z = Number(host.style['--z']) || 1;
      const left = parseFloat(host.style.left) || 500, top = parseFloat(host.style.top) || 88;
      const width = this.classList.contains('list') ? Math.min(340, parseFloat(this.style.maxWidth) || 340) * z : 42 * z;
      const height = this.classList.contains('list') ? Math.min(320, parseFloat(this.style.maxHeight) || 320) * z : 42 * z;
      return { left, top, right: left + width, bottom: top + height, width, height };
    }
  }
  document = new Element('document'); document.documentElement = new Element('html'); document.documentElement.parentNode = document;
  document.title = 'A safe <video> title'; document.fullscreenElement = null;
  document.createElement = tag => new Element(tag); document.createElementNS = (_, tag) => new Element(tag);
  document.querySelectorAll = selector => document.documentElement.querySelectorAll(selector);
  const video = new Element('video'); Object.assign(video, { duration: 60, paused: false, ended: false, currentSrc: initialSource, src: '', tabIndex: 0 }); document.documentElement.appendChild(video);
  let videoLink;
  if (initialLink) { videoLink = new Element('a'); videoLink.href = initialLink; video.appendChild(videoLink); }
  const chrome = {
    storage: { local: { get(defaults, cb) { cb(defaults); } }, onChanged: { addListener(fn) { storageListeners.push(fn); } } },
    runtime: {
      id: 'synthetic-extension',
      lastError: null,
      onMessage: { addListener(fn) { runtimeListeners.push(fn); } },
      sendMessage(message, cb) {
        messages.push(message);
        if (message.type === 'swiftget-resolve-video' && deferResolve) {
          pendingResolves.push(cb); return Promise.resolve();
        }
        if (message.type === 'swiftget-query-top-fullscreen') {
          const answer = reportedTopAvailable ? { fullscreen: reportedTopFullscreen } : {};
          if (deferFullscreen) pendingFullscreen.push(() => cb?.(answer));
          else cb?.(answer);
          return Promise.resolve(answer);
        }
        const response = message.type === 'swiftget-config' ? { enabled: true, skipSites: [] }
          : message.type === 'swiftget-media-request' ? items
          : message.type === 'swiftget-resolve-video' ? { items }
          : { ok: appRunning };
        cb?.(response); return Promise.resolve(response);
      },
    },
  };
  const ctx = { document, chrome, location: new URL(url), innerWidth: 1000, innerHeight: 720, URL, console,
    addEventListener: addGlobal, removeEventListener(type, fn) { events.get(type)?.delete(fn); },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; },
    setTimeout(fn) { timeouts.push(fn); return timeouts.length; }, clearTimeout() {},
    setInterval(fn, ms) { if (!intervals.has(ms)) intervals.set(ms, []); intervals.get(ms).push(fn); return fn; },
    clearInterval(fn) { for (const [ms, list] of intervals) intervals.set(ms, list.filter(f => f !== fn)); },
    getSelection() { return null; },
  };
  ctx.window = ctx; ctx.top = topFrame ? ctx : {};
  vm.runInNewContext(source, ctx, { filename: 'content.js' });
  const hosts = () => document.documentElement.children.filter(x => x._shadow);
  const root = () => hosts()[0]?._shadow;
  return { ctx, video, videoLink, document, messages, events, root, hosts,
    send(message, sender = {}, reply = () => {}) {
      if (message.type === 'swiftget-media' && !Object.hasOwn(message, 'clientToken')) {
        const last = [...messages].reverse().find(m => m.clientToken);
        message = { ...message, clientToken: last?.clientToken };
      }
      for (const fn of runtimeListeners) fn(message, sender, reply);
    },
    resolveVideo(index, result) { pendingResolves[index]?.(result); },
    pendingVideos() { return pendingResolves.length; },
    setTopFullscreen(value) { reportedTopFullscreen = value; },
    setTopAvailable(value) { reportedTopAvailable = value; },
    resolveFullscreen(index) { pendingFullscreen[index](); },
    pendingFullscreen() { return pendingFullscreen.length; },
    change(change) { for (const fn of storageListeners) fn(change, 'local'); },
    tick(ms) { for (const fn of intervals.get(ms) || []) fn(); },
    flush() { while (timeouts.length) timeouts.shift()(); },
    global(type, data) { emitGlobal(type, data); for (const frame of frames.splice(0)) frame(); },
    globalWithoutFrame: emitGlobal,
    flushFrame() { for (const frame of frames.splice(0)) frame(); },
    pendingFrames() { return frames.length; },
  };
}
function formats() {
  return [
    { label: '1080p Full HD · MP4', ext: 'mp4', yt: { key: '1080p|MP4', quality: '1080p', ext: 'mp4', tag: 'Full HD', codec: 'AV1', size: 30000000, duration: 60, title: 'A safe <video> title' } },
    { label: 'Audio · M4A', ext: 'm4a', yt: { key: 'audio|M4A', quality: 'audio', ext: 'm4a', size: 4000000, duration: 60 } },
    { label: 'Unavailable format', sub: 'Not available', disabled: true },
  ];
}

{
  const f = fixture(); const root = f.root(); const trigger = root.getElementById('grab'); const box = root.getElementById('list');
  assert.equal(trigger.tagName, 'BUTTON'); assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(root.getElementById('list-content').children.length, 0, 'closed widget does not build hidden format rows');
  trigger.emit('click', { detail: 0 });
  assert.equal(trigger.getAttribute('aria-expanded'), 'true'); assert.equal(box.getAttribute('role'), 'dialog');
  assert.deepEqual(root.querySelectorAll('h3').map(n => n.textContent), ['Video', 'Audio']);
  assert(root.querySelectorAll('.item').every(n => n.tagName === 'BUTTON'));
  assert.equal(root.querySelectorAll('.item').filter(n => n.disabled).length, 1);
  assert.equal(root.activeElement.getAttribute('data-choice'), '1080p|MP4');
  root.emit('keydown', { key: 'ArrowDown' }); assert.equal(root.activeElement.getAttribute('data-choice'), 'audio|M4A');
  const updated = [{ label: '4K · WEBM', ext: 'webm', yt: { key: '2160p|WEBM', quality: '2160p', ext: 'webm' } }, ...formats()];
  f.send({ type: 'swiftget-media', items: updated });
  assert.equal(root.activeElement.getAttribute('data-choice'), 'audio|M4A', 'async updates preserve the focused format');
  root.emit('keydown', { key: 'Home' }); assert.equal(root.activeElement.getAttribute('data-choice'), '2160p|WEBM');
  root.emit('keydown', { key: 'End' }); assert.equal(root.activeElement.getAttribute('data-choice'), 'audio|M4A');
  root.emit('keydown', { key: 'Escape' }); assert.equal(trigger.getAttribute('aria-expanded'), 'false'); assert.equal(root.activeElement, trigger);
  trigger.emit('click', { detail: 0 }); root.querySelectorAll('.item:not(:disabled)')[0].click();
  const sent = f.messages.find(m => m.type === 'swiftget-download'); assert.equal(sent.item.yt.key, '2160p|WEBM');
  assert.equal(sent.referrer, f.ctx.location.href); assert.equal(sent.title, f.document.title);
  assert(root.getElementById('list').textContent.includes('Sent to Mac Downloader.'));
  assert.equal(root.querySelectorAll('img').length, 0, 'page titles are plain text, not markup');
}
{
  const f = fixture(); const root = f.root(), trigger = root.getElementById('grab');
  trigger.emit('mousedown', { clientX: 600, clientY: 100 });
  f.global('mousemove', { clientX: 450, clientY: 180 }); f.global('mouseup'); trigger.emit('click', { detail: 1 });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'a drag does not also open the format picker');
  f.flush(); trigger.emit('click', { detail: 1 }); assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  root.getElementById('close').click(); assert.equal(f.hosts().length, 0);
  f.send({ type: 'swiftget-open-panel' }); assert.equal(f.hosts().length, 1, 'context menu can restore a hidden widget');
  assert.equal(f.events.get('mousemove').size, 1);
  f.video.remove(); f.tick(700);
  assert.equal(f.hosts().length, 0); assert.equal(f.events.get('mousemove').size, 0); assert.equal(f.events.get('mouseup').size, 0);
}
{
  const f = fixture(); const host = f.hosts()[0], root = f.root(), trigger = root.getElementById('grab');
  assert.equal(host.style.left, '690px', 'the default button is aligned above the player');
  assert(Number.parseFloat(host.style.top) + 42 <= 80, 'button stays outside the video');
  trigger.emit('mousedown', { clientX: 700, clientY: 40 });
  f.global('mousemove', { clientX: 400, clientY: 200 }); f.global('mouseup');
  assert.equal(host.style.top, '30px', 'dragging remains in the outside lane above the player');
  assert(Number.parseFloat(host.style.left) >= 104 && Number.parseFloat(host.style.left) + 42 <= 736);
  f.video.rect = { left: 100, top: -150, right: 740, bottom: 210, width: 640, height: 360 };
  f.global('scroll');
  assert.equal(host.style.display, 'block', 'a visible player keeps its control after the original anchor scrolls away');
  assert.equal(host.style.top, '72px', 'a scrolled control remains below the reserved navigation area');
  const header = { getBoundingClientRect: () => ({ top: 0, bottom: 100 }) };
  f.document.elementsFromPoint = () => [{ closest: () => header }];
  f.global('scroll'); assert.equal(host.style.top, '108px', 'a taller page header is kept clear');
  delete f.document.elementsFromPoint;
  f.video.rect = { left: 100, top: -310, right: 740, bottom: 50, width: 640, height: 360 };
  f.global('scroll'); assert.equal(host.style.display, 'block', 'a narrow but sufficient visible player area remains usable');
  f.video.rect = { left: 100, top: -325, right: 740, bottom: 35, width: 640, height: 360 };
  f.global('scroll'); assert.equal(host.style.display, 'none', 'the control hides when no safe player area remains');
  f.video.rect = { left: 100, top: 80, right: 740, bottom: 440, width: 640, height: 360 };
  f.global('scroll'); assert.equal(host.style.display, 'block');
}
{
  const f = fixture(), host = f.hosts()[0];
  f.video.rect = { left: 0, top: 80, right: 1000, bottom: 640, width: 1000, height: 560 };
  f.document.fullscreenElement = f.document.documentElement;
  f.global('resize'); assert.equal(host.style.display, 'none', 'fullscreen player containers hide the control');
  f.document.fullscreenElement = f.video;
  f.global('resize'); assert.equal(host.style.display, 'none', 'fullscreen video elements hide the control');
  f.document.fullscreenElement = null; f.video.webkitDisplayingFullscreen = true;
  f.global('resize'); assert.equal(host.style.display, 'none', 'native WebKit video fullscreen hides the control');
  f.video.webkitDisplayingFullscreen = false;
  f.document.fullscreenElement = null; f.global('resize'); assert.equal(host.style.display, 'block', 'exiting fullscreen restores the control');
  f.ctx.innerWidth = 32;
  f.global('resize'); assert.equal(host.style.display, 'none', 'very tiny viewports do not expose an offscreen control');
}
{
  const f = fixture({ topFrame: false, topFullscreen: true });
  f.send({ type: 'swiftget-open-panel' });
  const host = f.hosts()[0];
  assert(host, 'embedded player has its own widget');
  assert.equal(host.style.display, 'none', 'a child initialized during parent fullscreen stays hidden');
  f.setTopFullscreen(false);
  f.send({ type: 'swiftget-refresh-top-fullscreen' }, { id: 'synthetic-extension' });
  assert.equal(host.style.display, 'block', 'parent fullscreen exit restores the child widget');
  const before = f.messages.filter((m) => m.type === 'swiftget-query-top-fullscreen').length;
  f.setTopFullscreen(true);
  f.send({ type: 'swiftget-refresh-top-fullscreen' }, { id: 'foreign-extension' });
  f.send({ type: 'swiftget-refresh-top-fullscreen' }, { id: 'synthetic-extension', tab: { id: 7 } });
  assert.equal(f.messages.filter((m) => m.type === 'swiftget-query-top-fullscreen').length, before, 'untrusted or content-script signals are ignored');
  assert.equal(host.style.display, 'block');
  f.send({ type: 'swiftget-refresh-top-fullscreen' }, { id: 'synthetic-extension' });
  assert.equal(host.style.display, 'none', 'a trusted parent fullscreen signal hides the child');
}
{
  const f = fixture({ topFrame: false, topFullscreen: false, deferFullscreen: true });
  f.send({ type: 'swiftget-open-panel' }); const host = f.hosts()[0];
  assert.equal(f.pendingFullscreen(), 1, 'a new child requests initial top-frame state');
  assert.equal(host.style.display, 'none', 'the child does not flash before the initial query returns');
  f.setTopFullscreen(true);
  f.send({ type: 'swiftget-refresh-top-fullscreen' }, { id: 'synthetic-extension' });
  assert.equal(f.pendingFullscreen(), 2);
  f.resolveFullscreen(1);
  assert.equal(host.style.display, 'none');
  f.resolveFullscreen(0);
  assert.equal(host.style.display, 'none', 'an older async query cannot undo a newer fullscreen result');
  const nextPage = fixture({ topFrame: false, topFullscreen: false });
  nextPage.send({ type: 'swiftget-open-panel' });
  assert.equal(nextPage.hosts()[0].style.display, 'block', 'a new page uses fresh top-frame state');
}
{
  const f = fixture({ topFrame: false, topFullscreen: true, topAvailable: false });
  f.send({ type: 'swiftget-open-panel' }); const host = f.hosts()[0];
  assert.equal(host.style.display, 'none', 'an early child waits rather than flashing when its top script is not ready');
  f.setTopAvailable(true);
  f.send({ type: 'swiftget-refresh-top-fullscreen' }, { id: 'synthetic-extension' });
  f.flush();
  assert.equal(host.style.display, 'none', 'top startup state wins over the older unavailable-query fallback');
  f.setTopFullscreen(false);
  f.send({ type: 'swiftget-refresh-top-fullscreen' }, { id: 'synthetic-extension' });
  assert.equal(host.style.display, 'block', 'the child returns after the parent exits fullscreen');
  const unavailable = fixture({ topFrame: false, topAvailable: false });
  unavailable.send({ type: 'swiftget-open-panel' });
  assert.equal(unavailable.hosts()[0].style.display, 'none');
  unavailable.flush();
  assert.equal(unavailable.hosts()[0].style.display, 'none', 'unknown top-frame state fails closed after bounded retries');
  assert.equal(unavailable.messages.filter((m) => m.type === 'swiftget-query-top-fullscreen').length, 3, 'unavailable state does not create recurring polling');
  unavailable.setTopAvailable(true);
  unavailable.send({ type: 'swiftget-open-panel' }, { id: 'foreign-extension' });
  assert.equal(unavailable.hosts()[0].style.display, 'none', 'an untrusted open cannot trigger recovery');
  unavailable.send({ type: 'swiftget-open-panel' }, { id: 'synthetic-extension' });
  assert.equal(unavailable.hosts()[0].style.display, 'block', 'explicit authenticated open recovers after worker availability returns');
  unavailable.setTopFullscreen(true);
  unavailable.send({ type: 'swiftget-refresh-top-fullscreen' }, { id: 'synthetic-extension' });
  unavailable.send({ type: 'swiftget-open-panel' }, { id: 'synthetic-extension' });
  assert.equal(unavailable.hosts()[0].style.display, 'none', 'explicit open cannot reveal a fullscreen embedded player');
}
{
  const f = fixture(); let result;
  assert(f.messages.some((m) => m.type === 'swiftget-top-fullscreen-changed'), 'a new top frame announces its current state to early children');
  f.document.fullscreenElement = f.document.documentElement;
  f.send({ type: 'swiftget-read-top-fullscreen' }, { id: 'synthetic-extension' }, (r) => { result = r; });
  assert.equal(result.fullscreen, true, 'background can query the top frame');
  result = undefined;
  f.send({ type: 'swiftget-read-top-fullscreen' }, { id: 'foreign-extension' }, (r) => { result = r; });
  assert.equal(result, undefined, 'foreign top-frame state queries are ignored');
  f.document.emit('fullscreenchange');
  assert(f.messages.some((m) => m.type === 'swiftget-top-fullscreen-changed'), 'the top frame notifies the worker on transitions');
}
{
  const f = fixture(), host = f.hosts()[0];
  let hitTests = 0;
  f.document.elementsFromPoint = () => { hitTests++; return []; };
  for (let i = 0; i < 20; i++) {
    f.video.rect = { left: 100, top: 181 + i, right: 640, bottom: 541 + i, width: 540, height: 360 };
    f.globalWithoutFrame(i % 2 ? 'resize' : 'scroll');
  }
  assert.equal(f.pendingFrames(), 1, 'a burst schedules only one placement frame');
  assert.equal(hitTests, 0, 'scroll events do not synchronously repeat hit testing');
  f.flushFrame();
  assert(hitTests > 0 && hitTests <= 8, 'one frame performs one bounded placement pass');
  assert.equal(host.style.top, '150px', 'the frame uses the most recent player geometry');
  assert.equal(host.style.left, '590px');
  assert.equal(f.pendingFrames(), 0);

  f.globalWithoutFrame('scroll');
  f.document.fullscreenElement = f.document.documentElement;
  f.document.emit('fullscreenchange');
  assert.equal(host.style.display, 'none', 'fullscreen hides immediately even with a frame pending');
  f.flushFrame();
  assert.equal(host.style.display, 'none', 'the pending frame cannot reveal a fullscreen widget');
  f.document.fullscreenElement = null;
  f.document.emit('fullscreenchange');
  assert.equal(host.style.display, 'block', 'the widget returns immediately on fullscreen exit');
}
{
  const f = fixture(), host = f.hosts()[0];
  const header = { getBoundingClientRect: () => ({ left: 0, right: 1000, top: 0, bottom: 100 }) };
  const aside = { getBoundingClientRect: () => ({ left: 740, right: 1000, top: 100, bottom: 720 }) };
  let queries = 0;
  f.document.elementsFromPoint = (_x, y) => y < 100 ? [{ closest: () => header }] : [];
  f.video.rect = { left: 100, top: 60, right: 740, bottom: 420, width: 640, height: 360 };
  f.global('scroll');
  assert.equal(host.style.left, '748px', 'a clear right gutter is used when the header blocks the space above');
  assert(Number.parseFloat(host.style.top) >= 108, 'a side fallback stays below a fixed header');
  f.document.elementsFromPoint = (x, y) => {
    queries++;
    const target = y < 100 ? header : x >= 740 ? aside : null;
    return target ? [{ closest: () => target }] : [];
  };
  f.global('scroll');
  assert.equal(host.style.left, '50px', 'an occupied right sidebar is avoided in favor of a clear left gutter');
  assert(Number.parseFloat(host.style.top) >= 108, 'an on-screen but header-obscured anchor stays below the header');
  const afterFirst = queries;
  f.tick(700); f.tick(700); f.tick(700);
  assert.equal(queries, afterFirst, 'unchanged placement does not repeat DOM hit tests every interval');
  const leftAside = { getBoundingClientRect: () => ({ left: 0, right: 100, top: 100, bottom: 720 }) };
  f.document.elementsFromPoint = (x, y) => {
    const target = y < 100 ? header : x >= 740 ? aside : x <= 100 ? leftAside : null;
    return target ? [{ closest: () => target }] : [];
  };
  f.global('scroll');
  assert.equal(host.style.display, 'none', 'the widget hides instead of covering a header, sidebars, or video');
}
{
  const f = fixture(), host = f.hosts()[0];
  f.video.rect = { left: -620, top: 80, right: 20, bottom: 440, width: 640, height: 360 };
  f.global('scroll'); assert.equal(host.style.display, 'none', 'a nearly offscreen player does not leave a detached widget');
}
{
  const f = fixture(), host = f.hosts()[0], root = f.root();
  f.ctx.innerWidth = 400;
  f.video.rect = { left: 100, top: 80, right: 300, bottom: 280, width: 200, height: 200 };
  f.global('resize'); root.getElementById('grab').emit('click', { detail: 0 });
  const box = root.getElementById('list');
  const menuLeft = Number.parseFloat(host.style.left) + Number.parseFloat(box.style.left);
  assert(menuLeft >= 4 && menuLeft + 340 <= 396, 'menu stays inside a narrow viewport');
}
{
  const f = fixture(), host = f.hosts()[0], root = f.root();
  f.ctx.innerWidth = 1200;
  f.video.rect = { left: 350, top: 200, right: 850, bottom: 600, width: 500, height: 400 };
  f.global('resize'); root.getElementById('grab').emit('click', { detail: 0 });
  const box = root.getElementById('list');
  const menuLeft = Number.parseFloat(host.style.left) + Number.parseFloat(box.style.left);
  const menuTop = Number.parseFloat(host.style.top) + Number.parseFloat(box.style.top);
  const menuHeight = Number.parseFloat(box.style.maxHeight);
  assert(menuLeft >= 850 || menuLeft + 340 <= 350 || menuTop + menuHeight <= 200 || menuTop >= 600,
    'the menu stays outside the video when an external region fits it');
}
{
  const f = fixture(), root = f.root(), trigger = root.getElementById('grab');
  trigger.emit('click', { detail: 0 });
  const content = root.getElementById('list-content');
  assert(content.children.length > 1, 'the bounded scroll region contains the menu');
  assert(root.getElementById('help') && root.getElementById('close'), 'help and hide actions are available in the menu');
  root.getElementById('help').focus();
  root.getElementById('help').emit('click', { detail: 0 });
  assert(content.textContent.includes('Drag the Download button'), 'help remains available');
  assert.equal(root.activeElement.id, 'help', 'keyboard Help activation preserves focus');
  f.send({ type: 'swiftget-media', items: formats() });
  assert.equal(root.activeElement.id, 'help', 'asynchronous updates preserve Help focus');
  root.getElementById('close').focus(); f.send({ type: 'swiftget-media', items: formats() });
  assert.equal(root.activeElement.id, 'close', 'asynchronous updates preserve Hide focus');
  root.getElementById('close').click(); assert.equal(f.hosts().length, 0);
}
{
  const f = fixture(); f.change({ enabled: { newValue: false } });
  assert.equal(f.hosts().length, 0); assert.equal(f.events.get('mousemove').size, 0, 'disabling releases per-video handlers');
}
{
  const f = fixture({ url: 'https://www.netflix.com/watch/12345' }); const root = f.root();
  assert.equal(root.getElementById('label').textContent, 'Protected video'); root.getElementById('grab').click();
  assert(root.getElementById('list').textContent.includes('Netflix playback is not supported'));
  assert.equal(root.querySelectorAll('.item').length, 0);
  f.send({ type: 'swiftget-open-panel' });
  assert.equal(f.messages.filter(m => /resolve-video|download|playlist/.test(m.type)).length, 0, 'protected playback is not offered as a fragment download');
}
{
  const f = fixture({ url: 'https://www.netflix.com/title/12345' }); f.root().getElementById('grab').click();
  assert(f.root().querySelectorAll('.item').length > 0, 'Netflix public/general pages are not blanket-blocked');
}
{
  const f = fixture({ url: 'https://player.example.test/embed', items: [{ protected: true, disabled: true, type: 'protected', label: 'Protected video', url: null }] });
  f.root().getElementById('grab').click();
  assert.equal(f.root().getElementById('label').textContent, 'Protected video', 'a backend-protected embed also shows the explanation');
  assert.equal(f.root().querySelectorAll('.item').length, 0);
  assert.equal(f.messages.filter(m => /resolve-video|download|playlist/.test(m.type)).length, 0);
}
for (const url of ['https://notnetflix.com/watch/12345', 'https://netflix.com.example.test/watch/12345', 'https://www.netflix.com/watching/12345']) {
  const f = fixture({ url }); f.root().getElementById('grab').click();
  assert(f.root().querySelectorAll('.item').length > 0, 'Netflix guard requires its real hostname and watch path: ' + url);
}
{
  const f = fixture();
  const root = f.root();
  root.getElementById('grab').click();
  const oldRow = root.querySelector('.item');
  const oldToken = f.messages.find(m => m.type === 'swiftget-media-request').clientToken;
  f.ctx.location.href = 'https://example.test/watch?video=next';
  oldRow.click();
  assert(!f.messages.some(m => m.type === 'swiftget-download'), 'a queued old row cannot download after SPA navigation');
  assert.equal(f.hosts().length, 0, 'old page bubbles are removed immediately');
  const reset = [...f.messages].reverse().find(m => m.type === 'swiftget-player-changed');
  assert(reset?.clientToken && reset.clientToken !== oldToken);
  assert(!Object.hasOwn(reset, 'url') && !Object.hasOwn(reset, 'src'), 'freshness reset does not send a media URL');
  f.send({ type: 'swiftget-media', clientToken: oldToken, items: formats() });
  assert.equal(f.hosts().length, 0, 'old-generation broadcasts are ignored');
  f.send({ type: 'swiftget-media', clientToken: reset.clientToken, items: [{ label: 'New video', ext: 'mp4', url: 'https://cdn.example.test/next.mp4' }] });
  assert.equal(f.hosts().length, 1);
  f.root().getElementById('grab').click();
  assert(f.root().querySelector('.item').textContent.includes('New video'));
}
{
  const f = fixture();
  const root = f.root();
  root.getElementById('grab').click();
  const oldRow = root.querySelector('.item');
  const oldToken = f.messages.find(m => m.type === 'swiftget-media-request').clientToken;
  f.video.currentSrc = 'https://cdn.example.test/next.mp4';
  oldRow.click();
  assert(!f.messages.some(m => m.type === 'swiftget-download'), 'source replacement cannot download the previous format');
  const reset = [...f.messages].reverse().find(m => m.type === 'swiftget-player-changed');
  assert(reset && reset.clientToken !== oldToken, 'reused main player gets a new opaque generation');
  f.send({ type: 'swiftget-media', clientToken: oldToken, items: formats() });
  assert.equal(root.getElementById('list').hidden, true);
  f.send({ type: 'swiftget-media', clientToken: reset.clientToken, items: [{ label: 'Replacement video', ext: 'mp4', url: 'https://cdn.example.test/next.mp4' }] });
  root.getElementById('grab').click();
  assert(root.querySelector('.item').textContent.includes('Replacement video'));
}
{
  const f = fixture();
  f.tick(1500);
  f.video.currentSrc = 'https://cdn.example.test/auto-next.mp4';
  f.tick(1500);
  const reset = [...f.messages].reverse().find(m => m.type === 'swiftget-player-changed');
  const seen = [...f.messages].reverse().find(m => m.type === 'swiftget-video-seen');
  assert(reset && seen && seen.clientToken === reset.clientToken, 'same-page generic video observation uses the new generation');
  const count = f.messages.filter(m => m.type === 'swiftget-player-changed').length;
  f.tick(700); f.tick(1500); f.tick(700);
  assert.equal(f.messages.filter(m => m.type === 'swiftget-player-changed').length, count, 'an unchanged source does not reset repeatedly');
}
{
  const f = fixture();
  const root = f.root();
  root.getElementById('grab').click();
  const oldRow = root.querySelector('.item');
  const source = f.video.currentSrc;
  f.video.currentSrc = '';
  oldRow.click();
  assert(!f.messages.some(m => m.type === 'swiftget-download'), 'an empty transitioning source blocks the previous format');
  assert.equal(root.getElementById('list').hidden, true, 'old choices close during the transition');
  assert(!f.messages.some(m => m.type === 'swiftget-player-changed'), 'transient buffering does not create a new generation');
  f.video.currentSrc = source;
  root.getElementById('grab').click();
  root.querySelector('.item').click();
  assert(f.messages.some(m => m.type === 'swiftget-download'), 'the same source remains usable after buffering');
}
{
  const f = fixture({ url: 'https://example.test/feed', initialSource: 'blob:https://example.test/reused', initialLink: 'https://www.youtube.com/watch?v=first' });
  const root = f.root();
  root.getElementById('grab').click();
  const old = root.querySelector('.item');
  f.videoLink.href = 'https://www.youtube.com/watch?v=second';
  old.click();
  assert(!f.messages.some(m => m.type === 'swiftget-download'), 'a changed post link blocks prior formats even with the same source');
  assert(f.messages.some(m => m.type === 'swiftget-player-changed'));
}
{
  const f = fixture({ url: 'https://example.test/feed', initialSource: 'blob:https://example.test/shared', initialLink: 'https://www.youtube.com/watch?v=first' });
  const next = f.document.createElement('video');
  Object.assign(next, { duration: 60, paused: false, ended: false, currentSrc: 'blob:https://example.test/shared', src: '', tabIndex: 0 });
  const link = f.document.createElement('a'); link.href = 'https://www.youtube.com/watch?v=second'; next.appendChild(link);
  f.video.paused = true;
  f.document.documentElement.appendChild(next);
  f.tick(700);
  assert(f.messages.some(m => m.type === 'swiftget-player-changed'), 'different post links advance generation even if media URL is shared');
}
{
  const f = fixture({ topFrame: false, deferResolve: true });
  f.tick(700);
  const root = f.root();
  root.getElementById('grab').click();
  assert.equal(f.pendingVideos(), 1);
  f.video.currentSrc = 'https://cdn.example.test/new-embedded.mp4';
  f.tick(700);
  root.getElementById('grab').click();
  assert.equal(f.pendingVideos(), 2);
  f.resolveVideo(0, { items: [{ label: 'Old embedded video', url: 'https://cdn.example.test/old.mp4', ext: 'mp4' }] });
  assert(!root.textContent.includes('Old embedded video'), 'late prior lookup cannot revive stale formats');
  f.resolveVideo(1, { items: [{ label: 'New embedded video', url: 'https://cdn.example.test/new-embedded.mp4', ext: 'mp4' }] });
  assert(root.textContent.includes('New embedded video'));
}
{
  const f = fixture({ topFrame: false, deferResolve: true });
  f.tick(700); f.tick(1500);
  const first = [...f.messages].reverse().find(m => m.type === 'swiftget-video-seen');
  assert(first?.frameToken, 'embedded frame announces an opaque generation');
  f.root().getElementById('grab').click();
  const oldRequest = [...f.messages].reverse().find(m => m.type === 'swiftget-resolve-video');
  assert.equal(oldRequest.frameToken, first.frameToken);
  f.video.currentSrc = 'https://cdn.example.test/reused-embedded-next.mp4';
  f.tick(700); f.tick(1500);
  const second = [...f.messages].reverse().find(m => m.type === 'swiftget-video-seen');
  assert(second?.frameToken && second.frameToken !== first.frameToken, 'a reused embedded player advances its frame generation');
  let result;
  f.send({ type: 'swiftget-request-frame-generation' }, { id: 'foreign-extension' }, r => { result = r; });
  assert.equal(result, undefined, 'untrusted senders cannot query frame generations');
  f.send({ type: 'swiftget-request-frame-generation' }, { id: 'synthetic-extension' }, r => { result = r; });
  assert.equal(result.frameToken, second.frameToken, 'trusted worker receives the live frame generation');
  f.ctx.location.href = 'https://example.test/new-frame';
  f.send({ type: 'swiftget-request-frame-generation' }, { id: 'synthetic-extension' }, r => { result = r; });
  assert.notEqual(result.frameToken, second.frameToken, 'frame navigation advances its generation immediately');
}
{
  const first = fixture({ topFrame: false, url: 'https://example.test/embed/a' });
  const second = fixture({ topFrame: false, url: 'https://example.test/embed/b' });
  first.tick(700); first.tick(1500); second.tick(700); second.tick(1500);
  const seen = f => f.messages.filter(m => m.type === 'swiftget-video-seen');
  const firstCount = seen(first).length, secondCount = seen(second).length;
  const token = seen(second).at(-1).frameToken;
  second.document.emit('play', { target: second.video, composedPath: () => [second.video] });
  second.flush();
  assert.equal(seen(second).length, secondCount + 1, 'starting a preloaded embedded video reannounces that frame');
  assert.equal(seen(second).at(-1).frameToken, token, 'playback of the same video keeps its generation');
  assert.equal(seen(second).at(-1).activeSelection, true);
  assert(Number.isFinite(seen(second).at(-1).selectedAt));
  assert.equal(seen(first).length, firstCount, 'another embedded frame is not reannounced');
  first.document.emit('play', { target: first.video, composedPath: () => [first.video] });
  first.flush();
  assert.equal(seen(first).length, firstCount + 1, 'switching back to a preloaded frame reannounces it');
  assert.equal(seen(first).at(-1).activeSelection, true);
  const afterPlay = seen(second).length;
  second.video.duration = 2;
  second.document.emit('play', { target: second.video, composedPath: () => [second.video] });
  second.flush();
  assert.equal(seen(second).length, afterPlay, 'a tiny background loop does not steal the active video');
  const top = fixture({ topFrame: true, url: 'https://example.test/feed' });
  top.tick(700); top.tick(1500);
  const topCount = seen(top).length;
  top.document.emit('play', { target: top.video, composedPath: () => [top.video] });
  top.flush();
  assert.equal(seen(top).length, topCount + 1, 'playing the top-frame video reselects it after an embed');
  assert.equal(seen(top).at(-1).activeSelection, true);
  assert(seen(top).at(-1).clientToken && Number.isFinite(seen(top).at(-1).selectedAt));
}
{
  const paused = fixture({ topFrame: false, url: 'https://example.test/embed/a' });
  paused.video.paused = true;
  const playing = fixture({ topFrame: false, url: 'https://example.test/embed/b' });
  paused.tick(700); paused.tick(1500); playing.tick(700); playing.tick(1500);
  const seen = f => f.messages.filter(m => m.type === 'swiftget-video-seen');
  assert(!seen(paused).at(-1).observedPlaying, 'a paused preloaded player remains passive');
  assert.equal(seen(playing).at(-1).observedPlaying, true, 'already-playing embedded video is observed at startup');
  assert(!seen(playing).at(-1).activeSelection, 'initial observation is not mistaken for an actual play event');
  const count = seen(playing).length;
  playing.tick(1500); playing.tick(1500);
  assert.equal(seen(playing).length, count, 'normal polling does not repeatedly announce playback');
  playing.send({ type: 'swiftget-refresh-current-player' }, { id: 'foreign-extension' });
  assert.equal(seen(playing).length, count, 'foreign senders cannot request recovery');
  playing.send({ type: 'swiftget-refresh-current-player' }, { id: 'synthetic-extension' });
  assert.equal(seen(playing).length, count + 1);
  assert.equal(seen(playing).at(-1).observedPlaying, true, 'worker recovery can reannounce an active embed');
  playing.video.muted = true;
  playing.send({ type: 'swiftget-refresh-current-player' }, { id: 'synthetic-extension' });
  assert.equal(seen(playing).at(-1).observedPlaying, true, 'a visible, long muted video is available after recovery');
  playing.video.muted = false; playing.video.duration = 2;
  playing.send({ type: 'swiftget-refresh-current-player' }, { id: 'synthetic-extension' });
  assert(!seen(playing).at(-1).observedPlaying, 'short loops are not treated as a selection');
}
{
  const f = fixture({ topFrame: false, deferResolve: true });
  f.tick(700);
  f.root().getElementById('grab').click();
  f.ctx.location.href = 'https://example.test/next';
  f.global('popstate');
  assert.equal(f.hosts().length, 0);
  f.resolveVideo(0, { items: [{ label: 'Prior page video', url: 'https://cdn.example.test/old.mp4', ext: 'mp4' }] });
  assert.equal(f.hosts().length, 0, 'late callback cannot resurrect a detached prior-page widget');
}
{
  const f = fixture({ url: 'https://www.youtube.com/watch?v=video-a', initialSource: 'blob:https://www.youtube.com/quality-a' });
  const root = f.root();
  root.getElementById('grab').click();
  f.video.currentSrc = 'blob:https://www.youtube.com/quality-b';
  f.tick(700);
  assert(!f.messages.some(m => m.type === 'swiftget-player-changed'), 'YouTube MediaSource quality changes keep the same video generation');
  assert.equal(root.getElementById('list').hidden, false);
  assert(root.querySelectorAll('.item').length > 0);
  const replacement = f.document.createElement('video');
  Object.assign(replacement, { duration: 60, paused: false, ended: false, currentSrc: 'blob:https://www.youtube.com/quality-c', src: '', tabIndex: 0 });
  f.video.paused = true;
  f.document.documentElement.appendChild(replacement);
  f.tick(700);
  assert(!f.messages.some(m => m.type === 'swiftget-player-changed'), 'replacing a YouTube player for the same video does not reset quality choices');
  f.ctx.location.search = '?v=video-a&t=42&list=playlist';
  f.ctx.location.hash = '#t=42';
  f.global('popstate');
  assert.equal(f.hosts().length, 2, 'timestamp and playlist parameters keep existing same-video widgets');
  assert(!f.messages.some(m => m.type === 'swiftget-player-changed'));
  f.ctx.location.search = '?v=video-b&list=playlist';
  root.querySelector('.item').click();
  assert(!f.messages.some(m => m.type === 'swiftget-download'), 'switching YouTube video IDs blocks old actions immediately');
  assert(f.messages.some(m => m.type === 'swiftget-player-changed'));
}
{
  const f = fixture();
  const count = () => f.messages.filter(m => m.type === 'swiftget-media-request').length;
  const initial = count();
  f.send({ type: 'swiftget-media', clientToken: undefined, items: formats() }, { id: 'foreign-extension' });
  assert.equal(count(), initial, 'untrusted untagged messages cannot trigger a handshake');
  f.send({ type: 'swiftget-media', clientToken: undefined, items: formats() }, { id: 'synthetic-extension' });
  f.send({ type: 'swiftget-media', clientToken: undefined, items: formats() }, { id: 'synthetic-extension' });
  assert.equal(count(), initial + 1, 'worker restart triggers one bounded token handshake');
}
console.log('content widget: keyboard, placement, fullscreen and video-generation checks passed');
