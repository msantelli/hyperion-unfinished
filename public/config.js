/* Supabase connection for the gallery.
   These two values are PUBLIC BY DESIGN and safe to commit to a public repo:
   the anon key only identifies browser traffic, and everything it may do is
   decided by the Row Level Security policies on the Supabase side
   (insert-only + read-visible-only for this project).
   What must NEVER appear in this repo: the service_role key or the
   database password — those bypass RLS entirely. */

window.HYPERION_CONFIG = {
  supabaseUrl: "https://YOUR-PROJECT-REF.supabase.co",
  supabaseAnonKey: "PASTE-ANON-PUBLIC-KEY-HERE",
};
