# Swarm

**A peer-to-peer whiteboard built on a hand-written CRDT, with a network you can break.**

Swarm runs several replicas of a whiteboard side by side, each with its own copy of the state, talking only
through a simulated network. Turn up the latency, drop packets, duplicate them, or drag a knife across the
network map to cut links. The replicas drift apart, and then they always converge again.

Then switch to **Live P2P** and sync a real board between two browsers over WebRTC, with no server.

No CRDT libraries (no Yjs, no Automerge), no backend, no framework. Vanilla TypeScript and Canvas.

## What's inside

| Piece | How it works |
|---|---|
| Clocks | Lamport timestamps plus peer id give every edit one total order that all replicas agree on |
| Shapes | Each field of each element is its own last-writer-wins register, so a move and a recolour of the same shape both survive |
| Deletes | Not an op at all: `deleted: true` is just another field, so undo-of-delete is a plain write |
| Text | Sticky notes use RGA, a sequence CRDT. Concurrent typing at the same spot never interleaves letters |
| Z-order | Fractional indexing, so "bring to front" never renumbers anything or conflicts |
| Conflicts | Each write carries the stamp it overwrote; a receiver holding something newer knows the writes were concurrent and flashes the shape |
| Sync | Ops are pushed immediately, and peers also gossip version vectors. Anyone holding ops you lack sends them, so partitions heal through indirect paths |
| Live mode | WebRTC data channels. Offer and answer are deflated into copy-paste codes, so there's no signaling server |

## The lab

- **Chaos sliders**: latency, jitter (which reorders packets), packet loss, duplication, gossip interval
- **Network map**: packets fly between peers in real time; lost ones fizzle mid-link. Drag across it to slice links, click a link to toggle it
- **Split / Heal / Freeze**: partition the cluster in half, restore it, or stop time so every edit you make is concurrent
- **Race!**: every peer edits the same shape in the same instant. Guaranteed conflicts, guaranteed agreement
- **Chaos monkey**: random edits on every replica
- **Divergence meter**: a hash of each replica's state. One colour means converged
- **Op log**: every local op, coalesced, with conflicts highlighted

## Proof

```
npm test
```

15 tests, including **10,000 randomized property-based runs** (fast-check):

- Random edit histories across four peers, with partial syncs in between, then every op delivered to
  everyone in a random order with duplicates. All snapshots must be byte-identical.
- The same op set delivered in two different orders must produce the same state.
- The full simulated network with up to 60% loss, heavy jitter, duplicates and random partitions. After it
  heals, every replica must converge within bounded time.

The property tests earned their keep on the first run by catching a real divergence (a no-op text edit
leaving a phantom entry on one replica).

## Run it

```
npm install
npm run dev      # http://localhost:5193
npm run build    # static site in dist/, works under any sub-path
```

## Layout

```
src/crdt/      types, Replica (LWW map + op log), RGA text, fractional z-index
src/sync/      SyncNode (push + anti-entropy, transport-agnostic), Cluster
src/net/       SimNetwork (chaos + partitions), RtcMesh (WebRTC)
src/ui/        Board (canvas + input), Topology (network map), theme
test/          convergence, CRDT unit, and network property tests
```

## License

MIT
