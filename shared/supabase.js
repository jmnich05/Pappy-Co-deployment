/* ============================================================
   Pappy & Co — AI Deployment Hub — Supabase integration (optional)
   Exposes window.AOP_SUPABASE only when configured. app.js falls
   back to local-only behaviour when this object is absent.

   Configure via app/config/runtime.js (netlify substitutes the
   __SUPABASE_URL__ / __SUPABASE_ANON_KEY__ placeholders at build
   time) — or set window.AOP_CONFIG before this script runs.
   ============================================================ */
(function () {
  'use strict';
  var cfg = window.AOP_CONFIG || {};
  var url = (cfg.supabaseUrl || '').trim();
  var anon = (cfg.supabaseAnonKey || '').trim();
  // Not configured (placeholders still present or empty) -> do nothing.
  if (!url || !anon || /__SUPABASE/.test(url) || /__SUPABASE/.test(anon)) return;

  var CDN = 'https://esm.sh/@supabase/supabase-js@2';
  var clientPromise = import(CDN).then(function (mod) {
    return mod.createClient(url, anon, { auth: { persistSession: true, autoRefreshToken: true } });
  });

  function client() { return clientPromise; }

  async function tenantIdForSlug(sb, slug) {
    var r = await sb.from('tenants').select('id').eq('slug', slug).maybeSingle();
    if (r.error) throw r.error;
    return r.data ? r.data.id : null;
  }

  window.AOP_SUPABASE = {
    signInWithCredential: async function (idToken) {
      var sb = await client();
      var r = await sb.auth.signInWithIdToken({ provider: 'google', token: idToken });
      if (r.error) throw r.error;
      return r.data;
    },
    signOut: async function () { var sb = await client(); return sb.auth.signOut(); },

    // Returns { documents:[...], acks:{docId:isoTime}, isAdmin:bool }
    loadReading: async function (slug) {
      var sb = await client();
      // getSession() reads local storage — no network call when nobody's signed in
      var sess = await sb.auth.getSession();
      var user = sess && sess.data && sess.data.session && sess.data.session.user;
      if (!user) {
        // not signed in to Supabase yet — let app.js use its fallback
        throw new Error('not authenticated');
      }
      var uid = user.id;
      var docsR = await sb.from('documents').select('*').eq('published', true).order('sort_order', { ascending: true });
      if (docsR.error) throw docsR.error;
      var acksR = await sb.from('acknowledgments').select('document_id, acknowledged_at').eq('user_id', uid);
      if (acksR.error) throw acksR.error;
      var acks = {};
      (acksR.data || []).forEach(function (a) { acks[a.document_id] = a.acknowledged_at; });
      var memR = await sb.from('tenant_members').select('role').eq('user_id', uid).maybeSingle();
      var isAdmin = !memR.error && memR.data && (memR.data.role === 'tenant_admin' || memR.data.role === 'animo_admin');
      return { documents: docsR.data || [], acks: acks, isAdmin: !!isAdmin };
    },

    // ---------- Intake forms ----------
    // We cache the user's tenant_id once per session since RLS won't infer it on insert.
    _tenantId: null,
    _getTenantId: async function () {
      if (this._tenantId) return this._tenantId;
      var sb = await client();
      var sess = await sb.auth.getSession();
      var user = sess && sess.data && sess.data.session && sess.data.session.user;
      if (!user) throw new Error('not authenticated');
      var r = await sb.from('tenant_members').select('tenant_id').eq('user_id', user.id).maybeSingle();
      if (r.error || !r.data) throw new Error('No tenant membership for this account.');
      this._tenantId = r.data.tenant_id;
      return this._tenantId;
    },

    // Returns { responses, status, progress_pct, updated_at } or null if no draft yet.
    intakeLoad: async function (formKind) {
      var sb = await client();
      var sess = await sb.auth.getSession();
      var user = sess && sess.data && sess.data.session && sess.data.session.user;
      if (!user) throw new Error('not authenticated');
      var r = await sb.from('intake_responses').select('responses, status, progress_pct, updated_at, submitted_at').eq('user_id', user.id).eq('form_kind', formKind).maybeSingle();
      if (r.error) throw r.error;
      return r.data || null;
    },

    // Upserts the draft. responses = object; progressPct = 0–100.
    intakeSave: async function (formKind, responses, progressPct) {
      var sb = await client();
      var sess = await sb.auth.getSession();
      var user = sess && sess.data && sess.data.session && sess.data.session.user;
      if (!user) throw new Error('not authenticated');
      var tenantId = await this._getTenantId();
      var r = await sb.from('intake_responses').upsert({
        user_id: user.id, tenant_id: tenantId, form_kind: formKind,
        responses: responses || {}, progress_pct: progressPct || 0, status: 'draft'
      }, { onConflict: 'tenant_id,user_id,form_kind' });
      if (r.error) throw r.error;
      return true;
    },

    intakeSubmit: async function (formKind, responses, progressPct) {
      var sb = await client();
      var sess = await sb.auth.getSession();
      var user = sess && sess.data && sess.data.session && sess.data.session.user;
      if (!user) throw new Error('not authenticated');
      var tenantId = await this._getTenantId();
      var r = await sb.from('intake_responses').upsert({
        user_id: user.id, tenant_id: tenantId, form_kind: formKind,
        responses: responses || {}, progress_pct: 100, status: 'submitted',
        submitted_at: new Date().toISOString()
      }, { onConflict: 'tenant_id,user_id,form_kind' });
      if (r.error) throw r.error;
      return true;
    },

    // ---------- Role + admin matrix ----------
    getMyRole: async function () {
      var sb = await client();
      var sess = await sb.auth.getSession();
      if (!sess || !sess.data || !sess.data.session) return null;
      var r = await sb.from('my_role').select('role').maybeSingle();
      if (r.error) return null;
      return r.data ? r.data.role : null;
    },
    loadAdminMatrix: async function () {
      var sb = await client();
      var sess = await sb.auth.getSession();
      var user = sess && sess.data && sess.data.session && sess.data.session.user;
      if (!user) throw new Error('not authenticated');
      var mem = await sb.from('tenant_members').select('user_id, email, full_name, role').order('email', { ascending: true });
      if (mem.error) throw mem.error;
      var subs = await sb.from('intake_responses').select('user_id, form_kind, status, progress_pct, updated_at, submitted_at, responses');
      if (subs.error) throw subs.error;
      return { members: mem.data || [], submissions: subs.data || [] };
    },

    // ---------- Storage (logo / brand-asset uploads) ----------
    // Returns the public URL of the uploaded asset, or throws.
    uploadAsset: async function (file, formKind, fieldId) {
      var sb = await client();
      var sess = await sb.auth.getSession();
      var user = sess && sess.data && sess.data.session && sess.data.session.user;
      if (!user) throw new Error('not authenticated');
      var tenantId = await this._getTenantId();
      var safeName = (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      var ext = '';
      var dot = safeName.lastIndexOf('.');
      if (dot > 0) { ext = safeName.slice(dot); safeName = safeName.slice(0, dot); }
      var stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      var path = tenantId + '/' + (formKind || 'misc') + '/' + (fieldId || 'file') + '/' + safeName + '-' + stamp + ext;
      var up = await sb.storage.from('tenant-assets').upload(path, file, {
        upsert: false, contentType: file.type || 'application/octet-stream'
      });
      if (up.error) throw up.error;
      var pub = sb.storage.from('tenant-assets').getPublicUrl(path);
      return pub.data && pub.data.publicUrl;
    },

    acknowledge: async function (documentId) {
      var sb = await client();
      var sess = await sb.auth.getUser();
      if (!sess || !sess.data || !sess.data.user) throw new Error('Sign in required to acknowledge.');
      var uid = sess.data.user.id;
      var memR = await sb.from('tenant_members').select('tenant_id').eq('user_id', uid).maybeSingle();
      if (memR.error || !memR.data) throw new Error('No tenant membership found for this account.');
      var docR = await sb.from('documents').select('content_hash').eq('id', documentId).maybeSingle();
      var hash = (docR.data && docR.data.content_hash) || '';
      var ins = await sb.from('acknowledgments').insert({
        document_id: documentId, user_id: uid, tenant_id: memR.data.tenant_id, doc_hash: hash
      });
      if (ins.error && ins.error.code !== '23505') throw ins.error; // 23505 = already acknowledged, treat as success
      return true;
    }
  };
})();
