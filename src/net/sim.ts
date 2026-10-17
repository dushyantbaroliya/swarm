// A simulated network you can be cruel to.
//
// Every message becomes a packet with a departure and arrival time. The
// chaos settings decide how long it takes, whether it arrives at all, and
// whether it arrives twice. Links can be cut to form partitions. Time is
// injected, so tests can run thousands of rounds without waiting.

import type { PeerId } from "../crdt/types";
import type { Msg } from "../sync/node";

export interface Chaos {
  /** Base one-way latency in ms. */
  latency: number;
  /** Extra random latency, 0..jitter ms. Large jitter reorders packets. */
  jitter: number;
  /** Probability a packet is lost, 0..1. */
  drop: number;
  /** Probability a packet is delivered twice, 0..1. */
  dup: number;
}

export interface Packet {
  id: number;
  from: PeerId;
  to: PeerId;
  msg: Msg;
  sent: number;
  arrive: number;
  /** Lost packets still fly (so the UI can show them die), but are never delivered. */
  lost: boolean;
}

export function linkKey(a: PeerId, b: PeerId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class SimNetwork {
  chaos: Chaos = { latency: 120, jitter: 80, drop: 0, dup: 0 };
  readonly cut = new Set<string>();
  readonly inflight: Packet[] = [];
  stats = { sent: 0, delivered: 0, lost: 0 };
  private nextId = 1;
  private peers: PeerId[] = [];

  constructor(
    private deliver: (to: PeerId, from: PeerId, msg: Msg) => void,
    private random: () => number = Math.random,
  ) {}

  setPeers(peers: PeerId[]): void {
    this.peers = [...peers];
    for (let i = this.inflight.length - 1; i >= 0; i--) {
      const p = this.inflight[i];
      if (!peers.includes(p.from) || !peers.includes(p.to)) this.inflight.splice(i, 1);
    }
  }

  isCut(a: PeerId, b: PeerId): boolean {
    return this.cut.has(linkKey(a, b));
  }

  neighbours(of: PeerId): PeerId[] {
    return this.peers.filter((p) => p !== of && !this.isCut(of, p));
  }

  send(from: PeerId, to: PeerId, msg: Msg, now: number): void {
    if (this.isCut(from, to)) return;
    const copies = this.random() < this.chaos.dup ? 2 : 1;
    for (let c = 0; c < copies; c++) {
      this.stats.sent++;
      const lost = this.random() < this.chaos.drop;
      const arrive = now + this.chaos.latency + this.random() * this.chaos.jitter;
      this.inflight.push({ id: this.nextId++, from, to, msg, sent: now, arrive, lost });
    }
  }

  /** Deliver every packet due by `now`, in arrival order. */
  step(now: number): void {
    const due = this.inflight.filter((p) => p.arrive <= now).sort((a, b) => a.arrive - b.arrive);
    if (due.length === 0) return;
    const dueIds = new Set(due.map((p) => p.id));
    for (let i = this.inflight.length - 1; i >= 0; i--) if (dueIds.has(this.inflight[i].id)) this.inflight.splice(i, 1);
    for (const p of due) {
      // A link cut mid-flight takes its packets with it.
      if (p.lost || this.isCut(p.from, p.to)) {
        this.stats.lost++;
        continue;
      }
      this.stats.delivered++;
      this.deliver(p.to, p.from, p.msg);
    }
  }
}
