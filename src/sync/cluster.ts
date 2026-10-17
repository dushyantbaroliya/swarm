// A cluster of replicas wired through the simulated network.
// Used by the lab UI and by the tests, so the tests exercise the real thing.

import { Replica } from "../crdt/replica";
import type { PeerId } from "../crdt/types";
import { SimNetwork } from "../net/sim";
import { SyncNode } from "./node";

export class Cluster {
  readonly net: SimNetwork;
  readonly nodes = new Map<PeerId, SyncNode>();
  now = 0;
  private lastGossip = 0;
  gossipEvery = 600;

  constructor(random: () => number = Math.random) {
    this.net = new SimNetwork((to, from, msg) => this.nodes.get(to)?.receive(from, msg), random);
  }

  add(peer: PeerId): SyncNode {
    const replica = new Replica(peer);
    const node = new SyncNode(replica, {
      send: (to, msg) => this.net.send(peer, to, msg, this.now),
      neighbours: () => this.net.neighbours(peer),
    });
    this.nodes.set(peer, node);
    this.net.setPeers([...this.nodes.keys()]);
    return node;
  }

  remove(peer: PeerId): void {
    this.nodes.delete(peer);
    this.net.setPeers([...this.nodes.keys()]);
    for (const k of [...this.net.cut]) if (k.split("|").includes(peer)) this.net.cut.delete(k);
  }

  replica(peer: PeerId): Replica {
    return this.nodes.get(peer)!.replica;
  }

  /** Advance simulated time to `now`: flush, deliver, gossip when due. */
  tick(now: number): void {
    this.now = now;
    for (const n of this.nodes.values()) n.flush();
    this.net.step(now);
    if (now - this.lastGossip >= this.gossipEvery) {
      this.lastGossip = now;
      for (const n of this.nodes.values()) n.gossip();
    }
  }

  converged(): boolean {
    const hashes = new Set([...this.nodes.values()].map((n) => n.replica.hash()));
    return hashes.size <= 1;
  }

  distinctStates(): number {
    return new Set([...this.nodes.values()].map((n) => n.replica.hash())).size;
  }
}
