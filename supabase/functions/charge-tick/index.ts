// Supabase Edge Function: runs the hub's "force charge from grid" windows (e.g. Octopus free-electricity sessions).
// Called every minute by pg_cron (header x-cron-secret) and straight after the hub adds/cancels a window
// (signed-in user's token). Turn OFF "Enforce JWT verification" for this function; it checks callers itself.
//
// Secrets: SOLAX_CLIENT_ID, SOLAX_CLIENT_SECRET  (developer.solaxcloud.com > Application)
//          SOLAX_INVERTER_SN                       (inverter serial, Developer Portal > Device list)
//          CRON_SECRET                             (any long random string, also used in the cron job)
// Uses the official SolaX Developer OpenAPI (EU region). After each window the inverter exits remote
// control and returns to whatever mode/TOU settings it had before.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const BASE = "https://openapi-eu.solaxcloud.com";
const EXIT_REMOTE_CONTROL = 160; // after the window, return to the inverter's own settings
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const env = (k: string) => (Deno.env.get(k) || "").trim();

// ---- SolaX auth: token lasts ~30 days; keep it in the private kv table so cold starts don't re-auth
async function token(force = false): Promise<string> {
  if (!force) {
    const { data } = await sb.from("kv").select("value, expires_at").eq("key", "solax_token").maybeSingle();
    if (data && new Date(data.expires_at).getTime() > Date.now() + 3600_000) return data.value;
  }
  const r = await fetch(`${BASE}/openapi/auth/get_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: env("SOLAX_CLIENT_ID"), client_secret: env("SOLAX_CLIENT_SECRET"), grant_type: "CICS" }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.code !== 0 || !j.result?.access_token) throw new Error(`SolaX login failed (${j.code}): ${j.message || "check client ID/secret"}`);
  const expires = new Date(Date.now() + (j.result.expires_in || 2591999) * 1000).toISOString();
  await sb.from("kv").upsert({ key: "solax_token", value: j.result.access_token, expires_at: expires });
  return j.result.access_token;
}

async function solax(path: string, body: Record<string, unknown>, retry = true): Promise<unknown> {
  const t = await token();
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { Authorization: `bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if ([10400, 10401, 10402].includes(j.code) && retry) { await token(true); return solax(path, body, false); }
  if (j.code !== 0) throw new Error(`SolaX ${path.split("/").pop()} failed (${j.code}): ${j.message || ""}`);
  const st = j.result?.[env("SOLAX_INVERTER_SN")]?.status;
  if (st === 1) throw new Error("Inverter is offline");
  if (st === 2) throw new Error("Inverter rejected the command");
  return j;
}

const sn = () => env("SOLAX_INVERTER_SN");
// Negative batteryPower = charge. PV keeps running; the shortfall comes from the grid.
const forceCharge = (watts: number, seconds: number) =>
  solax("/openapi/v2/device/inverter_vpp_mode/push_power/positive_or_negative_mode", {
    snList: [sn()], batteryPower: -Math.abs(watts), timeOfDuration: Math.max(60, Math.round(seconds)),
    nextMotion: EXIT_REMOTE_CONTROL, businessType: 1,
  });
const stopCharge = () => solax("/openapi/v2/device/inverter_vpp_mode/exit_vpp_mode", { snList: [sn()], businessType: 1 });

async function tick() {
  const now = Date.now(), log: string[] = [];
  const { data: rows, error } = await sb.from("charge_windows").select("*")
    .in("status", ["scheduled", "active", "cancel"]).order("start_at");
  if (error) throw error;
  for (const w of rows || []) {
    const start = new Date(w.start_at).getTime(), end = new Date(w.end_at).getTime();
    try {
      if (w.status === "cancel") {
        await stopCharge();
        await sb.from("charge_windows").update({ status: "cancelled", note: "Stopped early" }).eq("id", w.id);
        log.push(`stopped ${w.id}`);
      } else if (w.status === "active" && end <= now) {
        await sb.from("charge_windows").update({ status: "done" }).eq("id", w.id); // inverter already exited by itself
      } else if (w.status === "scheduled" && end <= now) {
        await sb.from("charge_windows").update({ status: "error", note: "Window passed before it could start" }).eq("id", w.id);
      } else if (w.status === "scheduled" && start <= now + 30_000) {
        await forceCharge(w.power_w, (end - now) / 1000);
        await sb.from("charge_windows").update({ status: "active", note: null }).eq("id", w.id);
        log.push(`started ${w.id}`);
      }
    } catch (e) {
      const tries = (w.tries || 0) + 1;
      await sb.from("charge_windows").update({ tries, note: String(e.message || e), status: tries >= 3 ? "error" : w.status }).eq("id", w.id);
      log.push(`error ${w.id}: ${e}`);
    }
  }
  return log;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  // Allowed callers: the cron job (shared secret) or a signed-in hub user
  const cronOk = env("CRON_SECRET") && req.headers.get("x-cron-secret") === env("CRON_SECRET");
  let userOk = false;
  const jwt = (req.headers.get("authorization") || "").replace(/^bearer\s+/i, "");
  if (!cronOk && jwt) { const { data } = await sb.auth.getUser(jwt); userOk = !!data?.user; }
  if (!cronOk && !userOk) return json({ error: "Not allowed" }, 401);
  try {
    if (!env("SOLAX_CLIENT_ID") || !env("SOLAX_CLIENT_SECRET") || !sn()) throw new Error("SOLAX_CLIENT_ID / SOLAX_CLIENT_SECRET / SOLAX_INVERTER_SN secrets not set");
    return json({ ok: true, log: await tick() });
  } catch (e) {
    console.error("charge-tick failed:", String(e));
    return json({ error: String(e.message || e) }, 500);
  }
});
