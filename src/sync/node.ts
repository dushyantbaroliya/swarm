// Transport-agnostic sync for one replica.
//
// Two mechanisms, deliberately redundant:
//
//  1. Push. Local ops are batched and sent to every neighbour right away.
//     Fast, but packets get dropped and partitions swallow them.
//  2. Anti-entropy. Every so often we send our version vector. A neighbour
//     that holds ops we lack replies with them; if it notices *it* is
//     behind, it replies with its own vector so we push back. Ops are
//     forwarded by anyone who holds them, so a partition heals as soon as
//     any path exists again, even an indirect one.
//
// The same class runs over the simulated network and over WebRTC.

import type { Replica } from "../crdt/replica";
import type { Op, PeerId, VV } from "../crdt/types";

export type Msg = { t: "ops"; ops: Op[] } | { t: "vv"; vv: VV };

export interface Transport {
  send(to: PeerId, msg: Msg): void;
  neighbours(): PeerId[];
}

export class SyncNode {
  private outbox: Op[] = [];

  constructor(
    readonly replica: Replica,
    private transport: Transport,
  ) {
    replica.on((e) => {
      if (e.type === "op" && e.local) this.outbox.push(e.op);
    });
  }

  /** Send any batched local ops. Call once per frame/tick. */
  flush(): void {
    if (this.outbox.length === 0) return;
    const ops = this.outbox;
    this.outbox = [];
    for (const n of this.transport.neighbours()) this.transport.send(n, { t: "ops", ops });
  }

  /** One round of anti-entropy: advertise what we have. */
  gossip(): void {
    const vv = this.replica.versionVector();
    for (const n of this.transport.neighbours()) this.transport.send(n, { t: "vv", vv });
  }

  receive(from: PeerId, msg: Msg): void {
    if (msg.t === "ops") {
      for (const op of msg.ops) this.replica.receive(op);
      return;
    }
    const missing = this.replica.missingFor(msg.vv);
    if (missing.length > 0) this.transport.send(from, { t: "ops", ops: missing });
    if (this.replica.isBehind(msg.vv)) this.transport.send(from, { t: "vv", vv: this.replica.versionVector() });
  }
}
