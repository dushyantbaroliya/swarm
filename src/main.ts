import "./styles.css";
import { Replica } from "./crdt/replica";
import type { Op } from "./crdt/types";
import { linkKey, type Chaos } from "./net/sim";
import { RtcMesh } from "./net/rtc";
import { Cluster } from "./sync/cluster";
import { SyncNode } from "./sync/node";
import { Board, W, H, type Tool, type ToolState } from "./ui/board";
import { Topology } from "./ui/topology";
import { PEER_NAMES, SHAPE_COLORS, peerColor } from "./ui/theme";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;

const tools: ToolState = { tool: "select", color: SHAPE_COLORS[0] };
const cluster = new Cluster();
const boards = new Map<string, Board>();
const cards = new Map<string, HTMLElement>();
let active: Board | null = null;
let conflictCount = 0;
const generation: Record<string, number> = {};

// ======================================================= toolbar & tools

function setTool(t: Tool): void {
  tools.tool = t;
  document.querySelectorAll<HTMLButtonElement>("#tools button").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
  if (t !== "select") for (const b of boards.values()) b.deselect();
}

document.querySelectorAll<HTMLButtonElement>("#tools button").forEach((b) =>
  b.addEventListener("click", () => setTool(b.dataset.tool as Tool)),
);

const swatches = $("#swatches");
for (const color of SHAPE_COLORS) {
  const s = document.createElement("button");
  s.className = "swatch" + (color === tools.color ? " on" : "");
  s.style.background = color;
  s.title = "Colour";
  s.addEventListener("click", () => {
    tools.color = color;
    swatches.querySelectorAll(".swatch").forEach((x) => x.classList.toggle("on", x === s));
    active?.recolorSelected(color);
    liveBoard?.recolorSelected(color);
  });
  swatches.append(s);
}

$("#undo").addEventListener("click", () => (liveVisible() ? liveBoard?.undo() : active?.undo()));

document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") return;
  const board = liveVisible() ? liveBoard : active;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    board?.undo();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Delete" || e.key === "Backspace") board?.deleteSelected();
  else if (e.key === "Escape") board?.deselect();
  else {
    const map: Record<string, Tool> = { v: "select", r: "rect", o: "ellipse", a: "arrow", p: "pen", s: "sticky", e: "erase" };
    const tool = map[e.key.toLowerCase()];
    if (tool) setTool(tool);
  }
});

// ============================================================ peer cards

function addPeer(name: string): void {
  generation[name] = (generation[name] ?? 0) + 1;
  // A re-added peer is a brand new replica; reusing the old id would make
  // its fresh seq numbers collide with ops the others already hold.
  const id = generation[name] === 1 ? name : `${name}${generation[name]}`;
  const node = cluster.add(id);
  const color = peerColor(id);

  const card = document.createElement("div");
  card.className = "peer-card";
  card.style.setProperty("--peer", color);
  card.innerHTML = `
    <div class="peer-head">
      <span class="dot"></span><b>${id}</b>
      <span class="vv"></span>
      <span class="hash"></span>
      <button class="close" title="Send this person home" aria-label="Remove ${id}">×</button>
    </div>
    <div class="board-wrap"></div>`;
  $("#peers").append(card);
  cards.set(id, card);

  const board = new Board(card.querySelector(".board-wrap")!, node.replica, color, tools, activate);
  boards.set(id, board);
  card.querySelector(".close")!.addEventListener("click", () => removePeer(id));

  node.replica.on((e) => {
    if (e.type === "op" && e.local) logOp(e.op);
    if (e.type === "conflict") {
      conflictCount++;
      logConflict(e.conflict.el, e.conflict.f, e.conflict.winner, e.conflict.loser);
    }
  });
  refreshPeerButtons();
}

function removePeer(id: string): void {
  if (cluster.nodes.size <= 2) return;
  cluster.remove(id);
  boards.delete(id);
  cards.get(id)?.remove();
  cards.delete(id);
  if (active && !boards.has(active.replica.peer)) active = null;
  refreshPeerButtons();
}

function refreshPeerButtons(): void {
  ($("#add-peer") as HTMLButtonElement).disabled = cluster.nodes.size >= PEER_NAMES.length;
  cards.forEach((c) => ((c.querySelector(".close") as HTMLButtonElement).disabled = cluster.nodes.size <= 2));
}

function activate(b: Board): void {
  active = b;
  for (const [id, c] of cards) c.classList.toggle("active", id === b.replica.peer);
  for (const other of boards.values()) if (other !== b) other.deselect();
}

$("#add-peer").addEventListener("click", () => {
  const used = new Set([...cluster.nodes.keys()].map((k) => k.replace(/\d+$/, "")));
  const free = PEER_NAMES.find((n) => !used.has(n));
  if (free) addPeer(free);
});

function hashColor(h: string): string {
  return `hsl(${parseInt(h.slice(0, 6), 16) % 360} 52% 40%)`;
}

function updateHeaders(): void {
  for (const [id, card] of cards) {
    const r = cluster.replica(id);
    const vv = r.versionVector();
    const vvEl = card.querySelector<HTMLElement>(".vv")!;
    vvEl.title = "How many changes this board has heard about from each person";
    vvEl.textContent = Object.keys(vv)
      .sort()
      .map((p) => `${p.slice(0, 3)} ${vv[p]}`)
      .join(" · ");
    const h = r.hash();
    const chip = card.querySelector<HTMLElement>(".hash")!;
    chip.textContent = h.slice(0, 6);
    chip.style.background = hashColor(h);
    chip.title = "Fingerprint of this board. Same colour as another board means they look exactly the same.";
  }
}

// ============================================================== op log

interface LogLine {
  who: string;
  key: string;
  text: string;
  conflict?: boolean;
  typed?: string;
}

const log: LogLine[] = [];
let logDirty = false;
let opTotal = 0;
const recentConflicts = new Map<string, number>();

const FIELD_WORDS: Record<string, string> = {
  x: "spot", y: "spot", color: "colour", w: "size", h: "size", deleted: "same thing", z: "order",
};
const KIND_WORDS: Record<string, string> = {
  rect: "a box", ellipse: "a circle", arrow: "an arrow", stroke: "a squiggle", sticky: "a sticky note",
};

function phrase(op: Op, r: Replica | undefined): string | null {
  if (op.t === "ins") return null;
  if (op.t === "del") return "rubbed out some letters";
  const kind = r?.get(op.el, "kind");
  const thing = typeof kind === "string" ? (KIND_WORDS[kind] ?? "something").replace(/^an? /, "the ") : "something";
  switch (op.f) {
    case "kind": return `drew ${KIND_WORDS[String(op.v)] ?? "something"}`;
    case "x": case "y": return `moved ${thing}`;
    case "w": case "h": return `resized ${thing}`;
    case "color": return `coloured ${thing}`;
    case "deleted": return op.v === true ? `rubbed out ${thing}` : `brought back ${thing}`;
    default: return null;
  }
}

function logOp(op: Op): void {
  opTotal++;
  const last = log[log.length - 1];
  const key = `${op.peer}|${op.el}|${op.t === "set" ? "set" : "text"}`;
  if (op.t === "ins") {
    if (last && last.key === key && last.typed !== undefined) {
      last.typed += op.ch === "\n" ? " " : op.ch;
      last.text = `typed "${last.typed.slice(-40)}"`;
    } else {
      log.push({ who: op.peer, key, typed: op.ch, text: `typed "${op.ch}"` });
    }
  } else {
    const p = phrase(op, cluster.nodes.get(op.peer)?.replica);
    if (!p) return void (logDirty = true);
    // A new shape sends several notes at once; "drew a box" already says it all.
    if (last && last.key === key && !last.conflict && (last.text.includes(p) || last.text.startsWith("drew"))) return;
    log.push({ who: op.peer, key, text: p });
  }
  if (log.length > 120) log.splice(0, log.length - 120);
  logDirty = true;
}

function logConflict(el: string, f: string, winner: string, loser: string): void {
  const k = `${el}.${f}:${winner}>${loser}`;
  const now = performance.now();
  if ((recentConflicts.get(k) ?? -Infinity) > now - 3000) return;
  recentConflicts.set(k, now);
  log.push({ who: winner, key: "conflict", text: `tie! ${winner} and ${loser} both changed the ${FIELD_WORDS[f] ?? "same thing"} at once. ${winner} wins`, conflict: true });
  logDirty = true;
}

function renderLog(): void {
  if (!logDirty) return;
  logDirty = false;
  const ol = $("#log");
  const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 30;
  ol.innerHTML = "";
  for (const l of log.slice(-80)) {
    const li = document.createElement("li");
    if (l.conflict) li.className = "conflict";
    const who = document.createElement("span");
    who.className = "who";
    who.style.color = peerColor(l.who);
    who.textContent = l.who.slice(0, 3);
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = l.text;
    what.title = l.text;
    li.append(who, what);
    ol.append(li);
  }
  if (atBottom) ol.scrollTop = ol.scrollHeight;
  $("#op-total").textContent = `${opTotal} notes sent`;
}

// ================================================================= chaos

const presets: Record<string, Chaos & { gossip: number }> = {
  calm: { latency: 120, jitter: 80, drop: 0, dup: 0, gossip: 600 },
  wifi: { latency: 350, jitter: 600, drop: 0.15, dup: 0.05, gossip: 800 },
  hostile: { latency: 700, jitter: 1600, drop: 0.45, dup: 0.2, gossip: 1200 },
};

const sliders: { id: string; get: () => number; set: (v: number) => void; show: (v: number) => string }[] = [
  { id: "c-latency", get: () => cluster.net.chaos.latency, set: (v) => (cluster.net.chaos.latency = v), show: (v) => `${v} ms` },
  { id: "c-jitter", get: () => cluster.net.chaos.jitter, set: (v) => (cluster.net.chaos.jitter = v), show: (v) => `${v} ms` },
  { id: "c-drop", get: () => cluster.net.chaos.drop, set: (v) => (cluster.net.chaos.drop = v), show: (v) => `${Math.round(v * 100)}%` },
  { id: "c-dup", get: () => cluster.net.chaos.dup, set: (v) => (cluster.net.chaos.dup = v), show: (v) => `${Math.round(v * 100)}%` },
  { id: "c-gossip", get: () => cluster.gossipEvery, set: (v) => (cluster.gossipEvery = v), show: (v) => `${(v / 1000).toFixed(1)}s` },
];

function syncSliders(): void {
  for (const s of sliders) {
    const input = $<HTMLInputElement>(`#${s.id}`);
    input.value = String(s.get());
    input.nextElementSibling!.textContent = s.show(s.get());
  }
}

for (const s of sliders) {
  const input = $<HTMLInputElement>(`#${s.id}`);
  input.addEventListener("input", () => {
    s.set(Number(input.value));
    input.nextElementSibling!.textContent = s.show(Number(input.value));
  });
}

document.querySelectorAll<HTMLButtonElement>("#presets button").forEach((b) =>
  b.addEventListener("click", () => {
    const p = presets[b.dataset.preset!];
    cluster.net.chaos = { latency: p.latency, jitter: p.jitter, drop: p.drop, dup: p.dup };
    cluster.gossipEvery = p.gossip;
    syncSliders();
  }),
);

$("#heal").addEventListener("click", () => cluster.net.cut.clear());
$("#split").addEventListener("click", () => {
  const peers = [...cluster.nodes.keys()];
  const half = Math.ceil(peers.length / 2);
  cluster.net.cut.clear();
  for (const a of peers.slice(0, half)) for (const b of peers.slice(half)) cluster.net.cut.add(linkKey(a, b));
});

let frozen = false;
$("#freeze").addEventListener("click", (e) => {
  frozen = !frozen;
  (e.currentTarget as HTMLElement).setAttribute("aria-pressed", String(frozen));
  (e.currentTarget as HTMLElement).textContent = frozen ? "Frozen" : "Freeze";
});

// ========================================================== chaos monkey

const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T>(xs: T[]): T => xs[rnd(xs.length)];
const WORDS = ["ship it", "why tho", "LGTM", "merge?", "todo", "nice", "hmm", "agreed", "wait", "v2"];

function monkeyStep(): void {
  const ids = [...boards.keys()];
  if (ids.length === 0) return;
  const id = pick(ids);
  const board = boards.get(id)!;
  const r = board.replica;
  const els = r.elements();
  const roll = Math.random();

  if (roll < 0.25 || els.length < 3) {
    const kind = pick(["rect", "ellipse", "sticky", "arrow"]);
    const w = kind === "sticky" ? 140 : 60 + rnd(110);
    const h = kind === "sticky" ? 110 : kind === "arrow" ? rnd(120) - 60 : 40 + rnd(80);
    const el = board.create(kind, { x: 20 + rnd(W - 200), y: 20 + rnd(H - 160), w, h }, pick(SHAPE_COLORS));
    if (kind === "sticky") r.editText(el, pick(WORDS));
  } else if (roll < 0.62) {
    const el = pick(els);
    r.set(el.id, "x", Math.max(0, Math.min(W - 60, Number(el.fields.x) + rnd(160) - 80)));
    r.set(el.id, "y", Math.max(0, Math.min(H - 60, Number(el.fields.y) + rnd(120) - 60)));
  } else if (roll < 0.78) {
    r.set(pick(els).id, "color", pick(SHAPE_COLORS));
  } else if (roll < 0.9) {
    const stickies = els.filter((e) => e.kind === "sticky");
    if (stickies.length) {
      const s = pick(stickies);
      const t = r.text(s.id);
      r.editText(s.id, t.length > 40 ? t.slice(-12) : `${t} ${pick(WORDS)}`.trim());
    }
  } else if (els.length > 6) {
    r.set(pick(els).id, "deleted", true);
  }
}

let monkey: number | null = null;
$("#monkey").addEventListener("click", (e) => {
  const btn = e.currentTarget as HTMLElement;
  if (monkey === null) monkey = window.setInterval(monkeyStep, 280);
  else {
    clearInterval(monkey);
    monkey = null;
  }
  btn.setAttribute("aria-pressed", String(monkey !== null));
});

// Race: every peer edits the same element in the same instant, before any
// packet can move. Guaranteed concurrent writes, guaranteed conflicts.
$("#race").addEventListener("click", () => {
  const ids = [...boards.keys()];
  const first = cluster.replica(ids[0]);
  const shared = first.elements().filter((e) => ids.every((id) => cluster.replica(id).elements().some((x) => x.id === e.id)));
  if (shared.length === 0) return;
  const target = pick(shared);
  const x0 = Number(target.fields.x);
  ids.forEach((id, i) => {
    const r = cluster.replica(id);
    r.set(target.id, "color", peerColor(id));
    r.set(target.id, "x", Math.max(0, Math.min(W - 80, x0 + (i - (ids.length - 1) / 2) * 70)));
  });
});

// ============================================================ status

function updateStatus(): void {
  const distinct = cluster.distinctStates();
  const status = $("#status");
  status.classList.toggle("diverged", distinct > 1);
  $("#verdict").textContent = distinct > 1 ? `${distinct} boards don't match yet` : "All boards match";
  const hashes = $("#hashes");
  hashes.innerHTML = "";
  for (const id of cluster.nodes.keys()) {
    const h = cluster.replica(id).hash();
    const chip = document.createElement("span");
    chip.className = "hash";
    chip.style.marginLeft = "0";
    chip.style.background = hashColor(h);
    chip.textContent = `${id.slice(0, 3)} ${h.slice(0, 4)}`;
    hashes.append(chip);
  }
  const s = cluster.net.stats;
  $("#st-flight").textContent = String(cluster.net.inflight.filter((p) => !p.lost).length);
  $("#st-delivered").textContent = String(s.delivered);
  $("#st-lost").textContent = String(s.lost);
  $("#st-conflicts").textContent = String(conflictCount);
}

// ============================================================== seeding

function seed(): void {
  const a = boards.get("ana")!;
  const b = boards.get("bao")!;
  const note = a.create("sticky", { x: 40, y: 40, w: 190, h: 140 }, SHAPE_COLORS[2]);
  a.replica.editText(note, "Draw on any board. It shows up on the others too!");
  a.create("rect", { x: 300, y: 70, w: 170, h: 100 }, SHAPE_COLORS[4]);
  b.create("ellipse", { x: 540, y: 60, w: 150, h: 110 }, SHAPE_COLORS[3]);
  b.create("arrow", { x: 480, y: 300, w: -150, h: -100 }, SHAPE_COLORS[0]);
  const n2 = b.create("sticky", { x: 520, y: 300, w: 200, h: 130 }, SHAPE_COLORS[1]);
  b.replica.editText(n2, "Press Everyone grab it! and watch them fight over me.");
  // Start everyone in sync so the first thing visitors see is agreement.
  const all = [...cluster.nodes.values()];
  for (const from of all) for (const to of all) for (const op of from.replica.missingFor(to.replica.versionVector())) to.replica.receive(op);
}

// ============================================================ live mode

let liveBoard: Board | null = null;
let liveNode: SyncNode | null = null;
let liveMesh: RtcMesh | null = null;

function liveVisible(): boolean {
  return !$("#live").hidden;
}

function startLive(): void {
  if (liveBoard) return;
  const id = `you-${Math.random().toString(36).slice(2, 6)}`;
  const replica = new Replica(id);
  const status = $("#rtc-status");
  liveMesh = new RtcMesh(
    id,
    (from, msg) => liveNode!.receive(from, msg),
    (peers) => {
      $("#live-peers").textContent = peers.length ? `drawing with ${peers.join(", ")}` : "no friends here yet";
      status.textContent = peers.length ? `Connected! You are drawing with ${peers.length} friend${peers.length > 1 ? "s" : ""}.` : "Not connected yet.";
      status.classList.toggle("ok", peers.length > 0);
      liveNode!.gossip();
    },
  );
  liveNode = new SyncNode(replica, liveMesh);
  $("#live-name").textContent = id;
  $("#live-dot").style.background = "#15171c";
  liveBoard = new Board($("#live-wrap"), replica, "#15171c", tools, () => {});
  window.setInterval(() => liveNode!.gossip(), 1000);

  const guard = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (err) {
      status.textContent = (err as Error).message;
      status.classList.remove("ok");
    }
  };
  $("#rtc-create").addEventListener(
    "click",
    guard(async () => {
      status.textContent = "Making your code…";
      $<HTMLTextAreaElement>("#rtc-offer").value = await liveMesh!.createInvite();
      status.textContent = "Code ready! Send it to your friend, then paste the code they send back.";
    }),
  );
  $("#rtc-accept").addEventListener(
    "click",
    guard(async () => {
      await liveMesh!.acceptReply($<HTMLTextAreaElement>("#rtc-answer-in").value);
      status.textContent = "Saying hello…";
    }),
  );
  $("#rtc-join").addEventListener(
    "click",
    guard(async () => {
      status.textContent = "Making your answer code…";
      $<HTMLTextAreaElement>("#rtc-answer").value = await liveMesh!.join($<HTMLTextAreaElement>("#rtc-offer-in").value);
      status.textContent = "Answer code ready! Send it back to your friend.";
    }),
  );
  const copy = (sel: string) => () => {
    const v = $<HTMLTextAreaElement>(sel).value;
    if (v) navigator.clipboard?.writeText(v).catch(() => {});
  };
  $("#rtc-copy-offer").addEventListener("click", copy("#rtc-offer"));
  $("#rtc-copy-answer").addEventListener("click", copy("#rtc-answer"));
}

document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    const tab = b.dataset.tab!;
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $("#lab").hidden = tab !== "lab";
    $("#live").hidden = tab !== "live";
    for (const id of ["#race", "#monkey", "#add-peer"]) $(id).hidden = tab !== "lab";
    if (tab === "live") startLive();
  }),
);

// ============================================================== loop

["ana", "bao", "cyd"].forEach(addPeer);
seed();
syncSliders();
activate(boards.get("ana")!);

let simTime = 0;
let last = performance.now();
let lastStatus = 0;
const topology = new Topology($<HTMLCanvasElement>("#topology"), cluster, updateStatus);

function frame(now: number): void {
  const dt = Math.min(100, now - last);
  last = now;
  if (!frozen) simTime += dt;
  cluster.tick(simTime);
  if (!liveVisible()) {
    for (const b of boards.values()) b.render(now);
    topology.render(now);
    if (now - lastStatus > 150) {
      lastStatus = now;
      updateStatus();
      updateHeaders();
      renderLog();
    }
  } else {
    liveNode?.flush();
    liveBoard?.render(now);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
