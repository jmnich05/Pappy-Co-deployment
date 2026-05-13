/* ============================================================
   Pappy & Co — AI Deployment Hub — shared app logic
   - Tenant resolution (?tenant= / localStorage / hostname map)
   - Content hydration from brands/{slug}/content.json
   - Google Workspace SSO gate (+ demo bypass)
   - Status tracker (localStorage, versioned defaults, namespaced per tenant)
   - Required Reading (Supabase if configured, else local fallback)
   ============================================================ */
(function () {
  'use strict';

  var DEFAULT_TENANT = 'pappy-co';
  var HOSTMAP = { 'ai.pappyco.com': 'pappy-co' };
  var KNOWN_TENANTS = ['pappy-co'];

  /* ---------- tenant resolution (must match the inline <head> bootstrap) ---------- */
  function resolveTenant() {
    var url = new URL(location.href);
    var q = url.searchParams.get('tenant');
    if (q) { try { localStorage.setItem('aop_tenant', q); } catch (e) {} return q; }
    var stored = null;
    try { stored = localStorage.getItem('aop_tenant'); } catch (e) {}
    return stored || HOSTMAP[location.hostname] || DEFAULT_TENANT;
  }
  var SLUG = resolveTenant();
  var DEMO_MODE = new URL(location.href).searchParams.has('demo');

  /* ---------- tiny data-path resolver ---------- */
  function resolve(data, path) {
    if (path == null || path === '' || path === '.') return data;
    return path.split('.').reduce(function (o, k) { return (o == null ? undefined : o[k]); }, data);
  }
  function hasListAncestor(el, root) {
    var p = el.parentElement;
    while (p && p !== root) { if (p.hasAttribute && p.hasAttribute('data-list')) return true; p = p.parentElement; }
    return false;
  }

  /* ---------- hydration ---------- */
  function applyBinds(el, data) {
    if (el.hasAttribute('data-show-if')) {
      var sv = resolve(data, el.getAttribute('data-show-if'));
      var show = Array.isArray(sv) ? sv.length > 0 : !!sv;
      if (!show) el.style.display = 'none';
    }
    if (el.hasAttribute('data-bind')) {
      var bv = resolve(data, el.getAttribute('data-bind'));
      if (bv != null) el.textContent = String(bv);
    }
    if (el.hasAttribute('data-html')) {
      var hv = resolve(data, el.getAttribute('data-html'));
      if (hv != null) el.innerHTML = String(hv);
    }
    if (el.hasAttribute('data-attr')) {
      el.getAttribute('data-attr').split(';').forEach(function (pair) {
        pair = pair.trim(); if (!pair) return;
        var idx = pair.indexOf(':'); if (idx < 0) return;
        var v = resolve(data, pair.slice(idx + 1).trim());
        if (v != null) el.setAttribute(pair.slice(0, idx).trim(), String(v));
      });
    }
  }

  function render(root, data) {
    // 1. lists (outermost-within-root first; nested handled via recursion on clones)
    Array.prototype.filter.call(root.querySelectorAll('[data-list]'), function (el) {
      return el === root || !hasListAncestor(el, root);
    }).forEach(function (listEl) {
      var items = resolve(data, listEl.getAttribute('data-list')) || [];
      var tpl = listEl.querySelector('template');
      if (!tpl) return;
      var emptyEl = listEl.querySelector('[data-list-empty]');
      items.forEach(function (item) {
        var frag = tpl.content.cloneNode(true);
        var scope = (item && typeof item === 'object') ? item : { value: item };
        var kids = Array.prototype.slice.call(frag.children);
        listEl.appendChild(frag);
        kids.forEach(function (child) { render(child, scope); });
      });
      if (emptyEl) emptyEl.style.display = items.length ? 'none' : '';
    });

    // 2. binds — root itself + every descendant that isn't inside a nested list within root
    applyBinds(root, data);
    Array.prototype.forEach.call(root.querySelectorAll('*'), function (el) {
      if (el.tagName === 'TEMPLATE') return;
      if (hasListAncestor(el, root)) return;
      applyBinds(el, data);
    });
  }

  /* ---------- markdown-ish renderer (headings, lists, **bold**, `code`, paragraphs) ---------- */
  function mdToHtml(md) {
    if (!md) return '';
    var esc = function (s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    var lines = String(md).replace(/\r\n/g, '\n').split('\n');
    var out = [], inList = false;
    function closeList() { if (inList) { out.push('</ul>'); inList = false; } }
    lines.forEach(function (raw) {
      var line = raw.trimEnd();
      if (/^###?\s+/.test(line)) { closeList(); out.push('<h3>' + inline(line.replace(/^###?\s+/, '')) + '</h3>'); return; }
      if (/^##\s+/.test(line)) { closeList(); out.push('<h3>' + inline(line.replace(/^##\s+/, '')) + '</h3>'); return; }
      if (/^[-*]\s+/.test(line)) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(line.replace(/^[-*]\s+/, '')) + '</li>'); return; }
      if (line.trim() === '') { closeList(); return; }
      closeList(); out.push('<p>' + inline(line) + '</p>');
    });
    closeList();
    function inline(s) {
      return esc(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    }
    return out.join('\n');
  }

  /* ---------- SSO gate ---------- */
  var CONTENT = null;

  function revealApp(label) {
    var gate = document.getElementById('login-gate');
    if (gate) gate.style.display = 'none';
    document.body.classList.remove('locked');
    try { window.dispatchEvent(new Event('aop:revealed')); } catch (e) {}
    var el = document.getElementById('user-email');
    if (el) el.textContent = label || '—';
  }

  function initAuth(content) {
    var auth = content.auth || {};
    var domain = (auth.allowedDomain || '').trim();
    var clientId = (auth.googleClientId || '').trim();
    var cacheKey = 'aop_user_' + SLUG;

    // Demo brands (no domain) or ?demo=1: skip real auth.
    if (!domain || DEMO_MODE) {
      var demoBtn = document.getElementById('demo-enter');
      if (demoBtn) {
        demoBtn.style.display = '';
        demoBtn.addEventListener('click', function () { revealApp('demo mode'); });
      }
      var gd = document.getElementById('gate-demo'); if (gd) gd.style.display = '';
      // auto-enter if previously entered
      try { if (sessionStorage.getItem(cacheKey)) revealApp(sessionStorage.getItem(cacheKey)); } catch (e) {}
      if (DEMO_MODE) { try { sessionStorage.setItem(cacheKey, 'demo mode'); } catch (e) {} }
      return;
    }

    function tick() {
      if (typeof google === 'undefined' || !google.accounts) { setTimeout(tick, 200); return; }
      if (!clientId || /CLIENT_ID/.test(clientId)) {
        // Not yet configured — show a note + demo bypass instead of a broken button.
        var gd2 = document.getElementById('gate-demo'); if (gd2) gd2.style.display = '';
        var db = document.getElementById('demo-enter');
        if (db) { db.style.display = ''; db.textContent = 'Continue (auth not yet configured)'; db.addEventListener('click', function () { revealApp('preview'); }); }
        return;
      }
      google.accounts.id.initialize({ client_id: clientId, callback: onCred, hd: domain, auto_select: false });
      google.accounts.id.renderButton(document.getElementById('g_id_signin'), { theme: 'filled_black', size: 'large', shape: 'rectangular', text: 'signin_with' });
      try {
        var cached = sessionStorage.getItem(cacheKey);
        if (cached) { var u = JSON.parse(cached); if (u && u.hd === domain) revealApp(u.email); }
      } catch (e) {}
    }
    function onCred(resp) {
      var payload = decodeJwt(resp.credential);
      if (!payload || payload.hd !== domain) { var ge = document.getElementById('gate-error'); if (ge) ge.classList.add('show'); return; }
      try { sessionStorage.setItem(cacheKey, JSON.stringify(payload)); } catch (e) {}
      if (window.AOP_SUPABASE && window.AOP_SUPABASE.signInWithCredential) {
        window.AOP_SUPABASE.signInWithCredential(resp.credential).catch(function () {});
      }
      revealApp(payload.email);
    }
    tick();
  }
  function decodeJwt(token) {
    try {
      var b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var json = decodeURIComponent(atob(b).split('').map(function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join(''));
      return JSON.parse(json);
    } catch (e) { return null; }
  }
  window.aopSignOut = function () {
    try { sessionStorage.removeItem('aop_user_' + SLUG); } catch (e) {}
    if (typeof google !== 'undefined' && google.accounts) google.accounts.id.disableAutoSelect();
    if (window.AOP_SUPABASE && window.AOP_SUPABASE.signOut) window.AOP_SUPABASE.signOut().catch(function () {});
    location.reload();
  };

  /* ---------- status tracker ---------- */
  var STATUSES = [
    { cls: 'status-not-started', label: 'NOT STARTED' },
    { cls: 'status-in-progress', label: 'IN PROGRESS' },
    { cls: 'status-blocked', label: 'BLOCKED' },
    { cls: 'status-done', label: 'DONE' }
  ];
  function trackerKey() { return 'aop_tracker_' + SLUG; }
  function trackerVerKey() { return 'aop_tracker_ver_' + SLUG; }

  function loadTrackerState(content) {
    var defaults = (content.tracker && content.tracker.defaults) || {};
    var version = (content.tracker && content.tracker.version) || 'v0';
    try {
      var stored = JSON.parse(localStorage.getItem(trackerKey()) || '{}');
      var sv = localStorage.getItem(trackerVerKey());
      if (sv !== version) {
        var merged = Object.assign({}, stored, defaults);
        localStorage.setItem(trackerKey(), JSON.stringify(merged));
        localStorage.setItem(trackerVerKey(), version);
        return merged;
      }
      return Object.assign({}, defaults, stored);
    } catch (e) { return Object.assign({}, defaults); }
  }
  function saveTrackerState(s) { try { localStorage.setItem(trackerKey(), JSON.stringify(s)); } catch (e) {} }
  function applyStatus(btn, idx) { var s = STATUSES[idx]; btn.className = 'status-pill ' + s.cls; btn.textContent = s.label; btn.dataset.statusIdx = idx; }

  function refreshDashboard(content) {
    var pills = document.querySelectorAll('.status-pill');
    var done = 0, prog = 0, blocked = 0, todo = 0, total = pills.length;
    var progTasks = [], doneTasks = [], outstandingTasks = [];
    pills.forEach(function (p) {
      var idx = Number(p.dataset.statusIdx);
      var row = p.closest('tr');
      var name = row && row.querySelector('.task-name') ? row.querySelector('.task-name').textContent.trim() : '';
      var owner = row && row.querySelector('.task-owner') ? row.querySelector('.task-owner').textContent.trim() : '';
      if (idx === 0) { todo++; outstandingTasks.push({ name: name, owner: owner }); }
      else if (idx === 1) { prog++; progTasks.push({ name: name, owner: owner }); }
      else if (idx === 2) { blocked++; outstandingTasks.push({ name: name, owner: owner }); }
      else if (idx === 3) { done++; doneTasks.push({ name: name, owner: owner }); }
    });
    var pct = total ? Math.round(done / total * 100) : 0;
    var set = function (id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
    set('stat-total', total); set('stat-done', done); set('stat-in-progress', prog);
    set('stat-blocked', blocked); set('stat-todo', todo); set('stat-pct', pct + '%');
    var pf = document.getElementById('progress-fill'); if (pf) pf.style.width = pct + '%';
    var ptx = document.getElementById('progress-text'); if (ptx) ptx.textContent = pct + '%';
    var rowHtml = function (t) { return '<li><span class="task">' + t.name + '</span><span class="owner">' + t.owner + '</span></li>'; };
    var nl = document.getElementById('now-list');
    if (nl) nl.innerHTML = progTasks.length ? progTasks.map(rowHtml).join('') : '<li class="empty">Nothing in flight</li>';
    var tl = document.getElementById('todo-list');
    if (tl) tl.innerHTML = outstandingTasks.length ? outstandingTasks.slice(0, 8).map(rowHtml).join('') + (outstandingTasks.length > 8 ? '<li class="empty">+ ' + (outstandingTasks.length - 8) + ' more in the full plan ↓</li>' : '') : '<li class="empty">Nothing outstanding 🎉</li>';
    var dl = document.getElementById('done-list');
    if (dl) dl.innerHTML = doneTasks.length ? doneTasks.slice(-6).reverse().map(rowHtml).join('') : '<li class="empty">Nothing finished yet</li>';
    var de = document.getElementById('last-updated-date');
    var lu = content.tracker && content.tracker.lastUpdated;
    if (de && lu) { var d = new Date(lu + 'T12:00:00'); de.textContent = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); }
  }

  function initTracker(content) {
    var state = loadTrackerState(content);
    document.querySelectorAll('.status-pill').forEach(function (btn) {
      var id = btn.dataset.id;
      var idx = Number.isInteger(state[id]) ? state[id] : 0;
      applyStatus(btn, idx);
      btn.addEventListener('click', function () {
        var next = (Number(btn.dataset.statusIdx) + 1) % STATUSES.length;
        applyStatus(btn, next);
        var s = loadTrackerState(content); s[id] = next; saveTrackerState(s);
        refreshDashboard(content);
      });
    });
    refreshDashboard(content);
  }
  window.aopResetTracker = function () {
    if (!confirm('Reset all task statuses to the current defaults?')) return;
    try { localStorage.removeItem(trackerKey()); localStorage.removeItem(trackerVerKey()); } catch (e) {}
    location.reload();
  };

  /* ---------- Required Reading ---------- */
  function ackLocalKey() { return 'aop_acks_' + SLUG; }
  function getLocalAcks() { try { return JSON.parse(localStorage.getItem(ackLocalKey()) || '{}'); } catch (e) { return {}; } }
  function setLocalAck(id) { var a = getLocalAcks(); a[id] = new Date().toISOString(); try { localStorage.setItem(ackLocalKey(), JSON.stringify(a)); } catch (e) {} }

  function initReading(content) {
    var section = document.getElementById('reading');
    if (!section) return;
    var grid = document.getElementById('reading-grid');
    var note = document.getElementById('reading-connect-note');
    var seed = content.requiredReading || [];

    function paintCard(doc, ackedAt) {
      var card = document.createElement('div');
      card.className = 'doc-card';
      if (doc.category) card.setAttribute('data-cat', doc.category);
      card.innerHTML =
        '<div class="doc-cat">' + (doc.category ? doc.category.toUpperCase() : 'DOCUMENT') + (doc.required ? ' · REQUIRED' : '') + '</div>' +
        '<h3></h3><div class="doc-summary"></div>' +
        '<div class="doc-actions"><button class="doc-open">Open document</button><span class="ack-slot"></span></div>';
      card.querySelector('h3').textContent = doc.title || '';
      card.querySelector('.doc-summary').textContent = doc.summary || '';
      var slot = card.querySelector('.ack-slot');
      function setAcked(when) {
        var d = when ? new Date(when) : new Date();
        slot.innerHTML = '<span class="ack-state done"><span class="check">✓</span> Read ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '</span>';
      }
      if (ackedAt) { setAcked(ackedAt); }
      else {
        var b = document.createElement('button'); b.className = 'ack-btn'; b.textContent = 'I have read this';
        b.addEventListener('click', function () { doAck(doc, function () { setAcked(); }); });
        slot.appendChild(b);
      }
      card.querySelector('.doc-open').addEventListener('click', function () { openDoc(doc, !!ackedAt, function () { setAcked(); }); });
      grid.appendChild(card);
    }

    function doAck(doc, onDone) {
      if (window.AOP_SUPABASE && window.AOP_SUPABASE.acknowledge) {
        window.AOP_SUPABASE.acknowledge(doc.id).then(function () { onDone(); }).catch(function (e) { alert('Could not record acknowledgment: ' + (e && e.message || e)); });
      } else { setLocalAck(doc.id || doc.slug); onDone(); }
    }

    function openDoc(doc, alreadyAcked, onAck) {
      var modal = document.getElementById('doc-modal');
      modal.querySelector('.doc-modal-cat').textContent = (doc.category ? doc.category.toUpperCase() + ' · ' : '') + (doc.required ? 'REQUIRED READING' : 'REFERENCE');
      modal.querySelector('h2').textContent = doc.title || '';
      modal.querySelector('.doc-modal-body').innerHTML = mdToHtml(doc.body_md || doc.body || doc.summary || '');
      var actions = modal.querySelector('.doc-modal-actions');
      actions.innerHTML = '';
      if (!alreadyAcked) {
        var ab = document.createElement('button'); ab.className = 'ack-btn'; ab.textContent = 'I have read and understood this';
        ab.addEventListener('click', function () { doAck(doc, function () { onAck(); closeModal(); }); });
        actions.appendChild(ab);
      }
      var cb = document.createElement('button'); cb.className = 'close-btn'; cb.textContent = 'Close';
      cb.addEventListener('click', closeModal);
      actions.appendChild(cb);
      modal.classList.add('open');
    }
    function closeModal() { var m = document.getElementById('doc-modal'); if (m) m.classList.remove('open'); }
    var mEl = document.getElementById('doc-modal');
    if (mEl) mEl.addEventListener('click', function (e) { if (e.target === mEl) closeModal(); });

    function paintSeed() {
      var acks = getLocalAcks();
      seed.forEach(function (doc) { paintCard(doc, acks[doc.id || doc.slug]); });
    }

    // data source
    if (window.AOP_SUPABASE && window.AOP_SUPABASE.loadReading) {
      if (note) note.style.display = 'none';
      window.AOP_SUPABASE.loadReading(SLUG).then(function (res) {
        (res.documents || []).forEach(function (doc) { paintCard(doc, (res.acks || {})[doc.id]); });
        var adminLink = document.getElementById('reading-admin-link');
        if (adminLink && res.isAdmin) adminLink.style.display = '';
      }).catch(function (e) {
        var msg = (e && e.message) || String(e);
        // "not authenticated" just means nobody's signed in (always true on the
        // SSO-less demo tenants) — quietly use the bundled set, no error banner.
        if (note && !/not authenticated/i.test(msg)) {
          note.style.display = '';
          note.textContent = 'Could not load documents from Supabase (' + msg + '). Showing the bundled set.';
        }
        paintSeed();
      });
    } else {
      if (note) note.style.display = '';
      paintSeed();
    }
  }

  /* ---------- left rail (sticky nav desktop / drawer mobile + scroll-spy) ---------- */
  function initRail() {
    var sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    var toggle = document.getElementById('rail-toggle');
    var backdrop = document.getElementById('rail-backdrop');
    var closeBtn = sidebar.querySelector('.rail-close');
    function setOpen(open) {
      document.body.classList.toggle('rail-open', open);
      if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (toggle) toggle.addEventListener('click', function () { setOpen(!document.body.classList.contains('rail-open')); });
    if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
    if (backdrop) backdrop.addEventListener('click', function () { setOpen(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });

    var items = Array.prototype.slice.call(sidebar.querySelectorAll('.rail-item'));
    function setActive(a) { items.forEach(function (x) { x.classList.toggle('active', x === a); }); }
    items.forEach(function (a) {
      a.addEventListener('click', function () { setActive(a); setOpen(false); });
    });

    function buildTargets() {
      var t = items.map(function (a) {
        var id = (a.getAttribute('href') || '').replace(/^#/, '');
        return { a: a, el: id ? document.getElementById(id) : null };
      }).filter(function (x) { return x.el; });
      // sort by document order so the spy loop is correct
      t.sort(function (x, y) {
        return (x.el.compareDocumentPosition(y.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
      });
      return t;
    }
    var targets = buildTargets();
    var headerH = 90, ticking = false;
    function spy() {
      ticking = false;
      if (!targets.length || document.body.classList.contains('locked')) return;
      var current = targets[0];
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].el.getBoundingClientRect().top <= headerH) current = targets[i];
        else break;
      }
      if ((window.innerHeight + window.scrollY) >= (document.documentElement.scrollHeight - 4)) current = targets[targets.length - 1];
      setActive(current.a);
    }
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }, { passive: true });
    window.addEventListener('resize', function () { targets = buildTargets(); spy(); });
    window.addEventListener('aop:revealed', function () { targets = buildTargets(); spy(); });
    spy();
  }

  /* ---------- boot ---------- */
  function applyMeta(content) {
    var m = content.meta || {};
    if (m.tabTitle) document.title = m.tabTitle;
    if (m.description) { var d = document.querySelector('meta[name="description"]'); if (d) d.setAttribute('content', m.description); }
    if (content.brand && content.brand.favicon) {
      var fav = document.getElementById('favicon');
      if (fav) fav.href = 'brands/' + SLUG + '/' + content.brand.favicon;
    }
  }
  function rewriteAssetPaths(content) {
    // brand.logo / brand.favicon are stored relative to the brand dir; expose absolute-ish paths for data-attr binds
    var b = content.brand || {};
    b._logoPath = b.logo ? ('brands/' + SLUG + '/' + b.logo) : '';
    return content;
  }

  document.addEventListener('DOMContentLoaded', function () {
    fetch('brands/' + SLUG + '/content.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('content.json ' + r.status); return r.json(); })
      .then(function (content) {
        CONTENT = rewriteAssetPaths(content);
        applyMeta(CONTENT);
        render(document.body, CONTENT);
        initAuth(CONTENT);
        initTracker(CONTENT);
        initReading(CONTENT);
        initRail();
      })
      .catch(function (e) {
        document.body.innerHTML = '<pre style="padding:40px;font-family:monospace;color:#c00">Failed to load brand "' + SLUG + '": ' + (e && e.message || e) + '\n\nCheck brands/' + SLUG + '/content.json</pre>';
      });
  });
})();
