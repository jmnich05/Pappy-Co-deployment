/* ============================================================
   Pappy & Co — AI Deployment Hub — client intake forms
   Seven forms (brand-kit, company-context, data-sources, skills,
   workflows, customer-personas, competitors). Multi-step, auto-
   saving every ~800ms to the intake_responses table (per-tenant
   RLS isolation) when Supabase is wired, or to localStorage in
   demo mode.
   ============================================================ */
(function () {
  'use strict';

  var FORMS = [
    { kind: 'workflows',         order: 1, assignees: ['*'],                                          ownerLabel: 'STEP 1 · EVERYONE' },
    { kind: 'skills',            order: 2, assignees: ['*'],                                          ownerLabel: 'STEP 2 · EVERYONE · 1 PER DEPT REQUIRED' },
    { kind: 'data-sources',      order: 3, assignees: ['*'],                                          ownerLabel: 'STEP 3 · EVERYONE' },
    { kind: 'company-context',   order: 4, assignees: ['carrie', 'louise', 'christy', 'kelcie'],      ownerLabel: 'STEP 4 · CARRIE, LOUISE, CHRISTY, KELCIE' },
    { kind: 'competitors',       order: 5, assignees: ['carrie', 'louise', 'christy', 'kelcie'],      ownerLabel: 'STEP 5 · CARRIE, LOUISE, CHRISTY, KELCIE' },
    { kind: 'customer-personas', order: 6, assignees: ['jonathan'],                                   ownerLabel: 'STEP 6 · JONATHAN' },
    { kind: 'brand-kit',         order: 7, assignees: ['kelcie'],                                     ownerLabel: 'STEP 7 · KELCIE' }
  ];

  var SLUG = (function () {
    try {
      var u = new URL(location.href);
      var q = u.searchParams.get('tenant');
      if (q) return q;
      var s = localStorage.getItem('aop_tenant');
      if (s) return s;
    } catch (e) {}
    var HOSTMAP = { 'ai.pappyco.com': 'pappy-co' };
    return HOSTMAP[location.hostname] || 'northwind';
  })();

  var formDefs  = {};   // kind -> loaded form definition
  var formState = {};   // kind -> { responses, status, step, dirty, saveTimer, progress }
  var ROLE      = null; // 'member' | 'tenant_admin' | 'animo_admin' | null
  function isAdmin() { return ROLE === 'tenant_admin' || ROLE === 'animo_admin'; }

  function localKey(kind) { return 'aop_intake_' + SLUG + '_' + kind; }

  /* ---------- persistence (Supabase if configured, else local) ---------- */
  function hasSupabase() {
    return !!(window.AOP_SUPABASE && window.AOP_SUPABASE.intakeSave);
  }
  function loadState(kind) {
    if (hasSupabase()) {
      return window.AOP_SUPABASE.intakeLoad(kind).then(function (row) {
        if (!row) return { responses: {}, status: 'draft', progress: 0 };
        return { responses: row.responses || {}, status: row.status || 'draft', progress: row.progress_pct || 0 };
      }).catch(function () {
        return loadLocal(kind);
      });
    }
    return Promise.resolve(loadLocal(kind));
  }
  function loadLocal(kind) {
    try { var raw = localStorage.getItem(localKey(kind)); if (raw) return JSON.parse(raw); } catch (e) {}
    return { responses: {}, status: 'draft', progress: 0 };
  }
  function saveState(kind, state) {
    var payload = { responses: state.responses, status: state.status, progress: state.progress, updated_at: new Date().toISOString() };
    try { localStorage.setItem(localKey(kind), JSON.stringify(payload)); } catch (e) {}
    if (hasSupabase() && state.status === 'draft') {
      return window.AOP_SUPABASE.intakeSave(kind, state.responses, state.progress).catch(function () { /* keep local copy */ });
    }
    return Promise.resolve();
  }
  function submitState(kind, state) {
    state.status = 'submitted';
    state.progress = 100;
    try { localStorage.setItem(localKey(kind), JSON.stringify({ responses: state.responses, status: 'submitted', progress: 100, updated_at: new Date().toISOString() })); } catch (e) {}
    if (hasSupabase()) {
      return window.AOP_SUPABASE.intakeSubmit(kind, state.responses);
    }
    return Promise.resolve();
  }

  /* ---------- progress: % of fields filled ---------- */
  function calcProgress(form, responses) {
    if (!form) return 0;
    var total = 0, filled = 0;
    form.steps.forEach(function (step) {
      step.fields.forEach(function (f) {
        if (f.type === 'repeater') {
          total++;
          var arr = (responses[step.id] || {})[f.id];
          if (Array.isArray(arr) && arr.length && arr.some(function (it) { return Object.values(it || {}).some(function (v) { return v && String(v).trim(); }); })) filled++;
        } else {
          total++;
          var v = (responses[step.id] || {})[f.id];
          if (v && String(v).trim()) filled++;
        }
      });
    });
    return total ? Math.round(filled / total * 100) : 0;
  }

  /* ---------- form definition loader ---------- */
  function loadFormDef(kind) {
    if (formDefs[kind]) return Promise.resolve(formDefs[kind]);
    return fetch('forms/' + kind + '.json', { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('forms/' + kind + '.json ' + r.status); return r.json(); })
      .then(function (def) { formDefs[kind] = def; return def; });
  }

  /* ---------- DOM helpers ---------- */
  function el(tag, props, children) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === 'class') e.className = props[k];
      else if (k === 'on') Object.keys(props.on).forEach(function (ev) { e.addEventListener(ev, props.on[ev]); });
      else if (k in e) try { e[k] = props[k]; } catch (_) { e.setAttribute(k, props[k]); }
      else e.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c == null) return; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  /* ---------- field renderers ---------- */
  function fieldRow(label, help, control, opts) {
    var lab = el('label', { class: 'intake-label' }, [label + (opts && opts.required ? ' *' : '')]);
    var row = el('div', { class: 'intake-field' }, [lab, control]);
    if (help) row.appendChild(el('div', { class: 'intake-help' }, [help]));
    return row;
  }
  function inputControl(field, value, onChange) {
    var input = el('input', {
      class: 'intake-input', type: field.type === 'color' ? 'text' : (field.type === 'url' ? 'url' : 'text'),
      value: value || '', placeholder: field.placeholder || ''
    });
    if (field.type === 'color') input.setAttribute('pattern', '^#[0-9A-Fa-f]{6}$');
    input.addEventListener('input', function () { onChange(input.value); });
    if (field.type === 'color') {
      var swatch = el('span', { class: 'intake-swatch' });
      swatch.style.background = value && /^#[0-9A-Fa-f]{6}$/.test(value) ? value : 'transparent';
      input.addEventListener('input', function () { swatch.style.background = /^#[0-9A-Fa-f]{6}$/.test(input.value) ? input.value : 'transparent'; });
      return el('div', { class: 'intake-color-wrap' }, [swatch, input]);
    }
    return input;
  }
  function textareaControl(field, value, onChange) {
    var ta = el('textarea', {
      class: 'intake-input intake-textarea', rows: field.rows || 3,
      placeholder: field.placeholder || ''
    });
    ta.value = value || '';
    ta.addEventListener('input', function () { onChange(ta.value); });
    return ta;
  }
  function selectControl(field, value, onChange) {
    var sel = el('select', { class: 'intake-input' });
    sel.appendChild(el('option', { value: '' }, ['—']));
    (field.options || []).forEach(function (opt) {
      var o = el('option', { value: opt.value }, [opt.label]);
      if (value === opt.value) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener('change', function () { onChange(sel.value); });
    return sel;
  }
  function fileControl(field, value, onChange, readonly, ctx) {
    var wrap = el('div', { class: 'intake-file' });
    var preview = el('div', { class: 'intake-file-preview' });
    var current = value;
    function renderPreview() {
      preview.innerHTML = '';
      if (current && typeof current === 'string') {
        var isImg = /^https?:\/\/.+\.(jpg|jpeg|png|gif|svg|webp)(\?.*)?$/i.test(current) || /^data:image\//.test(current);
        if (isImg) {
          var img = el('img', { class: 'intake-file-img', src: current, alt: '' });
          preview.appendChild(img);
        }
        var link = el('a', { href: current, target: '_blank', rel: 'noopener', class: 'intake-file-link' }, ['View file →']);
        preview.appendChild(link);
        if (!readonly) {
          var rm = el('button', { type: 'button', class: 'intake-file-remove' }, ['Remove']);
          rm.addEventListener('click', function () { current = null; onChange(null); renderPreview(); });
          preview.appendChild(rm);
        }
      }
    }
    renderPreview();
    if (!readonly) {
      var dropLabel = el('label', { class: 'intake-file-drop' }, [
        el('span', { class: 'intake-file-drop-cta' }, ['↑ Upload a file']),
        el('span', { class: 'intake-file-drop-hint' }, [field.accept ? 'Accepts: ' + field.accept : 'Image or PDF, up to 20 MB']),
      ]);
      var input = el('input', { type: 'file', accept: field.accept || 'image/*,application/pdf' });
      input.style.display = 'none';
      dropLabel.appendChild(input);
      var statusEl = el('div', { class: 'intake-file-status' });
      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) return;
        statusEl.textContent = 'Uploading…';
        if (window.AOP_SUPABASE && window.AOP_SUPABASE.uploadAsset) {
          window.AOP_SUPABASE.uploadAsset(file, ctx && ctx.formKind, field.id).then(function (url) {
            current = url; onChange(url); renderPreview();
            statusEl.textContent = 'Uploaded ✓';
            setTimeout(function () { statusEl.textContent = ''; }, 2500);
          }).catch(function (err) {
            statusEl.textContent = 'Upload failed: ' + (err && err.message || err);
          });
        } else {
          if (file.size > 250 * 1024) {
            statusEl.textContent = 'Without Supabase, uploads work only for small previews (≤ 250 KB). Paste a URL below instead.';
            return;
          }
          var reader = new FileReader();
          reader.onload = function () { current = reader.result; onChange(reader.result); renderPreview(); statusEl.textContent = 'Stored locally (Supabase not configured).'; };
          reader.readAsDataURL(file);
        }
      });
      wrap.appendChild(dropLabel);
      wrap.appendChild(statusEl);
      // Manual URL fallback (always available — paste a link from Drive/Dropbox)
      var orHint = el('div', { class: 'intake-file-or' }, ['…or paste a URL:']);
      var urlInput = el('input', {
        class: 'intake-input', type: 'url',
        placeholder: 'https://drive.google.com/…',
        value: (typeof current === 'string' && /^https?:/.test(current)) ? current : ''
      });
      urlInput.addEventListener('input', function () { current = urlInput.value || null; onChange(current); renderPreview(); });
      wrap.appendChild(orHint);
      wrap.appendChild(urlInput);
    }
    wrap.appendChild(preview);
    return wrap;
  }

  function repeaterControl(field, value, onChange, readonly, ctx) {
    var items = Array.isArray(value) ? value.slice() : [];
    if (!items.length && field.minItems) {
      for (var k = 0; k < field.minItems; k++) items.push({});
    }
    var wrap = el('div', { class: 'intake-repeater' });
    function render() {
      wrap.innerHTML = '';
      items.forEach(function (item, i) {
        var card = el('div', { class: 'intake-rep-item' });
        var head = el('div', { class: 'intake-rep-head' }, [
          el('span', { class: 'intake-rep-num' }, ['#' + (i + 1)]),
          readonly ? null : el('button', { class: 'intake-rep-rm', type: 'button', on: { click: function () { items.splice(i, 1); render(); onChange(items); } } }, ['Remove'])
        ]);
        card.appendChild(head);
        (field.itemFields || []).forEach(function (sub) {
          var ctrl = fieldControl(sub, item[sub.id], function (v) { item[sub.id] = v; onChange(items); }, readonly, ctx);
          card.appendChild(fieldRow(sub.label, sub.help, ctrl, { required: sub.required }));
        });
        wrap.appendChild(card);
      });
      if (!readonly) {
        wrap.appendChild(el('button', { class: 'intake-rep-add', type: 'button', on: { click: function () { items.push({}); render(); onChange(items); } } }, ['+ ' + (field.addLabel || 'Add another')]));
      }
    }
    render();
    return wrap;
  }
  function fieldControl(field, value, onChange, readonly, ctx) {
    var ctrl;
    if (field.type === 'textarea') ctrl = textareaControl(field, value, onChange);
    else if (field.type === 'select') ctrl = selectControl(field, value, onChange);
    else if (field.type === 'repeater') ctrl = repeaterControl(field, value, onChange, readonly, ctx);
    else if (field.type === 'file') ctrl = fileControl(field, value, onChange, readonly, ctx);
    else ctrl = inputControl(field, value, onChange);
    if (readonly) {
      var inputs = ctrl.querySelectorAll ? ctrl.querySelectorAll('input, textarea, select, button') : [];
      Array.prototype.forEach.call(inputs, function (i) { i.disabled = true; });
      if (ctrl.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(ctrl.tagName)) ctrl.disabled = true;
    }
    return ctrl;
  }

  /* ---------- main render ---------- */
  var root = null;

  function renderCards() {
    var grid = el('div', { class: 'intake-grid' });
    var statusPromises = FORMS.map(function (f) { return loadState(f.kind).then(function (s) { return { kind: f.kind, state: s }; }); });
    Promise.all(statusPromises).then(function (results) {
      results.forEach(function (r) {
        var def = formDefs[r.kind];  // may be undefined until loaded
        var formMeta = FORMS.filter(function (f) { return f.kind === r.kind; })[0] || {};
        var ownerLabel = formMeta.ownerLabel || '';
        var pct = def ? calcProgress(def, r.state.responses) : (r.state.progress || 0);
        var status = r.state.status;
        var statusLabel = status === 'submitted' ? '✓ SUBMITTED' : (pct > 0 ? 'IN PROGRESS · ' + pct + '%' : 'NOT STARTED');
        var canExport = pct > 0;
        var card = el('div', { class: 'intake-card status-' + status + (pct > 0 ? ' has-progress' : ''), on: { click: function (e) { if (e.target.closest('.intake-card-export')) return; openForm(r.kind); } } }, [
          ownerLabel ? el('div', { class: 'intake-card-owner' }, [ownerLabel]) : null,
          el('div', { class: 'intake-card-status' }, [statusLabel]),
          el('div', { class: 'intake-card-title' }, [titleFor(r.kind)]),
          el('p', { class: 'intake-card-sub' }, [subtitleFor(r.kind)]),
          el('div', { class: 'intake-card-actions' }, [
            el('span', { class: 'intake-card-cta' }, [pct > 0 && status === 'draft' ? 'Resume →' : (status === 'submitted' ? 'Review →' : 'Start →')]),
            canExport ? el('button', {
              class: 'intake-card-export', type: 'button',
              title: 'Download as markdown',
              on: { click: function (e) { e.stopPropagation(); downloadMarkdown(r.kind, r.state.responses, r.kind); } }
            }, ['↓ .md']) : null
          ])
        ]);
        grid.appendChild(card);
      });
    });
    return grid;
  }

  // Static metadata so cards render before form JSON loads
  var META = {
    'brand-kit':         { title: 'Brand Kit',          subtitle: 'Colors, fonts, logos — the look' },
    'company-context':   { title: 'Company Context',    subtitle: 'What you do, who you serve, what\'s special' },
    'customer-personas': { title: 'Customer Personas',  subtitle: 'Who you actually serve — the real people' },
    'competitors':       { title: 'Competitors',        subtitle: 'Who you stack against, and how you\'d frame it' },
    'data-sources':      { title: 'Data Sources',       subtitle: 'What tools should the AI be able to see?' },
    'skills':            { title: 'Skills',             subtitle: 'Processes the AI should learn — internal & external' },
    'workflows':         { title: 'Your Workflows',     subtitle: 'About your job — so the AI is shaped around you' }
  };
  function titleFor(k)    { return (formDefs[k] && formDefs[k].title)    || (META[k] && META[k].title)    || k; }
  function subtitleFor(k) { return (formDefs[k] && formDefs[k].subtitle) || (META[k] && META[k].subtitle) || ''; }

  function openForm(kind) {
    if (!root) return;
    showForm(kind);
  }
  function showForm(kind) {
    root.innerHTML = '';
    root.appendChild(el('div', { class: 'intake-form-host' }, [el('div', { class: 'intake-form-loading' }, ['Loading…'])]));
    Promise.all([loadFormDef(kind), loadState(kind)]).then(function (vals) {
      var def = vals[0];
      var state = vals[1];
      state.step = 0;
      formState[kind] = state;
      renderForm(kind, def, state);
    }).catch(function (err) {
      root.innerHTML = '<div class="intake-error">Could not load form: ' + (err && err.message || err) + '</div>';
    });
  }
  function backToCards() {
    if (!root) return;
    root.innerHTML = '';
    if (isAdmin()) root.appendChild(renderViewToggle('cards'));
    root.appendChild(renderCards());
  }

  function renderViewToggle(active) {
    return el('div', { class: 'intake-view-toggle' }, [
      el('button', { class: 'intake-toggle-btn' + (active === 'cards' ? ' active' : ''), type: 'button', on: { click: backToCards } }, ['Your forms']),
      el('button', { class: 'intake-toggle-btn' + (active === 'admin' ? ' active' : ''), type: 'button', on: { click: renderAdminView } }, ['Admin · team matrix'])
    ]);
  }

  function renderAdminView() {
    if (!root) return;
    root.innerHTML = '';
    root.appendChild(renderViewToggle('admin'));
    var host = el('div', { class: 'intake-admin-host' });
    var loading = el('div', { class: 'intake-admin-loading' }, ['Loading submissions…']);
    host.appendChild(loading);
    root.appendChild(host);
    if (!window.AOP_SUPABASE || !window.AOP_SUPABASE.loadAdminMatrix) {
      host.innerHTML = '<div class="intake-error">Admin matrix needs Supabase to be wired (set SUPABASE_URL and SUPABASE_ANON_KEY).</div>';
      return;
    }
    window.AOP_SUPABASE.loadAdminMatrix().then(function (m) {
      host.innerHTML = '';
      host.appendChild(renderMatrix(m));
    }).catch(function (e) {
      host.innerHTML = '<div class="intake-error">Could not load admin matrix: ' + escapeHtmlText(e && e.message || String(e)) + '</div>';
    });
  }

  function renderMatrix(m) {
    var byUserAndKind = {};
    m.submissions.forEach(function (s) { byUserAndKind[s.user_id + ':' + s.form_kind] = s; });
    var wrap = el('div', { class: 'intake-admin-wrap' });
    wrap.appendChild(el('p', { class: 'intake-admin-deck' }, [
      m.members.length + ' team member' + (m.members.length === 1 ? '' : 's') + '. Click any cell to read that submission. Use the ↓ to grab it as markdown.'
    ]));
    var tableWrap = el('div', { class: 'intake-admin-table-wrap' });
    var table = el('table', { class: 'intake-admin-table' });
    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', { class: 'intake-admin-th-member' }, ['Team member']));
    FORMS.forEach(function (f) { hr.appendChild(el('th', null, [titleFor(f.kind)])); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');
    m.members.forEach(function (member) {
      var row = el('tr');
      row.appendChild(el('td', { class: 'intake-admin-member' }, [
        el('div', { class: 'intake-admin-member-name' }, [member.full_name || (member.email || '').split('@')[0]]),
        el('div', { class: 'intake-admin-member-meta' }, [(member.email || '') + (member.role && member.role !== 'member' ? ' · ' + member.role : '')])
      ]));
      FORMS.forEach(function (f) {
        var sub = byUserAndKind[member.user_id + ':' + f.kind];
        var cell = el('td', { class: 'intake-admin-cell' });
        if (!sub) {
          cell.appendChild(el('span', { class: 'intake-admin-status-none' }, ['—']));
        } else {
          var lbl;
          if (sub.status === 'submitted') {
            lbl = '✓ ' + (sub.submitted_at ? new Date(sub.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Done');
          } else {
            lbl = (sub.progress_pct || 0) + '% draft';
          }
          var btn = el('button', { class: 'intake-admin-status-btn ' + sub.status, type: 'button' }, [lbl]);
          btn.addEventListener('click', function () { openReadOnly(member, f.kind, sub); });
          cell.appendChild(btn);
          if (sub.progress_pct > 0) {
            var dl = el('button', {
              class: 'intake-admin-dl', type: 'button', title: 'Download as .md'
            }, ['↓']);
            dl.addEventListener('click', function (e) {
              e.stopPropagation();
              var slug = (member.email || 'member').split('@')[0].replace(/[^a-z0-9-]/gi, '-').toLowerCase();
              downloadMarkdown(f.kind, sub.responses, f.kind + '-' + slug);
            });
            cell.appendChild(dl);
          }
        }
        row.appendChild(cell);
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    wrap.appendChild(tableWrap);
    return wrap;
  }

  function openReadOnly(member, formKind, sub) {
    loadFormDef(formKind).then(function (def) {
      var state = { responses: sub.responses || {}, status: 'submitted', step: 0, progress: sub.progress_pct || 0 };
      formState[formKind] = state;
      renderForm(formKind, def, state);
      // Prepend a banner pointing back to the admin matrix
      var host = root.querySelector('.intake-form-host');
      if (host) {
        var banner = el('div', { class: 'intake-admin-banner' }, [
          el('span', { class: 'intake-admin-banner-text' }, [
            'Viewing ', el('strong', null, [def.title]), ' — ', (member.full_name || member.email || 'team member')
          ]),
          el('button', { type: 'button', class: 'intake-admin-banner-back' }, ['← Back to admin matrix'])
        ]);
        banner.querySelector('.intake-admin-banner-back').addEventListener('click', renderAdminView);
        host.insertBefore(banner, host.firstChild);
      }
    });
  }

  function escapeHtmlText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function renderForm(kind, def, state) {
    var readonly = state.status === 'submitted';
    var step = def.steps[state.step];
    var pct = calcProgress(def, state.responses);
    state.progress = pct;
    var stepN = state.step + 1;
    var stepTotal = def.steps.length;

    var formMeta = { title: def.title, intro: def.intro };
    var stepMeta = { title: step.title, intro: step.intro };
    var getContextResponses = function () {
      // include everything except the current field (to avoid feeding the model its own current text)
      var clone = JSON.parse(JSON.stringify(state.responses || {}));
      return clone;
    };

    var host = el('section', { class: 'intake-form-host' + (readonly ? ' is-submitted' : '') }, [
      el('div', { class: 'intake-form-topbar' }, [
        el('button', { class: 'intake-back', type: 'button', on: { click: function () { flushSave(kind, state).then(backToCards); } } }, ['← All forms']),
        el('div', { class: 'intake-form-topbar-right' }, [
          el('button', { class: 'intake-md-btn', type: 'button', title: 'Download what you have as a .md file', on: { click: function () { downloadMarkdown(kind, state.responses, kind); } } }, ['↓ .md']),
          el('div', { class: 'intake-form-save-state', id: 'intake-save-state' }, [readonly ? 'Submitted — read-only' : 'Saved'])
        ])
      ]),
      el('header', { class: 'intake-form-head' }, [
        el('div', { class: 'intake-form-title' }, [def.title]),
        el('div', { class: 'intake-form-sub' }, [def.subtitle]),
        el('p', { class: 'intake-form-intro' }, [def.intro || '']),
        el('div', { class: 'intake-stepper' }, def.steps.map(function (s, i) {
          return el('button', { class: 'intake-step-pip' + (i === state.step ? ' active' : '') + (i < state.step ? ' done' : ''), type: 'button', on: { click: function () { state.step = i; renderForm(kind, def, state); } } }, [
            el('span', { class: 'intake-step-num' }, [String(i + 1)]),
            el('span', { class: 'intake-step-lab' }, [s.title])
          ]);
        }))
      ]),
      el('div', { class: 'intake-step' }, [
        el('h3', { class: 'intake-step-title' }, [stepN + ' / ' + stepTotal + ' · ' + step.title]),
        step.intro ? el('p', { class: 'intake-step-intro' }, [step.intro]) : null,
        el('div', { class: 'intake-fields' }, step.fields.map(function (f) {
          var sectionVal = state.responses[step.id] || {};
          var v = sectionVal[f.id];
          var ctrl = fieldControl(f, v, function (newV) {
            if (!state.responses[step.id]) state.responses[step.id] = {};
            state.responses[step.id][f.id] = newV;
            state.dirty = true;
            scheduleSave(kind, state);
          }, readonly, { formKind: kind, stepId: step.id });
          var row = fieldRow(f.label, f.help, ctrl, { required: f.required });
          if (!readonly && f.type === 'textarea' && f.aiAssist !== false) {
            var ta = row.querySelector('textarea');
            if (ta) attachAIAssist(row, ta, f, formMeta, stepMeta, getContextResponses);
          }
          return row;
        }))
      ]),
      el('div', { class: 'intake-form-foot' }, [
        el('button', { class: 'intake-btn ghost', type: 'button', disabled: state.step === 0, on: { click: function () { state.step--; renderForm(kind, def, state); } } }, ['Back']),
        el('div', { class: 'intake-progress' }, [
          el('div', { class: 'intake-progress-bar' }, [el('div', { class: 'intake-progress-fill', style: 'width:' + pct + '%' })]),
          el('div', { class: 'intake-progress-pct' }, [pct + '% complete'])
        ]),
        el('button', { class: 'intake-btn ghost', type: 'button', on: { click: function () { flushSave(kind, state).then(backToCards); } } }, ['Save & exit']),
        state.step < stepTotal - 1
          ? el('button', { class: 'intake-btn primary', type: 'button', on: { click: function () { state.step++; renderForm(kind, def, state); } } }, ['Next →'])
          : (readonly
            ? null
            : el('button', { class: 'intake-btn primary submit', type: 'button', on: { click: function () { confirmSubmit(kind, state, def); } } }, ['Submit ✓']))
      ])
    ]);
    root.innerHTML = '';
    root.appendChild(host);
  }

  var SAVE_DEBOUNCE_MS = 800;
  function scheduleSave(kind, state) {
    setSaveState('Saving…');
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () { flushSave(kind, state); }, SAVE_DEBOUNCE_MS);
  }
  function flushSave(kind, state) {
    if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
    if (!state.dirty) { setSaveState(state.status === 'submitted' ? 'Submitted — read-only' : 'Saved'); return Promise.resolve(); }
    state.progress = calcProgress(formDefs[kind], state.responses);
    return saveState(kind, state).then(function () {
      state.dirty = false;
      setSaveState('Saved · ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
    }).catch(function (e) {
      setSaveState('Save failed — ' + (e && e.message || 'try again'));
    });
  }
  function setSaveState(text) {
    var el = document.getElementById('intake-save-state');
    if (el) el.textContent = text;
  }
  function confirmSubmit(kind, state, def) {
    state.progress = calcProgress(def, state.responses);
    if (!confirm('Submit this form? You\'ll get to review the answers; you won\'t be able to edit them once submitted.')) return;
    setSaveState('Submitting…');
    submitState(kind, state).then(function () {
      setSaveState('Submitted ✓');
      // re-render in read-only mode
      renderForm(kind, def, state);
    }).catch(function (e) {
      setSaveState('Submit failed — ' + (e && e.message || 'try again'));
    });
  }

  /* ---------- AI-assist ---------- */
  function attachAIAssist(rowEl, textareaEl, field, formMeta, stepMeta, getContextResponses) {
    var panel = el('div', { class: 'intake-assist' });
    var trigger = el('button', { class: 'intake-assist-trigger', type: 'button' }, ['✨ Draft this with AI']);
    var box = el('div', { class: 'intake-assist-box' });
    box.style.display = 'none';

    function setStatus(html, klass) {
      box.style.display = '';
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'intake-assist-status ' + (klass || '') }, [html]));
    }
    function showSuggestion(text, model) {
      box.style.display = '';
      box.innerHTML = '';
      var hasValue = !!(textareaEl.value || '').trim();
      var labelEl = el('div', { class: 'intake-assist-label' }, [(hasValue ? '✨ Suggested revision' : '✨ Suggested draft') + (model ? ' · ' + model : '')]);
      var pre = el('pre', { class: 'intake-assist-text' });
      pre.textContent = text;
      var actions = el('div', { class: 'intake-assist-actions' });
      var useBtn = el('button', { class: 'intake-assist-use', type: 'button' }, ['Use this →']);
      useBtn.addEventListener('click', function () {
        textareaEl.value = text;
        textareaEl.dispatchEvent(new Event('input', { bubbles: true }));
        // auto-grow if textarea has rows attr suggesting short — give it some height
        textareaEl.focus();
        box.style.display = 'none';
        trigger.textContent = '✨ Draft again';
      });
      var refineBtn = el('button', { class: 'intake-assist-refine', type: 'button' }, ['Refine…']);
      refineBtn.addEventListener('click', function () {
        var hint = prompt('What should the AI change about it? (e.g. "shorter and more concrete" or "less formal")');
        if (hint && hint.trim()) request(hint.trim());
      });
      var dismissBtn = el('button', { class: 'intake-assist-dismiss', type: 'button' }, ['Discard']);
      dismissBtn.addEventListener('click', function () { box.style.display = 'none'; });
      actions.appendChild(useBtn);
      actions.appendChild(refineBtn);
      actions.appendChild(dismissBtn);
      box.appendChild(labelEl);
      box.appendChild(pre);
      box.appendChild(actions);
    }

    function request(refineHint) {
      trigger.disabled = true;
      var payload = {
        formTitle: formMeta.title, formIntro: formMeta.intro,
        stepTitle: stepMeta.title, stepIntro: stepMeta.intro,
        fieldLabel: field.label, fieldHelp: field.help, fieldPlaceholder: field.placeholder,
        currentValue: textareaEl.value, refineHint: refineHint || null,
        contextResponses: getContextResponses()
      };
      setStatus(refineHint ? 'Refining…' : 'Drafting…');
      fetch('/.netlify/functions/ai-assist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) {
        return r.text().then(function (t) {
          var j; try { j = JSON.parse(t); } catch (e) { j = { error: t }; }
          return { ok: r.ok, status: r.status, data: j };
        });
      }).then(function (res) {
        trigger.disabled = false;
        if (!res.ok) {
          setStatus(escapeHtml(res.data.error || ('Request failed (' + res.status + ')')), 'error');
          return;
        }
        showSuggestion(res.data.suggestion || '', res.data.model);
      }).catch(function (e) {
        trigger.disabled = false;
        setStatus('Couldn\'t reach the AI-assist service. ' + escapeHtml(String(e && e.message || e)), 'error');
      });
    }
    function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    trigger.addEventListener('click', function () { request(null); });
    panel.appendChild(trigger);
    panel.appendChild(box);
    rowEl.appendChild(panel);
  }

  /* ---------- markdown export ---------- */
  function mdEsc(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\r/g, ''); }
  function mdList(text) {
    if (!text) return '';
    var lines = String(text).split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    return lines.map(function (l) { return '- ' + l.replace(/^[-•*]\s*/, ''); }).join('\n') + '\n\n';
  }
  function mdTable(headers, rows) {
    if (!rows || !rows.length) return '';
    return '| ' + headers.join(' | ') + ' |\n|' + headers.map(function () { return '---'; }).join('|') + '|\n'
      + rows.map(function (r) { return '| ' + r.map(function (c) { return mdEsc(c).replace(/\n+/g, ' '); }).join(' | ') + ' |'; }).join('\n') + '\n\n';
  }
  function mdPara(label, value) { return value ? '**' + label + ':** ' + String(value).trim() + '\n\n' : ''; }
  function mdSection(level, title) { return Array(level + 1).join('#') + ' ' + title + '\n\n'; }

  var MD_BUILDERS = {
    'brand-kit': function (r) {
      var ident = r.identity || {}, colors = (r.colors || {}).colors || [];
      var typo = r.typography || {}, logo = r.logo || {}, voice = r.voice || {};
      var name = ident.brand_name || 'Brand';
      var out = '# ' + name + ' — Brand Kit\n\n';
      if (ident.voice_one_liner) out += '> ' + ident.voice_one_liner.trim() + '\n\n';
      out += mdPara('Tagline', ident.tagline);
      var validColors = colors.filter(function (c) { return c && (c.name || c.hex); });
      if (validColors.length) out += mdSection(2, 'Colors') + mdTable(['Name', 'Hex', 'When to use'], validColors.map(function (c) { return [c.name, c.hex, c.usage]; }));
      var hasType = typo.display_font || typo.body_font || typo.type_rules;
      if (hasType) {
        out += mdSection(2, 'Typography');
        if (typo.display_font) { out += mdPara('Display / headline', typo.display_font); if (typo.display_notes) out += typo.display_notes.trim() + '\n\n'; }
        if (typo.body_font) { out += mdPara('Body', typo.body_font); if (typo.body_notes) out += typo.body_notes.trim() + '\n\n'; }
        if (typo.accent_font) out += mdPara('Accent / editorial', typo.accent_font);
        if (typo.type_rules) out += mdSection(3, 'Type rules') + typo.type_rules.trim() + '\n\n';
      }
      if (logo.logo_primary_url || logo.logo_mark_url || logo.logo_horizontal_url || logo.logo_rules || logo.visual_inspiration) {
        out += mdSection(2, 'Logo');
        if (logo.logo_primary_url) out += '- **Primary:** ' + logo.logo_primary_url + '\n';
        if (logo.logo_mark_url) out += '- **Mark:** ' + logo.logo_mark_url + '\n';
        if (logo.logo_horizontal_url) out += '- **Horizontal:** ' + logo.logo_horizontal_url + '\n';
        if (logo.logo_primary_url || logo.logo_mark_url || logo.logo_horizontal_url) out += '\n';
        if (logo.logo_rules) out += mdSection(3, 'Logo rules') + logo.logo_rules.trim() + '\n\n';
        if (logo.visual_inspiration) out += mdSection(3, 'Visual inspiration') + logo.visual_inspiration.trim() + '\n\n';
      }
      if (voice.voice_dos || voice.voice_donts || voice.voice_examples) {
        out += mdSection(2, 'Voice');
        if (voice.voice_dos) out += mdSection(3, 'Do') + mdList(voice.voice_dos);
        if (voice.voice_donts) out += mdSection(3, 'Don\'t') + mdList(voice.voice_donts);
        if (voice.voice_examples) out += mdSection(3, 'Examples') + voice.voice_examples.trim() + '\n\n';
      }
      return out + '---\n_Generated from the Brand Kit intake form on ' + (new Date().toISOString().slice(0, 10)) + '._\n';
    },
    'company-context': function (r) {
      var p = r.pitch || {}, s = r.shape || {}, d = r.differentiation || {}, h = r.history || {}, b = r.boundaries || {};
      var out = '# Company Context\n\n';
      if (p.what_we_do) out += mdSection(2, 'What we do') + p.what_we_do.trim() + '\n\n';
      if (p.who_we_serve) out += mdSection(2, 'Who we serve') + p.who_we_serve.trim() + '\n\n';
      if (p.mission) out += mdSection(2, 'Why we exist') + p.mission.trim() + '\n\n';
      if (s.founded || s.size) { out += mdSection(2, 'Shape of the business'); out += mdPara('Founded', s.founded); out += mdPara('Size', s.size); }
      if (s.revenue_streams) out += mdSection(3, 'Revenue streams') + s.revenue_streams.trim() + '\n\n';
      if (s.growth_focus) out += mdSection(3, 'Where we\'re putting energy') + s.growth_focus.trim() + '\n\n';
      if (d.what_is_special) out += mdSection(2, 'What\'s different') + d.what_is_special.trim() + '\n\n';
      if (d.what_we_are_not) out += mdSection(2, 'What we are NOT') + d.what_we_are_not.trim() + '\n\n';
      if (d.competitors) out += mdSection(2, 'Competitive landscape') + d.competitors.trim() + '\n\n';
      if (h.wins) out += mdSection(2, 'Recent wins') + h.wins.trim() + '\n\n';
      if (h.lessons) out += mdSection(2, 'Cautionary tales') + h.lessons.trim() + '\n\n';
      if (b.off_limits || b.sensitive || b.house_rules) out += mdSection(2, 'Guardrails');
      if (b.off_limits) out += mdSection(3, 'Off-limits topics') + b.off_limits.trim() + '\n\n';
      if (b.sensitive) out += mdSection(3, 'Sensitive areas') + b.sensitive.trim() + '\n\n';
      if (b.house_rules) out += mdSection(3, 'House rules') + b.house_rules.trim() + '\n\n';
      return out + '---\n_Generated from the Company Context intake form on ' + (new Date().toISOString().slice(0, 10)) + '._\n';
    },
    'data-sources': function (r) {
      var tools = (r.tools || {}).tools || [];
      var off = (r.off_limits || {}).off_limits_tools || [];
      var notes = (r.notes || {}).general_notes || '';
      var out = '# Data Sources\n\n';
      var validTools = tools.filter(function (t) { return t && (t.name); });
      if (validTools.length) {
        out += mdSection(2, 'Tools to connect');
        out += mdTable(['Tool', 'Purpose', 'Owner', 'Priority', 'Access notes'], validTools.map(function (t) {
          return [t.name, t.purpose, t.owner, (t.priority || '').toUpperCase(), t.access_notes];
        }));
      }
      var validOff = off.filter(function (t) { return t && t.name; });
      if (validOff.length) {
        out += mdSection(2, 'Off-limits — do NOT connect');
        out += mdTable(['Source', 'Why'], validOff.map(function (t) { return [t.name, t.why]; }));
      }
      if (notes) out += mdSection(2, 'Notes') + notes.trim() + '\n\n';
      return out + '---\n_Generated from the Data Sources intake form on ' + (new Date().toISOString().slice(0, 10)) + '._\n';
    },
    'skills': function (r) {
      var internal = (r.internal || {}).internal_skills || [];
      var external = (r.external || {}).external_skills || [];
      var antiText = (r.anti || {}).do_not_automate || '';
      var out = '# Skills\n\n_Reusable processes the AI is taught to run, with the level of oversight the team wants on each._\n\n';
      function renderSkill(s, ext) {
        if (!s || !s.name) return '';
        var block = mdSection(3, s.name);
        if (ext && s.external_party) block += '**External party:** ' + s.external_party + '\n\n';
        if (s.trigger) block += '**Trigger:** ' + s.trigger.trim() + '\n\n';
        if (s.inputs) block += '**Inputs:** ' + s.inputs.trim() + '\n\n';
        if (s.outputs) block += '**Outputs:** ' + s.outputs.trim() + '\n\n';
        if (s.steps) block += '**Steps**\n\n' + s.steps.trim() + '\n\n';
        if (s.pain_today) block += '**Pain today:** ' + s.pain_today.trim() + '\n\n';
        if (s.ai_role) block += '**How the AI helps:** ' + s.ai_role.trim() + '\n\n';
        return block;
      }
      var validInternal = internal.filter(function (s) { return s && s.name; });
      var validExternal = external.filter(function (s) { return s && s.name; });
      if (validInternal.length) { out += mdSection(2, 'Internal processes'); validInternal.forEach(function (s) { out += renderSkill(s, false); }); }
      if (validExternal.length) { out += mdSection(2, 'External processes'); validExternal.forEach(function (s) { out += renderSkill(s, true); }); }
      if (antiText) out += mdSection(2, 'What the AI should NOT automate') + mdList(antiText);
      return out + '---\n_Generated from the Skills intake form on ' + (new Date().toISOString().slice(0, 10)) + '._\n';
    },
    'workflows': function (r) {
      var y = r.you || {}, w = r.week || {}, rep = r.repetitive || {}, hi = r.high_stakes || {}, t = r.tools || {}, ho = r.honest || {};
      var who = (y.name || 'Team Member') + (y.role ? ' — ' + y.role : '');
      var out = '# Workflow notes · ' + who + '\n\n';
      if (y.team || y.tenure) { if (y.team) out += mdPara('Team', y.team); if (y.tenure) out += mdPara('Tenure', y.tenure); }
      if (w.monday) out += mdSection(2, 'A typical Monday') + w.monday.trim() + '\n\n';
      if (w.rest_of_week) out += mdSection(2, 'The rest of the week') + w.rest_of_week.trim() + '\n\n';
      if (w.start_of_day) out += mdPara('Start of day (first app)', w.start_of_day);
      if (rep.repetitive_tasks) out += mdSection(2, 'Repetitive work — candidates for AI') + mdList(rep.repetitive_tasks);
      if (hi.ai_no_touch) out += mdSection(2, 'High-stakes work — AI should NOT touch') + mdList(hi.ai_no_touch);
      if (t.tools_used) out += mdSection(2, 'Tools used') + mdList(t.tools_used);
      if (t.tools_wish) out += mdSection(2, 'Wish list') + t.tools_wish.trim() + '\n\n';
      if (ho.concerns) out += mdSection(2, 'Concerns') + ho.concerns.trim() + '\n\n';
      if (ho.excited) out += mdSection(2, 'What a win looks like') + ho.excited.trim() + '\n\n';
      return out + '---\n_Generated from the Workflows intake form on ' + (new Date().toISOString().slice(0, 10)) + '._\n';
    },
    'customer-personas': function (r) {
      var primary = (r.primary || {}).personas || [];
      var anti = r.anti || {};
      var out = '# Customer Personas\n\n_Real people behind \"the customer\" — the AI will use these when drafting anything customer-facing._\n\n';
      var valid = primary.filter(function (p) { return p && p.name; });
      valid.forEach(function (p) {
        out += mdSection(2, p.name);
        if (p.snapshot) out += mdSection(3, 'Snapshot') + p.snapshot.trim() + '\n\n';
        if (p.what_they_want) out += mdSection(3, 'What they actually want') + p.what_they_want.trim() + '\n\n';
        if (p.what_blocks_them) out += mdSection(3, 'What gets in their way today') + p.what_blocks_them.trim() + '\n\n';
        if (p.where_they_are) out += mdSection(3, 'Where you reach them') + p.where_they_are.trim() + '\n\n';
        if (p.what_they_call_it) out += mdSection(3, 'How THEY describe what they want') + p.what_they_call_it.trim() + '\n\n';
      });
      if (anti.anti_personas) out += mdSection(2, 'Who you\'re NOT for') + anti.anti_personas.trim() + '\n\n';
      if (anti.lookalike_traps) out += mdSection(2, 'Lookalike traps') + anti.lookalike_traps.trim() + '\n\n';
      return out + '---\n_Generated from the Customer Personas intake form on ' + (new Date().toISOString().slice(0, 10)) + '._\n';
    },
    'competitors': function (r) {
      var ls = r.landscape || {}, cs = (r.competitors || {}).competitors || [], fr = r.framing || {}, nc = r.non_competitors || {};
      var out = '# Competitors & Positioning\n\n_Who you stack against, where you win, where you lose, and how you\'d rather frame the comparison._\n\n';
      if (ls.category_name) out += mdPara('Category', ls.category_name);
      if (ls.category_alternative) out += mdSection(2, 'How you refuse to play the category game') + ls.category_alternative.trim() + '\n\n';
      var valid = cs.filter(function (c) { return c && c.name; });
      if (valid.length) {
        out += mdSection(2, 'Direct competitors');
        valid.forEach(function (c) {
          out += mdSection(3, c.name + (c.url ? ' — ' + c.url : ''));
          if (c.where_they_win) out += '**Where they win:** ' + c.where_they_win.trim() + '\n\n';
          if (c.where_we_win) out += '**Where we win:** ' + c.where_we_win.trim() + '\n\n';
          if (c.how_we_differ) out += '**Positioning gap:** ' + c.how_we_differ.trim() + '\n\n';
        });
      }
      if (fr.preferred_frame) out += mdSection(2, 'Preferred framing') + fr.preferred_frame.trim() + '\n\n';
      if (fr.avoid_frame) out += mdSection(2, 'Framings to AVOID') + fr.avoid_frame.trim() + '\n\n';
      if (fr.switching_story) out += mdSection(2, 'Why customers switch to us') + fr.switching_story.trim() + '\n\n';
      if (nc.lookalikes) out += mdSection(2, 'Adjacent — not actually competitors') + nc.lookalikes.trim() + '\n\n';
      return out + '---\n_Generated from the Competitors intake form on ' + (new Date().toISOString().slice(0, 10)) + '._\n';
    }
  };

  function toMarkdown(kind, responses) {
    var builder = MD_BUILDERS[kind];
    if (!builder) return '# ' + kind + '\n\n```json\n' + JSON.stringify(responses, null, 2) + '\n```\n';
    return builder(responses || {});
  }
  function downloadMarkdown(kind, responses, filenameHint) {
    var md = toMarkdown(kind, responses);
    var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (filenameHint || kind) + '.md';
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  /* ---------- public init ---------- */
  function init() {
    root = document.getElementById('intake-root');
    if (!root) return;
    // initial paint with cached metadata (so it doesn't flash empty)
    backToCards();
    // fetch role + defs in parallel, then re-render
    Promise.all([
      Promise.all(FORMS.map(function (f) { return loadFormDef(f.kind).catch(function () { return null; }); })),
      (window.AOP_SUPABASE && window.AOP_SUPABASE.getMyRole) ? window.AOP_SUPABASE.getMyRole().catch(function () { return null; }) : Promise.resolve(null)
    ]).then(function (results) {
      ROLE = results[1];
      backToCards();
    });
  }

  window.AOP_INTAKE = {
    init: init, openForm: openForm, backToCards: backToCards,
    toMarkdown: toMarkdown, downloadMarkdown: downloadMarkdown
  };
})();
