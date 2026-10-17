// Core vocabulary shared by every replica.
//
// A Stamp is a Lamport timestamp plus the peer that issued it. Comparing
// (lamport, peer) gives every edit in the system a single total order that
// all replicas agree on without talking to each other. That agreement is
// the whole trick behind last-writer-wins.

export type PeerId = string;

export interface Stamp {
  l: number;
  p: PeerId;
}

export function cmpStamp(a: Stamp, b: Stamp): number {
  if (a.l !== b.l) return a.l - b.l;
  return a.p < b.p ? -1 : a.p > b.p ? 1 : 0;
}

export function stampKey(s: Stamp): string {
  return `${s.l}.${s.p}`;
}

export type Value = string | number | boolean | number[] | null;

interface OpBase {
  /** Author of the op. */
  peer: PeerId;
  /** Per-author sequence number, contiguous from 1. Used for dedup and version vectors. */
  seq: number;
  /** Lamport time the op was issued at. Also its stamp for ordering. */
  l: number;
}

/** Set one field of one element (last-writer-wins register). */
export interface SetOp extends OpBase {
  t: "set";
  el: string;
  f: string;
  v: Value;
  /** The stamp this write overwrote at its author, or null. Lets receivers spot concurrent writes. */
  prev: Stamp | null;
}

/** Insert one character into an element's text (RGA sequence). The char's id is its own stamp. */
export interface InsOp extends OpBase {
  t: "ins";
  el: string;
  /** Key of the char this one goes after, or null for the start. */
  after: string | null;
  ch: string;
}

/** Tombstone one character of an element's text. */
export interface DelOp extends OpBase {
  t: "del";
  el: string;
  target: string;
}

export type Op = SetOp | InsOp | DelOp;

/** Version vector: for each author, the highest seq we hold with no gaps before it. */
export type VV = Record<PeerId, number>;

export function opKey(op: Op): string {
  return `${op.peer}#${op.seq}`;
}
