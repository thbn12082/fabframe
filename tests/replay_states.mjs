// Rebuild machine states from a replay with the browser code (no WebGL needed)
// and print them as JSON: node replay_states.mjs <fab3d.js> <replay dir> <times json>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [, , fab3dPath, replayDir, timesJson, mode] = process.argv;
const RAW = mode === "raw";                    // raw STATE codes instead of the kernel's 0/1/2
const { decodeReplay, FabScene, STATE } = await import(pathToFileURL(fab3dPath).href);
const meta = JSON.parse(readFileSync(replayDir + "/replay.json", "utf8"));
const buf = readFileSync(replayDir + "/replay.bin");
const R = decodeReplay(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const n = meta.layout.machine_family.length;
const times = JSON.parse(timesJson);
const HOUR = 36000;

// the kernel reports calendar downs / PMs as "down"; wafer-count maintenance
// (shown as PM at the end of a busy period) keeps the tool busy
function inDown(m, T) {
  for (let k = R.dFirst[m]; k < R.dFirst[m + 1]; k++) if (R.dStart[k] <= T && T < R.dEnd[k]) return true;
  return false;
}

function freshScene() {
  const scene = Object.create(FabScene.prototype);
  scene.replay = R;
  scene.cursor = new Int32Array(n).fill(-2);
  scene.dCursor = new Int32Array(n).fill(-2);
  scene.lastT = -1;
  return scene;
}

function visit(scene, T) {
  if (scene.lastT < 0) scene.lastT = T;
  const row = [];
  for (let m = 0; m < n; m++) {
    const st = scene.machineState(m, T);
    if (RAW) { row.push(st); continue; }
    row.push(st === STATE.DOWN || (st === STATE.PM && inDown(m, T)) ? 2 : st === STATE.IDLE ? 0 : 1);
  }
  scene.lastT = T;
  return row;
}

function pass(order) {
  const scene = freshScene(), out = {};
  for (const T of order) out[T] = visit(scene, T);
  return out;
}

// what a user does with the player: jump ahead, step back an hour, then play on
function zigzag(order) {
  const scene = freshScene(), out = {};
  for (const T of order) {
    visit(scene, Math.min(R.endTime, T + 10 * HOUR));
    visit(scene, Math.max(0, T - HOUR));
    for (let k = 3; k >= 1; k--) visit(scene, Math.max(0, T - k * 600));
    out[T] = visit(scene, T);
  }
  return out;
}

const forward = pass(times);
const backward = pass([...times].reverse());
console.log(JSON.stringify({ forward, backward, zigzag: zigzag(times), endTime: R.endTime, dispatches: meta.dispatches }));
