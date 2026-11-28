# Family Hub

A single web app for the kitchen iPad (Air 4, landscape), with a calendar, Rae's chores, a shopping list and a to-do list. There's no build step: it's plain HTML, CSS and JS, hosted on GitHub Pages.

## 1. Run it in demo mode now
1. Upload the files to a new GitHub repo named `family-hub`.
2. In the repo, go to Settings > Pages > Deploy from branch > `main` / root.
3. On the iPad, open `https://<you>.github.io/family-hub/` in Safari, then tap Share > Add to Home Screen.

In demo mode, data stays on that one device and the sync dot is orange.

## 2. Turn on shared data (Supabase)
1. Go to supabase.com, choose **Continue with GitHub**, then New project (region: London, eu-west-2).
2. Open SQL Editor, paste `supabase/schema.sql` and click Run.
3. Under Authentication > Users > Add user, create one family login (for example `hub@yourdomain`), then turn off public sign-ups.
4. Under Project Settings > API, copy the Project URL and the anon key into `config.js`, then commit.
5. Sign in once on the iPad and on each phone. The sync dot turns green.

## 3. iCloud calendar
1. Go to account.apple.com > Sign-In and Security > App-Specific Passwords and create one called "Family Hub".
2. Deploy the function:
   ```
   npx supabase login
   npx supabase link --project-ref <ref>
   npx supabase functions deploy icloud-calendar
   npx supabase secrets set ICLOUD_USER=you@icloud.com ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx ICLOUD_CALENDARS="Family"
   ```
   Leave `ICLOUD_CALENDARS` blank to show all of your calendars.

## 4. iPad kiosk settings
- Settings > Accessibility > Guided Access: turn it on, set a passcode, and set Display Auto-Lock to "Never" for now (Phase 3 changes this).
- Open the Hub and triple-click the top button to start Guided Access.
- Settings > Display & Brightness: turn Auto-Brightness on and True Tone off.
- After 3 minutes idle the app shows a dim clock, and it does the same overnight (22:00–06:30). Tap to wake. These times are set in `config.js`.
- Battery: put the charger on a smart plug that runs about 2 hours, twice a day, so the iPad isn't held at 100% around the clock.

## 5. Journey times (Google Routes API)
Function `travel`, with secrets `GOOGLE_MAPS_KEY` (an API key restricted to the Routes API) and `HOME_ADDRESS`.

## 6. Energy (SolaX Cloud)
Function `energy`, with secrets `SOLAX_TOKEN` (from SolaX Cloud API → TokenID) and `SOLAX_SN` (the dongle's registration number).
