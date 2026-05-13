/* Runtime config — values are injected at build time by netlify.toml
   from environment variables. Locally these stay as placeholders, which
   makes the portal run in local-only mode (no Supabase, no real SSO). */
window.AOP_CONFIG = {
  supabaseUrl: '__SUPABASE_URL__',
  supabaseAnonKey: '__SUPABASE_ANON_KEY__',
  googleClientId: '__GOOGLE_CLIENT_ID__'
};
