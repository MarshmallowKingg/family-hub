// Supabase Edge Function: live solar / battery / grid figures from SolaX Cloud.
// Secrets: SOLAX_TOKEN (SolaX Cloud > Service/Support > API > TokenID)
//          SOLAX_SN    (Registration No. of the Pocket WiFi/LAN dongle, NOT the inverter serial)
// SolaX Cloud only refreshes about every 5 minutes, so results are cached for 60 s.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
let cache: { at: number; data: unknown } | null = null;
const n = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);

async function v1(token: string, sn: string) {
  const urls = [
    `https://www.solaxcloud.com/proxyApp/proxy/api/getRealtimeInfo.do?tokenId=${encodeURIComponent(token)}&sn=${encodeURIComponent(sn)}`,
    `https://global.solaxcloud.com/proxyApp/proxy/api/getRealtimeInfo.do?tokenId=${encodeURIComponent(token)}&sn=${encodeURIComponent(sn)}`,
  ];
  let last = "";
  for (const u of urls) {
    try {
      const j = await (await fetch(u, { signal: AbortSignal.timeout(10000) })).json(); // never hang the hub
      if (j?.success && j.result) return j.result;
      last = j?.exception || "No data";
    } catch (e) { last = String(e); }
  }
  throw new Error("SolaX: " + last);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (d: unknown, status = 200) =>
    new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const token = Deno.env.get("SOLAX_TOKEN"), sn = Deno.env.get("SOLAX_SN");
    if (!token || !sn) throw new Error("SOLAX_TOKEN / SOLAX_SN secrets not set");
    if (cache && Date.now() - cache.at < 60_000) return json(cache.data);
    const r = await v1(token.trim(), sn.trim());
    const solar = n(r.powerdc1) + n(r.powerdc2) + n(r.powerdc3) + n(r.powerdc4);
    const grid = n(r.feedinpower);                 // + exporting, - importing
    const battery = n(r.batPower);                 // + charging, - discharging
    const home = Math.max(0, n(r.acpower) - grid); // inverter output minus export = house load
    const data = {
      solarW: solar, homeW: home, gridW: grid, batteryW: battery,
      soc: r.soc ?? null,
      solarTodayKWh: n(r.yieldtoday),
      exportTotalKWh: n(r.feedinenergy), importTotalKWh: n(r.consumeenergy),
      status: r.inverterStatus ?? null, updated: r.uploadTime ?? null,
    };
    cache = { at: Date.now(), data };
    return json(data);
  } catch (e) {
    console.error("energy failed:", String(e));
    return json({ error: String(e) }, 500);
  }
});
