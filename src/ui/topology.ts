// The network map: peers on a ring, links between them, packets in flight.
// Drag across it to slice links (a partition); click a link to toggle it.

import type { Cluster } from "../sync/cluster";
import { linkKey } from "../net/sim";
import { MUTED, alpha, peerColor } from "./theme";

const SIZE = 300;

function segmentsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(ax, ay, bx, by, cx, cy) !== o(ax, ay, bx, by, dx, dy) && o(cx, cy, dx, dy, ax, ay) !== o(cx, cy, dx, dy, bx, by);
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

export class Topology {
  private ctx: CanvasRenderingContext2D;
  private knife: { x0: number; y0: number; x1: number; y1: number } | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private cluster: Cluster,
    private onChange: () => void,
  ) {
    this.ctx = canvas.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      const p = this.pt(e);
      this.knife = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!this.knife) return;
      const p = this.pt(e);
      this.knife.x1 = p.x;
      this.knife.y1 = p.y;
    });
    canvas.addEventListener("pointerup", () => this.release());
  }

  private pt(e: PointerEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * SIZE, y: ((e.clientY - r.top) / r.height) * SIZE };
  }

  private positions(): Map<string, { x: number; y: number }> {
    const peers = [...this.cluster.nodes.keys()];
    const out = new Map<string, { x: number; y: number }>();
    const R = peers.length === 2 ? 90 : 105;
    peers.forEach((p, i) => {
      const a = -Math.PI / 2 + (i / peers.length) * Math.PI * 2;
      out.set(p, { x: SIZE / 2 + R * Math.cos(a), y: SIZE / 2 + R * Math.sin(a) });
    });
    return out;
  }

  private links(): [string, string][] {
    const peers = [...this.cluster.nodes.keys()];
    const out: [string, string][] = [];
    for (let i = 0; i < peers.length; i++) for (let j = i + 1; j < peers.length; j++) out.push([peers[i], peers[j]]);
    return out;
  }

  private release(): void {
    const k = this.knife;
    this.knife = null;
    if (!k) return;
    const pos = this.positions();
    const cut = this.cluster.net.cut;
    const isClick = Math.hypot(k.x1 - k.x0, k.y1 - k.y0) < 5;
    for (const [a, b] of this.links()) {
      const pa = pos.get(a)!, pb = pos.get(b)!;
      const key = linkKey(a, b);
      if (isClick) {
        if (distToSegment(k.x0, k.y0, pa.x, pa.y, pb.x, pb.y) < 9) {
          if (cut.has(key)) cut.delete(key);
          else cut.add(key);
          break;
        }
      } else if (segmentsCross(k.x0, k.y0, k.x1, k.y1, pa.x, pa.y, pb.x, pb.y)) cut.add(key);
    }
    this.onChange();
  }

  render(now: number): void {
    const c = this.ctx;
    const pos = this.positions();
    const cut = this.cluster.net.cut;
    c.clearRect(0, 0, SIZE, SIZE);

    for (const [a, b] of this.links()) {
      const pa = pos.get(a)!, pb = pos.get(b)!;
      const isCut = cut.has(linkKey(a, b));
      c.save();
      c.lineWidth = isCut ? 1.5 : 2;
      c.strokeStyle = isCut ? "rgba(229, 72, 77, 0.55)" : "rgba(21, 23, 28, 0.16)";
      if (isCut) c.setLineDash([4, 5]);
      c.beginPath();
      c.moveTo(pa.x, pa.y);
      c.lineTo(pb.x, pb.y);
      c.stroke();
      c.restore();
      if (isCut) {
        const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
        c.strokeStyle = "#e5484d";
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(mx - 4, my - 4);
        c.lineTo(mx + 4, my + 4);
        c.moveTo(mx + 4, my - 4);
        c.lineTo(mx - 4, my + 4);
        c.stroke();
      }
    }

    const simNow = this.cluster.now;
    for (const p of this.cluster.net.inflight) {
      const pa = pos.get(p.from), pb = pos.get(p.to);
      if (!pa || !pb) continue;
      let t = (simNow - p.sent) / Math.max(1, p.arrive - p.sent);
      t = Math.max(0, Math.min(1, t));
      if (p.lost && t > 0.55) {
        // A lost packet fizzles out halfway.
        const k = Math.min(1, (t - 0.55) / 0.25);
        if (k >= 1) continue;
        const x = pa.x + (pb.x - pa.x) * 0.55, y = pa.y + (pb.y - pa.y) * 0.55;
        c.strokeStyle = alpha("#e5484d", 1 - k);
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(x, y, 3 + k * 7, 0, Math.PI * 2);
        c.stroke();
        continue;
      }
      const x = pa.x + (pb.x - pa.x) * t, y = pa.y + (pb.y - pa.y) * t;
      const isOps = p.msg.t === "ops";
      c.fillStyle = isOps ? peerColor(p.from) : alpha(MUTED, 0.55);
      c.beginPath();
      c.arc(x, y, isOps ? 4 + Math.min(3, p.msg.t === "ops" ? p.msg.ops.length / 6 : 0) : 2.5, 0, Math.PI * 2);
      c.fill();
    }

    for (const [peer, q] of pos) {
      const color = peerColor(peer);
      const pulse = (Math.sin(now / 400 + peer.length) + 1) / 2;
      c.fillStyle = alpha(color, 0.12 + pulse * 0.06);
      c.beginPath();
      c.arc(q.x, q.y, 24, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = color;
      c.beginPath();
      c.arc(q.x, q.y, 15, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "#fff";
      c.font = "600 11px 'JetBrains Mono', monospace";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(peer.slice(0, 3), q.x, q.y + 0.5);
    }

    const k = this.knife;
    if (k) {
      c.save();
      c.strokeStyle = "#e5484d";
      c.lineWidth = 2;
      c.setLineDash([6, 4]);
      c.beginPath();
      c.moveTo(k.x0, k.y0);
      c.lineTo(k.x1, k.y1);
      c.stroke();
      c.restore();
    }
  }
}
