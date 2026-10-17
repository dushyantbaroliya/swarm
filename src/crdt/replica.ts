// A Replica is one peer's copy of the whiteboard.
//
// State is a map of element -> field -> last-writer-wins register, plus an
// RGA per element for text. There is no "create" or "delete" op: creating
// an element is just setting its fields, and deleting it is setting
// `deleted: true`. That makes undo-of-delete a plain write, and it means a
// move that races a delete simply resolves by stamp like any other field.
//
// Every op ever seen is kept in a log so the replica can hand missing ops
// to peers that fell behind (see sync/node.ts).

import { RGA } from "./rga";
import { keyBetween } from "./fractional";
import {
  cmpStamp,
  opKey,
  type DelOp,
  type InsOp,
  type Op,
  type PeerId,
  type SetOp,
  type Stamp,
  type Value,
  type VV,
} from "./types";

interface Register {
  v: Value;
  s: Stamp;
}

export interface Element {
  id: string;
  kind: string;
  fields: Record<string, Value>;
}

export interface Conflict {
  el: string;
  f: string;
  /** Peer whose value survived. */
  winner: PeerId;
  /** Peer whose value was overruled. */
  loser: PeerId;
}

export type ReplicaEvent =
  | { type: "op"; op: Op; local: boolean }
  | { type: "conflict"; conflict: Conflict };

export class Replica {
  readonly peer: PeerId;
  private lamport = 0;
  private seq = 0;
  private elemCounter = 0;

  private log = new Map<PeerId, Map<number, Op>>();
  private vv: VV = {};
  private fields = new Map<string, Map<string, Register>>();
  private texts = new Map<string, RGA>();
  private listeners = new Set<(e: ReplicaEvent) => void>();
  private version = 0;

  constructor(peer: PeerId) {
    this.peer = peer;
  }

  // -------------------------------------------------------------- events

  on(fn: (e: ReplicaEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ReplicaEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  /** Bumps on every state change; cheap dirty check for renderers. */
  get stateVersion(): number {
    return this.version;
  }

  // --------------------------------------------------------- local edits

  newElementId(): string {
    return `${this.peer}:${++this.elemCounter}`;
  }

  set(el: string, f: string, v: Value): SetOp {
    const prev = this.fields.get(el)?.get(f)?.s ?? null;
    const op: SetOp = { t: "set", el, f, v, prev, ...this.nextHeader() };
    this.integrate(op, true);
    return op;
  }

  /** Replace the text of `el` with `next`, emitting the minimal ins/del ops. */
  editText(el: string, next: string): Op[] {
    const rga = this.texts.get(el);
    const keys = rga?.visibleKeys() ?? [];
    const prevText = rga?.text() ?? "";
    let p = 0;
    while (p < prevText.length && p < next.length && prevText[p] === next[p]) p++;
    let s = 0;
    while (
      s < prevText.length - p &&
      s < next.length - p &&
      prevText[prevText.length - 1 - s] === next[next.length - 1 - s]
    )
      s++;

    const ops: Op[] = [];
    for (let i = p; i < prevText.length - s; i++) {
      const op: DelOp = { t: "del", el, target: keys[i], ...this.nextHeader() };
      this.integrate(op, true);
      ops.push(op);
    }
    let after = p > 0 ? keys[p - 1] : null;
    for (const ch of next.slice(p, next.length - s)) {
      const op: InsOp = { t: "ins", el, after, ch, ...this.nextHeader() };
      this.integrate(op, true);
      ops.push(op);
      after = `${op.l}.${op.peer}`;
    }
    return ops;
  }

  private nextHeader(): { peer: PeerId; seq: number; l: number } {
    return { peer: this.peer, seq: ++this.seq, l: ++this.lamport };
  }

  // -------------------------------------------------------- remote edits

  /** Apply an op from elsewhere. Returns false if we already had it. */
  receive(op: Op): boolean {
    if (this.log.get(op.peer)?.has(op.seq)) return false;
    this.lamport = Math.max(this.lamport, op.l);
    this.integrate(op, false);
    return true;
  }

  private integrate(op: Op, local: boolean): void {
    let byPeer = this.log.get(op.peer);
    if (!byPeer) {
      byPeer = new Map();
      this.log.set(op.peer, byPeer);
    }
    byPeer.set(op.seq, op);
    let top = this.vv[op.peer] ?? 0;
    while (byPeer.has(top + 1)) top++;
    this.vv[op.peer] = top;

    if (op.t === "set") this.applySet(op, local);
    else if (op.t === "ins") this.textOf(op.el).insert(op);
    else this.textOf(op.el).remove(op);

    this.version++;
    this.emit({ type: "op", op, local });
  }

  private applySet(op: SetOp, local: boolean): void {
    let reg = this.fields.get(op.el);
    if (!reg) {
      reg = new Map();
      this.fields.set(op.el, reg);
    }
    const s: Stamp = { l: op.l, p: op.peer };
    const cur = reg.get(op.f);

    // Concurrent write: our current value is newer than anything the author
    // had seen for this field, and came from someone else. Whoever wins,
    // that's a real conflict worth showing.
    if (!local && cur && cur.s.p !== op.peer && (op.prev === null || cmpStamp(cur.s, op.prev) > 0)) {
      const wins = cmpStamp(s, cur.s) > 0;
      this.emit({
        type: "conflict",
        conflict: { el: op.el, f: op.f, winner: wins ? op.peer : cur.s.p, loser: wins ? cur.s.p : op.peer },
      });
    }

    if (!cur || cmpStamp(s, cur.s) > 0) reg.set(op.f, { v: op.v, s });
  }

  private textOf(el: string): RGA {
    let rga = this.texts.get(el);
    if (!rga) {
      rga = new RGA();
      this.texts.set(el, rga);
    }
    return rga;
  }

  // --------------------------------------------------------------- reads

  get(el: string, f: string): Value | undefined {
    return this.fields.get(el)?.get(f)?.v;
  }

  text(el: string): string {
    return this.texts.get(el)?.text() ?? "";
  }

  /** Live elements in stacking order (bottom first). */
  elements(): Element[] {
    const out: Element[] = [];
    for (const [id, reg] of this.fields) {
      const kind = reg.get("kind")?.v;
      if (typeof kind !== "string" || reg.get("deleted")?.v === true) continue;
      const fields: Record<string, Value> = {};
      for (const [f, r] of reg) fields[f] = r.v;
      out.push({ id, kind, fields });
    }
    out.sort((a, b) => {
      const za = String(a.fields.z ?? ""),
        zb = String(b.fields.z ?? "");
      if (za !== zb) return za < zb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return out;
  }

  /** A z key above everything currently on the board. */
  topZ(): string {
    let max = "";
    for (const reg of this.fields.values()) {
      const z = reg.get("z")?.v;
      if (typeof z === "string" && z > max) max = z;
    }
    return keyBetween(max, null);
  }

  // ---------------------------------------------------------------- sync

  versionVector(): VV {
    return { ...this.vv };
  }

  opCount(): number {
    let n = 0;
    for (const m of this.log.values()) n += m.size;
    return n;
  }

  /** Every op we hold that a peer with version vector `theirs` might lack. */
  missingFor(theirs: VV): Op[] {
    const out: Op[] = [];
    for (const [peer, ops] of this.log) {
      const have = theirs[peer] ?? 0;
      for (const [seq, op] of ops) if (seq > have) out.push(op);
    }
    out.sort((a, b) => a.l - b.l);
    return out;
  }

  /** True if `theirs` holds something we don't. */
  isBehind(theirs: VV): boolean {
    for (const peer in theirs) if (theirs[peer] > (this.vv[peer] ?? 0)) return true;
    return false;
  }

  /** Canonical serialization of visible state. Equal snapshots == converged. */
  snapshot(): string {
    const ids = [...new Set([...this.fields.keys(), ...this.texts.keys()])].sort();
    const parts: string[] = [];
    for (const id of ids) {
      const reg = this.fields.get(id);
      const fs = reg ? [...reg.entries()].sort(([a], [b]) => (a < b ? -1 : 1)) : [];
      const text = this.texts.get(id)?.text() ?? "";
      // An element whose only text was typed and fully deleted is
      // indistinguishable from one never touched; don't let that differ.
      if (fs.length === 0 && text === "") continue;
      parts.push(JSON.stringify([id, fs.map(([f, r]) => [f, r.v, r.s.l, r.s.p]), text]));
    }
    return parts.join("\n");
  }

  hash(): string {
    // FNV-1a, 32-bit. Only used to compare replicas at a glance.
    let h = 0x811c9dc5;
    const s = this.snapshot();
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  /** Peers we have heard from (including ourselves). */
  knownPeers(): PeerId[] {
    return Object.keys(this.vv).sort();
  }

  // Internal access for tests.
  /** @internal */ get _lamport(): number {
    return this.lamport;
  }
}

export type { Op, SetOp, InsOp, DelOp, Stamp, Value, VV, PeerId } from "./types";
export { opKey };
