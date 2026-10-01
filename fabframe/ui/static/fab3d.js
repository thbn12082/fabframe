// 3D fab ("nhà máy 3D"), realistic pass.
// Layout (FabMind-demo): two rows of station-group bays facing a central
// aisle. Each tool is a white equipment model (plinth, body, EFEM with glass,
// two load ports, four-tier stack light) whose status roof, painted head, EFEM
// light bar and stack-light tier carry its state, so it stays readable from
// the whole-fab view down to a single bay. Waiting lots sit as FOUPs on racks in
// front of each bay, lots on Delay stations fill a stocker down the aisle, and
// moving lots ride overhead-hoist (OHT) vehicles along ceiling rails.
// Rendering: PMREM room environment, soft shadows, GTAO ambient occlusion,
// bloom on status lights only, MSAA, Neutral tone mapping, three quality tiers.

import * as THREE from "./vendor/three.module.min.js";
import { OrbitControls } from "./vendor/OrbitControls.js";
import { RoomEnvironment } from "./vendor/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "./vendor/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "./vendor/jsm/utils/BufferGeometryUtils.js";
import { EffectComposer } from "./vendor/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/jsm/postprocessing/RenderPass.js";
import { GTAOPass } from "./vendor/jsm/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "./vendor/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "./vendor/jsm/postprocessing/OutputPass.js";

export const STATE = { IDLE: 0, BUSY: 1, SETUP: 2, PM: 3, DOWN: 4 };
const UNKNOWN = 255;       // a tool's paint before any replay state is known
const NO_FAMILY_IDX = 255; // replay: the lot has no next step (it is finished)
export const STATE_NAMES = ["Rảnh", "Bận", "Setup", "Bảo trì", "Hỏng"];
export const QUALITY = ["low", "medium", "high"];

const BACK = ["Litho", "Litho_Met", "Dry_Etch", "Def_Met"];
const FRONT = ["Wet_Etch", "Diffusion", "Dielectric", "TF", "TF_Met", "Implant", "Planar"];
export const GROUP_LABEL = {
  Litho: "LITHO", Litho_Met: "LITHO MET", Dry_Etch: "DRY ETCH", Def_Met: "DEF MET", Wet_Etch: "WET ETCH",
  Diffusion: "DIFFUSION", Dielectric: "DIELECTRIC", TF: "THIN FILM", TF_Met: "TF MET", Implant: "IMPLANT", Planar: "CMP",
};
// area accent colours (floor stripe + tag only); status colours stay reserved
export const GROUP_COLOR = {
  Litho: 0xd6a21e, Litho_Met: 0xe0c060, Dry_Etch: 0x4a6fd6, Def_Met: 0x7a8fa6, Wet_Etch: 0x3fa7c9, Diffusion: 0xb8497f,
  Dielectric: 0x8a67cf, TF: 0x1f9e74, TF_Met: 0x62c49c, Implant: 0x5e7d3a, Planar: 0x9c7a64,
};
const OTHER_COLOR = 0x8a8f96;
// tool envelope [x, height, z] per group (furnaces tall, scanners big, metrology small)
const SIZE = {
  Litho: [0.86, 0.92, 0.8], Litho_Met: [0.66, 0.58, 0.68], Dry_Etch: [0.8, 0.74, 0.8], Def_Met: [0.66, 0.56, 0.66],
  Wet_Etch: [0.84, 0.64, 0.8], Diffusion: [0.6, 1.22, 0.8], Dielectric: [0.8, 0.76, 0.8], TF: [0.8, 0.8, 0.8],
  TF_Met: [0.64, 0.56, 0.66], Implant: [0.86, 0.86, 0.8], Planar: [0.84, 0.7, 0.8],
};
const DEFAULT_SIZE = [0.78, 0.74, 0.8];

// Tool silhouettes by process type. Local frame: the tool's centre on the
// floor, its front (+z) is where the EFEM and load ports are, y is measured
// from the top of the plinth. `core` is the status block (lower body, painted
// head, status roof and stack light); parts are [type, x, y (bottom), z, w, h, d].
function toolShape(group, sx, h, sz) {
  const bodyD = sz * 0.74, zb = -sz / 2, zc = zb + bodyD / 2;       // the space behind the EFEM
  const parts = [];
  const add = (...part) => parts.push(part);
  switch (group) {
    case "Litho": {                                                   // scanner, coater/developer track, lens column
      const core = { x: -sx * 0.17, z: zc, w: sx * 0.6, d: bodyD * 0.96, h };
      add("cabinet", sx * 0.31, 0, zc, sx * 0.34, h * 0.58, bodyD);
      add("paintBlock", core.x - core.w * 0.08, h - 0.01, zc - bodyD * 0.06, core.w * 0.62, h * 0.16, core.d * 0.52);
      for (const dz of [-0.2, 0.2]) add("vent", sx * 0.31, h * 0.58, zc + bodyD * dz, sx * 0.22, 0.012, bodyD * 0.16);
      return { core, parts };
    }
    case "Dry_Etch": case "Dielectric": case "TF": {                  // cluster tool: transfer hub, load locks, 3 chambers
      const r = sx * (group === "TF" ? 0.18 : 0.17), hc = h * 0.8;
      const core = { x: 0, z: zc + bodyD * 0.1, w: sx * 0.34, d: bodyD * 0.4, h: h * 0.62 };
      for (const cx of [-0.09, 0.09]) add("cabinet", sx * cx, 0, zb + bodyD - 0.07, sx * 0.13, h * 0.42, 0.13);
      for (const [cx, cz] of [[-sx * 0.33, zc + bodyD * 0.08], [sx * 0.33, zc + bodyD * 0.08], [0, zc - bodyD * 0.29]]) {
        add("chamber", cx, 0, cz, 2 * r, hc * 0.62, 2 * r);
        add("chamberTop", cx, hc * 0.62, cz, 2 * r, hc * 0.38, 2 * r);
        if (group === "TF") add("pump", cx + (cx < 0 ? -1 : cx > 0 ? 1 : 0.7) * r * 0.2, 0, cz - r * 0.95, r * 0.5, hc * 0.5, r * 0.5);   // cryo pump
        else add("fitting", cx + r * 0.3, hc - 0.005, cz - r * 0.3, r * 0.5, 0.05, r * 0.4);                                           // RF match box
      }
      return { core, parts };
    }
    case "Wet_Etch": {                                                // wet bench: exhaust canopy, deck with tanks, robot gantry
      const dC = bodyD * 0.3, dB = bodyD * 0.7, zB = zb + dC + dB / 2, hB = h * 0.66;
      const core = { x: 0, z: zb + dC / 2, w: sx, d: dC, h };
      add("cabinet", 0, 0, zB, sx, hB - 0.05, dB);
      add("paintBlock", 0, hB - 0.05, zB, sx, 0.05, dB);                // the deck carries the state colour
      for (let k = 0; k < 4; k++) add("tank", -sx * 0.36 + k * sx * 0.24, hB - 0.004, zB + dB * 0.06, sx * 0.19, 0.012, dB * 0.6);
      add("rail", 0, hB + 0.1, zB - dB * 0.38, sx * 0.94, 0.022, 0.03);
      add("darkBox", -sx * 0.12, hB + 0.02, zB - dB * 0.38, 0.08, 0.1, 0.07);
      return { core, parts };
    }
    case "Diffusion": {                                               // vertical furnace: heater tower, wafer load station
      const dT = bodyD * 0.56, dL = bodyD * 0.44;
      const core = { x: 0, z: zb + dT / 2, w: sx * 0.74, d: dT, h };
      add("cabinet", 0, 0, zb + dT + dL / 2, sx, h * 0.52, dL);
      for (const f of [0.46, 0.58, 0.7]) add("band", 0, h * f, core.z, core.w + 0.018, 0.016, core.d + 0.018);
      add("duct", -core.w * 0.28, h, core.z - core.d * 0.2, 0.08, 0.16, 0.08);
      return { core, parts };
    }
    case "Implant": {                                                 // ion source, analyser magnet, beamline, end station
      const core = { x: sx * 0.18, z: zc, w: sx * 0.62, d: bodyD, h };
      add("cabinet", -sx * 0.36, 0, zc + bodyD * 0.08, sx * 0.27, h * 0.62, bodyD * 0.8);
      add("tube", -sx * 0.25, h * 0.64, zc - bodyD * 0.12, sx * 0.32, 0.12, 0.12);
      add("magnet", -sx * 0.2, h * 0.56, zc - bodyD * 0.12, 0.16, 0.26, 0.22);
      return { core, parts };
    }
    case "Planar": {                                                  // CMP: platens and head arms under a window, status band at the back
      const top = h * 0.82;
      const core = { x: 0, z: zc, w: sx, d: bodyD, h: top, roof: { z: -bodyD * 0.34, d: 0.28 } };
      for (const dx of [-0.27, 0, 0.27]) {
        add("platen", sx * dx, top, zc + bodyD * 0.14, sx * 0.24, 0.02, sx * 0.24);
        add("arm", sx * dx, top + 0.04, zc - bodyD * 0.07, 0.026, 0.022, bodyD * 0.3);
      }
      add("cover", 0, top + 0.1, zc + bodyD * 0.12, sx * 0.94, 0.008, bodyD * 0.6);
      return { core, parts };
    }
    default: {                                                        // metrology / inspection: compact, optics head on top
      const core = { x: 0, z: zc, w: sx, d: bodyD, h: h * 0.84 };
      add("paintBlock", -sx * 0.12, h * 0.84 - 0.01, zc - bodyD * 0.12, sx * 0.5, h * 0.2, bodyD * 0.46);
      add("vent", sx * 0.28, h * 0.84, zc + bodyD * 0.2, sx * 0.26, 0.012, bodyD * 0.16);
      return { core, parts };
    }
  }
}

// part types: geometry, material, painted with the tool's state (like its
// head), fine detail (hidden in the whole-fab view), picked by the mouse
const PARTS = {
  cabinet: { geo: "rounded", mat: "body", pick: true, jitter: true },
  paintBlock: { geo: "rounded", mat: "body", paint: true, pick: true },
  chamber: { geo: "cyl", mat: "shell", pick: true },
  chamberTop: { geo: "cyl", mat: "body", paint: true, pick: true },
  pump: { geo: "cylS", mat: "metal", detail: true },
  darkBox: { geo: "rounded", mat: "dark", detail: true },
  fitting: { geo: "rounded", mat: "metal", detail: true },
  tank: { geo: "unit", mat: "liquid" },
  rail: { geo: "unit", mat: "metal", detail: true },
  band: { geo: "unit", mat: "metal", detail: true },
  duct: { geo: "cylS", mat: "metal", detail: true },
  tube: { geo: "cylX", mat: "metal", pick: true },
  magnet: { geo: "rounded", mat: "dark", pick: true },
  platen: { geo: "cyl", mat: "metal" },
  arm: { geo: "unit", mat: "metal", detail: true },
  cover: { geo: "unit", mat: "cover" },
  vent: { geo: "unit", mat: "vent", detail: true },
};
const DETAIL_DIST = 48;       // camera distance below which fine parts are drawn

const P = 1.0;             // machine pitch
const AISLE_HALF = 2.1;    // aisle half width
const RACK_GAP = 0.3, RACK_D = 0.95;
const BAY_GAP = 1.7;
const DEPTH = { back: 16, front: 10 };
const FOUP = 0.17, FOUP_GRID = 0.23, RACK_ROWS = 3, RACK_LEVELS = 4, LEVEL_H = 0.26;
const RAIL_Y = 2.35;
// OHT transport. The simulator itself moves a lot to its next step instantly,
// so the trips are illustrative, but they are tied to the replay clock: a lot
// leaves its bay's rack so that it lands on the load port exactly when the tool
// starts it, and is lifted off the moment the tool releases it, then carried to
// the next bay's rack (the stocker for a Delay step, the exit when finished). A
// trip is a pure function of replay time - pausing freezes it, seeking shows it
// in place, reverse playback runs it backwards.
// Like a real OHT system every rail is one-way (see buildRails) and all
// vehicles run at one speed, so they never meet head-on or pass through each
// other. A trip of TRIP_REF_LEN world units takes TRIP_SIM sim seconds, or
// TRIP_REAL real seconds at the current playback speed if that is longer.
const TRIP_SIM = 300, TRIP_REAL = 1.6, TRIP_REF_LEN = 40;
const MAX_TRIPS = { high: 360, medium: 240, low: 120 };
const CARRIAGE_Y = RAIL_Y - 0.175;                // vehicle hanging under the rail (its top 0.025 below it)
const HANG_Y = CARRIAGE_Y - 0.14 - FOUP;          // bottom of a FOUP held up under it
const tripHash = (i, salt) => fract(Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453);

// Machine-state colours, as display sRGB: the status roof shows exactly these
// (see displayColor) and the legend swatches use the same values (style.css
// --st0..--st4). Lightness is the first separator - idle darkest, down deep red,
// PM mid blue, setup bright amber, busy lightest - so every pair stays apart for
// protan, deutan and tritan viewers too (OKLab dE >= 16 on all pairs, both
// themes). Busy, the normal state, stays neutral as in ISA-101 practice. Colour
// is never the only cue: PM and down roofs carry a pattern (blueprint grid,
// hazard stripes) and every state lights its own tier of the stack light.
//              idle       busy       setup      PM         down
const STATES_DARK = ["#262b33", "#efeee9", "#f0b020", "#5a8cf2", "#dc2f55"];
const STATES_LIGHT = ["#2c323a", "#f4f3ef", "#f0b020", "#5a8cf2", "#dc2f55"];
// Status head: the upper body panels, from the EFEM top up (all a whole-fab
// view sees of a tool's sides), painted per state while the lower body stays
// white. Busy keeps the theme's off-white, idle goes grey (lights off),
// exceptions get an enamel version of their roof colour in the same lightness
// order (painted outright: a white-and-red mix only ever reads as pink); the
// unlit roof stays the saturated signal.
const HEAD = 0.62;          // split height as a share of the tool height (= EFEM top)
const PAINT = ["#b23641", "#5279c1", "#dba341"];          // down, PM, setup
// per state; a number is a linear multiplier of the theme's body colour
const PAINT_DARK = [0.5, 1, PAINT[2], PAINT[1], PAINT[0]];
const PAINT_LIGHT = [0.58, 1, PAINT[2], PAINT[1], PAINT[0]];
// roof pattern per state: 0 plain, 1 hazard stripes (down), 2 blueprint grid (PM)
const PATTERN = [0, 0, 0, 2, 1];
const STRIPE_P = 0.17, GRID_P = 0.2;   // pattern periods, world units
const ROOF_T = 0.018;        // status roof thickness
// four-tier stack light, bottom to top: blue (PM), green (busy), amber (setup),
// red (down) - the lit tier tells the state without its colour
const TIER = [-1, 1, 2, 0, 3];
const TIER_H = 0.055;
// stack-light lamps, linear HDR: exceptions exceed the bloom threshold and
// glow; the busy (normal) green stays a plain lamp
const LAMP = {
  [STATE.BUSY]: [0.16, 0.8, 0.28],
  [STATE.SETUP]: [4.8, 2.5, 0.2],
  [STATE.PM]: [1.0, 2.6, 8.4],
  [STATE.DOWN]: [8.4, 0.5, 1.0],
};
// Yellow light per theme (see applyLook). bay: the yellow-room filter, linear,
// relative to white; bayTool: how much of it tool surfaces take; glow: warm
// light the yellow room throws on its own floor.
const LOOK_DARK = { bay: [1.0, 0.85, 0.34], bayTool: 0.42, glow: [0.06, 0.04, 0.005] };
const LOOK_LIGHT = { bay: [1.0, 0.88, 0.38], bayTool: 0.45, glow: [0.03, 0.022, 0.0] };
const THEMES = {
  dark: {
    bg: 0x07090b, fog: 0x07090b, floorA: "#0d1013", floorB: "#101417", floorLine: "#1a2025", bayPlate: 0x14191d,
    aisleLine: 0xc9a634, body: 0xd9d7d0, efem: 0xa3a9b0, glass: 0x10161b, plinth: 0x3b4148, rail: 0x8c959e,
    rack: 0x4c545c, foup: 0xd3d8dc, vehicle: 0xe8e8e2, stocker: 0x2c3238, hover: 0xffffff, cable: 0x9aa3ab,
    shell: 0xbfc4c9, liquid: 0x16262b,
    states: STATES_DARK, paint: PAINT_DARK, stripe: "#1f2126", grid: "#d3def2", barOff: 0x30363c,
    hemiSky: 0xbfcad3, hemiGround: 0x0a0d0f, hemi: 0.35, sun: 1.7, env: 0.32, exposure: 1.0,
    look: LOOK_DARK,
  },
  light: {
    bg: 0xd5dade, fog: 0xd5dade, floorA: "#b9c0c7", floorB: "#c1c7cd", floorLine: "#a6aeb6", bayPlate: 0xd3d8dd,
    aisleLine: 0xd2a520, body: 0xf6f5f1, efem: 0xc3c8cd, glass: 0x28323b, plinth: 0x858c94, rail: 0x7f8891,
    rack: 0x8a929a, foup: 0xeef1f3, vehicle: 0xfafaf7, stocker: 0xa4acb4, hover: 0x0b0b0b, cable: 0x3a4148,
    shell: 0xdfe2e5, liquid: 0x22363c,
    states: STATES_LIGHT, paint: PAINT_LIGHT, stripe: "#1f2126", grid: "#d8e2f4", barOff: 0x3a4148,
    hemiSky: 0xffffff, hemiGround: 0x8a9098, hemi: 0.45, sun: 2.3, env: 0.42, exposure: 0.95,
    look: LOOK_LIGHT,
  },
};

/* ================================================================= layout */

export function buildLayout(src) {
  const families = src.families.map((f, i) => ({ ...f, index: i, machinesIdx: [] }));
  src.machine_family.forEach((fi, m) => families[fi].machinesIdx.push(m));
  const groups = new Map();
  for (const f of families) {
    const name = f.group || "Other";
    if (!groups.has(name)) groups.set(name, { name, families: [], machines: [] });
    groups.get(name).families.push(f);
  }
  for (const g of groups.values()) {
    g.families.sort((a, b) => a.name.localeCompare(b.name));
    for (const f of g.families) g.machines.push(...f.machinesIdx);
  }
  const isDelay = (n) => n.startsWith("Delay");
  const back = BACK.filter((n) => groups.has(n)), front = FRONT.filter((n) => groups.has(n));
  const count = (names) => names.reduce((s, n) => s + groups.get(n).machines.length, 0);
  for (const n of groups.keys()) {
    if (isDelay(n) || back.includes(n) || front.includes(n)) continue;
    (count(back) / DEPTH.back <= count(front) / DEPTH.front ? back : front).push(n);
  }
  const zStart = AISLE_HALF + RACK_GAP + RACK_D + RACK_GAP;
  const nM = src.machine_family.length;
  const machinePos = new Float32Array(nM * 3).fill(NaN);
  const machineSide = new Int8Array(nM);
  const bays = [];
  let width = 0;
  const rows = [[back, -1, DEPTH.back], [front, 1, DEPTH.front]].map(([names, side, depth]) => {
    let x = 0;
    const list = names.map((name) => {
      const g = groups.get(name);
      const perCol = Math.min(depth, Math.max(1, g.machines.length));
      const cols = Math.max(2, Math.ceil(g.machines.length / perCol));
      const bay = { group: g.name, g, side, perCol, cols, w: cols * P, x };
      x += bay.w + BAY_GAP;
      return bay;
    });
    const w = Math.max(0, x - BAY_GAP);
    width = Math.max(width, w);
    return { list, w, side };
  });
  for (const row of rows) {
    const x0 = -row.w / 2;
    for (const bay of row.list) {
      const s = row.side;
      bay.x0 = x0 + bay.x; bay.x1 = bay.x0 + bay.w;
      bay.zNear = s * zStart; bay.zFar = s * (zStart + bay.perCol * P);
      bay.g.machines.forEach((m, k) => {
        const c = Math.floor(k / bay.perCol), r = k % bay.perCol;
        machinePos[m * 3] = bay.x0 + (c + 0.5) * P;
        machinePos[m * 3 + 1] = 0;
        machinePos[m * 3 + 2] = s * (zStart + (r + 0.5) * P);
        machineSide[m] = s;
      });
      bay.cx = (bay.x0 + bay.x1) / 2; bay.cz = (bay.zNear + bay.zFar) / 2;
      bay.rack = { x0: bay.x0, x1: bay.x1, z0: s * (AISLE_HALF + RACK_GAP), z1: s * (AISLE_HALF + RACK_GAP + RACK_D) };
      bay.rackCols = Math.max(1, Math.floor(bay.w / FOUP_GRID));
      bay.rackCap = bay.rackCols * RACK_ROWS * RACK_LEVELS;
      bays.push(bay);
    }
  }
  const familyBay = new Int32Array(families.length).fill(-1);
  bays.forEach((b, i) => { for (const f of b.g.families) familyBay[f.index] = i; });
  // Delay stations: cells of a stocker running down the aisle centre
  const half = width / 2 + 2.2;
  const delay = [];
  for (const [name, g] of groups) if (isDelay(name)) delay.push(...g.machines);
  const stockLen = Math.max(4, width * 0.72);
  const cellsPerRow = Math.max(1, Math.ceil(delay.length / 4));        // 2 faces x 2 levels
  const cell = stockLen / cellsPerRow;
  const delayCell = new Map();
  delay.forEach((m, k) => {
    const col = k % cellsPerRow, rest = Math.floor(k / cellsPerRow), face = rest % 2, level = Math.floor(rest / 2);
    delayCell.set(m, { x: -stockLen / 2 + (col + 0.5) * cell, y: 0.068 + level * 0.36, z: face ? 0.22 : -0.22 });
  });
  return {
    families, groups, bays, familyBay, machinePos, machineSide, width, half, delayCell,
    stocker: { len: stockLen, cell, levels: 2 },
    zBack: -(zStart + DEPTH.back * P), zFront: zStart + DEPTH.front * P,
    entry: { x: -half - 0.8, z: 0 }, exit: { x: half + 0.8, z: 0 },
  };
}

/* ================================================================= replay */

const VIEWS = { I: Uint32Array, H: Uint16Array, B: Uint8Array };

export function decodeReplay(meta, buffer) {
  const a = {};
  for (const s of meta.sections) a[s.name] = new VIEWS[s.type](buffer, s.offset, s.length);
  a.r_t = a.r_t || new Uint32Array(0);
  a.r_family = a.r_family || new Uint8Array(0);
  a.pm = a.pm || new Uint32Array(meta.dispatches);      // v2 replays had no wafer-count PM column
  const nM = meta.layout.machine_family.length;
  const byMachine = (arr, n) => {
    const start = new Uint32Array(nM + 1);
    for (let i = 0; i < n; i++) start[arr[i] + 1]++;
    for (let m = 0; m < nM; m++) start[m + 1] += start[m];
    const order = new Uint32Array(n), fill = start.slice(0, nM);
    for (let i = 0; i < n; i++) order[fill[arr[i]]++] = i;
    return { start, order };
  };
  const disp = byMachine(a.machine, meta.dispatches);
  // consecutive lots on a tool alternate between its two load ports
  a.r_rank = new Uint16Array(a.r_t.length);
  a.r_rankMax = 0;
  for (let q = 1; q < a.r_t.length; q++) {
    if (a.r_t[q] === a.r_t[q - 1]) a.r_rank[q] = Math.min(65535, a.r_rank[q - 1] + 1);
    a.r_rankMax = Math.max(a.r_rankMax, a.r_rank[q]);
  }
  disp.nth = new Uint32Array(meta.dispatches);
  for (let m = 0; m < nM; m++) for (let k = disp.start[m]; k < disp.start[m + 1]; k++) disp.nth[disp.order[k]] = k - disp.start[m];
  const downs = byMachine(a.d_machine, meta.downs);
  // per machine: non-overlapping down segments, a breakdown wins over a PM
  // only where they actually overlap
  const dStart = [], dEnd = [], dKind = [], dFirst = new Uint32Array(nM + 1);
  for (let m = 0; m < nM; m++) {
    dFirst[m] = dStart.length;
    const rows = Array.from(downs.order.subarray(downs.start[m], downs.start[m + 1]));
    if (!rows.length) continue;
    const cuts = [...new Set(rows.flatMap((r) => [a.d_start[r], a.d_end[r]]))].sort((p, q) => p - q);
    for (let c = 0; c + 1 < cuts.length; c++) {
      const t0 = cuts[c], t1 = cuts[c + 1];
      let kind = 2;
      for (const r of rows) if (a.d_start[r] <= t0 && a.d_end[r] >= t1) kind = Math.min(kind, a.d_kind[r]);
      if (kind === 2) continue;
      const last = dStart.length - 1;
      if (last >= dFirst[m] && dEnd[last] === t0 && dKind[last] === kind) dEnd[last] = t1;
      else { dStart.push(t0); dEnd.push(t1); dKind.push(kind); }
    }
  }
  dFirst[nM] = dStart.length;
  const arrOrder = Array.from({ length: meta.dispatches }, (_, i) => i).sort((p, q) => (a.t[p] + a.lot_end[p]) - (a.t[q] + a.lot_end[q]));
  const arrT = new Float64Array(arrOrder.length), arrRow = Uint32Array.from(arrOrder);
  arrOrder.forEach((i, k) => { arrT[k] = a.t[i] + a.lot_end[i]; });
  return {
    meta, a, disp, dStart, dEnd, dKind, dFirst, arrT, arrRow, nFam: meta.layout.families.length,
    endTime: Math.round((meta.window.end_seconds - meta.window.start_seconds) * 10),
  };
}

function upper(arr, lo, hi, v) {
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid + 1; else hi = mid; }
  return lo;
}
function fract(v) { return v - Math.floor(v); }

/* ================================================================ helpers */

const _rows = [];
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _c = new THREE.Color(), _c2 = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function floorTexture(T) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const n = 4, tile = 256 / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    g.fillStyle = (i + j) % 2 ? T.floorA : T.floorB;
    g.fillRect(i * tile, j * tile, tile, tile);
    g.fillStyle = T.floorLine;                     // perforation dots
    for (let a = 4; a < tile; a += 8) for (let b = 4; b < tile; b += 8) g.fillRect(i * tile + a, j * tile + b, 1, 1);
  }
  g.strokeStyle = T.floorLine; g.lineWidth = 2;
  for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * tile, 0); g.lineTo(i * tile, 256); g.stroke(); g.beginPath(); g.moveTo(0, i * tile); g.lineTo(256, i * tile); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// equipment skin: three panels with seams and a trim line top and bottom
// (symmetric, so it reads the same whichever way a face's UVs run)
function panelTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "rgba(0, 0, 0, 0.13)";
  for (const x of [42, 85]) g.fillRect(x, 0, 1, 128);
  for (const y of [9, 118]) g.fillRect(0, y, 128, 1);
  g.fillStyle = "rgba(0, 0, 0, 0.05)";
  g.fillRect(0, 119, 128, 9);
  g.fillRect(0, 0, 128, 9);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function instanced(geo, mat, count, { cast = true, receive = true } = {}) {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, count));
  m.castShadow = cast; m.receiveShadow = receive;
  return m;
}

// Linear colour an unlit surface needs so that, after exposure and three's
// Neutral tone mapping (the output pass), the screen shows exactly `hex`:
// the closed-form inverse of NeutralToneMapping, per colour. Channels above
// sRGB ~243 are held there: brighter would need HDR input that blooms.
function displayColor(hex, exposure, target = new THREE.Color()) {
  target.set(hex);                                        // sRGB -> linear
  const out = [target.r, target.g, target.b].map((v) => Math.min(v, 0.9));
  let y = out;
  const np = Math.max(...out);
  if (np >= 0.76) {                                       // undo highlight compression
    const d = 0.24, peak = (d * d) / (1 - np) - d + 0.76;
    const g = 1 - 1 / (0.15 * (peak - np) + 1), k = ((1 - g) * np) / peak;
    y = out.map((v) => (v - np * g) / k);
  }
  const lo = Math.min(...y);                              // undo the toe offset
  const off = lo >= 0.04 ? 0.04 : 0.4 * Math.sqrt(Math.max(lo, 0)) - Math.max(lo, 0);
  return target.setRGB((y[0] + off) / exposure, (y[1] + off) / exposure, (y[2] + off) / exposure, THREE.LinearSRGBColorSpace);
}

// Status roof: unlit, per-instance colour, plus a per-instance pattern drawn in
// the shader (hazard stripes for down, blueprint grid for PM). The pattern is
// laid out in each roof's own metres, anti-aliased, and fades to the plain
// state colour once it gets too fine to read, so the whole-fab view shows the
// validated palette and a bay close-up shows the pattern.
function roofMaterial(T) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const uniforms = { uStripe: { value: displayColor(T.stripe, T.exposure) }, uGrid: { value: displayColor(T.grid, T.exposure) } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aPattern;\nvarying vec3 vPat;")
      .replace("#include <project_vertex>", `#include <project_vertex>
        vPat = vec3( transformed.xz, aPattern );
        #ifdef USE_INSTANCING
          vPat.xy *= vec2( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 2 ].xyz ) );
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vPat;\nuniform vec3 uStripe;\nuniform vec3 uGrid;")
      .replace("#include <color_fragment>", `#include <color_fragment>
        if ( vPat.z > 0.5 && vPat.z < 1.5 ) {          // down: diagonal hazard stripes, 1/3 dark
          float s = ( vPat.x - vPat.y ) * ${(0.70711 / STRIPE_P).toFixed(4)} + 0.5;
          float w = fwidth( s );
          float band = 1.0 - smoothstep( 0.17 - 0.7 * w, 0.17 + 0.7 * w, abs( fract( s ) - 0.5 ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, uStripe, band * ( 1.0 - smoothstep( 0.2, 0.36, w ) ) );
        } else if ( vPat.z > 1.5 ) {                    // PM: blueprint grid, cells centred on the roof
          vec2 q = vPat.xy * ${(1 / GRID_P).toFixed(4)};
          vec2 w = fwidth( q );
          vec2 dl = 0.5 - abs( fract( q + 0.5 ) - 0.5 );
          vec2 ln = 1.0 - smoothstep( 0.12 - 0.7 * w, 0.12 + 0.7 * w, dl );
          diffuseColor.rgb = mix( diffuseColor.rgb, uGrid, max( ln.x, ln.y ) * ( 1.0 - smoothstep( 0.2, 0.36, max( w.x, w.y ) ) ) );
        }`);
  };
  mat.customProgramCacheKey = () => "fab-status-roof";
  return mat;
}

/* =================================================================== look */
// Yellow light, shared by every lit material (patchLook, applied by applyLook
// once a fab is built, so it reaches whatever materials the tools use); unlit
// surfaces - status roofs, lamps, light bars - are never touched, so the state
// colours stay exact on every quality tier. Photolithography bays are lit
// through yellow filters (no light under ~500 nm), so all light a surface
// receives in the Litho and Litho_Met bays is filtered warm yellow and spills
// a little onto the aisle. Tools take less of it than the room, and painted
// state colours keep their hue, so a busy tool never reads as a setup one.
const YELLOW_BAYS = ["Litho", "Litho_Met"];
const ZONES = 2;

function lookUniforms() {
  const nowhere = () => new THREE.Vector4(1e5, 1e5, 1e5 + 1, 1e5 + 1);
  return {
    uFabZone: { value: Array.from({ length: ZONES }, nowhere) },   // yellow rooms: x0, z0, x1, z1
    uFabBay: { value: new THREE.Vector4(1, 1, 1, 0.9) },            // filter rgb, spill width
    uFabGlow: { value: new THREE.Vector3() },
  };
}

// the yellow rooms: each yellow bay from the aisle line to behind its last
// row; neighbouring yellow bays in one row share a room
function yellowZones(L) {
  const rooms = [];
  for (const b of L.bays) {
    if (!YELLOW_BAYS.includes(b.group)) continue;
    const zA = b.side * AISLE_HALF, zB = b.zFar + b.side * 0.4;
    const r = { side: b.side, x0: b.x0 - 0.3, x1: b.x1 + 0.3, z0: Math.min(zA, zB), z1: Math.max(zA, zB) };
    const room = rooms.find((q) => q.side === r.side && r.x0 <= q.x1 + BAY_GAP && q.x0 <= r.x1 + BAY_GAP);
    if (room) Object.assign(room, { x0: Math.min(room.x0, r.x0), x1: Math.max(room.x1, r.x1), z0: Math.min(room.z0, r.z0), z1: Math.max(room.z1, r.z1) });
    else rooms.push(r);
  }
  return rooms.slice(0, ZONES);
}

const LOOK_VERT_PARS = `#include <common>
varying vec3 vFabW;`;
const LOOK_VERT = `#include <project_vertex>
  {
    vec4 fabW = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
      fabW = instanceMatrix * fabW;
    #endif
    fabW = modelMatrix * fabW;
    vFabW = fabW.xyz;
  }`;
const LOOK_FRAG_PARS = `#include <common>
varying vec3 vFabW;
uniform vec4 uFabZone[ ${ZONES} ];
uniform vec4 uFabBay;
uniform vec3 uFabGlow;
uniform float uFabAmt;
float fabZone( vec2 p ) {
  float m = 0.0;
  for ( int i = 0; i < ${ZONES}; i ++ ) {
    vec4 r = uFabZone[ i ];
    vec2 q = abs( p - 0.5 * ( r.xy + r.zw ) ) - 0.5 * ( r.zw - r.xy );
    float d = length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 );
    m = max( m, 1.0 - smoothstep( -0.25, uFabBay.a, d ) );
  }
  return m;
}`;
const LOOK_LIGHTS = `#include <lights_fragment_end>
  float fabBay = fabZone( vFabW.xz ) * uFabAmt;
  #ifndef FAB_ENV
  {                                        // painted state colours keep their hue
    float hi = max( max( diffuseColor.r, diffuseColor.g ), diffuseColor.b );
    float lo = min( min( diffuseColor.r, diffuseColor.g ), diffuseColor.b );
    fabBay *= 1.0 - 0.85 * smoothstep( 0.12, 0.4, ( hi - lo ) / max( hi, 1e-3 ) );
  }
  #endif
  vec3 fabF = mix( vec3( 1.0 ), uFabBay.rgb, fabBay );
  reflectedLight.directDiffuse *= fabF;
  reflectedLight.indirectDiffuse *= fabF;
  reflectedLight.directSpecular *= fabF;
  reflectedLight.indirectSpecular *= fabF;`;
const LOOK_OUT = `
  #ifdef FAB_FLOOR
    outgoingLight += uFabGlow * fabBay;
  #endif
#include <opaque_fragment>`;

// Adds the yellow light to a lit material. kind: "tool" (the default: part of
// the yellow light, state paint kept), "room" (racks, stocker, floor stripes:
// the full yellow light), "floor" (floor and bay plates: also the room's warm
// glow). Chains any onBeforeCompile the material already has.
function patchLook(mat, kind, U, amt) {
  if (mat.userData.fabLook) return;
  const prev = mat.onBeforeCompile;
  const baseKey = Object.prototype.hasOwnProperty.call(mat, "customProgramCacheKey") ? mat.customProgramCacheKey.bind(mat) : ((s) => () => s)(prev.toString());
  const own = { uFabAmt: { value: amt } };
  mat.userData.fabLook = own;
  mat.onBeforeCompile = (sh, renderer) => {
    prev.call(mat, sh, renderer);
    const v = sh.vertexShader, f = sh.fragmentShader;
    const hooks = [v.includes("#include <common>"), v.includes("#include <project_vertex>"), f.includes("#include <common>"),
      f.includes("#include <lights_fragment_end>"), f.includes("#include <opaque_fragment>")];
    if (!hooks.every(Boolean)) return;
    Object.assign(sh.uniforms, U, own);
    const defs = (kind !== "tool" ? "#define FAB_ENV\n" : "") + (kind === "floor" ? "#define FAB_FLOOR\n" : "");
    sh.vertexShader = defs + v.replace("#include <common>", LOOK_VERT_PARS).replace("#include <project_vertex>", LOOK_VERT);
    sh.fragmentShader = defs + f.replace("#include <common>", LOOK_FRAG_PARS).replace("#include <lights_fragment_end>", LOOK_LIGHTS)
      .replace("#include <opaque_fragment>", LOOK_OUT);
  };
  mat.customProgramCacheKey = () => baseKey() + "|fab-look:" + kind;
  mat.needsUpdate = true;
}

/* ================================================================== scene */

export class FabScene {
  constructor(container, labelHost, { onHover, onQuality } = {}) {
    this.container = container;
    this.labelHost = labelHost;
    this.onHover = onHover || (() => {});
    this.onQuality = onQuality || (() => {});
    this.themeName = "dark";
    this.quality = "high";
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.append(this.renderer.domElement);
    this.renderer.domElement.setAttribute("role", "img");
    this.renderer.domElement.setAttribute("aria-label", "Nhà máy 3D: kéo để xoay, cuộn để phóng to, bấm đúp vào một khu để lại gần");

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.3, 1500);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.08, maxPolarAngle: Math.PI * 0.46, autoRotateSpeed: 0.3, zoomSpeed: 0.9 });
    this.controls.addEventListener("change", () => {
      this.dirty = true;
      if (this.pointer) this.pickPending = true;
      // carried FOUPs grow when zoomed out, so flows between bays stay visible
      const sc = Math.min(2.2, Math.max(1, this.camera.position.distanceTo(this.controls.target) / 25));
      if (Math.abs(sc - this.tripScale) > 0.05) { this.tripScale = sc; if (this.replay && this.L) { this.updateTrips(this.time); this.dirty = true; } }
      this.showDetail();
    });
    this.controls.addEventListener("start", () => { this.controls.autoRotate = false; });
    // a drag or scroll by the user takes over a camera flight (see flyTo)
    this.controls.addEventListener("start", () => { this.touched = true; this.interruptFlight(); });
    this.baseFov = this.camera.fov;
    this.flight = null;                // camera move in progress (see flyTo)
    this.playing = false;              // replay playing: stack-light effects run
    this.flashing = [];                // [lamp instance, tool slot] of down / PM tools, filled by setTime
    this.flashLevel = new Float32Array(0);
    this.motionQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    this.sun = new THREE.DirectionalLight(0xfff4e5, 2.5);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.02;
    this.fill = new THREE.DirectionalLight(0xdfe8ff, 0.5);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.fill);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.look = lookUniforms();       // yellow light (applyLook)

    this.composer = null;
    this.raycaster = new THREE.Raycaster();
    this.speed = 1800;
    this.tripScale = 1;
    this.routes = new Map();
    this.replay = null;
    this.time = 0;
    this.dirty = true;
    this.frameTimes = [];

    const cv = this.renderer.domElement;
    cv.addEventListener("pointermove", (e) => { this.pointer = { x: e.clientX, y: e.clientY }; this.pickPending = true; });
    cv.addEventListener("pointerleave", () => { this.pointer = null; this.setHover(null); });
    cv.addEventListener("dblclick", (e) => { this.pointer = { x: e.clientX, y: e.clientY }; const h = this.hit(); if (h && h.bay >= 0) this.focusBay(h.bay); else this.frame(); });
    // the opening flight gives way to any input: on the fab a drag or scroll
    // takes the camera over ("start" above), anywhere else it settles quickly
    const skip = (e) => { if (this.flight?.intro && e.target !== cv) this.settleFlight(); };
    for (const type of ["pointerdown", "wheel", "keydown"]) addEventListener(type, skip, { capture: true, passive: true });
    new ResizeObserver(() => this.resize()).observe(container);
    this.setQuality("high", true);
    let last = performance.now(), drew = false, g = 0;
    const gaps = [16, 16, 16, 16];      // frame intervals right after a draw: what a frame costs
    this.frameMs = 16;
    const loop = (now) => {
      requestAnimationFrame(loop);
      if (drew) { gaps[g++ % gaps.length] = now - last; this.frameMs = Math.min(...gaps); }
      if (this.flight) this.stepFlight(now);
      else if (this.controls.update()) this.dirty = true;
      this.stepLamps(now);
      if (this.pickPending && !this.flight) { this.pickPending = false; this.pick(); }
      drew = this.dirty;
      if (this.dirty) {
        this.dirty = false;
        if (this.composer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
        this.placeLabels();
        this.watchPerformance(now - last);
      }
      last = now;
    };
    requestAnimationFrame(loop);
  }

  /* ------------------------------------------------------------- quality */
  setQuality(q, silent, auto = false) {
    this.quality = QUALITY.includes(q) ? q : "high";
    const hi = this.quality === "high", lo = this.quality === "low";
    this.renderer.setPixelRatio(hi ? Math.min(window.devicePixelRatio || 1, 2) : 1);
    this.renderer.shadowMap.enabled = !lo;
    this.sun.castShadow = !lo;
    this.sun.shadow.mapSize.set(hi ? 4096 : 2048, hi ? 4096 : 2048);
    if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    this.buildComposer();
    this.frameTimes = [];
    this.resize();
    if (this.replay && this.L) this.updateTrips(this.time);            // the trip cap depends on the quality
    if (!silent) this.onQuality(this.quality, auto);
  }

  buildComposer() {
    if (this.composer) {
      // EffectComposer.dispose() frees only its own targets, not the passes'
      for (const pass of this.composer.passes) pass.dispose?.();
      this.composer.dispose?.();
      this.composer = null; this.gtao = null; this.bloom = null;
    }
    // composed tiers render the scene more than once a frame (AO normals): the
    // shadow map is drawn once, by beforeScene, and only when something that
    // casts a shadow moved
    this.renderer.shadowMap.autoUpdate = this.quality === "low";
    this.shadowKeyLast = null;
    if (this.quality === "low") return;
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, rt);
    const scenePass = new RenderPass(this.scene, this.camera), drawScene = scenePass.render.bind(scenePass);
    scenePass.render = (...args) => { this.beforeScene(); drawScene(...args); };
    composer.addPass(scenePass);
    if (this.quality === "high") {
      const gtao = new GTAOPass(this.scene, this.camera, w, h);
      gtao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.4, thickness: 1.2, scale: 1.1, samples: 16 });
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 16 });
      gtao.blendIntensity = 0.85;
      composer.addPass(gtao);
      this.gtao = gtao;
    } else this.gtao = null;
    // threshold above any lit white surface, so only the status lamps glow
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.42, 0.3, 1.45);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  // once per composed frame, before the scene pass: redraw the shadow map
  // when a caster moved
  beforeScene() {
    const key = this.shadowKey();
    if (key !== this.shadowKeyLast) { this.renderer.shadowMap.needsUpdate = true; this.shadowKeyLast = key; }
  }

  // what the shadow map depends on: the casting meshes, their instance
  // transforms and counts (any change to those bumps the attribute version)
  shadowKey() {
    let key = this.sun.shadow.map ? "" : "none|";
    for (const o of this.world.children) if (o.castShadow && o.visible) key += o.id + (o.isInstancedMesh ? ":" + o.instanceMatrix.version + "/" + o.count : "") + ",";
    return key;
  }

  // the theme's yellow light, the yellow rooms, and the light patch on every
  // lit material of the freshly built fab
  applyLook(L, T) {
    const X = T.look, U = this.look, rooms = yellowZones(L);
    U.uFabZone.value.forEach((v, i) => { const r = rooms[i]; if (r) v.set(r.x0, r.z0, r.x1, r.z1); else v.set(1e5, 1e5, 1e5 + 1, 1e5 + 1); });
    U.uFabBay.value.set(X.bay[0], X.bay[1], X.bay[2], 0.6);
    U.uFabGlow.value.fromArray(X.glow);
    this.world.traverse((o) => {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m || !(m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial)) continue;
        const kind = m.userData.fabKind || "tool";
        patchLook(m, kind, U, kind === "tool" ? X.bayTool : 1);
      }
    });
  }

  watchPerformance(dt) {
    if (this.quality === "low" || !this.replay || dt <= 0 || dt > 500) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 90) return;
    const avg = this.frameTimes.reduce((s, v) => s + v, 0) / this.frameTimes.length;
    this.frameTimes = [];
    if (avg > 34) this.setQuality(this.quality === "high" ? "medium" : "low", false, true);
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(w, h);
    }
    this.dirty = true;
  }

  setTheme(name) {
    this.themeName = name === "light" ? "light" : "dark";
    if (this.src) this.setLayout(this.src, { keepCamera: true });
    if (this.replay) this.setTime(this.time, { force: true });
  }

  /* ---------------------------------------------------------------- build */
  setLayout(src, { keepCamera = false } = {}) {
    if (src !== this.src) this.replay = null;          // a replay of another fab cannot be drawn on this one
    this.src = src;
    const L = buildLayout(src), T = THEMES[this.themeName];
    this.L = L;
    this.vehicleMesh = null;
    this.routes = new Map();
    this.world.traverse((o) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.map?.dispose?.(); m.dispose?.(); }); });
    this.world.clear();
    this.scene.background = new THREE.Color(T.bg);
    const span = Math.max(L.width + 12, L.zFront - L.zBack + 8);
    // keep the fog fitted by frame() when only the theme changes
    const fit = keepCamera && this.fitDist ? this.fitDist : null;
    this.scene.fog = fit ? new THREE.Fog(T.fog, fit * 1.35, fit * 3.2) : new THREE.Fog(T.fog, span * 1.6, span * 3.6);
    this.scene.environmentIntensity = T.env;
    this.renderer.toneMappingExposure = T.exposure;
    this.hemi.color.set(T.hemiSky); this.hemi.groundColor.set(T.hemiGround); this.hemi.intensity = T.hemi;
    this.sun.intensity = T.sun;

    const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, ...extra });
    const box = (w, h, d, mat, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z); m.receiveShadow = true;
      this.world.add(m);
      return m;
    };

    // raised cleanroom floor; it and the bay plates take the yellow rooms' glow (applyLook)
    const tex = floorTexture(T);
    const floorSize = span * 14;
    tex.repeat.set(floorSize / 2.4, floorSize / 2.4);
    const floorMat = std(0xffffff, { map: tex, roughness: 0.62, metalness: 0.0 });
    floorMat.userData.fabKind = "floor";
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorSize, floorSize), floorMat);
    floor.rotation.x = -Math.PI / 2; floor.position.set(0, -0.001, (L.zFront + L.zBack) / 2); floor.receiveShadow = true;
    this.world.add(floor);

    // aisle walkway lines
    const lineMat = new THREE.MeshBasicMaterial({ color: T.aisleLine });
    for (const z of [-AISLE_HALF + 0.08, AISLE_HALF - 0.08]) box(L.half * 2 + 1.6, 0.004, 0.05, lineMat, 0, 0.003, z);

    // bays: plate + accent stripe on the aisle side
    const plateMat = std(T.bayPlate, { roughness: 0.8 });
    plateMat.userData.fabKind = "floor";
    for (const b of L.bays) {
      const d = Math.abs(b.zFar - b.zNear) + 0.5;
      box(b.w + 0.5, 0.02, d, plateMat, b.cx, 0.01, b.cz);
      const accent = new THREE.MeshStandardMaterial({ color: GROUP_COLOR[b.group] ?? OTHER_COLOR, roughness: 0.5, emissive: GROUP_COLOR[b.group] ?? OTHER_COLOR, emissiveIntensity: this.themeName === "dark" ? 0.25 : 0.05 });
      accent.userData.fabKind = "room";
      box(b.w + 0.5, 0.012, 0.09, accent, b.cx, 0.026, b.zNear - b.side * 0.2);
    }

    // FOUP racks (base + two shelves + posts)
    const rackMat = std(T.rack, { roughness: 0.45, metalness: 0.6 });
    rackMat.userData.fabKind = "room";
    for (const b of L.bays) {
      const zc = (b.rack.z0 + b.rack.z1) / 2;
      for (let lvl = 0; lvl < RACK_LEVELS; lvl++) box(b.w, 0.025, RACK_D * 0.9, rackMat, b.cx, 0.02 + lvl * LEVEL_H, zc);
      for (const x of [b.x0 + 0.02, b.x1 - 0.02]) for (const dz of [-0.4, 0.4]) box(0.03, LEVEL_H * (RACK_LEVELS - 1) + 0.05, 0.03, rackMat, x, (LEVEL_H * (RACK_LEVELS - 1)) / 2 + 0.02, zc + dz * RACK_D);
    }

    // stocker for lots on Delay stations
    const stockMat = std(T.stocker, { roughness: 0.4, metalness: 0.55 });
    stockMat.userData.fabKind = "room";
    const S = L.stocker;
    for (let lvl = 0; lvl <= S.levels; lvl++) box(S.len, 0.03, 0.9, stockMat, 0, 0.05 + lvl * 0.36, 0);
    box(S.len, 0.72, 0.03, stockMat, 0, 0.41, 0);
    for (const x of [-S.len / 2, S.len / 2]) box(0.05, 0.8, 0.9, stockMat, x, 0.4, 0);

    // machines -------------------------------------------------------
    const shown = [];
    for (const b of L.bays) shown.push(...b.g.machines);
    this.shown = Int32Array.from(shown);
    const n = shown.length;
    this.slotOf = new Int32Array(src.machine_family.length).fill(-1);
    shown.forEach((m, i) => { this.slotOf[m] = i; });
    this.machineGroup = shown.map((m) => L.families[src.machine_family[m]].group);
    this.machineSize = shown.map((m, i) => SIZE[this.machineGroup[i]] || DEFAULT_SIZE);

    // one bevel step: at this scale it reads as rounded, at a third of the triangles
    const rounded = new RoundedBoxGeometry(1, 1, 1, 1, 0.028); rounded.translate(0, 0.5, 0);
    const unit = new THREE.BoxGeometry(1, 1, 1); unit.translate(0, 0.5, 0);
    // state colours for this theme: exact-display roof colours, and head paint
    // as a multiplier on the body colour (the per-tool brightness jitter is
    // folded in when a tool is painted)
    const bodyLin = new THREE.Color(T.body);
    this.roofCol = T.states.map((hex) => displayColor(hex, T.exposure));
    this.headTint = T.paint.map((p) => {
      if (typeof p === "number") return new THREE.Color(p, p, p);
      const c = new THREE.Color(p);
      return new THREE.Color(c.r / bodyLin.r, c.g / bodyLin.g, c.b / bodyLin.b);
    });
    this.jitter = new Float32Array(n);
    const plinths = instanced(unit, std(T.plinth, { roughness: 0.7, metalness: 0.2 }), n, { cast: false });
    const bodyMat = std(T.body, { map: panelTexture(), roughness: 0.42, metalness: 0.08 });
    this.bodies = instanced(rounded, bodyMat, n);
    this.heads = instanced(rounded, bodyMat, n);
    const efems = instanced(rounded, std(T.efem, { roughness: 0.45, metalness: 0.12 }), n);
    const glass = instanced(unit, std(T.glass, { roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.62, depthWrite: false }), n, { cast: false });
    glass.renderOrder = 1;
    // wafer-handling robot behind the EFEM window: a column on a linear track with its arm
    const robotGeo = mergeGeometries([
      new THREE.BoxGeometry(0.05, 0.1, 0.02).translate(0, 0.05, 0),
      new THREE.BoxGeometry(0.1, 0.014, 0.018).translate(0.035, 0.1, 0),
    ]);
    this.robots = instanced(robotGeo, std(0x59626b, { roughness: 0.4, metalness: 0.5 }), n, { cast: false });
    this.robotSpots = new Float32Array(n * 4);             // x at rest, y, z, travel
    // operator screen on the EFEM front: lit while the tool has work, dark when idle
    this.screens = instanced(unit, new THREE.MeshBasicMaterial({ color: 0xffffff }), n, { cast: false, receive: false });
    const roofGeo = unit.clone();
    this.roofPattern = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    roofGeo.setAttribute("aPattern", this.roofPattern);
    this.roofs = instanced(roofGeo, roofMaterial(T), n, { cast: false, receive: false });
    const ports = instanced(unit, std(T.plinth, { roughness: 0.5, metalness: 0.4 }), n * 2, { cast: false });
    const poleGeo = new THREE.CylinderGeometry(0.018, 0.018, 1, 6); poleGeo.translate(0, 0.5, 0);
    const poles = instanced(poleGeo, std(0x6d747b, { metalness: 0.6, roughness: 0.4 }), n, { cast: false });
    const lampGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.05, 10);
    const housings = instanced(lampGeo, std(0x2a3036, { roughness: 0.3 }), n * 4, { cast: false });
    this.lamps = instanced(lampGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), n, { cast: false, receive: false });
    this.lamps.count = 0;
    const foupGeo = new RoundedBoxGeometry(FOUP, FOUP, FOUP, 1, 0.04); foupGeo.translate(0, FOUP / 2, 0);
    const foupMat = std(T.foup, { roughness: 0.45, metalness: 0.02 });
    this.portFoups = instanced(foupGeo, foupMat, n * 2);
    this.portFoups.count = 0;

    // per-type tool parts (see toolShape): one instanced mesh per part type
    const geos = {
      rounded, unit,
      cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 28).translate(0, 0.5, 0),
      cylS: new THREE.CylinderGeometry(0.5, 0.5, 1, 12).translate(0, 0.5, 0),
      cylX: new THREE.CylinderGeometry(0.5, 0.5, 1, 16).rotateZ(Math.PI / 2).translate(0, 0.5, 0),
    };
    const mats = {
      body: bodyMat,
      shell: std(T.shell, { roughness: 0.34, metalness: 0.32 }),
      metal: std(0x9aa1a8, { roughness: 0.32, metalness: 0.75 }),
      dark: std(0x3a4148, { roughness: 0.5, metalness: 0.3 }),
      liquid: std(T.liquid, { roughness: 0.32, metalness: 0.0, envMapIntensity: 0.4 }),
      cover: std(0xd6e6ef, { roughness: 0.05, metalness: 0.0, transparent: true, opacity: 0.28, depthWrite: false }),
      vent: std(0xa7aeb5, { roughness: 0.35, metalness: 0.7 }),
    };
    const shapes = shown.map((m, i) => toolShape(this.machineGroup[i], ...this.machineSize[i]));
    const bars = instanced(unit, new THREE.MeshBasicMaterial({ color: 0xffffff }), n, { cast: false, receive: false });
    this.bars = bars;
    this.parts = { plinths, efems, glass, ports, poles, housings };
    this.portSpots = new Float32Array(n * 6);
    this.lampSpots = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const m = shown[i], x = L.machinePos[m * 3], z = L.machinePos[m * 3 + 2], side = L.machineSide[m];
      const [sx, h, sz] = this.machineSize[i];
      const front = 1;                           // all tools face +z, towards the default camera
      const bodyD = sz * 0.74, efemD = sz * 0.24;
      const bodyZ = z - front * (sz / 2 - bodyD / 2), efemZ = z + front * (sz / 2 - efemD / 2);
      const { core } = shapes[i], cx = x + core.x, cz = z + core.z;
      plinths.setMatrixAt(i, _m4.compose(_v.set(x, 0, z), _q, _s.set(sx + 0.04, 0.05, sz + 0.04)));
      this.bodies.setMatrixAt(i, _m4.compose(_v.set(cx, 0.05, cz), _q, _s.set(core.w, core.h * HEAD, core.d)));
      this.heads.setMatrixAt(i, _m4.compose(_v.set(cx, 0.05 + core.h * HEAD, cz), _q, _s.set(core.w, core.h * (1 - HEAD), core.d)));
      this.jitter[i] = 0.97 + 0.06 * fract(Math.sin(m * 12.9898) * 43758.5453);
      this.bodies.setColorAt(i, _c.setScalar(this.jitter[i]));
      efems.setMatrixAt(i, _m4.compose(_v.set(x, 0.05, efemZ), _q, _s.set(sx * 0.94, h * HEAD, efemD)));
      const face = efemZ + front * efemD / 2;               // the EFEM's front face
      glass.setMatrixAt(i, _m4.compose(_v.set(x, 0.05 + h * 0.3, face + 0.026), _q, _s.set(sx * 0.62, h * 0.22, 0.006)));
      this.robotSpots.set([x, 0.05 + h * 0.3 + 0.01, face + 0.012, sx * 0.22], i * 4);
      this.robots.setMatrixAt(i, _m4.compose(_v.set(x - sx * 0.22, 0.05 + h * 0.3 + 0.01, face + 0.012), _q, _s.set(1, 1, 1)));
      this.screens.setMatrixAt(i, _m4.compose(_v.set(x + sx * 0.37, 0.05 + h * 0.34, face + 0.004), _q, _s.set(0.085, 0.06, 0.008)));
      // status roof: the flat top of the status block (a band of it on a CMP), a thin raised panel
      const rf = core.roof || { z: 0, d: 0.9 };
      this.roofs.setMatrixAt(i, _m4.compose(_v.set(cx, 0.046 + core.h, cz + rf.z), _q, _s.set(core.w * 0.93, ROOF_T, core.d * rf.d)));
      for (let p = 0; p < 2; p++) {
        const px = x + (p ? 1 : -1) * sx * 0.22, pz = efemZ + front * (efemD / 2 + 0.06);
        ports.setMatrixAt(i * 2 + p, _m4.compose(_v.set(px, 0.05, pz), _q, _s.set(0.19, 0.26, 0.12)));
        this.portSpots.set([px, 0.31, pz], (i * 2 + p) * 3);
      }
      // status light bar along the top front edge of the EFEM
      bars.setMatrixAt(i, _m4.compose(_v.set(x, 0.05 + h * HEAD, efemZ + front * (efemD / 2 - 0.012)), _q, _s.set(sx * 0.86, 0.022, 0.024)));
      const lx = cx + core.w * 0.4, lz = cz - core.d * 0.35, ly = 0.05 + core.h;     // stack light on the status block
      poles.setMatrixAt(i, _m4.compose(_v.set(lx, ly, lz), _q, _s.set(1, 0.17, 1)));
      for (let k = 0; k < 4; k++) housings.setMatrixAt(i * 4 + k, _m4.compose(_v.set(lx, ly + 0.19 + k * TIER_H, lz), _q, _s.set(1, 1, 1)));
      this.lampSpots.set([lx, ly + 0.19, lz], i * 3);
    }
    // parts: count per type, build one instanced mesh each, remember which
    // tool every instance belongs to (painting, picking)
    const byType = {};
    shapes.forEach((sh, i) => { for (const part of sh.parts) (byType[part[0]] ||= []).push([i, part]); });
    this.paintLinks = Array.from({ length: n }, () => []);
    this.paintMeshes = [];
    this.detailMeshes = [];
    this.pickParts = [];
    for (const [type, list] of Object.entries(byType)) {
      const spec = PARTS[type];
      const mesh = instanced(geos[spec.geo], mats[spec.mat], list.length, { cast: !spec.detail && spec.mat !== "cover" });
      const slots = new Int32Array(list.length);
      list.forEach(([i, [, px, py, pz, w, hh, d]], k) => {
        const m = shown[i];
        mesh.setMatrixAt(k, _m4.compose(_v.set(L.machinePos[m * 3] + px, 0.05 + py, L.machinePos[m * 3 + 2] + pz), _q, _s.set(w, hh, d)));
        slots[k] = i;
        if (spec.paint) this.paintLinks[i].push([mesh, k]);
        else if (spec.jitter) mesh.setColorAt(k, _c.setScalar(this.jitter[i]));
      });
      mesh.userData.slots = slots;
      if (spec.paint) this.paintMeshes.push(mesh);
      if (spec.detail) this.detailMeshes.push(mesh);
      if (spec.pick) this.pickParts.push(mesh);
      if (spec.mat === "cover") mesh.renderOrder = 2;
      this.world.add(mesh);
    }
    for (const mesh of [plinths, this.bodies, this.heads, efems, glass, this.roofs, ports, poles, housings, this.lamps, this.portFoups, bars, this.robots, this.screens]) this.world.add(mesh);
    this.detailMeshes.push(this.robots, this.screens);
    this.state = new Uint8Array(n).fill(255);

    // waiting lots on racks, lots in the stocker, OHT
    const cap = L.bays.reduce((s, b) => s + b.rackCap, 0);
    this.rackFoups = instanced(foupGeo, foupMat, cap);
    this.rackFoups.count = 0;
    this.stockFoups = instanced(foupGeo, foupMat, Math.max(1, L.delayCell.size));
    this.stockFoups.count = 0;
    this.world.add(this.rackFoups, this.stockFoups);
    this.buildRails(T);
    const vehGeo = mergeGeometries([
      new THREE.BoxGeometry(0.3, 0.16, 0.22).translate(0, 0.07, 0),
      new THREE.BoxGeometry(0.24, 0.03, 0.025).translate(0, -0.03, 0.095),
      new THREE.BoxGeometry(0.24, 0.03, 0.025).translate(0, -0.03, -0.095),
    ]);
    // a pale running light (not a status colour) so traffic reads from far away
    const maxTrips = MAX_TRIPS.high;
    this.vehicleMesh = instanced(vehGeo, std(T.vehicle, { roughness: 0.35, metalness: 0.15, emissive: 0x9fe8ff, emissiveIntensity: 0.22 }), maxTrips, { receive: false });
    this.vehicleFoups = instanced(foupGeo, foupMat, maxTrips, { receive: false });
    // hoist belt while a FOUP is lowered to / lifted from a port or rack
    const cableGeo = new THREE.BoxGeometry(0.014, 1, 0.014); cableGeo.translate(0, 0.5, 0);
    this.cables = instanced(cableGeo, new THREE.MeshBasicMaterial({ color: T.cable }), maxTrips, { cast: false, receive: false });
    for (const mesh of [this.vehicleMesh, this.vehicleFoups, this.cables]) { mesh.count = 0; mesh.frustumCulled = false; }
    this.world.add(this.vehicleMesh, this.vehicleFoups, this.cables);

    this.hoverBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: T.hover }));
    this.hoverBox.visible = false;
    this.world.add(this.hoverBox);

    // light rig fitted to the fab
    const cz = (L.zFront + L.zBack) / 2;
    this.sun.position.set(-span * 0.28, span * 0.9, cz + span * 0.42);
    this.sun.target.position.set(0, 0, cz);
    const r = span * 0.62;
    Object.assign(this.sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: span * 2.6 });
    this.sun.shadow.camera.updateProjectionMatrix();
    this.fill.position.set(span * 0.5, span * 0.4, cz - span * 0.6);
    this.applyLook(L, T);
    this.paintIdle();
    this.buildLabels();
    if (!keepCamera) this.frame();
    this.showDetail();
    this.dirty = true;
  }

  // One-way OHT network. The interbay loop runs along the back rail in +x, down
  // the right end, along the front rail in -x and up the left end. Each bay has
  // an entry spur at its upstream edge (vehicles arrive along the loop and turn
  // in, away from the aisle), rails over the rack and over every row of load
  // ports running downstream, an exit spur at its downstream edge back to the
  // loop, and a return rail near the aisle from the exit spur to the entry spur
  // for moves that stay inside the bay.
  buildRails(T) {
    const L = this.L, segs = [];
    const zr = AISLE_HALF - 0.45, H = L.half;
    const net = { H, zr, Lt: 4 * H + 4 * zr, bays: [] };
    net.loopPos = (x, side) => (side < 0 ? x + H : 2 * H + 2 * zr + (H - x));
    segs.push([-H, -zr, H, -zr], [H, -zr, H, zr], [H, zr, -H, zr], [-H, zr, -H, -zr]);
    let deepest = 0;
    for (const b of L.bays) {
      const s = b.side, dir = s < 0 ? 1 : -1;                 // bays flow with the loop rail beside them
      const sz = (SIZE[b.group] || DEFAULT_SIZE)[2], zStart = Math.abs(b.zNear);
      const rowZ = Array.from({ length: b.perCol }, (_, r) => s * (zStart + (r + 0.5) * P) + sz / 2 + 0.06);
      const far = [b.zFar - s * 0.35, ...rowZ.map((z) => z + s * 0.1)];
      const B = {
        side: s, dir, zAisle: s * zr, zReturn: s * (zr + 0.45), zRack: s * (AISLE_HALF + RACK_GAP + RACK_D / 2),
        zFar: s > 0 ? Math.max(...far) : Math.min(...far),               // the spurs reach every port row
        entryX: dir > 0 ? b.x0 + 0.12 : b.x1 - 0.12, exitX: dir > 0 ? b.x1 - 0.12 : b.x0 + 0.12,
      };
      B.inMax = 3 * b.w + 2 * Math.abs(B.zFar - B.zAisle) + 4;            // any route leg inside this bay is shorter
      net.bays.push(B);
      deepest = Math.max(deepest, 2 * Math.abs(B.zFar - B.zAisle) + 2 * b.w);
      segs.push([B.entryX, B.zAisle, B.entryX, B.zFar], [B.exitX, B.zFar, B.exitX, B.zAisle]);
      segs.push([B.exitX, B.zReturn, B.entryX, B.zReturn, 0.7], [B.entryX, B.zRack, B.exitX, B.zRack]);
      for (const z of rowZ) segs.push([B.entryX, z, B.exitX, z, 0.42]);
    }
    // short rails out to the entry and exit gates
    segs.push([-H, 0, -H - 0.8, 0, 0.7], [H, 0, H + 0.8, 0, 0.7]);
    // the stocker: a rail over each face, flowing with the loop rail beside it,
    // joined to that loop rail at both ends; lots are handed over on its top
    const S = L.stocker, lim = S.len / 2 - 0.2;
    net.stockY = 0.05 + S.levels * 0.36 + 0.02;
    net.faces = [-1, 1].map((side) => {
      const dir = side < 0 ? 1 : -1, F = { side, dir, z: side * 0.22, inX: -dir * lim, outX: dir * lim, lim };
      segs.push([F.inX, side * zr, F.inX, F.z, 0.7], [F.inX, F.z, F.outX, F.z, 0.7], [F.outX, F.z, F.outX, side * zr, 0.7]);
      return F;
    });
    net.lenMax = net.Lt + 2 * deepest + 4 * lim + 12;        // longest possible trip
    this.net = net;
    const railGeo = new THREE.BoxGeometry(1, 0.05, 0.07); railGeo.translate(0.5, 0, 0);
    const rails = instanced(railGeo, new THREE.MeshStandardMaterial({ color: T.rail, metalness: 0.45, roughness: 0.6 }), segs.length, { receive: false });
    segs.forEach(([x0, z0, x1, z1, thin = 1], i) => {
      const len = Math.hypot(x1 - x0, z1 - z0), yaw = Math.atan2(-(z1 - z0), x1 - x0);
      rails.setMatrixAt(i, _m4.compose(_v.set(x0, RAIL_Y, z0), _q.setFromAxisAngle(UP, yaw), _s.set(len, thin, thin)));
    });
    _q.identity();
    this.world.add(rails);
  }

  // every channel that carries one tool's state: roof colour and pattern, head
  // paint (with the tool's brightness jitter), scanner column, EFEM light bar.
  // UNKNOWN (no replay loaded) is plain white equipment with its lights off,
  // not "idle": nothing is known about the tools yet.
  paintState(i, st) {
    const known = st !== UNKNOWN, k = known ? st : STATE.BUSY;
    this.roofs.setColorAt(i, this.roofCol[k]);
    this.roofPattern.setX(i, PATTERN[k]);
    _c.copy(this.headTint[k]).multiplyScalar(this.jitter[i]);
    this.heads.setColorAt(i, _c);
    for (const [mesh, k] of this.paintLinks[i]) mesh.setColorAt(k, _c);
    const lit = known && st !== STATE.IDLE;
    this.screens.setColorAt(i, lit ? _c.setRGB(0.62, 0.68, 0.7) : _c.setRGB(0.05, 0.06, 0.07));
    if (!known || st === STATE.IDLE) this.bars.setColorAt(i, _c.set(THEMES[this.themeName].barOff));
    else if (st === STATE.BUSY) this.bars.setColorAt(i, this.roofCol[st]);
    else { const c = LAMP[st]; this.bars.setColorAt(i, _c.setRGB(c[0] * 0.55, c[1] * 0.55, c[2] * 0.55)); }
  }

  flushState() {
    for (const a of [this.roofs.instanceColor, this.roofPattern, this.heads.instanceColor, this.bars.instanceColor]) if (a) a.needsUpdate = true;
    for (const mesh of this.paintMeshes) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    if (this.screens.instanceColor) this.screens.instanceColor.needsUpdate = true;
  }

  paintIdle() {
    for (let i = 0; i < this.shown.length; i++) this.paintState(i, UNKNOWN);
    this.flushState();
    this.state.fill(UNKNOWN);
    this.lamps.count = 0;
    this.portFoups.count = 0;
  }

  /* --------------------------------------------------------------- labels */
  buildLabels() {
    this.labelHost.replaceChildren();
    this.labels = [];
    const L = this.L;
    const add = (cls, text, x, y, z, color) => {
      const el = document.createElement("div");
      el.className = "tag " + cls;
      if (color !== undefined) el.style.borderBottomColor = "#" + new THREE.Color(color).getHexString();
      const span = document.createElement("span");
      span.textContent = text;
      el.append(span);
      this.labelHost.append(el);
      const item = { el, span, p: new THREE.Vector3(x, y, z), prio: cls.startsWith("pile") ? 3 : cls === "bay" ? 2 : 1, w: 0, h: 0 };
      this.labels.push(item);
      return item;
    };
    this.bayLabels = L.bays.map((b) => add("bay", GROUP_LABEL[b.group] || b.group.toUpperCase(), b.cx, 0.05, b.zFar + b.side * 0.85, GROUP_COLOR[b.group] ?? OTHER_COLOR));
    this.rackLabels = L.bays.map((b) => {
      const it = add("pile", "", b.x0 - 0.15, LEVEL_H * RACK_LEVELS + 0.1, (b.rack.z0 + b.rack.z1) / 2);
      it.el.hidden = true;
      return it;
    });
    add("gate", "▶ VÀO", L.entry.x, 0.1, 0);
    add("gate done", "✓ XONG", L.exit.x, 0.1, 0);
    this.labels.sort((p, q) => q.prio - p.prio);          // queue counts win overlaps, then bay names
  }

  placeLabels() {
    if (!this.labels) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    for (const it of this.labels) if (!it.w && !it.el.hidden) { it.w = it.el.offsetWidth; it.h = it.el.offsetHeight; }
    const placed = [];
    for (const it of this.labels) {
      if (it.el.hidden) continue;
      _v.copy(it.p).project(this.camera);
      const x = ((_v.x + 1) / 2) * w, y = ((1 - _v.y) / 2) * h;
      const r = [x - it.w / 2 - 3, y - it.h / 2 - 2, x + it.w / 2 + 3, y + it.h / 2 + 2];
      const off = _v.z > 1 || Math.abs(_v.x) > 1.05 || Math.abs(_v.y) > 1.05;
      if (off || placed.some((o) => r[0] < o[2] && r[2] > o[0] && r[1] < o[3] && r[3] > o[1])) { it.el.style.visibility = "hidden"; continue; }
      placed.push(r);
      it.el.style.visibility = "";
      it.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
  }

  /* --------------------------------------------------------------- camera */
  // Camera moves glide: frame(), focusBay() and the opening flight move the
  // camera and its orbit target together along a path timed by the wall clock
  // (a slow frame drops frames, it does not slow the move down). A drag or
  // scroll takes the camera over mid-flight; prefers-reduced-motion makes
  // every move instant.

  // the whole-fab view: from the front left, as close as the fab fits (the fog
  // is fitted to this distance). A scratch camera does the fitting, the real
  // one may be in flight.
  framePose() {
    const L = this.L;
    const target = new THREE.Vector3(0, 0, ((L.zFront + L.zBack) / 2) * 0.3);
    const dir = new THREE.Vector3(-0.46, 0.7, 0.95).normalize();
    const cam = new THREE.PerspectiveCamera(this.baseFov, this.camera.aspect, this.camera.near, this.camera.far);
    const corners = [];
    for (const x of [-L.half - 1.5, L.half + 1.5]) for (const z of [L.zBack - 1.2, L.zFront + 1.2]) for (const y of [0, RAIL_Y]) corners.push(new THREE.Vector3(x, y, z));
    let lo = 5, hi = 900;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      cam.position.copy(target).addScaledVector(dir, mid);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      const fits = corners.every((c) => { const p = c.clone().project(cam); return Math.abs(p.x) < 0.95 && p.y < 0.8 && p.y > -0.78; });
      if (fits) hi = mid; else lo = mid;
    }
    return { position: target.clone().addScaledVector(dir, hi), target, fit: hi };
  }

  // whole-fab view: set at once when a fab is first shown, a glide afterwards
  // (home button, double click on the floor)
  frame({ instant = false } = {}) {
    if (!this.L) return;
    const { position, target, fit } = this.framePose();
    this.fitDist = fit;
    this.controls.minDistance = 3;
    this.controls.maxDistance = fit * 2.5;
    const fresh = this.framedSrc !== this.src;
    this.framedSrc = this.src;
    this.flyTo(position, target, { instant: instant || fresh, fog: [fit * 1.35, fit * 3.2] });
  }

  // Opening flight, shown by app.js the first time a session shows a replay:
  // in over the entry gate, low along the central aisle just above the OHT
  // rails (nothing in the fab stands higher, so it clears every vehicle and
  // hoist) looking a little towards the tool fronts, then up and back to the
  // whole-fab view; a wide lens in the aisle narrows to the normal one on the
  // way up. Any input ends it (see the constructor). `done` runs however it ends.
  playIntro(done) {
    if (!this.L || this.touched || !this.canAnimate()) return false;
    const H = this.L.half, end = this.framePose(), p = end.position, q = end.target, f = this.baseFov;
    this.fitDist = end.fit;
    this.controls.minDistance = 3;
    this.controls.maxDistance = end.fit * 2.5;
    this.framedSrc = this.src;
    const y = RAIL_Y + 0.55;
    //  time  camera                     look at                      lens
    const keys = [
      [0.0, -H - 3.4, y, 0.9, -H + 9.5, 0.6, -1.4, 46],
      [1.5, -H + 5.5, y + 0.15, 0.9, -H + 18, 0.4, -1.8, 44],
      [2.7, -H + 15, y + 0.4, 0.9, -H + 27, 0.35, -2.3, 41],
      [3.4, -H + 18, y + 2.3, 1, -H + 27.5, 0.3, -2.8, 37],
      [4.2, -H + 13, 12, 8.2, 1.5, 0, -3.3, f],
      [INTRO_S, p.x, p.y, p.z, q.x, q.y, q.z, f],
    ];
    this.startFlight({ intro: true, ms: INTRO_S * 1000, pose: tourPath(keys), to: [p, q, f], fog: this.fogTo([end.fit * 1.35, end.fit * 3.2]), done });
    return true;
  }

  // motion is not reduced, and frames come often enough for a glide to show
  // (a software renderer drawing a frame every second or two would show the
  // start of a move for that long: there moves are instant)
  canAnimate() { return !this.motionQuery?.matches && this.frameMs < SLOW_FRAME_MS; }

  // glide to a pose, or jump there when asked, when motion cannot be shown,
  // or when the camera is there already
  flyTo(position, target, { instant = false, fog = null, fov = this.baseFov, ms = FLY_MS, done = null } = {}) {
    const cam = this.camera, from = cam.position.clone(), aim = this.controls.target.clone();
    const there = from.distanceTo(position) < 1e-3 && aim.distanceTo(target) < 1e-3 && Math.abs(cam.fov - fov) < 1e-3;
    const w = 2 * Math.tan(THREE.MathUtils.degToRad(this.baseFov) / 2) * cam.aspect;   // view width per unit of distance
    const cap = Math.max(from.distanceTo(aim), position.distanceTo(target), this.fitDist || 0);
    this.startFlight({ ms, pose: glidePath(from, aim, cam.fov, position, target, fov, w, cap), to: [position.clone(), target.clone(), fov], fog: this.fogTo(fog), done });
    if (instant || there || !this.canAnimate()) this.finishFlight();
  }

  fogTo(fog) {
    const F = this.scene.fog;
    return fog && F ? [F.near, F.far, fog[0], fog[1]] : null;
  }

  startFlight(flight) {
    const old = this.flight;
    this.flight = null;
    old?.done?.();
    this.quietControls();
    // the hover box and tooltip would go stale while the view moves
    if (this.hoverBox?.visible || this.pointer) this.setHover(null);
    this.flight = { t0: null, ...flight };
    this.dirty = true;
  }

  stepFlight(now) {
    const f = this.flight;
    if (f.t0 === null) f.t0 = now;                 // timed from its first frame
    const k = (now - f.t0) / f.ms;
    if (k >= 1) { this.finishFlight(); return; }
    this.setFov(f.pose(k, this.camera.position, this.controls.target));
    this.camera.lookAt(this.controls.target);
    const F = this.scene.fog;
    if (f.fog && F) { const e = ease(k); F.near = f.fog[0] + (f.fog[2] - f.fog[0]) * e; F.far = f.fog[1] + (f.fog[3] - f.fog[1]) * e; }
    this.controls.dispatchEvent(_change);          // what a moved view needs: redraw, FOUP scale...
  }

  finishFlight() {
    const f = this.flight;
    if (!f) return;
    this.flight = null;
    const [p, q, fov] = f.to;
    this.camera.position.copy(p);
    this.controls.target.copy(q);
    this.setFov(fov);
    this.camera.lookAt(q);
    if (f.fog && this.scene.fog) { this.scene.fog.near = f.fog[2]; this.scene.fog.far = f.fog[3]; }
    this.quietControls();
    this.controls.update();
    this.controls.dispatchEvent(_change);
    f.done?.();
  }

  // A drag or scroll during a flight takes the camera over where it is; a
  // view the orbit controls cannot hold (the opening flight's low shots down
  // the aisle, its wide lens) ends the flight at its destination instead.
  interruptFlight() {
    const f = this.flight, c = this.controls;
    if (!f) return;
    const off = _fly.copy(this.camera.position).sub(c.target), r = off.length();
    const holds = Math.abs(this.camera.fov - this.baseFov) < 0.01 && r >= c.minDistance && r <= c.maxDistance
      && Math.acos(THREE.MathUtils.clamp(off.y / r, -1, 1)) <= c.maxPolarAngle + 1e-4;
    if (!holds) { this.finishFlight(); return; }
    this.flight = null;
    if (f.fog && this.scene.fog) { this.scene.fog.near = f.fog[2]; this.scene.fog.far = f.fog[3]; }
    this.quietControls();
    this.controls.dispatchEvent(_change);
    f.done?.();
  }

  // any other input during the opening flight ends it: a quick glide to its
  // last view
  settleFlight() {
    const f = this.flight;
    if (!f?.intro) return;
    this.flyTo(f.to[0], f.to[1], { fov: f.to[2], ms: SETTLE_MS, fog: f.fog && [f.fog[2], f.fog[3]] });
  }

  setFov(fov) {
    if (Math.abs(this.camera.fov - fov) < 1e-6) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  // OrbitControls keeps a swipe's momentum in private fields (r179): clear it,
  // so a flight is not followed by the rest of an earlier drag
  quietControls() {
    const c = this.controls;
    c._sphericalDelta?.set(0, 0, 0);
    c._panOffset?.set(0, 0, 0);
    if (typeof c._scale === "number") c._scale = 1;
  }

  focusBay(i) {
    const b = this.L?.bays[i];
    if (!b) return;
    const dir = this.camera.position.clone().sub(this.controls.target);
    const flat = Math.hypot(dir.x, dir.z) || 1, lift = Math.tan((28 * Math.PI) / 180);
    if (dir.y / flat > lift) dir.y = flat * lift;                   // no steeper than 28 degrees
    if (dir.z < 0.2 * flat) { dir.z = Math.abs(dir.z) + 0.6 * flat; }  // look at the fronts (tools face +z)
    // nor lower than the orbit controls allow (the opening flight runs lower)
    const low = Math.tan(Math.PI / 2 - this.controls.maxPolarAngle + 0.07), flat2 = Math.hypot(dir.x, dir.z);
    if (dir.y < flat2 * low) dir.y = flat2 * low;
    dir.normalize();
    const target = new THREE.Vector3(b.cx, 0.3, b.cz);
    this.flyTo(target.clone().addScaledVector(dir, Math.max(13, b.w * 1.25)), target);
  }

  // wafer-handling robots shuttle behind the EFEM window on working tools (only
  // drawn close up, and only moved while the replay is played)
  moveRobots() {
    if (!this.robots || !this.robots.visible || !this.state) return;
    const now = performance.now() / 1000, R = this.robotSpots;
    for (let i = 0; i < this.state.length; i++) {
      const st = this.state[i], k = i * 4;
      const working = st === STATE.BUSY || st === STATE.SETUP;
      const u = working ? Math.sin(now * 1.7 + i * 2.39) : -1;             // -1 = parked at the left
      this.robots.setMatrixAt(i, _m4.compose(_v.set(R[k] + u * R[k + 3], R[k + 1], R[k + 2]), _q, _s.set(1, 1, 1)));
    }
    this.robots.instanceMatrix.needsUpdate = true;
  }

  // fine tool parts (pumps, rails, bands, vents...) only when close enough to see them
  showDetail() {
    const near = this.camera.position.distanceTo(this.controls.target) < DETAIL_DIST;
    for (const mesh of this.detailMeshes || []) mesh.visible = near;
  }

  setAutoRotate(on) { this.controls.autoRotate = !!on; this.dirty = true; }

  /* --------------------------------------------------------------- replay */
  setReplay(R) {
    this.replay = R;
    const n = this.src.machine_family.length;
    this.cursor = new Int32Array(n).fill(-2);
    this.dCursor = new Int32Array(n).fill(-2);
    this.lastT = -1;
    this.tripStride = 1;
    this.routes.clear();
    this.clearVehicles();
    this.controls.autoRotate = false;
    this.setTime(0, { force: true });
  }

  clearReplay() {
    this.replay = null;
    if (!this.L) return;
    this.paintIdle();
    this.rackFoups.count = 0; this.stockFoups.count = 0;
    this.clearVehicles();
    for (const it of this.rackLabels || []) it.el.hidden = true;
    this.dirty = true;
  }

  // the dispatch that runs (or last ran) on machine m at time T, -1 before its
  // first one; a per-machine cursor keeps forward playback O(1) per tool
  rowAt(m, T) {
    const R = this.replay, a = R.a, e0 = R.disp.start[m], e1 = R.disp.start[m + 1];
    if (e1 === e0) return -1;
    let k = this.cursor[m];
    if (k === -2 || T < this.lastT || (k >= e0 && a.t[R.disp.order[k]] > T)) {
      let lo = e0, hi = e1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (a.t[R.disp.order[mid]] <= T) lo = mid + 1; else hi = mid; }
      k = lo - 1;
    } else while (k + 1 < e1 && a.t[R.disp.order[k + 1]] <= T) k++;
    this.cursor[m] = k;
    return k < e0 ? -1 : R.disp.order[k];
  }

  machineState(m, T) {
    const R = this.replay, a = R.a, row = this.rowAt(m, T);    // cursor seated whatever the state
    const d0 = R.dFirst[m], d1 = R.dFirst[m + 1];
    if (d1 > d0) {
      let k = this.dCursor[m];
      if (k === -2 || T < this.lastT) k = upper(R.dStart, d0, d1, T) - 1;
      else while (k + 1 < d1 && R.dStart[k + 1] <= T) k++;
      this.dCursor[m] = k;
      if (k >= d0 && T < R.dEnd[k]) return R.dKind[k] === 1 ? STATE.PM : STATE.DOWN;
    }
    if (row < 0) return STATE.IDLE;
    const dt = T - a.t[row];
    if (dt < a.setup[row]) return STATE.SETUP;
    // wafer-count maintenance is appended to the busy time by the kernel
    if (dt < a.busy[row]) return dt >= a.busy[row] - a.pm[row] ? STATE.PM : STATE.BUSY;
    return STATE.IDLE;
  }

  // dispatches whose lots are still on tool m at T, newest first: a lot stays
  // from the moment it lands until the tool releases it (through setups,
  // breakdowns and wafer-count maintenance), and many tools start the next lot
  // before the previous one is released. Needs the cursor seated (machineState).
  openRows(m, T, out) {
    const R = this.replay, a = R.a, e0 = R.disp.start[m];
    out.length = 0;
    for (let k = this.cursor[m]; k >= e0 && k > this.cursor[m] - 4; k--) {
      const row = R.disp.order[k];
      if (T - a.t[row] < a.lot_end[row]) out.push(row);
    }
    return out;
  }

  // occupied load ports as a bit mask (bit p = port p): a lot uses the port of
  // its dispatch's parity, a batch of two or more lots fills both
  lotsOn(m, T) {
    const R = this.replay;
    let mask = 0;
    for (const row of this.openRows(m, T, _rows)) mask |= R.a.nlots[row] >= 2 ? 3 : 1 << (R.disp.nth[row] & 1);
    return mask;
  }

  setTime(T, { force = false } = {}) {
    if (!this.replay || !this.L) return null;
    const R = this.replay, a = R.a, L = this.L;
    if (!Number.isFinite(T)) T = 0;
    T = Math.max(0, Math.min(R.endTime, T));
    if (!force && T === this.time && this.summary) return this.summary;
    if (this.lastT < 0) this.lastT = T;
    const counts = [0, 0, 0, 0, 0];
    let changed = false, nl = 0, nf = 0;
    this.flashing.length = 0; this.flashFresh = true;      // lamps refilled at full colour (see stepLamps)
    for (let i = 0; i < this.shown.length; i++) {
      const m = this.shown[i];
      const st = this.machineState(m, T);
      counts[st]++;
      if (st !== this.state[i] || force) {
        this.state[i] = st;
        this.paintState(i, st);
        changed = true;
      }
      if (st !== STATE.IDLE) {
        const c = LAMP[st], k = i * 3;
        this.lamps.setMatrixAt(nl, _m4.compose(_v.set(this.lampSpots[k], this.lampSpots[k + 1] + TIER[st] * TIER_H, this.lampSpots[k + 2]), _q, _s.set(1.05, 1.05, 1.05)));
        this.lamps.setColorAt(nl, _c.setRGB(c[0], c[1], c[2]));
        if (st === STATE.DOWN || st === STATE.PM) this.flashing.push(nl, i);
        nl++;
      }
      {
        const ports = this.lotsOn(m, T);
        for (let p = 0; p < 2; p++) {
          if (!(ports & (1 << p))) continue;
          const k = (i * 2 + p) * 3;
          this.portFoups.setMatrixAt(nf++, _m4.compose(_v.set(this.portSpots[k], this.portSpots[k + 1], this.portSpots[k + 2]), _q, _s.set(1, 1, 1)));
        }
      }
    }
    if (changed) this.flushState();
    this.lamps.count = nl;
    this.lamps.instanceMatrix.needsUpdate = true;
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
    this.portFoups.count = nf;
    this.portFoups.instanceMatrix.needsUpdate = true;

    // racks: waiting lots per bay from the nearest samples
    const st = R.meta.samples.t, nF = R.nFam;
    const j = Math.max(0, Math.min(st.length - 1, upper(st, 0, st.length, T) - 1));
    const j2 = Math.min(st.length - 1, j + 1);
    const w = j2 > j && st[j2] > st[j] ? (T - st[j]) / (st[j2] - st[j]) : 0;
    this.queueNow = new Float32Array(nF);
    for (let f = 0; f < nF; f++) this.queueNow[f] = a.s_queue[j * nF + f] * (1 - w) + a.s_queue[j2 * nF + f] * w;
    let np = 0;
    L.bays.forEach((b, bi) => {
      let q = 0;
      for (const f of b.g.families) q += this.queueNow[f.index];
      q = Math.round(q);
      b.queue = q;
      const shownN = Math.min(q, b.rackCap), perLevel = b.rackCols * RACK_ROWS;
      for (let k = 0; k < shownN; k++) {
        const level = Math.floor(k / perLevel), r = k % perLevel, col = Math.floor(r / RACK_ROWS), row = r % RACK_ROWS;
        const x = b.rack.x0 + (col + 0.5) * (b.w / b.rackCols);
        const z = b.side * (AISLE_HALF + RACK_GAP + RACK_D * (0.2 + row * 0.3));
        this.rackFoups.setMatrixAt(np++, _m4.compose(_v.set(x, 0.035 + level * LEVEL_H, z), _q, _s.set(1, 1, 1)));
      }
      const lab = this.rackLabels[bi], text = String(q), over = q > b.rackCap;
      if (lab.el.hidden !== q <= 0) { lab.el.hidden = q <= 0; lab.w = 0; }
      if (lab.span.textContent !== text) { lab.span.textContent = text; lab.w = 0; }
      lab.el.classList.toggle("over", over);                // more lots than the rack can show
    });
    this.rackFoups.count = np;
    this.rackFoups.instanceMatrix.needsUpdate = true;

    // stocker: one cell per Delay station, filled while it holds a lot
    let nd = 0, delayBusy = 0;
    for (const [m, c] of L.delayCell) {
      if (this.machineState(m, T) === STATE.IDLE) continue;
      delayBusy++;
      this.stockFoups.setMatrixAt(nd++, _m4.compose(_v.set(c.x, c.y, c.z), _q, _s.set(1, 1, 1)));
    }
    this.stockFoups.count = nd;
    this.stockFoups.instanceMatrix.needsUpdate = true;
    for (const mesh of [this.lamps, this.portFoups, this.rackFoups, this.stockFoups]) mesh.boundingSphere = null;

    this.updateTrips(T);
    this.moveRobots();
    if (this.pointer) this.pickPending = true;              // keep the hover tooltip current
    this.lastT = T;
    this.time = T;
    const pick = (arr) => arr[j] * (1 - w) + arr[j2] * w;
    const Sm = R.meta.samples;
    this.summary = { t: T, counts, delayBusy, completed: pick(Sm.completed), cqt: pick(Sm.cqt_violations), wip: pick(Sm.wip), moves: pick(Sm.moves) };
    this.dirty = true;
    return this.summary;
  }

  /* --------------------------------------------------------- stack lights */
  // app.js reports play / pause: the lamp effects run only while playing
  setPlaying(on) { this.playing = !!on; }

  // While the replay plays, a down tool's red beacon flashes (about 1.2 Hz,
  // crisp on / off, every tool on its own phase) and a PM tool's blue lamp
  // breathes slowly. setTime lists those lamps as it fills this.lamps, so a
  // frame only rewrites their colours, and asks for a new frame only when one
  // of them changed. Paused, under reduced motion or with nothing listed the
  // lamps stay steady and nothing is redrawn.
  stepLamps(now) {
    const lamps = this.lamps, list = this.flashing;
    if (!lamps || !this.replay || !lamps.count || !lamps.instanceColor) { this.lampFx = false; return; }
    const live = this.playing && list.length > 0 && !this.motionQuery?.matches;
    if (!live && !this.lampFx) return;
    if (this.flashFresh) {                           // setTime wrote them all at full colour
      if (this.flashLevel.length !== list.length / 2) this.flashLevel = new Float32Array(list.length / 2);
      this.flashLevel.fill(1);
      this.flashFresh = false;
    }
    const level = this.flashLevel;
    let changed = false;
    for (let j = 0; j < list.length; j += 2) {
      const n = list[j], i = list[j + 1], st = this.state[i];
      let v = 1;
      if (live) {
        const ph = tripHash(i, 5);
        v = st === STATE.DOWN ? (fract(now / BLINK_MS + ph) < BLINK_ON ? 1 : 0)
          : PULSE_LOW + (1 - PULSE_LOW) * (0.5 + 0.5 * Math.cos(2 * Math.PI * (now / PULSE_MS + ph)));
      }
      if (v === level[j / 2]) continue;
      level[j / 2] = v;
      const c = LAMP[st] || LAMP[STATE.DOWN];
      if (st === STATE.DOWN && v === 0) lamps.setColorAt(n, _c.setRGB(BEACON_OFF[0], BEACON_OFF[1], BEACON_OFF[2]));
      else lamps.setColorAt(n, _c.setRGB(c[0] * v, c[1] * v, c[2] * v));
      changed = true;
    }
    this.lampFx = live;
    if (changed) { lamps.instanceColor.needsUpdate = true; this.dirty = true; }
  }

  /* ------------------------------------------------------------- vehicles */
  // playback speed (sim seconds per real second): trips keep a minimum real duration
  setSpeed(speed) {
    this.speed = Math.max(1, Number(speed) || 1);
    if (this.replay && this.L) { this.updateTrips(this.time); this.dirty = true; }
  }

  clearVehicles() {
    if (this.vehicleMesh) for (const mesh of [this.vehicleMesh, this.vehicleFoups, this.cables]) mesh.count = 0;
    this.dirty = true;
  }

  // where a lot is picked up / set down: a spot on a bay's rack, a tool's first
  // load port, a stocker cell (Delay station), the entry / exit gates
  rackPoint(bi, u) {
    const b = this.L.bays[bi];
    return { kind: "bay", bay: bi, x: b.rack.x0 + 0.2 + u * (b.w - 0.4), y: LEVEL_H * (RACK_LEVELS - 1) + 0.045, z: this.net.bays[bi].zRack };
  }

  machinePoint(m, port = 0) {
    const cell = this.L.delayCell.get(m);
    if (cell) return { kind: "stocker", x: cell.x, y: this.net.stockY, z: cell.z };     // stocker port on top
    const i = this.slotOf[m];
    if (i < 0) return null;
    const k = (i * 2 + port) * 3, fam = this.src.machine_family[m];
    return { kind: "bay", bay: this.L.familyBay[fam], x: this.portSpots[k], y: this.portSpots[k + 1], z: this.portSpots[k + 2] };
  }

  // waypoints of a trip on the one-way network: hoist up, downstream along the
  // row / rack rail to the exit spur, then either the bay's return rail (same
  // bay) or the loop in its direction of travel (round the end if the target
  // lies behind), in through the target's entry spur, downstream along its
  // row / rack rail, hoist down
  route(a, b) {
    const N = this.net, y = HANG_Y, pts = [[a.x, a.y, a.z], [a.x, y, a.z]];
    const go = (x, z) => { const q = pts[pts.length - 1]; if (Math.abs(q[0] - x) > 1e-6 || Math.abs(q[2] - z) > 1e-6) pts.push([x, y, z]); };
    let pos;
    if (a.kind === "bay") {
      const A = N.bays[a.bay];
      go(A.exitX, a.z);
      if (b.kind === "bay" && b.bay === a.bay) {
        go(A.exitX, A.zReturn); go(A.entryX, A.zReturn); go(A.entryX, b.z); go(b.x, b.z);
        pts.push([b.x, b.y, b.z]);
        return this.finishRoute(pts);
      }
      go(A.exitX, A.zAisle);
      pos = N.loopPos(A.exitX, A.side);
    } else if (a.kind === "entry") {
      go(-N.H, 0);
      pos = N.Lt - N.zr;                                   // middle of the left end
    } else {                                               // from the stocker top: along its face rail, out to the loop
      const F = N.faces[a.z >= 0 ? 1 : 0];
      go(F.outX, F.z); go(F.outX, F.side * N.zr);
      pos = N.loopPos(F.outX, F.side);
    }
    let end, target;                                       // loop position to leave at; last rail point
    if (b.kind === "bay") {
      const B = N.bays[b.bay];
      end = N.loopPos(B.entryX, B.side);
      target = () => { go(B.entryX, b.z); go(b.x, b.z); pts.push([b.x, b.y, b.z]); };
    } else if (b.kind === "exit") {
      end = 2 * N.H + N.zr;                                // middle of the right end
      target = () => { go(N.H + 0.8, 0); pts.push([N.H + 0.8, b.y, 0]); };
    } else {                                               // into the stocker through the face reached first
      const dist = (F) => (((N.loopPos(F.inX, F.side) - pos) % N.Lt) + N.Lt) % N.Lt;
      const F = dist(N.faces[0]) <= dist(N.faces[1]) ? N.faces[0] : N.faces[1];
      const xs = F.inX + F.dir * 2 * F.lim * (0.1 + 0.8 * (b.u ?? 0.5));
      end = N.loopPos(F.inX, F.side);
      target = () => { go(F.inX, F.z); go(xs, F.z); pts.push([xs, N.stockY, F.z]); };
    }
    this.loopTravel(pos, end, go);
    target();
    return this.finishRoute(pts);
  }

  loopTravel(from, to, go) {
    const { H, zr, Lt } = this.net;
    const d = (((to - from) % Lt) + Lt) % Lt;
    const corners = [[2 * H, H, -zr], [2 * H + 2 * zr, H, zr], [4 * H + 2 * zr, -H, zr], [Lt, -H, -zr]]
      .map(([cp, x, z]) => [(((cp - from) % Lt) + Lt) % Lt, x, z]).filter(([o]) => o > 1e-9 && o < d).sort((p, q) => p[0] - q[0]);
    for (const [, x, z] of corners) go(x, z);
    const e = ((to % Lt) + Lt) % Lt;
    let x, z;
    if (e < 2 * H) { x = e - H; z = -zr; }
    else if (e < 2 * H + 2 * zr) { x = H; z = e - 2 * H - zr; }
    else if (e < 4 * H + 2 * zr) { x = H - (e - 2 * H - 2 * zr); z = zr; }
    else { x = -H; z = zr - (e - 4 * H - 2 * zr); }
    go(x, z);
  }

  finishRoute(pts) {
    const lens = [], yaw = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0, z0] = pts[i - 1], [x1, y1, z1] = pts[i];
      const d = Math.hypot(x1 - x0, y1 - y0, z1 - z0), dx = x1 - x0, dz = z1 - z0;
      lens.push(d); total += d;
      yaw.push(Math.abs(dx) + Math.abs(dz) > 1e-6 ? Math.atan2(-dz, dx) : NaN);
    }
    // a hoist (vertical) segment keeps the heading of the rail next to it
    for (let i = 0; i < yaw.length; i++) if (Number.isNaN(yaw[i])) yaw[i] = yaw.slice(i).find((v) => !Number.isNaN(v)) ?? yaw.slice(0, i).reverse().find((v) => !Number.isNaN(v)) ?? 0;
    return { pts, lens, yaw, total };
  }

  // the point `d` along a route (bottom centre of the carried FOUP) into `out`;
  // returns the heading, and sets this.hoisting when that part of the route is
  // a hoist (the vehicle stands still on the rail)
  along(r, d, out) {
    let s = 0;
    while (s < r.lens.length - 1 && d > r.lens[s]) { d -= r.lens[s]; s++; }
    const t = r.lens[s] > 0 ? Math.max(0, Math.min(1, d / r.lens[s])) : 1, p0 = r.pts[s], p1 = r.pts[s + 1];
    out.set(p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t);
    this.hoisting = p0[0] === p1[0] && p0[2] === p1[2];
    return r.yaw[s];
  }

  placeTrip(t) {
    t.d = Math.max(0, Math.min(t.r.total, t.d));
    t.yaw = this.along(t.r, t.d, _p);
    t.x = _p.x; t.y = _p.y; t.z = _p.z; t.hoist = this.hoisting;
    const pts = t.r.pts;
    t.ground = Math.min(HANG_Y - 0.01, t.d < t.r.total / 2 ? pts[0][1] : pts[pts.length - 1][1]);
  }

  // Queueing. Vehicles run at one speed, so two that meet at a junction would
  // stay on top of each other for the rest of their shared rail; the one behind
  // (the other lies ahead along its own heading) waits a vehicle length back.
  // A vehicle hoisting at a port or rack keeps its spot, so lots still land on
  // time. Depends only on the current set of trips: still a function of T.
  resolveQueues(list) {
    const GAP = 0.34, G2 = GAP * GAP, cell = (v) => Math.floor(v / GAP);
    for (let pass = 0; pass < 24; pass++) {
      const grid = new Map();
      list.forEach((t, i) => {
        const key = cell(t.x) * 100003 + cell(t.z);
        const bucket = grid.get(key);
        if (bucket) bucket.push(i); else grid.set(key, [i]);
      });
      let moved = false;
      for (let i = 0; i < list.length; i++) {
        const A = list[i], cx = cell(A.x), cz = cell(A.z);
        for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
          const bucket = grid.get(gx * 100003 + gz);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const B = list[j], dx = B.x - A.x, dz = B.z - A.z, d2 = dx * dx + dz * dz;
            if (d2 >= G2) continue;
            const aheadOfA = dx * Math.cos(A.yaw) - dz * Math.sin(A.yaw) > 1e-6;   // B lies ahead of A
            const aheadOfB = -dx * Math.cos(B.yaw) + dz * Math.sin(B.yaw) > 1e-6;
            let f = aheadOfA && !aheadOfB ? A : B;
            if (f.hoist) f = f === A ? B : A;
            if (f.hoist || f.d <= 0) continue;
            f.d -= GAP - Math.sqrt(d2) + 1e-3;
            this.placeTrip(f);
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }

  // every trip in flight at time T. At high speed far more are in flight than
  // can be drawn; then every E-th candidate is kept, a nested subset, so a
  // trip on screen stays on screen as long as E does not grow.
  updateTrips(T) {
    if (!this.replay || !this.vehicleMesh || !this.net || this.cursor.length !== this.src.machine_family.length) return;
    const R = this.replay, a = R.a, L = this.L, N = this.net, fam = this.src.machine_family;
    const tauS = Math.max(TRIP_SIM, TRIP_REAL * this.speed);
    const v = TRIP_REF_LEN / (tauS * 10);                                   // world units per decisecond
    const gap = 0.36 / v;                                                    // a vehicle length of time
    const cap = MAX_TRIPS[this.quality] || MAX_TRIPS.medium;
    const bayLen = (bi) => (bi >= 0 ? N.bays[bi].inMax : 4 * N.faces[0].lim + 6);
    const inMax = Math.max(...N.bays.map((B) => B.inMax));
    const span = N.lenMax / v, relSpan = (N.Lt + Math.max(inMax, bayLen(-1)) + 10) / v;
    const nD = a.t.length, nA = R.arrT.length, nR = a.r_t.length;
    const i0 = upper(a.t, 0, nD, T), i1 = upper(a.t, i0, nD, T + inMax / v);  // will land on a tool (rack -> tool stays in the bay)
    const k0 = upper(R.arrT, 0, nA, T - span), k1 = upper(R.arrT, k0, nA, T);  // left a tool
    const r0 = upper(a.r_t, 0, nR, T - relSpan - a.r_rankMax * gap), r1 = upper(a.r_t, r0, nR, T);  // entered the fab
    // Sampling: every E-th candidate of each kind (E a power of two) is looked
    // at, and drawn if in flight. The kept set is nested, so a trip on screen
    // stays there while E does not grow; E moves one step at a time and only
    // when the load is clearly off (hysteresis), so trips do not flicker.
    let E = this.tripStride || 1;
    const cands = (i1 - i0) + (k1 - k0) + (r1 - r0);
    while (cands / E > 24 * cap) E *= 2;                                    // bounded work per frame
    const first = (lo) => Math.ceil(lo / E) * E;
    if (this.routes.size > 8000) this.routes.clear();
    const routeFor = (key, make) => {
      let r = this.routes.get(key);
      if (r === undefined) { r = make(); this.routes.set(key, r); }
      return r;
    };
    const found = [];                                                        // [index, route, distance]
    for (let i = first(i0); i < i1; i += E) {                               // rack -> tool
      const m = a.machine[i], bi = L.familyBay[fam[m]];
      if (!(bi >= 0) || a.t[i] - N.bays[bi].inMax / v > T) continue;       // Delay tool, or surely not left the rack yet
      const r = routeFor("i" + i, () => { const to = this.machinePoint(m, R.disp.nth[i] & 1); return to && this.route(this.rackPoint(bi, fract(i * 0.618)), to); });
      if (!r) continue;
      const start = a.t[i] - r.total / v;
      if (start <= T) found.push([i, r, (T - start) * v]);
    }
    for (let k = first(k0); k < k1; k += E) {                               // tool -> next rack / stocker / exit
      const row = R.arrRow[k], m = a.machine[row], nf = a.next_family[row];
      const bayA = L.familyBay[fam[m]], bayB = nf === NO_FAMILY_IDX ? -1 : L.familyBay[nf];
      let loop = N.Lt;                                                       // upper bound of the loop leg
      if (bayA >= 0 && bayB >= 0 && bayA !== bayB) {
        const A = N.bays[bayA], B = N.bays[bayB];
        loop = (((N.loopPos(B.entryX, B.side) - N.loopPos(A.exitX, A.side)) % N.Lt) + N.Lt) % N.Lt;
      } else if (bayA === bayB && bayA >= 0) loop = 0;
      if (R.arrT[k] + (bayLen(bayA) + loop + bayLen(bayB)) / v <= T) continue;  // surely delivered already
      const r = routeFor("o" + row, () => {
        const from = this.machinePoint(m, R.disp.nth[row] & 1);
        if (!from) return null;
        if (nf === NO_FAMILY_IDX) return this.route(from, { kind: "exit", y: 0.05 });
        return this.route(from, bayB >= 0 ? this.rackPoint(bayB, fract(row * 0.618)) : { kind: "stocker", u: fract(row * 0.618) });
      });
      if (r && R.arrT[k] + r.total / v > T) found.push([k, r, (T - R.arrT[k]) * v]);
    }
    for (let q = first(r0); q < r1; q += E) {                               // new lots enter the fab
      const start = a.r_t[q] + a.r_rank[q] * gap;                            // lots released together queue at the gate
      if (start > T || start + relSpan <= T) continue;
      const r = routeFor("r" + q, () => {
        const bi = L.familyBay[a.r_family[q]], from = { kind: "entry", x: L.entry.x, y: 0.05, z: 0 };
        return this.route(from, bi >= 0 ? this.rackPoint(bi, fract(q * 0.618)) : { kind: "stocker", u: fract(q * 0.618) });
      });
      if (r && start + r.total / v > T) found.push([q, r, (T - start) * v]);
    }
    // hysteresis: thin out at once when over, fill in one step at a time when
    // the doubled sample would still be well under (the next frame then looks
    // at twice as many candidates)
    while (found.length > 0.9 * cap) {
      E *= 2;
      for (let j = found.length - 1; j >= 0; j--) if (found[j][0] % E !== 0) found.splice(j, 1);
    }
    this.tripStride = E > 1 && found.length * 2 < 0.8 * cap ? E / 2 : E;
    const list = found.map(([, r, d]) => { const t = { r, d }; this.placeTrip(t); return t; });
    this.resolveQueues(list);
    list.forEach((t, i) => this.drawTrip(i, t));
    const n = list.length;
    this.vehicleMesh.count = n; this.vehicleFoups.count = n; this.cables.count = n;
    for (const mesh of [this.vehicleMesh, this.vehicleFoups, this.cables]) mesh.instanceMatrix.needsUpdate = true;
  }

  // one vehicle at its (queued) place. Zoomed out, vehicles and FOUPs are drawn
  // larger; a FOUP shrinks back to its real size on the way down to a port or
  // rack, so it lands at the size of the FOUPs sitting there.
  drawTrip(n, t) {
    const sc = this.tripScale, lift = Math.max(0, Math.min(1, (t.y - t.ground) / (HANG_Y - t.ground)));
    const f = 1 + (sc - 1) * lift;                                          // FOUP scale
    const vy = RAIL_Y - 0.025 - 0.15 * sc;                                  // a scaled vehicle still hangs under the rail
    const hang = vy - (0.14 + FOUP) * f;                                     // FOUP held up under it
    const y = Math.min(t.y, HANG_Y) - (HANG_Y - hang) * lift;
    _q.setFromAxisAngle(UP, t.yaw);
    this.vehicleMesh.setMatrixAt(n, _m4.compose(_v.set(t.x, vy, t.z), _q, _s.set(sc, sc, sc)));
    this.vehicleFoups.setMatrixAt(n, _m4.compose(_v.set(t.x, y, t.z), _q, _s.set(f, f, f)));
    const top = y + FOUP * f, len = vy - 0.045 * sc - top;
    this.cables.setMatrixAt(n, _m4.compose(_v.set(t.x, top, t.z), _q, _s.set(1, Math.max(len, 0.0001), 1)));
    _q.identity();
  }

  /* -------------------------------------------------------------- picking */
  hit() {
    if (!this.pointer || !this.L) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((this.pointer.x - rect.left) / rect.width) * 2 - 1, -((this.pointer.y - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects([this.bodies, this.heads, ...this.pickParts, this.rackFoups], false);
    if (!hits.length) return null;
    const h = hits[0], slots = h.object.userData.slots;
    if (h.object === this.bodies || h.object === this.heads || slots) {
      const slot = slots ? slots[h.instanceId] : h.instanceId, m = this.shown[slot];
      return { kind: "machine", slot, machine: m, family: this.src.machine_family[m], bay: this.L.familyBay[this.src.machine_family[m]] };
    }
    const p = h.point;
    const bay = this.L.bays.findIndex((b) => p.x >= b.x0 - 0.3 && p.x <= b.x1 + 0.3 && Math.sign(p.z) === b.side);
    return { kind: "bay", bay };
  }

  pick() { const h = this.hit(); this.setHover(h ? { ...h, x: this.pointer.x, y: this.pointer.y } : null); }

  setHover(h) {
    if (!this.hoverBox) return;
    if (h && h.kind === "machine") {
      const m = h.machine, L = this.L, [sx, hh, sz] = this.machineSize[h.slot];
      this.hoverBox.position.set(L.machinePos[m * 3], 0.05 + hh / 2, L.machinePos[m * 3 + 2]);
      this.hoverBox.scale.set(sx + 0.1, hh + 0.14, sz + 0.1);
      this.hoverBox.visible = true;
      h.state = this.replay ? this.state[h.slot] : null;
    } else this.hoverBox.visible = false;
    if (h && h.bay >= 0) {
      const b = this.L.bays[h.bay];
      h.bayInfo = { group: b.group, label: GROUP_LABEL[b.group] || b.group, machines: b.g.machines.length, queue: this.replay ? b.queue : null };
    }
    if (h && h.kind === "machine") {
      h.familyInfo = this.L.families[h.family];
      const R = this.replay, rows = R ? this.openRows(h.machine, this.time, []) : [];
      if (rows.length) {                                                 // lots on this tool; where the newest goes next
        const a = R.a, nf = a.next_family[rows[0]], bi = nf === NO_FAMILY_IDX ? -1 : this.L.familyBay[nf];
        h.lots = rows.reduce((n, row) => n + a.nlots[row], 0);
        h.next = nf === NO_FAMILY_IDX ? "XONG" : bi >= 0 ? GROUP_LABEL[this.L.bays[bi].group] || this.L.bays[bi].group : "stocker";
      }
    }
    this.dirty = true;
    this.onHover(h);
  }
}

/* ================================================================= motion */

const FLY_MS = 900, SETTLE_MS = 700;    // camera glide; the opening flight skipped half way
const INTRO_S = 5.4;                    // opening flight, seconds
const SLOW_FRAME_MS = 180;              // slower frames than this: camera moves are instant
// stack-light effects: a down beacon flashes (period, share of it lit) and
// shows an unlit red lens between flashes; a PM lamp breathes (period, dimmest)
const BLINK_MS = 1000 / 1.2, BLINK_ON = 0.58, BEACON_OFF = [0.14, 0.01, 0.018];
const PULSE_MS = 2400, PULSE_LOW = 0.35;
const RHO = Math.SQRT2;                 // zoom / pan trade-off of glidePath (van Wijk & Nuij)
const _fly = new THREE.Vector3();
const _change = { type: "change" };     // a flight moves the view as the orbit controls do

// ease in and out with no jolt: zero speed and acceleration at both ends
function ease(t) { t = Math.max(0, Math.min(1, t)); return t * t * t * (t * (6 * t - 15) + 10); }

// Van Wijk & Nuij's smooth zoom-and-pan ("Smooth and efficient zooming and
// panning", 2003; d3.interpolateZoom): the view width w goes from w0 to w1
// while the look point pans a distance d, pulling back first when the two
// views lie far apart for their size, so both stay in sight on the way.
// Returns t -> [share of the pan done, w].
function zoomPath(d, w0, w1) {
  if (d < 1e-6 * Math.max(w0, w1)) {
    const S = Math.log(w1 / w0) / RHO;
    return (t) => [t, w0 * Math.exp(RHO * t * S)];
  }
  const b0 = (w1 * w1 - w0 * w0 + RHO ** 4 * d * d) / (2 * w0 * RHO * RHO * d);
  const b1 = (w1 * w1 - w0 * w0 - RHO ** 4 * d * d) / (2 * w1 * RHO * RHO * d);
  const r0 = Math.asinh(-b0), r1 = Math.asinh(-b1), S = (r1 - r0) / RHO, c0 = Math.cosh(r0);
  return (t) => {
    const r = RHO * t * S + r0;
    return [(w0 / (RHO * RHO * d)) * (c0 * Math.tanh(r) - Math.sinh(r0)), (w0 * c0) / Math.cosh(r)];
  };
}

// A camera glide from (p0 looking at q0, lens fov0) to (p1, q1, fov1): the
// look point pans and the orbit radius follows zoomPath (capped at `cap`),
// while the camera swings round the look point by the shorter way. `w` is the
// view width per unit of distance. Returns (progress, pos, target) -> fov.
function glidePath(p0, q0, fov0, p1, q1, fov1, w, cap) {
  const s0 = new THREE.Spherical().setFromVector3(_fly.subVectors(p0, q0));
  const s1 = new THREE.Spherical().setFromVector3(_fly.subVectors(p1, q1));
  const zoom = zoomPath(q0.distanceTo(q1), Math.max(s0.radius, 1e-3) * w, Math.max(s1.radius, 1e-3) * w);
  const dTheta = Math.atan2(Math.sin(s1.theta - s0.theta), Math.cos(s1.theta - s0.theta));
  const s = new THREE.Spherical();
  return (k, pos, target) => {
    const e = ease(k), [u, width] = zoom(e);
    target.lerpVectors(q0, q1, u);
    s.set(Math.min(width / w, cap), s0.phi + (s1.phi - s0.phi) * e, s0.theta + dTheta * e);
    pos.setFromSpherical(s).add(target);
    return fov0 + (fov1 - fov0) * e;
  };
}

// Monotone cubic through keys (t_i, v_i) with zero slope at both ends
// (Steffen 1990): smooth speed, no overshoot between keys, so a camera that
// skims the stocker or passes under the rails never dips into them.
function monotone(ts, vs) {
  const n = ts.length, m = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const h0 = ts[i] - ts[i - 1], h1 = ts[i + 1] - ts[i];
    const d0 = (vs[i] - vs[i - 1]) / h0, d1 = (vs[i + 1] - vs[i]) / h1, p = (d0 * h1 + d1 * h0) / (h0 + h1);
    m[i] = (Math.sign(d0) + Math.sign(d1)) * Math.min(Math.abs(d0), Math.abs(d1), 0.5 * Math.abs(p));
  }
  return (t) => {
    let i = 0;
    while (i < n - 2 && t > ts[i + 1]) i++;
    const h = ts[i + 1] - ts[i], s = Math.max(0, Math.min(1, (t - ts[i]) / h)), s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * vs[i] + (s3 - 2 * s2 + s) * h * m[i] + (3 * s2 - 2 * s3) * vs[i + 1] + (s3 - s2) * h * m[i + 1];
  };
}

// a scripted camera path from keys [time, camera xyz, look-at xyz, fov]
function tourPath(keys) {
  const ts = keys.map((k) => k[0]), T = ts[ts.length - 1];
  const f = [1, 2, 3, 4, 5, 6, 7].map((c) => monotone(ts, keys.map((k) => k[c])));
  return (k, pos, target) => {
    const t = k * T;
    pos.set(f[0](t), f[1](t), f[2](t));
    target.set(f[3](t), f[4](t), f[5](t));
    return f[6](t);
  };
}
