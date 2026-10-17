import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Replica, type Conflict } from "../src/crdt/replica";
import { keyBetween } from "../src/crdt/fractional";

function exchange(a: Replica, b: Replica): void {
  for (const op of a.missingFor(b.versionVector())) b.receive(op);
  for (const op of b.missingFor(a.versionVector())) a.receive(op);
}

describe("last-writer-wins registers", () => {
  it("higher stamp wins, ties broken by peer id", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    a.set("r", "color", "red");
    b.set("r", "color", "blue"); // same lamport (1); "b" > "a"
    exchange(a, b);
    expect(a.get("r", "color")).toBe("blue");
    expect(b.get("r", "color")).toBe("blue");
  });

  it("a write that has seen the previous one always wins", () => {
    const a = new Replica("z");
    const b = new Replica("a");
    a.set("r", "x", 1);
    exchange(a, b);
    b.set("r", "x", 2); // lamport 2 beats peer-id tiebreak
    exchange(a, b);
    expect(a.get("r", "x")).toBe(2);
  });

  it("concurrent edits to different fields both survive", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    a.set("r", "kind", "rect");
    exchange(a, b);
    a.set("r", "x", 100);
    b.set("r", "color", "teal");
    exchange(a, b);
    for (const r of [a, b]) {
      expect(r.get("r", "x")).toBe(100);
      expect(r.get("r", "color")).toBe("teal");
    }
  });

  it("delete is a field, so undoing it is just another write", () => {
    const a = new Replica("a");
    a.set("r", "kind", "rect");
    a.set("r", "deleted", true);
    expect(a.elements()).toHaveLength(0);
    a.set("r", "deleted", false);
    expect(a.elements()).toHaveLength(1);
  });

  it("reports concurrent writes as conflicts, but not sequential ones", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    const seen: Conflict[] = [];
    a.on((e) => e.type === "conflict" && seen.push(e.conflict));
    b.on((e) => e.type === "conflict" && seen.push(e.conflict));

    a.set("r", "x", 1);
    exchange(a, b);
    b.set("r", "x", 2); // b saw a's write: sequential
    exchange(a, b);
    expect(seen).toHaveLength(0);

    a.set("r", "x", 3);
    b.set("r", "x", 4); // neither saw the other: concurrent
    exchange(a, b);
    expect(seen).toHaveLength(2);
    expect(seen.every((c) => c.winner === "b" && c.loser === "a")).toBe(true);
  });
});

describe("RGA text", () => {
  it("concurrent inserts at the same spot never interleave characters", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    a.editText("n", "hi");
    exchange(a, b);
    a.editText("n", "hi ana");
    b.editText("n", "hi bao");
    exchange(a, b);
    const t = a.text("n");
    expect(b.text("n")).toBe(t);
    expect([" ana bao", " bao ana"].map((s) => "hi" + s)).toContain(t);
  });

  it("insert anchored on a concurrently deleted char still lands", () => {
    const a = new Replica("a");
    const b = new Replica("b");
    a.editText("n", "abc");
    exchange(a, b);
    a.editText("n", "ac"); // delete b
    b.editText("n", "abXc"); // insert after b
    exchange(a, b);
    expect(a.text("n")).toBe("aXc");
    expect(b.text("n")).toBe("aXc");
  });

  it("inserts that arrive before their anchor are buffered", () => {
    const a = new Replica("a");
    a.editText("n", "hello");
    const ops = a.missingFor({});
    const b = new Replica("b");
    for (const op of [...ops].reverse()) b.receive(op);
    expect(b.text("n")).toBe("hello");
  });
});

describe("fractional z-order", () => {
  it("keys always sort strictly between their neighbours", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 200 }), (picks) => {
        const keys: string[] = [];
        for (const p of picks) {
          const i = Math.floor(p * (keys.length + 1)) % (keys.length + 1);
          const k = keyBetween(i > 0 ? keys[i - 1] : "", i < keys.length ? keys[i] : null);
          if (i > 0) expect(k > keys[i - 1]).toBe(true);
          if (i < keys.length) expect(k < keys[i]).toBe(true);
          expect(k.endsWith("0")).toBe(false);
          keys.splice(i, 0, k);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
