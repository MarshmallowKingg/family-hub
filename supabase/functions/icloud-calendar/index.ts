// Supabase Edge Function: reads your iCloud calendars over CalDAV and returns upcoming events as JSON.
// Secrets (Edge Functions > Secrets):
//   ICLOUD_USER          your Apple ID email
//   ICLOUD_APP_PASSWORD  app-specific password from account.apple.com > Sign-In and Security
//   ICLOUD_CALENDARS     optional, comma-separated calendar names to include (e.g. "Family,Home"). Blank = all.
// Only signed-in hub users can call it (JWT verification is on by default).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const ROOT = "https://caldav.icloud.com";

function auth() {
  const u = (Deno.env.get("ICLOUD_USER") || "").trim().toLowerCase();
  const p = (Deno.env.get("ICLOUD_APP_PASSWORD") || "").replace(/\s+/g, "").toLowerCase();
  return "Basic " + btoa(`${u}:${p}`);
}

async function dav(url: string, method: string, body: string, depth = "0") {
  const r = await fetch(url, {
    method,
    headers: { Authorization: auth(), Depth: depth, "Content-Type": "application/xml; charset=utf-8" },
    body,
    redirect: "follow",
  });
  if (!r.ok && r.status !== 207) throw new Error(`${method} ${url} -> ${r.status}${r.status === 401 || r.status === 403 ? " (iCloud rejected the email/app-specific password)" : ""}`);
  return await r.text();
}

// Tiny namespace-agnostic XML helpers (iCloud uses varying prefixes)
const tagRe = (name: string) => new RegExp(`<(?:[\\w-]+:)?${name}[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "gi");
const all = (xml: string, name: string) => [...xml.matchAll(tagRe(name))].map((m) => m[1]);
const first = (xml: string, name: string) => all(xml, name)[0];
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const abs = (base: string, href: string) => new URL(href.trim(), base).toString();

let allNames: string[] = [];
let cache: { at: number; key: string; data: unknown } | null = null;

async function calendars() {
  const p1 = await dav(ROOT + "/", "PROPFIND", `<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`);
  if (!Deno.env.get("ICLOUD_USER") || !Deno.env.get("ICLOUD_APP_PASSWORD")) throw new Error("ICLOUD_USER / ICLOUD_APP_PASSWORD secrets not set");
  const cup = first(p1, "current-user-principal");
  if (!cup) throw new Error("No principal in iCloud reply: " + p1.slice(0, 300));
  const principal = abs(ROOT, first(cup, "href"));
  const p2 = await dav(principal, "PROPFIND", `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`);
  const home = abs(principal, first(first(p2, "calendar-home-set"), "href"));
  const p3 = await dav(home, "PROPFIND",
    `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/></d:prop></d:propfind>`, "1");
  const want = (Deno.env.get("ICLOUD_CALENDARS") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // resourcetype looks like <collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/> (attributes vary)
  const found = all(p3, "response")
    .filter((r) => /<(?:[\w-]+:)?calendar[\s\/>]/i.test(first(r, "resourcetype") || "") && /VEVENT/.test(r))
    .map((r) => ({ url: abs(home, first(r, "href")), name: decode((first(r, "displayname") || "Calendar").trim()) }));
  allNames = found.map((c) => c.name);
  return found.filter((c) => !want.length || want.includes(c.name.toLowerCase()));
}

const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function parseICS(ics: string, calendar: string) {
  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out: Record<string, unknown>[] = [];
  let ev: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") ev = {};
    else if (line === "END:VEVENT" && ev) {
      const allDay = /VALUE=DATE(?!-)/.test(ev.DTSTART_P || "") || /^\d{8}$/.test(ev.DTSTART || "");
      const conv = (v: string) => allDay
        ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
        : new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(9, 11)}:${v.slice(11, 13)}:${v.slice(13, 15)}${v.endsWith("Z") ? "Z" : ""}`).toISOString();
      if (ev.DTSTART && ev.STATUS !== "CANCELLED") {
        out.push({
          title: (ev.SUMMARY || "(no title)").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/g, " "),
          start: conv(ev.DTSTART), end: conv(ev.DTEND || ev.DTSTART), allDay, calendar,
          lat: ev.GEO_LAT ? Number(ev.GEO_LAT) : null,
          lon: ev.GEO_LON ? Number(ev.GEO_LON) : null,
          location: ev.LOCATION ? ev.LOCATION.replace(/\\n/gi, ", ").replace(/\\([,;\\])/g, "$1").trim() : null,
        });
      }
      ev = null;
    } else if (ev) {
      if (line.startsWith("X-APPLE-STRUCTURED-LOCATION")) {
        const g = line.match(/geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i);
        if (g) { ev.GEO_LAT = g[1]; ev.GEO_LON = g[2]; }
        continue;
      }
      const i = line.indexOf(":"); if (i < 0) continue;
      const [name, ...params] = line.slice(0, i).split(";");
      if (!(name in ev)) { ev[name] = line.slice(i + 1); if (params.length) ev[name + "_P"] = params.join(";"); }
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { days = 14 } = await req.json().catch(() => ({}));
    const key = String(days);
    if (cache && cache.key === key && Date.now() - cache.at < 60_000) {
      return new Response(JSON.stringify(cache.data), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
    const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 7);
    const end = new Date(Date.now() + Number(days) * 864e5);
    const range = `start="${fmt(start)}" end="${fmt(end)}"`;
    const body = `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
      <d:prop><c:calendar-data><c:expand ${range}/></c:calendar-data></d:prop>
      <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range ${range}/></c:comp-filter></c:comp-filter></c:filter>
    </c:calendar-query>`;
    const cals = await calendars();
    const results = await Promise.all(cals.map(async (c) => {
      const xml = await dav(c.url, "REPORT", body, "1");
      return all(xml, "calendar-data").flatMap((d) => parseICS(decode(d), c.name));
    }));
    const data = { events: results.flat(), calendars: cals.map((c) => c.name), available: allNames, fetched: new Date().toISOString() };
    cache = { at: Date.now(), key, data };
    return new Response(JSON.stringify(data), { headers: { ...CORS, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("icloud-calendar failed:", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
