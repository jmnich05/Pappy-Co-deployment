/* ============================================================
   Pappy & Co — AI Deployment Hub — Supabase integration (optional)
   Exposes window.AOP_SUPABASE only when configured. app.js falls
   back to local-only behaviour when this object is absent.

   Configure via config/runtime.js (netlify substitutes the
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
      var isAdmin = !memR.error && memR.data && (memR.data.role === 'tenant_admin' || memR.data.role === 'super_admin');
      return { documents: docsR.data || [], acks: acks, isAdmin: !!isAdmin };
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
