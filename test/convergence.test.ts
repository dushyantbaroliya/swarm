// The claim this project rests on: replicas that have seen the same set of
// ops are in the same state, regardless of the order those ops arrived in,
// how many times, or what each replica did in between.
//
// fast-check generates random histories: peers edit, partially sync with
// each other (so later edits causally depend on some earlier ones but not
// others), and finally every op is delivered to everyone in a random,
// duplicated order. Every run must end in identical snapshots.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Replica } from "../src/crdt/replica";
import type { Op } from "../src/crdt/types";

const PEERS = ["ana", "bao", "cyd", "dev"];
const ELEMS = ["e1", "e2", "e3"];
const FIELDS = ["kind", "x", "y", "color", "deleted", "z"];

const value = fc.oneof(fc.integer({ min: -50, max: 50 }), fc.constantFrom("red", "teal", "rect", "V", "k"), fc.boolean());

const action = fc.oneof(
  fc.record({ kind: fc.constant("set" as const), el: fc.constantFrom(...ELEMS), f: fc.constantFrom(...FIELDS), v: value }),
  fc.record({
    kind: fc.constant("text" as const),
    el: fc.constantFrom(...ELEMS),
    at: fc.double({ min: 0, max: 1, noNaN: true }),
    del: fc.integer({ min: 0, max: 3 }),
    ins: fc.string({ maxLength: 4, unit: fc.constantFrom("a", "b", "c", "x", " ") }),
  }),
);

const step = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant("act" as const), peer: fc.nat(PEERS.length - 1), a: action }) },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("sync" as const),
      from: fc.nat(PEERS.length - 1),
      to: fc.nat(PEERS.length - 1),
      keep: fc.double({ min: 0, max: 1, noNaN: true }),
      seed: fc.integer(),
    }),
  },
);

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

type Step = typeof step extends fc.Arbitrary<infer S> ? S : never;

function run(steps: Step[], finalSeed: number): Replica[] {
  const reps = PEERS.map((p) => new Replica(p));
  const all: Op[] = [];
  for (const r of reps) r.on((e) => e.type === "op" && e.local && all.push(e.op));

  for (const s of steps) {
    if (s.t === "act") {
      const r = reps[s.peer];
      if (s.a.kind === "set") r.set(s.a.el, s.a.f, s.a.v);
      else {
        const t = r.text(s.a.el);
        const p = Math.floor(s.a.at * (t.length + 1)) % (t.length + 1);
        r.editText(s.a.el, t.slice(0, p) + s.a.ins + t.slice(p + s.a.del));
      }
    } else {
      // Partial, shuffled sync: some of what `from` knows reaches `to`.
      const rnd = mulberry(s.seed);
      const ops = reps[s.from].missingFor(reps[s.to].versionVector()).filter(() => rnd() < s.keep);
      for (const op of shuffle(ops, rnd)) reps[s.to].receive(op);
    }
  }

  // Everyone gets everything: random order, with duplicates.
  const rnd = mulberry(finalSeed);
  for (const r of reps) {
    const delivery = shuffle([...all, ...all.filter(() => rnd() < 0.3)], rnd);
    for (const op of delivery) r.receive(op);
  }
  return reps;
}

describe("convergence", () => {
  it("replicas converge under arbitrary interleavings, reorderings and duplicates", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), fc.integer(), (steps, seed) => {
        const reps = run(steps, seed);
        const snap = reps[0].snapshot();
        for (const r of reps) expect(r.snapshot()).toBe(snap);
      }),
      { numRuns: 4000 },
    );
  });

  it("long histories with heavy text editing converge", () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 60, maxLength: 160 }), fc.integer(), (steps, seed) => {
        const reps = run(steps, seed);
        const texts = ELEMS.map((e) => reps[0].text(e));
        for (const r of reps) expect(ELEMS.map((e) => r.text(e))).toEqual(texts);
        for (const r of reps) expect(r.hash()).toBe(reps[0].hash());
      }),
      { numRuns: 1500 },
    );
  });

  it("delivery order never matters for a fixed op set", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 30 }), fc.integer(), fc.integer(), (steps, s1, s2) => {
        const a = run(steps, s1);
        const b = run(steps, s2);
        expect(a[0].snapshot()).toBe(b[0].snapshot());
      }),
      { numRuns: 2000 },
    );
  });
});
