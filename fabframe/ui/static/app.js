// fabframe UI: 3D fab first, controls on the side, details in dialogs.
// Data-derived text is always inserted with textContent.

import { FabScene, decodeReplay, STATE_NAMES } from "./fab3d.js";

const TOKEN = document.querySelector('meta[name="fabframe-token"]').content;
const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (sel) => document.querySelector(sel);
const DS_PER_DAY = 864000;
const SPEED_MIN = 1, SPEED_MAX = 86400;              // sim seconds per real second
const RUN_ICON = { done: "✓", failed: "✕", cancelled: "⊘", interrupted: "!", queued: "…", running: "•" };
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

const state = {
  dispatchers: [], runs: [], selected: null, dataset: "HVLM", layoutDataset: null,
  replayRun: null, editor: null, detailTab: "daily", detail: null, pollTimer: null, loading: null,
  replayFailed: new Set(), hashUsed: false, progressHint: null, runsKey: "",
};
const player = { T: 0, end: 0, playing: false, speed: 1800, dir: 1, last: 0, hudAt: 0 };

/* ------------------------------------------------------------ helpers */

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
function icon(name) {
  const s = document.createElementNS(SVG_NS, "svg");
  const u = document.createElementNS(SVG_NS, "use");
  u.setAttribute("href", "#i-" + name);
  s.append(u);
  s.setAttribute("aria-hidden", "true");
  return s;
}
function svg(tag, attrs, parent) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  if (parent) parent.append(n);
  return n;
}
async function api(path, { method = "GET", body } = {}) {
  const o = { method, headers: {} };
  if (method !== "GET") {
    o.headers["X-Fabframe-Token"] = TOKEN;
    o.headers["Content-Type"] = "application/json";
    o.body = JSON.stringify(body || {});
  }
  const r = await fetch(path, o);
  let d;
  try { d = await r.json(); } catch { d = { error: "Phản hồi không hợp lệ" }; }
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}
const nf = (d) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: d });
const num = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? "–" : nf(d).format(v));
const pct = (v) => (v === null || v === undefined ? "–" : nf(1).format(v * 100) + "%");
function clock(T) {
  // the end of an N-day replay is "day N, 24:00", not day N+1
  const lastDay = Math.max(1, Math.ceil(player.end / DS_PER_DAY));
  let day = Math.floor(T / DS_PER_DAY) + 1, sec = Math.floor((T % DS_PER_DAY) / 10);
  if (day > lastDay) { day = lastDay; sec = Math.round((T - (lastDay - 1) * DS_PER_DAY) / 10); }
  const hh = String(Math.floor(sec / 3600)).padStart(2, "0"), mm = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  return "Ngày " + day + " · " + hh + ":" + mm;
}

/* ------------------------------------------------------------- 3D + player */

const tip = $("#tip");
const QUALITY_NAMES = { high: "Cao", medium: "Vừa", low: "Nhẹ" };
const scene = new FabScene($("#canvas-host"), $("#labels"), { onHover: showTip, onQuality: showQuality });

function showQuality(q, auto) {
  $("#quality-label").textContent = QUALITY_NAMES[q];
  $("#quality").title = "Chất lượng hình: " + QUALITY_NAMES[q].toLowerCase() + (auto ? " (tự hạ vì máy chậm)" : "") + " · bấm để đổi";
  $("#quality").setAttribute("aria-label", "Chất lượng hình: " + QUALITY_NAMES[q].toLowerCase());
}
$("#quality").addEventListener("click", () => {
  const order = ["high", "medium", "low"];
  scene.setQuality(order[(order.indexOf(scene.quality) + 1) % order.length]);
  // only a choice the user made is remembered, not an automatic downgrade
  try { localStorage.setItem("fabframe-quality", scene.quality); } catch { /* ignore */ }
});
try {
  const q = localStorage.getItem("fabframe-quality");
  if (q && q !== "high") scene.setQuality(q);
} catch { /* ignore */ }

// the tooltip must live inside an open modal dialog (top layer) to be seen
function tipHost(host) { if (tip.parentElement !== host) host.append(tip); }

function showTip(h) {
  if (!h || (!h.familyInfo && !h.bayInfo)) { tip.hidden = true; return; }
  tipHost($("#stage"));
  const rows = [];
  if (h.kind === "machine") {
    rows.push(el("div", { class: "t1" }, h.familyInfo.name));
    if (h.state !== null && h.state !== undefined) {
      rows.push(el("div", { class: "t2" }, el("i", { class: "dot st" + h.state }), STATE_NAMES[h.state]));
    }
    rows.push(el("div", { class: "t2 muted" }, (h.bayInfo ? h.bayInfo.label + " · " : "") + "máy " + h.machine + (h.familyInfo.batch ? " · batch" : "")));
    if (h.lots) rows.push(el("div", { class: "t2" }, el("i", { class: "foup-ico" }), num(h.lots) + " lot → " + h.next));
  } else {
    rows.push(el("div", { class: "t1" }, h.bayInfo.label));
    rows.push(el("div", { class: "t2 muted" }, num(h.bayInfo.machines) + " máy"));
  }
  if (h.bayInfo && h.bayInfo.queue !== null && h.bayInfo.queue !== undefined) rows.push(el("div", { class: "t2" }, "Chờ: " + num(h.bayInfo.queue) + " lot"));
  tip.replaceChildren(...rows);
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = h.x + 14, y = h.y + 14;
  if (x + r.width > innerWidth - 8) x = h.x - r.width - 14;
  if (y + r.height > innerHeight - 8) y = h.y - r.height - 14;
  tip.style.left = x + "px";
  tip.style.top = y + "px";
}

function setPlaying(on) {
  player.playing = on && !!scene.replay;
  scene.setPlaying(player.playing);             // stack-light effects run only while playing
  const b = $("#play");
  b.replaceChildren(icon(player.playing ? "pause" : "play"));
  b.setAttribute("aria-label", player.playing ? "Tạm dừng" : "Phát");
  player.last = 0;
}

function updateHud(sum, force) {
  const now = performance.now();
  if (!force && now - player.hudAt < 120) return;
  player.hudAt = now;
  if (!sum) {
    for (const id of ["k-done", "k-rate", "k-cqt", "k-wip"]) $("#" + id).textContent = "–";
    for (let i = 0; i < 5; i++) $("#c" + i).textContent = "";
    return;
  }
  const days = sum.t / DS_PER_DAY;
  $("#k-done").textContent = num(sum.completed);
  $("#k-rate").textContent = days >= 0.25 ? num(sum.completed / days, 1) : "–";
  $("#k-cqt").textContent = num(sum.cqt);
  $("#k-wip").textContent = num(sum.wip);
  for (let i = 0; i < 5; i++) $("#c" + i).textContent = num(sum.counts[i]);
  $("#clock").textContent = clock(sum.t);
  const scrub = $("#scrub");
  if (!player.scrubbing) scrub.value = String(Math.round((sum.t / Math.max(1, player.end)) * 1000));
  scrub.setAttribute("aria-valuetext", clock(sum.t));
}

function frame(ts) {
  requestAnimationFrame(frame);
  if (!player.playing || !scene.replay) { player.last = ts; return; }
  const dt = player.last ? Math.min(0.1, (ts - player.last) / 1000) : 0;
  player.last = ts;
  player.T = Math.max(0, Math.min(player.end, player.T + dt * player.speed * player.dir * 10));
  if (player.dir > 0 && player.T >= player.end) setPlaying(false);
  if (player.dir < 0 && player.T <= 0) setPlaying(false);
  updateHud(scene.setTime(player.T), !player.playing);
}
requestAnimationFrame(frame);

window.fabframe = { scene, player };          // for the browser console

function togglePlay() {
  if (!scene.replay) return;
  if (!player.playing && player.dir > 0 && player.T >= player.end) player.T = 0;
  if (!player.playing && player.dir < 0 && player.T <= 0) player.T = player.end;
  setPlaying(!player.playing);
}
function seek(T) {
  if (!scene.replay) return;
  player.T = Math.max(0, Math.min(player.end, T));
  updateHud(scene.setTime(player.T), true);
}
$("#play").addEventListener("click", togglePlay);
$("#restart").addEventListener("click", () => { if (scene.replay) { player.T = 0; updateHud(scene.setTime(0, { force: true }), true); } });
$("#back").addEventListener("click", (e) => seek(player.T - (e.shiftKey ? DS_PER_DAY : 36000)));
$("#fwd").addEventListener("click", (e) => seek(player.T + (e.shiftKey ? DS_PER_DAY : 36000)));
$("#scrub").addEventListener("input", (e) => seek((Number(e.target.value) / 1000) * player.end));
// while the thumb is held the playhead must not fight the pointer
$("#scrub").addEventListener("pointerdown", () => { player.scrubbing = true; });
for (const ev of ["pointerup", "pointercancel"]) addEventListener(ev, () => { player.scrubbing = false; });

/* speed: any value from real time to 1 day per second, forwards or backwards */
const UNITS = [[86400, "n"], [3600, "h"], [60, "p"], [1, "s"]];
function speedLabel(v) {
  if (v === 1) return "×1";
  for (const [size, u] of UNITS) {
    if (v >= size) {
      const n = v / size;
      return (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString("vi-VN") + u + "/s";
    }
  }
  return v.toLocaleString("vi-VN") + "s/s";
}
// the card's title: a named tier; the subtitle: the exact speed in words
const TIERS = [[21600, "Siêu tốc"], [3600, "Rất nhanh"], [600, "Nhanh"], [60, "Vừa"], [2, "Chậm"], [0, "Thời gian thực"]];
const speedTier = (v) => TIERS.find(([from]) => v >= from)[1];
const LONG_UNITS = [[86400, "ngày"], [3600, "giờ"], [60, "phút"], [1, "giây"]];
function speedWords(v, short) {
  const [size, u] = LONG_UNITS.find(([s]) => v >= s) || [1, "giây"];
  const n = (Math.round((v / size) * 100) / 100).toLocaleString("vi-VN") + " " + u;
  return short ? n + " / giây" : n + " mô phỏng mỗi giây";
}
const toRange = (v) => Math.round((Math.log(v / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN)) * 1000);
const fromRange = (r) => {
  const v = SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, r / 1000);
  // snap to a readable value in the unit it is shown in (7,7 giây, 45 phút,
  // 1 ngày): 2 significant digits, so both ends are reachable exactly
  const [size] = LONG_UNITS.find(([s]) => v >= s * 0.995) || [1];
  const n = v / size, p = n >= 10 ? 1 : 0.1;
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round(n / p) * p * size));
};
function setSpeed(v, dir, from) {
  if (Number.isFinite(v)) player.speed = Math.max(SPEED_MIN, Math.min(SPEED_MAX, v));
  if (dir) player.dir = dir;
  scene.setSpeed(player.speed);                 // OHT trips keep a visible real duration
  const chip = $("#speed");
  $("#speed-chip").textContent = (player.dir < 0 ? "◀ " : "") + speedLabel(player.speed);
  chip.setAttribute("aria-label", "Tốc độ phát: " + speedLabel(player.speed) + (player.dir < 0 ? ", phát lùi" : ""));
  chip.classList.toggle("rev", player.dir < 0);
  if (from !== "range") $("#speed-range").value = String(toRange(player.speed));
  // card: tier, exact speed, and the gradient fill up to the knob
  const sub = player.dir < 0 ? "◀ Phát lùi · " + speedWords(player.speed, true) : speedWords(player.speed);
  $("#speed-name").textContent = speedTier(player.speed);
  $("#speed-sub").textContent = sub;
  $("#speed-range").setAttribute("aria-valuetext", speedTier(player.speed) + ", " + sub);
  $("#speed-slider").style.setProperty("--f", (Number($("#speed-range").value) / 1000).toFixed(4));
  if (from !== "val") {
    const unit = [...UNITS].find(([size]) => player.speed >= size)?.[0] || 1;
    $("#speed-unit").value = String(unit);
    $("#speed-val").value = String(Math.round((player.speed / unit) * 100) / 100);
  }
  for (const b of document.querySelectorAll(".speed-pop .dir button")) b.setAttribute("aria-checked", String(Number(b.dataset.dir) === player.dir));
  for (const b of document.querySelectorAll("#speed-chips button")) b.setAttribute("aria-pressed", String(Number(b.dataset.v) === player.speed));
  // the speed is remembered; the direction is not (a new replay plays forward)
  try { localStorage.setItem("fabframe-speed", JSON.stringify([player.speed])); } catch { /* ignore */ }
}
function closeSpeed(focus) {
  $("#speed-pop").hidden = true;
  $("#speed").setAttribute("aria-expanded", "false");
  if (focus) $("#speed").focus();
}
$("#speed").addEventListener("click", () => {
  const pop = $("#speed-pop");
  pop.hidden = !pop.hidden;
  $("#speed").setAttribute("aria-expanded", String(!pop.hidden));
});
document.addEventListener("pointerdown", (e) => {
  const pop = $("#speed-pop");
  if (!pop.hidden && !pop.contains(e.target) && e.target !== $("#speed") && !$("#speed").contains(e.target)) closeSpeed(false);
});
$("#player").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#speed-pop").hidden) { e.preventDefault(); closeSpeed(true); }
});
$("#speed-range").addEventListener("input", (e) => setSpeed(fromRange(Number(e.target.value)), 0, "range"));
// while typing the field is left alone; on commit it shows the clamped value
$("#speed-val").addEventListener("input", () => setSpeed(Number($("#speed-val").value) * Number($("#speed-unit").value), 0, "val"));
$("#speed-val").addEventListener("change", () => setSpeed(Number($("#speed-val").value) * Number($("#speed-unit").value)));
$("#speed-unit").addEventListener("change", () => setSpeed(Number($("#speed-val").value) * Number($("#speed-unit").value)));
for (const b of document.querySelectorAll("#speed-chips button")) b.addEventListener("click", () => setSpeed(Number(b.dataset.v)));
$("#speed-more").addEventListener("click", () => {
  const adv = $("#speed-adv");
  adv.hidden = !adv.hidden;
  $("#speed-more").setAttribute("aria-expanded", String(!adv.hidden));
});
$("#speed-reset").addEventListener("click", () => setSpeed(1800, 1));
for (const b of document.querySelectorAll(".speed-pop .dir button")) b.addEventListener("click", () => setSpeed(NaN, Number(b.dataset.dir)));
try {
  const saved = JSON.parse(localStorage.getItem("fabframe-speed") || "null");
  if (Array.isArray(saved)) setSpeed(Number(saved[0]), 1);
  else setSpeed(player.speed, 1);
} catch { setSpeed(player.speed, 1); }

/* keyboard: Space play/pause, arrows seek / speed, Home start, End finish */
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  // controls keep their own keys: fields, radios and tabs everything, buttons Space/Enter
  const t = e.target instanceof Element ? e.target : document.body;
  if (t.closest("input, textarea, select, [contenteditable], [role=radio], [role=tab]") || document.querySelector("dialog[open]")) return;
  if (!scene.replay) return;
  const onButton = !!t.closest("button, a, [role=button]");
  const step = e.shiftKey ? DS_PER_DAY : 36000;
  if (e.key === " ") { if (onButton) return; e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); seek(player.T + step); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); seek(player.T - step); }
  else if (e.key === "ArrowUp") { e.preventDefault(); setSpeed(Math.min(SPEED_MAX, player.speed * 2)); }
  else if (e.key === "ArrowDown") { e.preventDefault(); setSpeed(Math.max(SPEED_MIN, player.speed / 2)); }
  else if (e.key === "Home") { e.preventDefault(); seek(0); }
  else if (e.key === "End") { e.preventDefault(); seek(player.end); }
});
$("#home").addEventListener("click", () => scene.frame());

function hint(text) { $("#hint").textContent = text || ""; }

// "#t=2.5" opens a replay at day 2.5, paused: handy for sharing one moment
function hashDay() {
  const m = /(?:^|[#&])t=(\d+(?:\.\d+)?|\.\d+)(?=$|&)/.exec(location.hash);
  const v = m ? Number.parseFloat(m[1]) : NaN;
  return Number.isFinite(v) ? v : null;
}
function hashBay() {
  const m = /(?:^|[#&])bay=([A-Za-z_]+)/.exec(location.hash);
  if (!m || !scene.L) return -1;
  return scene.L.bays.findIndex((b) => b.group.toLowerCase() === m[1].toLowerCase());
}
// a shared link applies to the first replay only, not to every run opened later
function startAt() {
  const d = state.hashUsed ? null : hashDay();
  return d === null ? 0 : Math.min(player.end, d * DS_PER_DAY);
}
// The first replay of a browser session opens with a short flight through the
// fab, unless a shared link points somewhere (#t=, #bay=) or motion is reduced;
// any click or key skips it.
const INTRO_KEY = "fabframe-intro", INTRO_HINT = "Bấm chuột hoặc nhấn phím để bỏ qua";
function playIntro() {
  if (REDUCED_MOTION || /(?:^|[#&])(?:t|bay)=/.test(location.hash)) return;
  try { if (sessionStorage.getItem(INTRO_KEY)) return; } catch { /* no storage: show it */ }
  if (!scene.playIntro(() => { if ($("#hint").textContent === INTRO_HINT) hint(""); })) return;
  try { sessionStorage.setItem(INTRO_KEY, "1"); } catch { /* ignore */ }
  if (!$("#hint").textContent) hint(INTRO_HINT);
}
addEventListener("hashchange", () => {
  if (!scene.replay) return;
  const d = hashDay();
  if (d !== null) { setPlaying(/(^|[#&])play/.test(location.hash)); seek(d * DS_PER_DAY); }
  const bi = hashBay();
  if (bi >= 0) scene.focusBay(bi);
});

async function showLayout(dataset) {
  if (state.layoutDataset === dataset && !scene.replay) return;
  const layout = await api("/api/layout?dataset=" + dataset);
  scene.clearReplay();
  scene.setLayout(layout);
  scene.setAutoRotate(!REDUCED_MOTION);
  state.layoutDataset = dataset;
  state.replayRun = null;
  $("#player").hidden = true;
  updateHud(null, true);
}

async function loadReplay(runId) {
  if (state.replayRun === runId) {
    // back to the run on screen while another one was loading: drop that load
    if (state.loading) { state.loading = null; hint(""); }
    return;
  }
  state.loading = runId;
  hint("Đang tải…");
  try {
    const [meta, buf] = await Promise.all([
      api("/api/runs/" + runId + "/replay.json"),
      fetch("/api/runs/" + runId + "/replay.bin").then((r) => { if (!r.ok) throw new Error("không tải được replay"); return r.arrayBuffer(); }),
    ]);
    if (state.loading !== runId) return;            // another run was selected meanwhile
    const R = decodeReplay(meta, buf);
    if (state.layoutDataset !== meta.dataset) { scene.setLayout(meta.layout); state.layoutDataset = meta.dataset; }
    scene.setReplay(R);
    state.replayRun = runId;
    player.end = R.endTime;
    player.T = startAt();
    setSpeed(NaN, 1);
    $("#player").hidden = false;
    // a replay can be shorter than the run (UI runs record at most 60 days)
    const cut = meta.replay_days && meta.days && meta.replay_days < meta.days - 1e-6;
    const cover = cut ? "Replay: " + num(meta.replay_days, 1) + " / " + num(meta.days, 1) + " ngày đầu" : "";
    $("#scrub").title = cover || "Tua thời gian";
    $("#clock").title = cover;
    hint(cover);
    if (cut) setTimeout(() => { if ($("#hint").textContent === cover) hint(""); }, 5000);
    updateHud(scene.setTime(player.T, { force: true }), true);
    const fromHash = !state.hashUsed;
    state.hashUsed = true;
    const bi = fromHash ? hashBay() : -1;                          // "#bay=Litho" zooms into a bay
    if (bi >= 0) scene.focusBay(bi);
    else if (fromHash) playIntro();
    const paused = fromHash && hashDay() !== null && !/(^|[#&])play/.test(location.hash);
    setPlaying(!REDUCED_MOTION && !paused);
  } catch (e) {
    state.replayFailed.add(runId);                                  // no automatic retry every poll
    hint(e.message);
  } finally {
    if (state.loading === runId) state.loading = null;
  }
}

/* ---------------------------------------------------------- side panel */

$("#toggle-side").addEventListener("click", () => {
  const hidden = $("#app").classList.toggle("side-hidden");
  $("#toggle-side").setAttribute("aria-expanded", String(!hidden));
  $("#side").inert = hidden;                                      // a closed drawer takes no focus
  setTimeout(() => scene.resize(), 220);
});
if (matchMedia("(max-width: 860px)").matches) {
  $("#app").classList.add("side-hidden");
  $("#toggle-side").setAttribute("aria-expanded", "false");
  $("#side").inert = true;
}

for (const b of document.querySelectorAll(".seg button[data-ds]")) {
  b.addEventListener("click", async () => {
    for (const o of document.querySelectorAll(".seg button[data-ds]")) o.setAttribute("aria-checked", String(o === b));
    state.dataset = b.dataset.ds;
    if (!scene.replay) await showLayout(state.dataset).catch((e) => hint(e.message));
  });
}
// Nhanh: try code in half a minute; Chuẩn: past a FIFO warm-up of about two cycle times (a lot
// needs ~35-38 days end to end), a year of measurement to compare rules on
const PRESETS = { quick: { days: 7, warmup: 0 }, standard: { days: 365, warmup: 60 } };
function markPreset() {
  const days = Number($("#f-days").value), warmup = Number($("#f-warmup").value || 0);
  for (const b of document.querySelectorAll(".seg button[data-preset]")) {
    const p = PRESETS[b.dataset.preset];
    b.setAttribute("aria-checked", String(p.days === days && p.warmup === warmup));
  }
}
for (const b of document.querySelectorAll(".seg button[data-preset]")) {
  b.addEventListener("click", () => {
    const p = PRESETS[b.dataset.preset];
    $("#f-days").value = p.days;
    $("#f-warmup").value = p.warmup;
    markPreset();
  });
}
for (const id of ["#f-days", "#f-warmup"]) $(id).addEventListener("input", markPreset);
$("#b-adv").addEventListener("click", () => {
  const adv = $("#adv");
  adv.hidden = !adv.hidden;
  $("#b-adv").setAttribute("aria-expanded", String(!adv.hidden));
});

const GROUPS = [["builtin", "Luật Paper 4"], ["mine", "Của tôi"]];
async function loadDispatchers(selectId) {
  state.dispatchers = await api("/api/dispatchers");
  const sel = $("#disp");
  const keep = selectId || sel.value || "builtin:fifo";
  sel.replaceChildren();
  for (const [kind, label] of GROUPS) {
    const items = state.dispatchers.filter((d) => d.kind === kind);
    if (!items.length) continue;
    sel.append(el("optgroup", { label }, ...items.map((d) => el("option", { value: d.id, title: d.doc || "" }, d.name))));
  }
  if (state.dispatchers.some((d) => d.id === keep)) sel.value = keep;
}
const currentDispatcher = () => state.dispatchers.find((d) => d.id === $("#disp").value);
$("#disp").addEventListener("change", () => { const box = $("#check-out"); box.hidden = true; box.dataset.seq = String(Number(box.dataset.seq || 0) + 1); });

function checkBox(box, ok, text, busy) {
  box.hidden = false;
  const line = busy
    ? el("div", { class: "ok-line muted" }, "Đang kiểm tra…")
    : el("div", { class: ok ? "ok-line" : "bad-line" }, icon(ok ? "check" : "x"), ok ? "OK" : "Lỗi");
  const detail = !busy && text && (!ok || text.length < 160) ? el("pre", {}, text) : null;
  box.replaceChildren(line, detail || "");
}

async function runCheck(id, box, button) {
  // a result that comes back after the selection changed is dropped
  const seq = String(Number(box.dataset.seq || 0) + 1);
  box.dataset.seq = seq;
  checkBox(box, true, "", true);
  if (button) button.disabled = true;
  try {
    const r = await api("/api/check", { method: "POST", body: { id } });
    if (box.dataset.seq === seq) checkBox(box, r.ok, r.output);
  } catch (e) { if (box.dataset.seq === seq) checkBox(box, false, e.message); }
  finally { if (button) button.disabled = false; }
}
$("#b-check").addEventListener("click", () => { const d = currentDispatcher(); if (d) runCheck(d.id, $("#check-out"), $("#b-check")); });

function parseOptions(text) {
  const out = {};
  for (const part of text.split(/[,;\n]/)) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq < 1) throw new Error("Tham số dạng ten=gia_tri");
    const k = item.slice(0, eq).trim(), raw = item.slice(eq + 1).trim();
    if (!/^[A-Za-z_]\w*$/.test(k)) throw new Error("Tên tham số không hợp lệ: " + k);
    if (/^-?\d+(\.\d+)?([eE]-?\d+)?$/.test(raw)) out[k] = Number(raw);
    else if (raw === "true" || raw === "false") out[k] = raw === "true";
    else out[k] = raw.replace(/^["']|["']$/g, "");
  }
  return out;
}

$("#b-run").addEventListener("click", async () => {
  const d = currentDispatcher();
  const msg = $("#run-msg");
  msg.textContent = "";
  if (!d) return;
  let body;
  try {
    body = {
      dispatcher: d.id, dataset: state.dataset,
      days: Number($("#f-days").value), seed: Math.trunc(Number($("#f-seed").value)),
      warmup_days: Number($("#f-warmup").value || 0), rng: $("#f-rng").value,
      options: parseOptions($("#f-options").value),
    };
  } catch (e) { msg.textContent = e.message; return; }
  $("#b-run").disabled = true;
  try {
    const r = await api("/api/runs", { method: "POST", body });
    state.selected = r.run_id;
    await refreshRuns();
    schedule();                                                   // progress every second from now
  } catch (e) { msg.textContent = e.message; }
  finally { $("#b-run").disabled = false; }
});

/* ------------------------------------------------------------- runs */

function flash(text) {
  hint(text);
  setTimeout(() => { if ($("#hint").textContent === text) hint(""); }, 4000);
}

async function refreshRuns() {
  try { state.runs = await api("/api/runs"); } catch { return; }
  renderRuns();
  const sel = state.runs.find((r) => r.run_id === state.selected);
  if (sel && sel.state === "done" && sel.has_replay && state.replayRun !== sel.run_id && state.loading !== sel.run_id
      && !state.replayFailed.has(sel.run_id)) loadReplay(sel.run_id);
  if (sel && (sel.state === "running" || sel.state === "queued")) {
    const p = sel.progress;
    hint(sel.state === "queued" ? "Đang chờ…" : "Đang chạy " + (p && p.total_days ? Math.round((p.sim_days / p.total_days) * 100) : 0) + "%");
    state.progressHint = sel.run_id;
  } else if (state.progressHint) {
    // the run we were showing progress for has ended one way or another
    const ended = state.runs.find((r) => r.run_id === state.progressHint);
    state.progressHint = null;
    if (ended && ["running", "queued", "done"].includes(ended.state)) {
      if (/^Đang (chờ|chạy)/.test($("#hint").textContent)) hint("");   // selection moved on, or it finished
    } else flash(ended && ended.state === "cancelled" ? "Đã huỷ" : "Lần chạy lỗi — xem chi tiết");
  }
}

function renderRuns() {
  const box = $("#runs");
  // polling must not rebuild (and steal focus from) an unchanged list
  const key = state.selected + "|" + JSON.stringify(state.runs);
  if (key === state.runsKey && box.childElementCount) return;
  state.runsKey = key;
  const f = document.activeElement, row = f && f.closest ? f.closest(".run") : null;
  const focusId = row && box.contains(row) ? row.dataset.id : null, focusLabel = row && f !== row ? f.getAttribute("aria-label") : null;
  if (!state.runs.length) { box.replaceChildren(el("div", { class: "empty" }, "Chưa có lần chạy")); return; }
  box.replaceChildren(...state.runs.map(runRow));
  if (focusId) {
    const again = [...box.querySelectorAll(".run")].find((r) => r.dataset.id === focusId);
    if (again) {
      again.focus();
      if (focusLabel) [...again.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === focusLabel)?.focus();
    }
  }
}

function runRow(run) {
  const req = run.request || {}, r = run.result;
  const active = run.state === "running" || run.state === "queued";
  const pctDone = run.progress && run.progress.total_days ? (run.progress.sim_days / run.progress.total_days) * 100 : 0;
  const ico = el("span", { class: "ico " + run.state, title: run.state, "aria-label": run.state }, RUN_ICON[run.state] || "?");
  if (run.state === "running") ico.classList.add("spin");
  const acts = el("div", { class: "acts" },
    run.state === "done" || run.state === "failed" ? el("button", { class: "ib", type: "button", title: "Chi tiết", "aria-label": "Chi tiết",
      onclick: (e) => { e.stopPropagation(); openDetail(run.run_id); } }, icon("chart")) : null,
    active
      ? el("button", { class: "ib danger", type: "button", title: "Huỷ", "aria-label": "Huỷ",
        onclick: async (e) => { e.stopPropagation(); await api("/api/runs/" + run.run_id + "/cancel", { method: "POST" }).catch(() => {}); await refreshRuns(); schedule(); } }, icon("stop"))
      : el("button", { class: "ib danger", type: "button", title: "Xoá", "aria-label": "Xoá",
        onclick: (e) => { e.stopPropagation(); deleteRun(run.run_id); } }, icon("trash")));
  const bar = el("span");
  bar.style.width = pctDone.toFixed(1) + "%";
  return el("div", {
    class: "run" + (run.run_id === state.selected ? " sel" : ""), tabindex: "0", role: "button", "data-id": run.run_id,
    onclick: () => selectRun(run),
    // keys pressed on the row's own buttons belong to those buttons
    onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectRun(run); } },
  },
  ico,
  el("div", {},
    el("div", { class: "name" }, (r && r.dispatcher) || req.dispatcher_name || run.run_id),
    el("div", { class: "meta" }, [req.dataset, (req.warmup_days ? num(req.warmup_days, 2) + "+" : "") + num(req.days, 2) + "n",
      "#" + req.seed, (req.created_at || "").slice(11, 16)].join(" · "))),
  el("div", { class: "val", title: "Lot hoàn tất mỗi ngày" }, r ? num(r.throughput_per_day, 1) : "", r ? el("small", {}, "lot/ngày") : null),
  active ? el("div", { class: "prog" }, bar) : null,
  acts);
}

// the highlighted run is the one on the 3D stage (or the one being waited for);
// runs without a replay only open their details
async function selectRun(run) {
  if (run.state === "done" && run.has_replay) {
    state.selected = run.run_id;
    state.replayFailed.delete(run.run_id);                         // an explicit click retries
    renderRuns();
    await loadReplay(run.run_id);
    return;
  }
  if (run.state === "running" || run.state === "queued") {
    state.selected = run.run_id;
    renderRuns();
    refreshRuns();
    return;
  }
  openDetail(run.run_id);
}

async function deleteRun(id) {
  if (!confirm("Xoá lần chạy này?")) return;
  try { await api("/api/runs/" + id, { method: "DELETE" }); } catch (e) { alert(e.message); return; }
  if (state.selected === id) state.selected = null;
  if (state.replayRun === id) { setPlaying(false); await showLayout(state.dataset).catch(() => {}); }
  refreshRuns();
}

function schedule() {
  clearTimeout(state.pollTimer);
  const active = state.runs.some((r) => r.state === "running" || r.state === "queued");
  state.pollTimer = setTimeout(async () => { await refreshRuns(); schedule(); }, active ? 1000 : 5000);
}

/* ---------------------------------------------------------- code dialog */

const dlgCode = $("#dlg-code");
const editorDirty = () => !!state.editor && state.editor.mode !== "view" && $("#ed-code").value !== state.editor.saved;
const mayClose = (d) => d !== dlgCode || !editorDirty() || confirm("Bỏ các thay đổi chưa lưu?");
for (const d of document.querySelectorAll("dialog")) {
  // backdrop click closes only if the press also started on the backdrop
  // (a text selection released outside the dialog must not close it)
  let downOnBackdrop = false;
  d.addEventListener("pointerdown", (e) => { downOnBackdrop = e.target === d; });
  d.addEventListener("click", (e) => { if (e.target === d && downOnBackdrop && mayClose(d)) d.close(); });
  d.addEventListener("cancel", (e) => { if (!mayClose(d)) e.preventDefault(); });
  for (const c of d.querySelectorAll("[data-close]")) c.addEventListener("click", () => { if (mayClose(d)) d.close(); });
  d.addEventListener("close", () => { if (tip.parentElement === d) { tip.hidden = true; tipHost($("#stage")); } });
}

function openEditor({ mode, name, code }) {
  state.editor = { mode, name, saved: mode === "new" ? null : code };
  const ro = mode === "view";
  $("#ed-name").value = name;
  $("#ed-name").readOnly = mode !== "new";
  $("#ed-code").value = code;
  $("#ed-code").readOnly = ro;
  $("#ed-ro").hidden = !ro;
  $("#ed-copy").hidden = !ro;
  $("#ed-save").hidden = ro;
  $("#ed-check").hidden = ro;
  $("#ed-out").hidden = true;
  if (!dlgCode.open) dlgCode.showModal();
  (mode === "new" ? $("#ed-name") : $("#ed-code")).focus();
}

$("#b-code").addEventListener("click", async () => {
  const d = currentDispatcher();
  if (!d) return;
  try {
    const src = await api("/api/source?id=" + encodeURIComponent(d.id));
    openEditor({ mode: src.editable ? "edit" : "view", name: src.name, code: src.code });
  } catch (e) { checkBox($("#check-out"), false, e.message); }
});

async function newDispatcher(code, base) {
  let name = (base || "my_dispatcher").replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z_]+/, "") || "my_dispatcher";
  const taken = new Set(state.dispatchers.filter((d) => d.kind === "mine").map((d) => d.name));
  let cand = name, n = 2;
  while (taken.has(cand)) cand = name + "_" + n++;
  if (code === undefined) code = (await api("/api/template?name=" + encodeURIComponent(cand))).code;
  // a copy reports under its own name, not the original's
  else code = code.replace(/^(\s*name\s*=\s*)(["'])[^"'\n]*\2/m, (_, head, q) => head + q + cand.replace(/_/g, "-") + q);
  openEditor({ mode: "new", name: cand, code });
}
$("#b-new").addEventListener("click", () => newDispatcher().catch((e) => checkBox($("#check-out"), false, e.message)));
$("#ed-copy").addEventListener("click", () => newDispatcher($("#ed-code").value, (state.editor?.name || "my") + "_copy"));

async function saveEditor(check) {
  const name = $("#ed-name").value.trim(), code = $("#ed-code").value;
  if (state.editor?.mode === "new" && state.dispatchers.some((d) => d.kind === "mine" && d.name === name)
      && !confirm("Đã có " + name + ".py — ghi đè?")) return;
  try {
    const saved = await api("/api/dispatchers", { method: "POST", body: { name, code } });
    await loadDispatchers(saved.id);
    state.editor = { mode: "edit", name, saved: code };
    $("#ed-name").readOnly = true;
    if (check) await runCheck(saved.id, $("#ed-out"), $("#ed-check"));
    else checkBox($("#ed-out"), true, "");
  } catch (e) { checkBox($("#ed-out"), false, e.message); }
}
$("#ed-save").addEventListener("click", () => saveEditor(false));
$("#ed-check").addEventListener("click", () => saveEditor(true));
// Tab indents; Shift+Tab, or Esc then Tab, leaves the editor; Ctrl+S saves
let tabLeaves = false;
$("#ed-code").addEventListener("keydown", (e) => {
  const ta = e.target;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (!ta.readOnly) saveEditor(false); return; }
  if (e.key === "Escape") { e.preventDefault(); tabLeaves = true; return; }
  if (e.key !== "Tab") { if (e.key !== "Shift") tabLeaves = false; return; }
  if (ta.readOnly || e.shiftKey || tabLeaves) { tabLeaves = false; return; }
  e.preventDefault();
  ta.setRangeText("    ", ta.selectionStart, ta.selectionEnd, "end");
});

/* -------------------------------------------------------- detail dialog */

const dlgDetail = $("#dlg-detail");
async function openDetail(id) {
  try { state.detail = await api("/api/runs/" + id); } catch (e) { alert(e.message); return; }
  renderDetail();
  if (!dlgDetail.open) dlgDetail.showModal();
}

function renderDetail() {
  const d = state.detail, req = d.request || {}, res = d.result_full;
  $("#dt-title").textContent = (res && res.dispatcher) || req.dispatcher_name || d.run_id;
  $("#dt-meta").textContent = [req.dataset, num(req.days, 2) + " ngày", "seed " + req.seed,
    req.warmup_days ? "warm-up " + num(req.warmup_days, 2) : null, req.rng === "legacy" ? "RNG gốc" : null,
    Object.keys(req.options || {}).length ? JSON.stringify(req.options) : null].filter(Boolean).join(" · ");
  const json = $("#dt-json");
  json.hidden = !res;
  if (res) json.setAttribute("href", "/api/runs/" + d.run_id + "/result.json");
  const body = $("#dt-body");
  if (!res) {
    body.replaceChildren(el("div", { class: "bad-line" }, icon("x"), d.state === "cancelled" ? "Đã huỷ" : "Lỗi"), d.log ? el("pre", { class: "log" }, d.log) : "");
    return;
  }
  const k = res.kpi;
  const tile = (label, value, unit) => el("div", { class: "tile" }, el("div", { class: "tile-label" }, label),
    el("div", { class: "tile-value" }, value, unit ? el("span", { class: "tile-unit" }, unit) : null));
  const tiles = el("div", { class: "tiles" },
    tile("Lot/ngày", num(k.throughput_per_day, 2)), tile("Đúng hạn", pct(k.on_time_rate)),
    tile("Cycle time", num(k.mean_cycle_time_days, 2), "ngày"), tile("Vi phạm CQT", num(k.cqt_violations)),
    tile("Moves/ngày", num(k.moves_per_day)), tile("Đổi setup", num(k.setups)),
    tile("WIP cuối", num(k.wip_end)), tile("Dự phòng FIFO", num(res.fallbacks), "/ " + num(res.decisions)));
  const charts = el("div", { class: "charts" },
    figure("c-done", "Lot hoàn tất / ngày"), figure("c-wip", "WIP cuối ngày"), figure("c-cqt", "Vi phạm CQT / ngày"));
  const tabs = [["daily", "Theo ngày"], ["product", "Theo loại lot"], ["tech", "Kỹ thuật"]];
  const pickTab = (id) => { state.detailTab = id; renderDetail(); $("#dt-body .tab[aria-selected=true]")?.focus(); };
  const bar = el("div", {
    class: "tabs", role: "tablist", "aria-label": "Bảng số liệu",
    onkeydown: (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const i = tabs.findIndex(([id]) => id === state.detailTab);
      pickTab(tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length][0]);
    },
  }, ...tabs.map(([id, label]) => el("button", {
    class: "tab", type: "button", role: "tab", "aria-selected": String(state.detailTab === id),
    tabindex: state.detailTab === id ? "0" : "-1", onclick: () => pickTab(id) }, label)));
  let panel;
  if (state.detailTab === "daily") {
    panel = table(["Ngày", "Hoàn tất", "Đúng hạn", "CQT", "Moves", "Setup", "WIP"],
      (k.daily || []).map((r) => [r.day, num(r.completed), pct(r.on_time_rate), num(r.cqt_violations), num(r.moves), num(r.setups), num(r.wip)]));
  } else if (state.detailTab === "product") {
    const names = Object.keys(k.per_product || {}).sort((a, b) => a.localeCompare(b, "vi", { numeric: true }));
    panel = table(["Loại lot", "Hoàn tất", "Đúng hạn", "Cycle time (ngày)"],
      names.map((n) => [n, num(k.per_product[n].completed), pct(k.per_product[n].on_time_rate), num(k.per_product[n].mean_cycle_time_days, 2)]));
  } else {
    const kv = el("dl", { class: "kv" }, ...[
      ["Quyết định", num(res.decisions)], ["Dự phòng FIFO", num(res.fallbacks)],
      ["Thời gian dispatcher", num(res.dispatcher_seconds, 2) + " s (max " + num(res.slowest_decision_ms, 1) + " ms)"],
      ["Thời gian chạy", num(res.wall_seconds, 1) + " s"], ["Batch TB", num(k.mean_batch_size, 2)],
      ["Máy bận / setup", pct(k.busy_share) + " / " + pct(k.setup_share)], ["Trễ TB", num(k.mean_tardiness_hours, 2) + " giờ"],
      ["Kernel", (res.kernel_manifest_sha256 || "").slice(0, 16)], ["Python", res.python],
    ].flatMap(([a, b]) => [el("dt", {}, a), el("dd", {}, b)]));
    const reasons = Object.entries(res.fallback_reasons || {});
    panel = el("div", {}, kv,
      reasons.length ? [el("h4", {}, "Lý do dự phòng"), table(["Lý do", "Lần"], reasons.map(([a, b]) => [a, num(b)]))] : null,
      d.source ? [el("h4", {}, "Code đã chạy"), el("pre", { class: "log" }, d.source)] : null,
      d.log && d.log.trim() ? [el("h4", {}, "Nhật ký"), el("pre", { class: "log" }, d.log)] : null);
  }
  body.replaceChildren(tiles, charts, bar, el("div", { class: "table-wrap", role: "tabpanel" }, panel));
  requestAnimationFrame(() => {
    const daily = k.daily || [];
    columnChart($("#c-done .cb"), daily, "completed", "lot");
    lineChart($("#c-wip .cb"), daily, "wip", "lot");
    columnChart($("#c-cqt .cb"), daily, "cqt_violations", "CQT");
  });
}

function figure(id, title) { return el("figure", { class: "chart", id }, el("h3", {}, title), el("div", { class: "cb" })); }
function table(headers, rows) {
  return el("table", { class: "data" }, el("thead", {}, el("tr", {}, ...headers.map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, ...rows.map((cells) => el("tr", {}, ...cells.map((c) => el("td", {}, c))))));
}

/* charts: one series each (the title names it), hover + keyboard, table twin above */
function niceScale(lo, hi, count = 4) {
  if (!(hi > lo)) hi = lo + 1;
  const raw = (hi - lo) / count, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const min = Math.floor(lo / step) * step, max = Math.ceil(hi / step) * step, ticks = [];
  for (let v = min; v <= max + step * 1e-6; v += step) ticks.push(Number(v.toFixed(10)));
  return { min, max, ticks };
}
function plotFrame(c, right) {
  const width = Math.max(240, Math.floor(c.clientWidth || 320)), height = 180;
  const title = c.parentElement?.querySelector("h3")?.textContent || "";
  const root = svg("svg", { class: "plot", viewBox: "0 0 " + width + " " + height, width, height, role: "img", "aria-label": title });
  c.replaceChildren(root);
  return { root, x0: 44, x1: width - right, y0: 12, y1: height - 24 };
}
function yAxis(f, s, y) {
  for (const t of s.ticks) {
    const yy = y(t);
    svg("line", { class: t === s.min ? "baseline" : "grid", x1: f.x0, x2: f.x1, y1: yy, y2: yy }, f.root);
    svg("text", { class: "tick", x: f.x0 - 6, y: yy + 3.5, "text-anchor": "end" }, f.root).textContent = num(t);
  }
}
function xLabels(f, n, xAt) {
  const every = Math.max(1, Math.ceil(n / 10));
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    if (!last && (i % every !== 0 || n - 1 - i < every)) continue;
    svg("text", { class: "tick", x: xAt(i), y: f.y1 + 15, "text-anchor": "middle" }, f.root).textContent = String(i + 1);
  }
}
function columnChart(c, rows, key, unit) {
  if (!c) return;
  const f = plotFrame(c, 10), vals = rows.map((r) => r[key]), ok = vals.filter((v) => typeof v === "number");
  if (!ok.length) { c.replaceChildren(el("p", { class: "muted small" }, "–")); return; }
  const s = niceScale(0, Math.max(...ok)), y = (v) => f.y1 - ((v - s.min) / (s.max - s.min)) * (f.y1 - f.y0);
  yAxis(f, s, y);
  const band = (f.x1 - f.x0) / rows.length, bw = Math.max(2, Math.min(24, band * 0.62)), maxI = vals.indexOf(Math.max(...ok));
  rows.forEach((row, i) => {
    const v = vals[i];
    if (typeof v !== "number") return;
    const x = f.x0 + i * band + (band - bw) / 2, top = y(v), base = y(0), h = base - top, r = Math.min(4, bw / 2, h);
    const bar = svg("path", { class: "bar", d: h <= 0 ? "" : `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${base}Z` }, f.root);
    if (i === maxI && h > 0) svg("text", { class: "value-label", x: x + bw / 2, y: top - 4, "text-anchor": "middle" }, f.root).textContent = num(v);
    const hit = svg("rect", { class: "hit", x: f.x0 + i * band, y: f.y0, width: band, height: f.y1 - f.y0, tabindex: "0", "aria-label": "Ngày " + row.day + ": " + num(v) + " " + unit }, f.root);
    const on = (px, py) => { bar.classList.add("hover"); plainTip(num(v), "Ngày " + row.day + " · " + unit, px, py); };
    hit.addEventListener("pointermove", (e) => on(e.clientX, e.clientY));
    hit.addEventListener("focus", () => { const b = hit.getBoundingClientRect(); on(b.left + b.width / 2, b.top + 24); });
    const off = () => { bar.classList.remove("hover"); tip.hidden = true; };
    hit.addEventListener("pointerleave", off); hit.addEventListener("blur", off);
  });
  xLabels(f, rows.length, (i) => f.x0 + i * band + band / 2);
}
function lineChart(c, rows, key, unit) {
  if (!c) return;
  const f = plotFrame(c, 48), pts = rows.map((r, i) => ({ i, day: r.day, v: r[key] })).filter((p) => typeof p.v === "number");
  if (!pts.length) { c.replaceChildren(el("p", { class: "muted small" }, "–")); return; }
  const lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v)), pad = Math.max(1, (hi - lo) * 0.15);
  const s = niceScale(Math.max(0, lo - pad), hi + pad), y = (v) => f.y1 - ((v - s.min) / (s.max - s.min)) * (f.y1 - f.y0);
  const n = rows.length, x = (i) => (n === 1 ? (f.x0 + f.x1) / 2 : f.x0 + (i * (f.x1 - f.x0)) / (n - 1));
  yAxis(f, s, y);
  if (pts.length > 1) svg("path", { class: "line", d: pts.map((p, k) => (k ? "L" : "M") + x(p.i) + "," + y(p.v)).join("") }, f.root);
  const last = pts[pts.length - 1];
  svg("circle", { class: "dotm", cx: x(last.i), cy: y(last.v), r: 4 }, f.root);
  svg("text", { class: "value-label", x: x(last.i) + 8, y: y(last.v) + 4 }, f.root).textContent = num(last.v);
  xLabels(f, n, x);
  const cross = svg("line", { class: "crosshair", x1: 0, x2: 0, y1: f.y0, y2: f.y1, visibility: "hidden" }, f.root);
  const mk = svg("circle", { class: "dotm", r: 4, visibility: "hidden" }, f.root);
  const ov = svg("rect", { class: "overlay", x: f.x0, y: f.y0, width: f.x1 - f.x0, height: f.y1 - f.y0, tabindex: "0", "aria-label": "WIP theo ngày" }, f.root);
  let cur = pts.length - 1;
  const show = (k, px, py) => {
    cur = k; const p = pts[k];
    cross.setAttribute("x1", x(p.i)); cross.setAttribute("x2", x(p.i)); cross.setAttribute("visibility", "visible");
    mk.setAttribute("cx", x(p.i)); mk.setAttribute("cy", y(p.v)); mk.setAttribute("visibility", "visible");
    plainTip(num(p.v), "Ngày " + p.day + " · " + unit, px, py);
  };
  const nearest = (cx) => {
    const b = f.root.getBoundingClientRect(), sx = ((cx - b.left) / b.width) * f.root.viewBox.baseVal.width;
    let best = 0;
    pts.forEach((p, k) => { if (Math.abs(x(p.i) - sx) < Math.abs(x(pts[best].i) - sx)) best = k; });
    return best;
  };
  ov.addEventListener("pointermove", (e) => show(nearest(e.clientX), e.clientX, e.clientY));
  const off = () => { cross.setAttribute("visibility", "hidden"); mk.setAttribute("visibility", "hidden"); tip.hidden = true; };
  ov.addEventListener("pointerleave", off); ov.addEventListener("blur", off);
  const at = () => { const b = mk.getBoundingClientRect(); return [b.left, b.top]; };
  ov.addEventListener("focus", () => { show(cur, 0, 0); show(cur, ...at()); });
  ov.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const k = Math.max(0, Math.min(pts.length - 1, cur + (e.key === "ArrowRight" ? 1 : -1)));
    show(k, 0, 0); show(k, ...at());
  });
}
function plainTip(value, label, x, y) {
  tipHost(document.querySelector("dialog[open]") || $("#stage"));
  tip.replaceChildren(el("div", { class: "t1" }, value), el("div", { class: "t2" }, label));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y - r.height - 10;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top < 8) top = y + 16;
  tip.style.left = left + "px"; tip.style.top = top + "px";
}

/* ------------------------------------------------------------- theme */

function effectiveTheme() {
  return document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("fabframe-theme"); } catch { /* storage unavailable */ }
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  scene.setTheme(effectiveTheme());
  $("#theme").addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("fabframe-theme", next); } catch { /* ignore */ }
    scene.setTheme(next);
    if (dlgDetail.open && state.detail) renderDetail();
  });
  // with no saved choice the page follows the OS, the 3D scene too
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (document.documentElement.dataset.theme) return;
    scene.setTheme(effectiveTheme());
    if (dlgDetail.open && state.detail) renderDetail();
  });
})();

/* -------------------------------------------------------------- start */

(async function start() {
  try {
    const s = await api("/api/status");
    const k = $("#kernel");
    k.textContent = s.kernel_ok ? "✓ kernel" : "✕ kernel";
    k.className = "kstat " + (s.kernel_ok ? "ok" : "bad");
    k.setAttribute("aria-label", s.kernel_ok ? "Kernel nguyên vẹn" : "Kernel lỗi");
    k.title = s.kernel_ok ? "Kernel nguyên vẹn · v" + s.version + " · Python " + s.python : s.kernel_problems.join("\n");
  } catch (e) { hint("Không kết nối được server"); }
  await loadDispatchers().catch((e) => hint(e.message));
  await showLayout(state.dataset).catch((e) => hint(e.message));
  await refreshRuns();
  const latest = state.runs.find((r) => r.state === "done" && r.has_replay);
  if (latest) { state.selected = latest.run_id; renderRuns(); await loadReplay(latest.run_id); }
  else hint("Chọn dispatcher rồi bấm ▶ Chạy");
  schedule();
})();
