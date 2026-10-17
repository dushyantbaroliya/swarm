// RGA: a replicated growable array, used for sticky-note text.
//
// Each character is a node with a unique stamp and a pointer to the
// character it was typed after. To place a new node we start right after
// its anchor and skip past any neighbours with a *larger* stamp: those were
// typed concurrently (or later) at the same spot, and the stamp order
// decides who goes first. Because every replica applies the same rule over
// the same stamps, they all build the same string, in any delivery order.
//
// Deletes only tombstone a node, so a late insert anchored on a deleted
// character still has somewhere to land.

import { cmpStamp, stampKey, type DelOp, type InsOp, type Stamp } from "./types";

interface Node {
  s: Stamp;
  ch: string;
}

export class RGA {
  private nodes = new Map<string, Node>();
  private order: string[] = [];
  private deleted = new Set<string>();
  /** Inserts that arrived before their anchor, keyed by the anchor they wait for. */
  private pending = new Map<string, InsOp[]>();

  insert(op: InsOp): void {
    const s: Stamp = { l: op.l, p: op.peer };
    const key = stampKey(s);
    if (this.nodes.has(key)) return;
    if (op.after !== null && !this.nodes.has(op.after)) {
      const waiting = this.pending.get(op.after) ?? [];
      waiting.push(op);
      this.pending.set(op.after, waiting);
      return;
    }
    let i = op.after === null ? 0 : this.order.indexOf(op.after) + 1;
    while (i < this.order.length && cmpStamp(this.nodes.get(this.order[i])!.s, s) > 0) i++;
    this.nodes.set(key, { s, ch: op.ch });
    this.order.splice(i, 0, key);

    const waiting = this.pending.get(key);
    if (waiting) {
      this.pending.delete(key);
      for (const w of waiting) this.insert(w);
    }
  }

  remove(op: DelOp): void {
    // Recorded even if the target hasn't arrived yet; it'll be born dead.
    this.deleted.add(op.target);
  }

  /** Keys of visible characters, in document order. */
  visibleKeys(): string[] {
    return this.order.filter((k) => !this.deleted.has(k));
  }

  text(): string {
    let out = "";
    for (const k of this.order) if (!this.deleted.has(k)) out += this.nodes.get(k)!.ch;
    return out;
  }
}
