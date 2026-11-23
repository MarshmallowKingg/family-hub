/* Family Hub — single-page app. Vanilla JS, no build step. */
(function () {
  "use strict";
  const APP_VERSION = "14"; // bump with version.json on every release so kiosks reload themselves
  const C = window.HUB_CONFIG;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const mondayOf = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(16).slice(2));

  /* ---------------- backends ---------------- */
  // Demo backend: everything in localStorage on this device.
  const Local = {
    mode: "demo",
    _get(k, d) { try { return JSON.parse(localStorage.getItem("hub_" + k)) ?? d; } catch { return d; } },
    _set(k, v) { localStorage.setItem("hub_" + k, JSON.stringify(v)); Local._cb && Local._cb(); },
    async init() {
      if (!localStorage.getItem("hub_chores")) {
        Local._set("chores", [
          { id: uid(), name: "Brush teeth", emoji: "🪥", days: [0, 1, 2, 3, 4, 5, 6], sort: 1 },
          { id: uid(), name: "Tidy toys", emoji: "🧸", days: [0, 1, 2, 3, 4, 5, 6], sort: 2 },
          { id: uid(), name: "Feed Stitch", emoji: "🐶", days: [1, 3, 5], sort: 3 },
          { id: uid(), name: "Feed Hugo", emoji: "🐱", days: [0, 2, 4, 6], sort: 4 },
        ]);
      }
      return true;
    },
    subscribe(cb) { Local._cb = cb; window.addEventListener("storage", cb); },
    async items(list) { return Local._get("items", []).filter((i) => i.list === list); },
    async allItems() { return Local._get("items", []); },
    async addItem(list, text) { const a = Local._get("items", []); a.push({ id: uid(), list, text, done: false, created_at: new Date().toISOString() }); Local._set("items", a); },
    async updateItem(id, patch) { Local._set("items", Local._get("items", []).map((i) => (i.id === id ? { ...i, ...patch } : i))); },
    async deleteItems(ids) { Local._set("items", Local._get("items", []).filter((i) => !ids.includes(i.id))); },
    async chores() { return Local._get("chores", []).sort((a, b) => a.sort - b.sort); },
    async addChore(c) { const a = Local._get("chores", []); a.push({ id: uid(), sort: a.length + 1, ...c }); Local._set("chores", a); },
    async deleteChore(id) { Local._set("chores", Local._get("chores", []).filter((c) => c.id !== id)); },
    async updateChore(id, patch) { Local._set("chores", Local._get("chores", []).map((c) => (c.id === id ? { ...c, ...patch } : c))); },
    async createEvent(ev) { const a = Local._get("myevents", []); a.push({ ...ev, calendar: ev.calendar || "Family" }); Local._set("myevents", a); },
    async setHandoff(kind, payload) { Local._set("handoff", { kind, payload, created_at: new Date().toISOString() }); },
    async choreLog(from) { return Local._get("chore_log", []).filter((l) => l.date >= from); },
    async toggleChore(chore_id, date) {
      const a = Local._get("chore_log", []); const i = a.findIndex((l) => l.chore_id === chore_id && l.date === date);
      if (i >= 0) a.splice(i, 1); else a.push({ id: uid(), chore_id, date }); Local._set("chore_log", a);
    },
    async events() {
      const t = startOfDay(new Date()); const mk = (d, h, m, mins, title, cal) => { const s = addDays(t, d); s.setHours(h, m); return { title, start: s.toISOString(), end: new Date(+s + mins * 60000).toISOString(), allDay: false, calendar: cal }; };
      const ad = (d, title, cal) => ({ title, start: ymd(addDays(t, d)), end: ymd(addDays(t, d + 1)), allDay: true, calendar: cal });
      S.calendars = ["Family", "Home"];
      return [...Local._get("myevents", []), { ...mk(0, 9, 30, 60, "Demo: Swimming", "Family"), location: "Wakefield Sun Lane Leisure Centre" }, mk(0, 18, 0, 90, "Demo: Tea at Nan's", "Family"), ad(1, "Demo: Bin day (green)", "Home"), mk(2, 19, 0, 120, "Demo: Cricket committee", "Lewis"), mk(4, 10, 0, 45, "Demo: Vets – Stitch", "Family")];
    },
  };

  // Supabase backend: shared live data, family login, iCloud via edge function.
  const Cloud = {
    mode: "cloud",
    async init() {
      Cloud.sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
      const { data } = await Cloud.sb.auth.getSession();
      if (data.session) return true;
      return new Promise((resolve) => {
        $("#login").classList.remove("hidden");
        $("#loginForm").onsubmit = async (e) => {
          e.preventDefault();
          const { error } = await Cloud.sb.auth.signInWithPassword({ email: $("#loginEmail").value.trim(), password: $("#loginPass").value });
          if (error) { $("#loginErr").textContent = error.message; return; }
          $("#login").classList.add("hidden"); resolve(true);
        };
      });
    },
    subscribe(cb) {
      let t, ch, retry; const deb = () => { clearTimeout(t); t = setTimeout(cb, 250); };
      // Live channel that rebuilds itself if it ever drops (Wi-Fi blip, router restart, token renewal).
      const connect = () => {
        clearTimeout(retry);
        if (ch) Cloud.sb.removeChannel(ch);
        ch = Cloud.sb.channel("hub-" + Date.now()).on("postgres_changes", { event: "*", schema: "public" }, deb)
          .subscribe((st) => {
            if (st === "SUBSCRIBED") { setSync("ok"); cb(); } // catch anything missed while disconnected
            else if (st === "CHANNEL_ERROR" || st === "TIMED_OUT" || st === "CLOSED") { setSync("err"); retry = setTimeout(connect, 5000); }
          });
      };
      connect();
      Cloud.sb.auth.onAuthStateChange((ev, session) => { if (ev === "TOKEN_REFRESHED" && session) Cloud.sb.realtime.setAuth(session.access_token); });
      window.addEventListener("online", connect);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) connect(); });
    },
    async _q(p) { const { data, error } = await p; if (error) { setSync("err"); throw error; } return data; },
    async items(list) { return Cloud._q(Cloud.sb.from("items").select("*").eq("list", list).order("created_at")); },
    async allItems() { return Cloud._q(Cloud.sb.from("items").select("list,text,done,created_at").order("created_at", { ascending: false }).limit(500)); },
    async addItem(list, text) { await Cloud._q(Cloud.sb.from("items").insert({ list, text })); },
    async updateItem(id, patch) { await Cloud._q(Cloud.sb.from("items").update(patch).eq("id", id)); },
    async deleteItems(ids) { if (ids.length) await Cloud._q(Cloud.sb.from("items").delete().in("id", ids)); },
    async chores() { return Cloud._q(Cloud.sb.from("chores").select("*").eq("active", true).order("sort")); },
    async addChore(c) { await Cloud._q(Cloud.sb.from("chores").insert(c)); },
    async deleteChore(id) { await Cloud._q(Cloud.sb.from("chores").update({ active: false }).eq("id", id)); },
    async updateChore(id, patch) { await Cloud._q(Cloud.sb.from("chores").update(patch).eq("id", id)); },
    async createEvent(ev) {
      const { data, error } = await Cloud.sb.functions.invoke("icloud-calendar", { body: { action: "create", event: ev } });
      let err = error && error.message; if (error) { try { err = (await error.context.json()).error || err; } catch (x) {} }
      if (err || (data && data.error)) throw new Error(err || data.error);
      return data;
    },
    async setHandoff(kind, payload) { await Cloud._q(Cloud.sb.from("handoff").upsert({ id: 1, kind, payload, created_at: new Date().toISOString() })); },
    async choreLog(from) { return Cloud._q(Cloud.sb.from("chore_log").select("*").gte("date", from)); },
    async toggleChore(chore_id, date) {
      const ex = await Cloud._q(Cloud.sb.from("chore_log").select("id").eq("chore_id", chore_id).eq("date", date));
      if (ex.length) await Cloud._q(Cloud.sb.from("chore_log").delete().eq("id", ex[0].id));
      else await Cloud._q(Cloud.sb.from("chore_log").insert({ chore_id, date }));
    },
    async events() {
      const { data, error } = await Cloud.sb.functions.invoke("icloud-calendar", { body: { days: C.CALENDAR_DAYS } });
      if (error) {
        let msg = error.message; try { const b = await error.context.json(); msg = b.error || msg; } catch (e) {}
        S.calError = msg; return S.events || [];
      }
      S.calError = null;
      if (data && data.calendars) S.calendars = data.calendars;
      if (data && data.error) { S.calError = data.error; return []; }
      if (data && !(data.calendars || []).length) S.calError = "Connected, but no calendars matched ICLOUD_CALENDARS. Calendars on the account: " + ((data.available || []).join(", ") || "none found");
      else if (data && !(data.events || []).length) S.calError = "Connected to " + data.calendars.join(", ") + " but found no events in the next " + C.CALENDAR_DAYS + " days.";
      return data.events || [];
    },
  };

  const DB = C.SUPABASE_URL && C.SUPABASE_ANON_KEY ? Cloud : Local;

  /* ---------------- chore schedules ----------------
     chore.days = original days; chore.schedule = [{from:"YYYY-MM-DD", days:[...]}] changes that apply from that date on.
     Past days keep whatever schedule was in force then. */
  function daysFor(c, ds) {
    let d = c.days || [];
    for (const s of (c.schedule || []).slice().sort((a, b) => (a.from < b.from ? -1 : 1))) if (s.from <= ds) d = s.days;
    return d;
  }
  function withSchedule(c, days) {
    const today = ymd(new Date());
    return [...(c.schedule || []).filter((s) => s.from !== today), { from: today, days }];
  }

  /* ---------------- state + render ---------------- */
  const S = { view: "home", events: [], weekStart: mondayOf(new Date()), manage: false, choreWeek: 0 };

  function setSync(s) { $("#sync").className = "sync " + (DB.mode === "demo" ? "demo" : s); }
  function toast(msg) { const t = document.createElement("div"); t.className = "toast"; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2200); }

  function evDate(e) { return e.allDay ? new Date(e.start + "T00:00:00") : new Date(e.start); }
  function eventsOn(day) {
    const d0 = startOfDay(day), d1 = addDays(d0, 1);
    return S.events.filter((e) => {
      const s = evDate(e), en = e.allDay ? new Date(e.end + "T00:00:00") : new Date(e.end || e.start);
      return s < d1 && (en > d0 || +s === +d0);
    }).sort((a, b) => (b.allDay - a.allDay) || (evDate(a) - evDate(b)));
  }
  const calColour = (name) => { let h = 0; for (const c of name || "") h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 70% 62%)`; };
  function evHTML(e) {
    const t = e.allDay ? "All day" : `${hm(new Date(e.start))}–${hm(new Date(e.end))}`;
    const loc = e.location ? `<div class="loc">📍 ${esc(e.location)}</div>` : "";
    const tap = e.location ? ` data-act="ev" data-i="${S.events.indexOf(e)}"` : "";
    return `<div class="ev ${e.location ? "has-loc" : ""}"${tap} style="--c:${calColour(e.calendar)}"><div class="t">${t}</div><div class="what"><div class="ttl">${esc(e.title)}</div>${loc}</div>${e.calendar ? `<div class="cal">${esc(e.calendar)}</div>` : ""}</div>`;
  }
  function dayLabel(d) {
    const t = startOfDay(new Date());
    const diff = Math.round((startOfDay(d) - t) / 864e5);
    const base = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
    return diff === 0 ? "Today · " + base : diff === 1 ? "Tomorrow · " + base : base;
  }

  // Background refreshes wait while someone is typing or a popup is open.
  let pending = false;
  function safeRender() {
    const a = document.activeElement;
    if ((a && a.tagName === "INPUT" && $("#main").contains(a)) || $("#pop")) { pending = true; return; }
    pending = false; render();
  }
  document.addEventListener("focusout", () => setTimeout(() => { if (pending) safeRender(); }, 300));

  async function render() {
    try {
      const v = S.view, m = $("#main");
      document.querySelectorAll(".rail button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
      if (v === "home") m.innerHTML = await viewHome();
      if (v === "calendar") m.innerHTML = viewWeek();
      if (v === "chores") m.innerHTML = await viewChores(false);
      if (v === "shopping" || v === "todo") m.innerHTML = await viewList(v, false);
      if (DB.mode === "demo") setSync("demo");
    } catch (e) {
      console.error(e);
      $("#main").innerHTML = `<div class="card"><h2>⚠️ Couldn't load</h2><p class="err">${esc(e.message || e)}</p><p class="empty">${esc(e.hint || e.details || e.code || "")}</p><button class="btn" onclick="location.reload()">Retry</button> <button class="btn" id="signout">Sign out</button></div>`;
      const so = $("#signout"); if (so && DB.sb) so.onclick = async () => { await DB.sb.auth.signOut(); location.reload(); };
    }
  }

  async function viewHome() {
    let days4 = "";
    for (let i = 0; i < 4; i++) {
      const d = addDays(new Date(), i), evs = eventsOn(d);
      days4 += `<div class="card dayc ${i === 0 ? "today" : ""}"><div class="day-h ${i === 0 ? "today" : ""}">${dayLabel(d)}<button class="addev" data-act="newev" data-date="${ymd(d)}">＋</button></div>${evs.length ? evs.map(evHTML).join("") : `<div class="empty">Nothing planned</div>`}</div>`;
    }
    const [chores, shop, todo] = await Promise.all([viewChores(true), viewList("shopping", true), viewList("todo", true)]);
    const calErr = S.calError ? `<p class="err">Calendar: ${esc(S.calError)}</p>` : "";
    return `<div class="grid2">
      <div class="col">${calErr}<div class="days4">${days4}</div></div>
      <div class="col">
        <div class="card">${chores}</div>
        <div class="card" style="flex:1">${shop}</div>
        <div class="card" style="flex:1">${todo}</div>
      </div></div>`;
  }

  function viewWeek() {
    const ws = S.weekStart, today = ymd(new Date());
    const row = (start) => {
      let c = "";
      for (let i = 0; i < 7; i++) {
        const d = addDays(start, i), evs = eventsOn(d);
        c += `<div class="d ${ymd(d) === today ? "today" : ""}"><h3 data-act="newev" data-date="${ymd(d)}">${DAYS[d.getDay()]} ${d.getDate()}${d.getDate() === 1 || i === 0 ? " " + d.toLocaleDateString("en-GB", { month: "short" }) : ""}</h3>${evs.map(evHTML).join("") || '<div class="empty">—</div>'}</div>`;
      }
      return `<div class="week">${c}</div>`;
    };
    const cols = row(ws) + row(addDays(ws, 7));
    const title = `${ws.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${addDays(ws, 13).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
    return `<div class="weeknav"><button class="btn" data-act="wk" data-n="-7">◀</button><button class="btn" data-act="wk" data-n="0">Today</button><button class="btn" data-act="wk" data-n="7">▶</button><h2>${title}</h2><button class="btn primary" data-act="newev" data-date="${ymd(new Date())}">＋ Add event</button></div>${S.calError ? `<p class="err">Calendar: ${esc(S.calError)}</p>` : ""}<div class="weeks">${cols}</div>`;
  }

  async function viewChores(mini) {
    const today = new Date(), tk = ymd(today), wd = today.getDay();
    const ws = mondayOf(today);
    const cs = addDays(ws, 7 * (mini ? 0 : S.choreWeek));   // week shown in the chart
    const [chores, log] = await Promise.all([DB.chores(), DB.choreLog(ymd(cs < ws ? cs : ws))]);
    const done = new Set(log.map((l) => l.chore_id + "|" + l.date));
    const todays = chores.filter((c) => daysFor(c, tk).includes(wd));
    const weekStars = log.filter((l) => l.date >= ymd(ws)).length;
    const tiles = todays.map((c) => `<button class="chore ${done.has(c.id + "|" + tk) ? "done" : ""}" data-act="chore" data-id="${c.id}"><div class="e">${esc(c.emoji)}</div><div class="n">${esc(c.name)}</div></button>`).join("") || `<div class="empty">No jobs today 🎉</div>`;
    const head = `<h2>⭐ ${esc(C.CHILD_NAME)}'s jobs today<span class="spacer"></span><span class="stars">${"★".repeat(Math.min(weekStars, 30))}</span><span class="pill">${weekStars} this week</span></h2>`;
    if (mini) return `<div class="mini">${head}<div class="chores">${tiles}</div></div>`;
    // weekly chart
    // In edit mode, any day up to today can be tapped to add/remove a star (fix mistaken stars).
    let rows = "";
    for (const c of chores) {
      const cells = [0, 1, 2, 3, 4, 5, 6].map((i) => { const d = addDays(cs, i), ds = ymd(d); return { ds, v: done.has(c.id + "|" + ds) ? "⭐" : daysFor(c, ds).includes(d.getDay()) ? "○" : "·" }; });
      if (cells.every((x) => x.v === "·")) continue; // not scheduled that week
      rows += `<tr><td>${esc(c.emoji)} ${esc(c.name)}</td>${cells.map((x) => S.manage && x.ds <= tk
        ? `<td><button class="cellb" data-act="star" data-id="${c.id}" data-date="${x.ds}">${x.v}</button></td>` : `<td>${x.v}</td>`).join("")}</tr>`;
    }
    const wkLabel = S.choreWeek === 0 ? "This week" : S.choreWeek === -1 ? "Last week" : `w/c ${cs.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
    const nav = `<button class="btn sm" data-act="cwk" data-n="-1">◀</button><button class="btn sm" data-act="cwk" data-n="1" ${S.choreWeek >= 0 ? "disabled" : ""}>▶</button>`;
    const chart = (S.manage ? `<p class="empty">Tap a ⭐ or ○ to correct it (today and earlier).</p>` : "") +
      `<table class="wk"><tr><th>${nav} ${wkLabel}</th>${[0, 1, 2, 3, 4, 5, 6].map((i) => { const d = addDays(cs, i); return `<th>${DAYS[d.getDay()]} ${d.getDate()}</th>`; }).join("")}</tr>${rows}</table>`;
    let manage = `<button class="btn" data-act="manage">${S.manage ? "Done" : "Edit jobs"}</button>`;
    if (S.manage) {
      const dayBtns = (scope, on) => [1, 2, 3, 4, 5, 6, 0].map((d) => `<button class="dayt ${on.includes(d) ? "on" : ""}" data-act="dayt" data-scope="${scope}" data-d="${d}">${DAYS[d]}</button>`).join("");
      manage += `<div class="manage card"><p class="empty">Day changes apply from today onwards. Past stars and days stay as they were.</p>` +
        chores.filter((c) => daysFor(c, tk).length).map((c) => `<div class="row"><span style="min-width:190px">${esc(c.emoji)} ${esc(c.name)}</span>${dayBtns(c.id, daysFor(c, tk))}<span style="flex:1"></span><button class="btn primary" data-act="savechore" data-id="${c.id}">Save</button><button class="btn" data-act="delchore" data-id="${c.id}">Remove</button></div>`).join("") +
        `<div class="row"><input id="cEmoji" placeholder="🧹" style="width:70px"><input id="cName" placeholder="New job" style="width:120px">` + dayBtns("new", [0, 1, 2, 3, 4, 5, 6]) +
        `<span style="flex:1"></span><button class="btn primary" data-act="addchore">Add</button></div></div>`;
    }
    return `<div class="card">${head}<div class="chores">${tiles}</div></div><div class="card" style="margin-top:18px">${chart}</div><div class="manage">${manage}</div>`;
  }

  async function viewList(list, mini) {
    const items = await DB.items(list);
    const open = items.filter((i) => !i.done), ticked = items.filter((i) => i.done);
    const title = list === "shopping" ? "🛒 Shopping" : "✅ To-do";
    if (list === "shopping") S.shopOpen = open.map((i) => i.text);
    const row = (i) => `<div class="item ${i.done ? "done" : ""}" data-act="tick" data-id="${i.id}" data-done="${i.done}"><div class="tick">${i.done ? "✓" : ""}</div><div class="txt">${esc(i.text)}</div>${mini ? "" : `<button class="del" data-act="del" data-id="${i.id}">✕</button>`}</div>`;
    if (mini) {
      return `<h2>${title}<span class="spacer"></span><span class="pill">${open.length} left</span></h2>` +
        (open.slice(0, 6).map(row).join("") || `<div class="empty">All done</div>`) + (open.length > 6 ? `<div class="empty">+${open.length - 6} more</div>` : "");
    }
    // Quick-add chips: most frequently added shopping items not already on the list
    let chips = "";
    if (list === "shopping") {
      const all = await DB.allItems(), counts = {}, onList = new Set(open.map((i) => i.text.toLowerCase()));
      all.filter((i) => i.list === "shopping").forEach((i) => { const k = i.text.trim().toLowerCase(); counts[k] = (counts[k] || 0) + 1; });
      const top = Object.entries(counts).filter(([k]) => !onList.has(k)).sort((a, b) => b[1] - a[1]).slice(0, 12);
      if (top.length) chips = `<div class="chips">${top.map(([k]) => `<button class="chip" data-act="quick" data-t="${esc(k)}">+ ${esc(k)}</button>`).join("")}</div>`;
    }
    const exp = list === "shopping" && open.length ? `<button class="btn" data-act="qr" data-kind="shop">📱 Send to phone</button> <button class="btn primary" data-act="export">📤 Export to Notes</button> ` : "";
    return `<div class="card"><h2>${title}<span class="spacer"></span>${exp}${ticked.length ? `<button class="btn" data-act="clear" data-list="${list}">Clear ticked (${ticked.length})</button>` : ""}</h2>
      <form class="addrow" data-list="${list}"><input name="t" placeholder="${list === "shopping" ? "Add item…" : "Add a to-do…"}" autocomplete="off" enterkeyhint="done"><button class="btn primary">Add</button></form>
      ${chips}${open.map(row).join("")}${ticked.map(row).join("")}</div>`;
  }

  /* ---------------- events ---------------- */
  document.addEventListener("click", async (e) => {
    const nav = e.target.closest(".rail button");
    if (nav) { S.view = nav.dataset.view; S.manage = false; S.choreWeek = 0; if (S.view === "calendar") S.weekStart = mondayOf(new Date()); return render(); }
    const a = e.target.closest("[data-act]"); if (!a) return;
    const act = a.dataset.act, id = a.dataset.id;
    if (act === "del") { e.stopPropagation(); await DB.deleteItems([id]); }
    else if (act === "tick") await DB.updateItem(id, { done: a.dataset.done !== "true" });
    else if (act === "clear") { const it = await DB.items(a.dataset.list); await DB.deleteItems(it.filter((i) => i.done).map((i) => i.id)); }
    else if (act === "quick") { await DB.addItem("shopping", a.dataset.t.replace(/^./, (c) => c.toUpperCase())); toast("Added " + a.dataset.t); }
    else if (act === "chore") { await DB.toggleChore(id, ymd(new Date())); if (!a.classList.contains("done")) cheer(); }
    else if (act === "wk") { S.weekStart = +a.dataset.n === 0 ? mondayOf(new Date()) : addDays(S.weekStart, +a.dataset.n); }
    else if (act === "manage") S.manage = !S.manage;
    else if (act === "dayt") { a.classList.toggle("on"); return; }
    else if (act === "savechore" || act === "delchore") {
      const c = (await DB.chores()).find((x) => x.id === id); if (!c) return;
      const days = act === "delchore" ? [] : [...document.querySelectorAll(`.dayt.on[data-scope="${id}"]`)].map((b) => +b.dataset.d);
      await DB.updateChore(id, { schedule: withSchedule(c, days) });
      toast(act === "delchore" ? `Removed ${c.name} from today on` : `${c.name} updated from today`);
    }
    else if (act === "export") { exportShopping(); return; }
    else if (act === "ev") { showTravel(S.events[+a.dataset.i]); return; }
    else if (act === "closepop") { $("#pop").remove(); if (pending) safeRender(); return; }
    else if (act === "noop") return;
    else if (act === "forecast") { showForecast(); return; }
    else if (act === "themes") { showThemes(); return; }
    else if (act === "settheme") { setTheme(a.dataset.t); showThemes(); return; }
    else if (act === "newev") { showNewEvent(a.dataset.date); return; }
    else if (act === "allday") { const on = a.classList.toggle("on"); document.querySelectorAll(".evtime").forEach((x) => (x.style.display = on ? "none" : "")); return; }
    else if (act === "saveev") { saveNewEvent(a); return; }
    else if (act === "star") await DB.toggleChore(id, a.dataset.date);
    else if (act === "cwk") S.choreWeek = Math.min(0, S.choreWeek + +a.dataset.n);
    else if (act === "qr") { showQR(a.dataset.kind, a.dataset.mode); return; }
    else if (act === "addchore") {
      const name = $("#cName").value.trim(); if (!name) return;
      const days = [...document.querySelectorAll('.dayt.on[data-scope="new"]')].map((b) => +b.dataset.d);
      await DB.addChore({ name, emoji: $("#cEmoji").value.trim() || "⭐", days });
    }
    render();
  });
  document.addEventListener("submit", async (e) => {
    const f = e.target.closest(".addrow"); if (!f) return;
    e.preventDefault(); const t = f.t.value.trim(); if (!t) return;
    await DB.addItem(f.dataset.list, t); f.t.value = ""; await render();
    const inp = document.querySelector(`.addrow[data-list="${f.dataset.list}"] input`); inp && inp.focus();
  });

  // Share sheet -> Notes. Must run synchronously inside the tap, so it uses the list already on screen.
  function exportShopping() {
    const items = S.shopOpen || []; if (!items.length) return;
    const title = "Shopping " + new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    const text = title + "\n" + items.join("\n");
    if (navigator.share) navigator.share({ text }).catch(() => {});
    else if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast("Copied – paste into Notes"));
  }

  /* ---------------- travel time popup ---------------- */
  const dur = (s) => { const m = Math.round(s / 60); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const dist = (m) => m == null ? "" : ` · ${(m / 1609.34).toFixed(m < 16093 ? 1 : 0)} mi`;
  async function showTravel(e) {
    if (!e) return;
    const old = $("#pop"); if (old) old.remove();
    const when = e.allDay ? "All day" : `${dayLabel(new Date(e.start)).split(" · ")[0]} · ${hm(new Date(e.start))}–${hm(new Date(e.end))}`;
    const q = encodeURIComponent(e.location);
    const el = document.createElement("div");
    el.id = "pop"; el.className = "pop"; el.dataset.act = "closepop";
    el.innerHTML = `<div class="popc" data-act="noop">
      <h2>${esc(e.title)}</h2><div class="empty">${esc(when)}</div><div class="loc">📍 ${esc(e.location)}</div>
      <div id="trav" class="trav"><div class="empty">Working out journey times…</div></div>
      <div id="qrbox"></div>
      <div class="popb"><a class="btn" href="https://maps.apple.com/?daddr=${q}&dirflg=d">Open in Maps</a><button class="btn" data-act="qr" data-kind="map" data-mode="d">📱 Send route to phone</button><button class="btn primary" data-act="closepop">Close</button></div></div>`;
    S.popEvent = e;
    document.body.appendChild(el);
    let html;
    if (DB.mode === "demo") {
      html = `<div class="mode">🚗 <b>18 min</b> <span>(demo)</span></div><div class="mode">🚶 <b>1 h 5 min</b> <span>(demo)</span></div>`;
    } else {
      const arriveBy = e.allDay ? null : e.start;
      const { data, error } = await DB.sb.functions.invoke("travel", { body: { destination: e.location, lat: e.lat, lon: e.lon, arriveBy } });
      let err = error && error.message; if (error) { try { err = (await error.context.json()).error || err; } catch (x) {} }
      if (err || !data) html = `<p class="err">${esc(err || "No route found")}</p>`;
      else {
        const d = data.drive, w = data.walk;
        const leave = d && arriveBy && new Date(arriveBy) > new Date() ? `<div class="leave">Leave by <b>${hm(new Date(new Date(arriveBy) - d.seconds * 1000 - 5 * 60000))}</b> to arrive 5 min early</div>` : "";
        const traffic = d && d.noTrafficSeconds && d.seconds - d.noTrafficSeconds >= 120 ? ` <span class="warn">+${dur(d.seconds - d.noTrafficSeconds)} traffic</span>` : "";
        html = (d ? `<div class="mode">🚗 <b>${dur(d.seconds)}</b><span>${dist(d.meters)}</span>${traffic}</div>` : `<div class="mode">🚗 <span>No driving route</span></div>`) +
          (w ? `<div class="mode">🚶 <b>${dur(w.seconds)}</b><span>${dist(w.meters)}</span></div>` : `<div class="mode">🚶 <span>No walking route</span></div>`) + leave;
      }
    }
    const t = $("#trav"); if (t) t.innerHTML = html;
  }

  /* ---------------- send to phone (QR) ----------------
     Scan with the iPhone camera. Map -> opens Apple Maps with the route from where you are.
     Shopping -> opens share.html with the list inside the link itself (nothing stored online), one tap to Notes. */
  function qrSVG(text) {
    const q = qrcode(0, "L"); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
  }
  // Shopping lines -> URL that runs the "Hub Shopping" Shortcut (adds each item to Reminders with tick boxes)
  function showQR(kind, mode) {
    const tapHint = `<p class="nfc">📲 Tap your iPhone on the <b>NFC tag</b> on the hub, or scan:</p>`;
    if (kind === "map") {
      const e = S.popEvent; if (!e) return;
      const dest = e.lat != null && e.lon != null ? `${e.lat},${e.lon}` : e.location;
      const url = `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}&dirflg=${mode}`;
      DB.setHandoff("map", { title: e.title, location: e.location, dest, mode }).catch(() => {});
      const extra = `<div class="qrmodes"><button class="btn sm ${mode === "d" ? "primary" : ""}" data-act="qr" data-kind="map" data-mode="d">🚗 Drive</button><button class="btn sm ${mode === "w" ? "primary" : ""}" data-act="qr" data-kind="map" data-mode="w">🚶 Walk</button></div>`;
      $("#qrbox").innerHTML = `<div class="qr">${qrSVG(url)}<div>${tapHint}<p class="empty">Opens the route in Apple Maps from wherever you are.</p>${extra}</div></div>`;
      return;
    }
    const items = S.shopOpen || []; if (!items.length) return;
    const head = "Shopping " + new Date().toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    DB.setHandoff("shop", { title: head, items }).catch(() => {});
    const url = new URL("share.html", location.href).href + "#" + encodeURIComponent(head + "\n" + items.join("\n"));
    const el = document.createElement("div");
    el.id = "pop"; el.className = "pop"; el.dataset.act = "closepop";
    el.innerHTML = `<div class="popc" data-act="noop"><h2>📱 Shopping list to phone</h2>
      <div class="qr">${qrSVG(url)}<div>${tapHint}<p class="empty">Then tap <b>Add to Reminders</b> for a tick-box list. ${items.length} items.</p></div></div>
      <div class="popb"><button class="btn primary" data-act="closepop">Close</button></div></div>`;
    document.body.appendChild(el);
  }

  /* ---------------- add event (writes to iCloud, syncs to everyone's phones) ---------------- */
  function showNewEvent(date) {
    const old = $("#pop"); if (old) old.remove();
    const n = new Date(); const h = Math.min(22, n.getHours() + 1);
    const cals = (S.calendars || []).map((c) => `<option>${esc(c)}</option>`).join("");
    const el = document.createElement("div");
    el.id = "pop"; el.className = "pop"; el.dataset.act = "closepop";
    el.innerHTML = `<div class="popc evform" data-act="noop"><h2>＋ New event</h2>
      <input id="evTitle" placeholder="What?" autocomplete="off">
      <div class="r"><input id="evDate" type="date" value="${date || ymd(n)}"><button class="dayt" data-act="allday">All day</button></div>
      <div class="r evtime"><label>From <input id="evStart" type="time" value="${pad(h)}:00"></label><label>to <input id="evEnd" type="time" value="${pad(h + 1)}:00"></label></div>
      <input id="evLoc" placeholder="Where? (optional)" autocomplete="off">
      ${cals ? `<div class="r"><label>Calendar <select id="evCal">${cals}</select></label></div>` : ""}
      <p id="evErr" class="err"></p>
      <div class="popb"><button class="btn" data-act="closepop">Cancel</button><button class="btn primary" data-act="saveev">Add to calendar</button></div></div>`;
    document.body.appendChild(el);
    // keep end an hour after start unless changed by hand
    $("#evStart").addEventListener("change", (e) => { const [hh, mm] = e.target.value.split(":").map(Number); $("#evEnd").value = `${pad(Math.min(23, hh + 1))}:${pad(mm)}`; });
    setTimeout(() => $("#evTitle").focus(), 50);
  }
  async function saveNewEvent(btn) {
    const title = $("#evTitle").value.trim(), date = $("#evDate").value, allDay = document.querySelector('[data-act="allday"]').classList.contains("on");
    if (!title || !date) { $("#evErr").textContent = "Add a title and date."; return; }
    let start, end;
    if (allDay) { start = date; end = ymd(addDays(new Date(date + "T12:00:00"), 1)); }
    else {
      start = new Date(`${date}T${$("#evStart").value}:00`); end = new Date(`${date}T${$("#evEnd").value}:00`);
      if (end <= start) end = new Date(+start + 3600000);
      start = start.toISOString(); end = end.toISOString();
    }
    const ev = { title, start, end, allDay, location: $("#evLoc").value.trim() || undefined, calendar: $("#evCal") ? $("#evCal").value : undefined };
    btn.disabled = true; btn.textContent = "Adding…";
    try {
      await DB.createEvent(ev);
      $("#pop").remove(); toast("Added – it'll appear on your phones shortly");
      S.events = [...S.events, ev]; render();   // show it straight away
      setTimeout(loadEvents, 4000);              // then refresh from iCloud
    } catch (e) { $("#evErr").textContent = e.message; btn.disabled = false; btn.textContent = "Add to calendar"; }
  }

  /* ---------------- 7-day forecast popup ---------------- */
  const WDESC = (c) => c === 0 ? "Clear" : c <= 2 ? "Partly cloudy" : c === 3 ? "Cloudy" : c <= 48 ? "Fog" : c <= 57 ? "Drizzle" : c <= 67 ? "Rain" : c <= 77 ? "Snow" : c <= 82 ? "Showers" : c <= 86 ? "Snow showers" : "Thunderstorms";
  function showForecast() {
    const w = S.weather; if (!w || !w.daily) return;
    const d = w.daily, t = (x) => x.slice(11, 16);
    const lo = Math.min(...d.temperature_2m_min), hi = Math.max(...d.temperature_2m_max), span = Math.max(1, hi - lo);
    let rows = "";
    for (let i = 0; i < d.time.length; i++) {
      const day = new Date(d.time[i] + "T12:00:00");
      const mn = d.temperature_2m_min[i], mx = d.temperature_2m_max[i];
      const bar = `<div class="tbar"><i style="left:${((mn - lo) / span) * 100}%;width:${Math.max(6, ((mx - mn) / span) * 100)}%"></i></div>`;
      rows += `<tr><td class="fd">${i === 0 ? "Today" : DAYS[day.getDay()] + " " + day.getDate()}</td><td class="fi">${WMO(d.weather_code[i])}</td><td class="fx">${WDESC(d.weather_code[i])}</td>
        <td class="ft">${Math.round(mn)}°</td><td class="fb">${bar}</td><td class="ft"><b>${Math.round(mx)}°</b></td>
        <td class="fr">☔ ${d.precipitation_probability_max[i]}%<span>${d.precipitation_sum[i] ? " · " + d.precipitation_sum[i].toFixed(1) + " mm" : ""}</span></td>
        <td class="fw">💨 ${Math.round(d.wind_speed_10m_max[i])} mph<span> · gusts ${Math.round(d.wind_gusts_10m_max[i])}</span></td></tr>`;
    }
    const c = w.current;
    const el = document.createElement("div");
    el.id = "pop"; el.className = "pop"; el.dataset.act = "closepop";
    el.innerHTML = `<div class="popc wide" data-act="noop"><h2>${WMO(c.weather_code)} ${Math.round(c.temperature_2m)}° now · ${WDESC(c.weather_code)}</h2>
      <p class="empty">Feels like ${Math.round(c.apparent_temperature)}° · wind ${Math.round(c.wind_speed_10m)} mph · sunrise ${t(d.sunrise[0])} · sunset ${t(d.sunset[0])} · UV ${Math.round(d.uv_index_max[0])}</p>
      <table class="fc">${rows}</table>
      <div class="popb"><button class="btn primary" data-act="closepop">Close</button></div></div>`;
    document.body.appendChild(el);
  }

  /* ---------------- themes (saved on each device separately) ---------------- */
  const THEMES = [
    { id: "midnight", name: "Midnight", sw: ["#14171c", "#1d2128", "#5fb3ff", "#ffd54a"] },
    { id: "daylight", name: "Daylight", sw: ["#f3f5f8", "#ffffff", "#2f7de1", "#f2b705"] },
    { id: "playtime", name: "Playtime", sw: ["#7cc6ef", "#fffaf0", "#ff8a3d", "#ffc93c"] },
    { id: "garden", name: "Garden", sw: ["#1a2a20", "#22362a", "#8fd16a", "#ffd84a"] },
  ];
  function setTheme(t) {
    try { localStorage.setItem("hub_theme", t); } catch (e) {}
    document.body.dataset.theme = t;
    const m = document.querySelector('meta[name="theme-color"]'); const th = THEMES.find((x) => x.id === t);
    if (m && th) m.content = th.sw[0];
  }
  function showThemes() {
    const cur = document.body.dataset.theme || "midnight";
    const old = $("#pop"); if (old) old.remove();
    const el = document.createElement("div");
    el.id = "pop"; el.className = "pop"; el.dataset.act = "closepop";
    el.innerHTML = `<div class="popc" data-act="noop"><h2>🎨 Theme</h2><p class="empty">Saved on this device only.</p><div class="themes">` +
      THEMES.map((t) => `<button class="theme ${t.id === cur ? "on" : ""}" data-act="settheme" data-t="${t.id}" style="background:${t.sw[1]};color:${t.id === "midnight" || t.id === "garden" ? "#eef1f5" : "#1f2a3a"}">${t.name}<span class="sw">${t.sw.map((c) => `<i style="background:${c}"></i>`).join("")}</span></button>`).join("") +
      `</div><div class="popb"><button class="btn primary" data-act="closepop">Done</button></div></div>`;
    document.body.appendChild(el);
  }
  try { setTheme(localStorage.getItem("hub_theme") || "midnight"); } catch (e) {}

  function cheer() {
    const el = document.createElement("div");
    el.textContent = "⭐"; el.style.cssText = "position:fixed;left:50%;top:50%;font-size:160px;transform:translate(-50%,-50%) scale(.2);transition:all .7s cubic-bezier(.2,1.6,.4,1);z-index:80;pointer-events:none";
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.transform = "translate(-50%,-50%) scale(1)"; });
    setTimeout(() => { el.style.opacity = "0"; el.style.transform = "translate(-50%,-160%) scale(.6)"; }, 650);
    setTimeout(() => el.remove(), 1400);
  }

  /* ---------------- clock, weather, screensaver ---------------- */
  function tick() {
    const n = new Date();
    $("#time").textContent = hm(n);
    $("#date").textContent = n.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    $("#saverTime").textContent = hm(n);
    $("#saverDate").textContent = $("#date").textContent;
    const next = S.events.filter((e) => !e.allDay && new Date(e.start) > n).sort((a, b) => new Date(a.start) - new Date(b.start))[0];
    $("#saverNext").textContent = next ? `Next: ${next.title} · ${dayLabel(new Date(next.start)).split(" · ")[0]} ${hm(new Date(next.start))}` : "";
    if (ymd(n) !== S.lastDay) { S.lastDay = ymd(n); render(); } // roll over at midnight
    checkIdle();
  }

  const WMO = (c) => c === 0 ? "☀️" : c <= 2 ? "🌤️" : c === 3 ? "☁️" : c <= 48 ? "🌫️" : c <= 57 ? "🌦️" : c <= 67 ? "🌧️" : c <= 77 ? "🌨️" : c <= 82 ? "🌧️" : c <= 86 ? "🌨️" : "⛈️";
  async function weather() {
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${C.LAT}&longitude=${C.LON}&current=temperature_2m,weather_code,apparent_temperature,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,sunrise,sunset,uv_index_max&wind_speed_unit=mph&timezone=Europe%2FLondon&forecast_days=7`;
      const w = await (await fetch(u)).json();
      S.weather = w;
      let h = `<span class="now">${WMO(w.current.weather_code)} ${Math.round(w.current.temperature_2m)}°</span>`;
      for (let i = 0; i < 4; i++) {
        const d = new Date(w.daily.time[i] + "T12:00:00");
        h += `<div class="day">${i === 0 ? "Today" : DAYS[d.getDay()]}<br>${WMO(w.daily.weather_code[i])} ${Math.round(w.daily.temperature_2m_max[i])}°/${Math.round(w.daily.temperature_2m_min[i])}°<br>☔ ${w.daily.precipitation_probability_max[i]}%</div>`;
      }
      $("#weather").innerHTML = h;
      $("#weather").dataset.act = "forecast";
    } catch (e) { console.warn("weather", e); }
  }

  async function loadEvents() { try { S.events = await DB.events(); safeRender(); } catch (e) { console.warn(e); } }

  // Self-update: if a newer version has been published, reload (only when nobody is mid-task).
  async function checkVersion() {
    try {
      const v = (await (await fetch("version.json?t=" + Date.now(), { cache: "no-store" })).json()).v;
      if (v && v !== APP_VERSION && !pending && !$("#pop")) location.replace(location.pathname + "?v=" + v);
    } catch (e) {}
  }

  let lastTouch = Date.now();
  const minsOf = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  function isNight() { const n = new Date(), m = n.getHours() * 60 + n.getMinutes(), a = minsOf(C.NIGHT_START), b = minsOf(C.NIGHT_END); return a > b ? m >= a || m < b : m >= a && m < b; }
  const isPhone = () => window.matchMedia("(max-width: 760px)").matches;
  function checkIdle() {
    if (isPhone()) { $("#saver").classList.add("hidden"); return; } // clock screen is for the wall hub only
    const idle = Date.now() - lastTouch > C.IDLE_MINUTES * 60000;
    $("#saver").classList.toggle("hidden", !(idle || (isNight() && Date.now() - lastTouch > 60000)));
  }
  function wake() { lastTouch = Date.now(); $("#saver").classList.add("hidden"); }
  ["touchstart", "mousedown", "keydown"].forEach((ev) => document.addEventListener(ev, wake, { passive: true }));
  window.hubWake = wake; // hook for presence sensor (phase 3)

  // Ask the browser to keep the screen on (supported in recent iPadOS Safari; Guided Access is the backstop).
  async function keepAwake() { try { if ("wakeLock" in navigator) await navigator.wakeLock.request("screen"); } catch (e) {} }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) keepAwake(); });

  /* ---------------- boot ---------------- */
  (async function boot() {
    setSync("");
    await DB.init();
    DB.subscribe(safeRender);
    keepAwake();
    tick(); setInterval(tick, 1000 * 15);
    weather(); setInterval(weather, 30 * 60000);
    await loadEvents(); setInterval(loadEvents, C.CALENDAR_REFRESH_MIN * 60000);
    setInterval(safeRender, 60000);                 // safety net: re-read lists/chores every minute
    setInterval(checkVersion, 5 * 60000);           // pick up new releases automatically
    setInterval(() => { const n = new Date(); if (n.getHours() === 3 && n.getMinutes() < 5) location.reload(); }, 5 * 60000); // fresh start nightly
    render();
  })();
})();
