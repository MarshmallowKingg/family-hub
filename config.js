// Family Hub settings. Leave SUPABASE_URL blank to run in demo mode (data saved on this device only).
window.HUB_CONFIG = {
  SUPABASE_URL: "https://jocuvgsremckahlwzywv.supabase.co",        // e.g. "https://abcdefgh.supabase.co"
  SUPABASE_ANON_KEY: "sb_publishable_OxhLMSIx6xy5YnzNydlcRw_lc6xOdmR",    // Project Settings > API > anon public key (safe to publish; data is locked to the signed-in family account)

  LAT: 53.68, LON: -1.50,    // Weather location (Wakefield)
  IDLE_MINUTES: 3,           // Dim to clock screen after this long without a touch
  NIGHT_START: "22:00",      // Clock screen stays on overnight between these times
  NIGHT_END: "06:30",
  CHILD_NAME: "Rae",
  CALENDAR_DAYS: 14,         // How far ahead to fetch iCloud events
  CALENDAR_REFRESH_MIN: 10
};
