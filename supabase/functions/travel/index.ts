// Supabase Edge Function: journey times from home to an event location (Google Routes API).
// Secrets: GOOGLE_MAPS_KEY (Routes API key), HOME_ADDRESS (e.g. "WF1 5FU" or full address)
// Body: { destination: "address text", lat?: number, lon?: number, arriveBy?: ISO string }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const cache = new Map<string, { at: number; data: unknown }>();

async function route(mode: "DRIVE" | "WALK", dest: Record<string, unknown>, departure?: string) {
  const body: Record<string, unknown> = {
    origin: { address: Deno.env.get("HOME_ADDRESS") },
    destination: dest,
    travelMode: mode,
    regionCode: "GB",
    units: "METRIC",
  };
  if (mode === "DRIVE") {
    body.routingPreference = "TRAFFIC_AWARE";
    if (departure) body.departureTime = departure;
  }
  const r = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": Deno.env.get("GOOGLE_MAPS_KEY") || "",
      "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters",
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `Routes API ${r.status}`);
  const rt = j.routes?.[0];
  if (!rt) return null;
  return {
    seconds: parseInt(rt.duration),
    noTrafficSeconds: rt.staticDuration ? parseInt(rt.staticDuration) : null,
    meters: rt.distanceMeters ?? null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (d: unknown, status = 200) =>
    new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    if (!Deno.env.get("GOOGLE_MAPS_KEY") || !Deno.env.get("HOME_ADDRESS")) throw new Error("GOOGLE_MAPS_KEY / HOME_ADDRESS secrets not set");
    const { destination, lat, lon, arriveBy } = await req.json();
    if (!destination && lat == null) throw new Error("No destination");
    const dest = lat != null && lon != null
      ? { location: { latLng: { latitude: lat, longitude: lon } } }
      : { address: destination };

    // For a future event, estimate traffic for ~30 min before it starts; otherwise leave now.
    let departure: string | undefined;
    if (arriveBy) {
      const t = new Date(new Date(arriveBy).getTime() - 30 * 60000);
      if (t.getTime() > Date.now() + 60000) departure = t.toISOString();
    }
    const key = JSON.stringify([destination, lat, lon, departure?.slice(0, 15)]);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60000) return json(hit.data);

    const [drive, walk] = await Promise.all([route("DRIVE", dest, departure), route("WALK", dest)]);
    const data = { drive, walk, departure: departure || null };
    cache.set(key, { at: Date.now(), data });
    return json(data);
  } catch (e) {
    console.error("travel failed:", String(e));
    return json({ error: String(e) }, 500);
  }
});
