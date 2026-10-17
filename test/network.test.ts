// End to end through the simulated network: chaos on, partitions cut,
// peers editing throughout. Once the network heals and calms down,
// push + anti-entropy must bring every replica to the same state.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Cluster } from "../src/sync/cluster";
import { linkKey } from "../src/net/sim";

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

describe("simulated network", () => {
  it("heals partitions and converges under loss, jitter and duplication", () => {
    fc.assert(
      fc.property(
        fc.integer(),
        fc.integer({ min: 2, max: 5 }),
        fc.double({ min: 0, max: 0.6, noNaN: true }),
        fc.double({ min: 0, max: 0.4, noNaN: true }),
        (seed, n, drop, dup) => {
          const rnd = mulberry(seed);
          const c = new Cluster(rnd);
          const peers = ["ana", "bao", "cyd", "dev", "eli"].slice(0, n);
          peers.forEach((p) => c.add(p));
          c.net.chaos = { latency: 50, jitter: 400, drop, dup };

          let t = 0;
          for (let i = 0; i < 120; i++) {
            t += 20 + rnd() * 60;
            const peer = peers[Math.floor(rnd() * n)];
            const r = c.replica(peer);
            const el = `e${Math.floor(rnd() * 4)}`;
            if (rnd() < 0.7) r.set(el, ["x", "y", "color", "kind"][Math.floor(rnd() * 4)], Math.floor(rnd() * 99));
            else r.editText(el, r.text(el) + "abc"[Math.floor(rnd() * 3)]);
            if (rnd() < 0.05) {
              const a = peers[Math.floor(rnd() * n)];
              const b = peers[Math.floor(rnd() * n)];
              if (a !== b) c.net.cut.add(linkKey(a, b));
            }
            if (rnd() < 0.03) c.net.cut.clear();
            c.tick(t);
          }

          // Heal and calm. Convergence must follow in bounded time.
          c.net.cut.clear();
          c.net.chaos = { latency: 50, jitter: 50, drop: 0, dup: 0 };
          for (let i = 0; i < 100 && !(c.converged() && c.net.inflight.length === 0); i++) {
            t += 100;
            c.tick(t);
          }
          expect(c.converged()).toBe(true);
        },
      ),
      { numRuns: 1500 },
    );
  });

  it("a peer that joins late catches up through gossip alone", () => {
    const c = new Cluster(mulberry(7));
    c.add("ana");
    c.add("bao");
    c.replica("ana").set("r", "kind", "rect");
    c.replica("bao").editText("r", "late joiners welcome");
    for (let t = 0; t <= 2000; t += 100) c.tick(t);
    c.add("cyd");
    for (let t = 2100; t <= 5000; t += 100) c.tick(t);
    expect(c.replica("cyd").text("r")).toBe("late joiners welcome");
    expect(c.converged()).toBe(true);
  });

  it("ops travel around a partition through a third peer", () => {
    const c = new Cluster(mulberry(3));
    ["ana", "bao", "cyd"].forEach((p) => c.add(p));
    c.net.cut.add(linkKey("ana", "cyd"));
    c.replica("ana").set("r", "x", 42);
    for (let t = 0; t <= 3000; t += 100) c.tick(t);
    expect(c.replica("cyd").get("r", "x")).toBe(42);
  });
});
