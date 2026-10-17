// One peer's whiteboard: renders its replica and turns pointer input into
// CRDT writes. Every board is independent; nothing here knows about the
// network. Boards only ever read their own replica.

import type { Element, Replica } from "../crdt/replica";
import type { Value } from "../crdt/types";
import { CONFLICT, INK, alpha, tint } from "./theme";

export const W = 800;
export const H = 520;

export type Tool = "select" | "rect" | "ellipse" | "arrow" | "pen" | "sticky" | "erase";

export interface ToolState {
  tool: Tool;
  color: string;
}

interface UndoEntry {
  el: string;
  f: string;
  v: Value;
}

type Drag =
  | { kind: "move"; el: string; sx: number; sy: number; dx: number; dy: number }
  | { kind: "resize"; el: string; w: number; h: number; sx: number; sy: number; ow: number; oh: number }
  | { kind: "create"; tool: Tool; x0: number; y0: number; x1: number; y1: number }
  | { kind: "pen"; pts: number[] };

const num = (v: Value | undefined, d = 0): number => (typeof v === "number" ? v : d);

export class Board {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private editor: HTMLTextAreaElement;
  private editing: string | null = null;
  private selected: string | null = null;
  private drag: Drag | null = null;
  private flashes = new Map<string, number>();
  private undoStack: UndoEntry[][] = [];
  private seenVersion = -1;
  private needsDraw = true;
  private scale = 1;

  constructor(
    private wrap: HTMLElement,
    readonly replica: Replica,
    private accent: string,
    private tools: ToolState,
    private onActivate: (b: Board) => void,
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "board";
    this.canvas.setAttribute("aria-label", `${replica.peer}'s whiteboard`);
    this.ctx = this.canvas.getContext("2d")!;
    this.editor = document.createElement("textarea");
    this.editor.className = "sticky-editor";
    this.editor.spellcheck = false;
    wrap.append(this.canvas, this.editor);

    replica.on((e) => {
      if (e.type === "conflict") this.flashes.set(e.conflict.el, performance.now());
    });

    this.canvas.addEventListener("pointerdown", (e) => this.down(e));
    this.canvas.addEventListener("pointermove", (e) => this.move(e));
    this.canvas.addEventListener("pointerup", (e) => this.up(e));
    this.canvas.addEventListener("pointercancel", () => (this.drag = null));
    this.canvas.addEventListener("dblclick", (e) => {
      const p = this.toBoard(e);
      const hit = this.hit(p.x, p.y);
      if (hit?.kind === "sticky") this.openEditor(hit.id);
    });
    this.editor.addEventListener("input", () => {
      if (this.editing) this.replica.editText(this.editing, this.editor.value);
    });
    this.editor.addEventListener("blur", () => this.closeEditor());
    this.editor.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.editor.blur();
    });

    new ResizeObserver(() => this.resize()).observe(wrap);
    this.resize();
  }

  // ------------------------------------------------------------ geometry

  private resize(): void {
    const w = this.wrap.clientWidth;
    if (w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.scale = w / W;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round((w * H * dpr) / W);
    this.canvas.style.height = `${(w * H) / W}px`;
    this.ctx.setTransform(this.scale * dpr, 0, 0, this.scale * dpr, 0, 0);
    this.placeEditor();
    this.needsDraw = true;
  }

  private toBoard(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  }

  private box(el: Element): { x: number; y: number; w: number; h: number } {
    const f = el.fields;
    let x = num(f.x),
      y = num(f.y),
      w = num(f.w, 1),
      h = num(f.h, 1);
    if (w < 0) (x += w), (w = -w);
    if (h < 0) (y += h), (h = -h);
    return { x, y, w, h };
  }

  private hit(px: number, py: number): Element | null {
    const els = this.replica.elements();
    for (let i = els.length - 1; i >= 0; i--) {
      const b = this.box(els[i]);
      const pad = 8;
      if (px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad) return els[i];
    }
    return null;
  }

  private handleAt(px: number, py: number): Element | null {
    if (!this.selected) return null;
    const el = this.replica.elements().find((e) => e.id === this.selected);
    if (!el || el.kind === "stroke") return null;
    const hx = num(el.fields.x) + num(el.fields.w),
      hy = num(el.fields.y) + num(el.fields.h);
    return Math.hypot(px - hx, py - hy) < 12 ? el : null;
  }

  // --------------------------------------------------------------- input

  private down(e: PointerEvent): void {
    this.onActivate(this);
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.toBoard(e);
    const tool = this.tools.tool;

    if (tool === "select") {
      const handle = this.handleAt(p.x, p.y);
      if (handle) {
        const w = num(handle.fields.w),
          h = num(handle.fields.h);
        this.drag = { kind: "resize", el: handle.id, w, h, ow: w, oh: h, sx: p.x, sy: p.y };
        return;
      }
      const hit = this.hit(p.x, p.y);
      this.selected = hit?.id ?? null;
      if (hit) this.drag = { kind: "move", el: hit.id, sx: p.x, sy: p.y, dx: 0, dy: 0 };
    } else if (tool === "erase") {
      const hit = this.hit(p.x, p.y);
      if (hit) this.remove(hit.id);
    } else if (tool === "pen") {
      this.drag = { kind: "pen", pts: [p.x, p.y] };
    } else {
      this.drag = { kind: "create", tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    }
    this.needsDraw = true;
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d) {
      if (this.tools.tool === "select") {
        const p = this.toBoard(e);
        this.canvas.style.cursor = this.handleAt(p.x, p.y)
          ? "nwse-resize"
          : this.hit(p.x, p.y)
            ? "move"
            : "default";
      } else this.canvas.style.cursor = this.tools.tool === "erase" ? "pointer" : "crosshair";
      return;
    }
    const p = this.toBoard(e);
    if (d.kind === "move") (d.dx = p.x - d.sx), (d.dy = p.y - d.sy);
    else if (d.kind === "resize") (d.w = d.ow + p.x - d.sx), (d.h = d.oh + p.y - d.sy);
    else if (d.kind === "create") (d.x1 = p.x), (d.y1 = p.y);
    else {
      const n = d.pts.length;
      if (Math.hypot(p.x - d.pts[n - 2], p.y - d.pts[n - 1]) > 2.5) d.pts.push(p.x, p.y);
    }
    this.needsDraw = true;
  }

  private up(_e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const r = this.replica;

    if (d.kind === "move") {
      if (Math.abs(d.dx) < 1 && Math.abs(d.dy) < 1) return;
      const x = num(r.get(d.el, "x")),
        y = num(r.get(d.el, "y"));
      const z = r.get(d.el, "z") ?? null;
      this.write(d.el, { x: Math.round(x + d.dx), y: Math.round(y + d.dy), z: r.topZ() }, { x, y, z });
    } else if (d.kind === "resize") {
      const kind = r.get(d.el, "kind");
      const min = kind === "arrow" ? -Infinity : 16;
      this.write(
        d.el,
        { w: Math.round(Math.max(min, d.w)), h: Math.round(Math.max(min, d.h)) },
        { w: d.ow, h: d.oh },
      );
    } else if (d.kind === "pen") {
      if (d.pts.length < 4) return;
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (let i = 0; i < d.pts.length; i += 2) {
        minX = Math.min(minX, d.pts[i]);
        maxX = Math.max(maxX, d.pts[i]);
        minY = Math.min(minY, d.pts[i + 1]);
        maxY = Math.max(maxY, d.pts[i + 1]);
      }
      const rel = d.pts.map((v, i) => Math.round(v - (i % 2 === 0 ? minX : minY)));
      this.create("stroke", {
        x: Math.round(minX),
        y: Math.round(minY),
        w: Math.round(maxX - minX),
        h: Math.round(maxY - minY),
        points: rel,
      });
    } else {
      const g = this.createGeometry(d);
      const id = this.create(d.tool, g);
      if (d.tool === "sticky") {
        this.selected = id;
        this.openEditor(id);
      }
    }
    this.needsDraw = true;
  }

  private createGeometry(d: Extract<Drag, { kind: "create" }>): Record<string, number> {
    let w = d.x1 - d.x0,
      h = d.y1 - d.y0;
    const tiny = Math.abs(w) < 6 && Math.abs(h) < 6;
    if (d.tool === "arrow") {
      if (tiny) (w = 120), (h = 0);
      return { x: Math.round(d.x0), y: Math.round(d.y0), w: Math.round(w), h: Math.round(h) };
    }
    if (tiny) {
      const s = d.tool === "sticky" ? 150 : 110;
      return { x: Math.round(d.x0 - s / 2), y: Math.round(d.y0 - s / 2.6), w: s, h: d.tool === "sticky" ? 130 : 80 };
    }
    return {
      x: Math.round(Math.min(d.x0, d.x1)),
      y: Math.round(Math.min(d.y0, d.y1)),
      w: Math.round(Math.abs(w)),
      h: Math.round(Math.abs(h)),
    };
  }

  // ------------------------------------------------------------- actions

  /** Write several fields and record their old values as one undo step. */
  private write(el: string, next: Record<string, Value>, old: Record<string, Value | undefined>): void {
    const entry: UndoEntry[] = [];
    for (const f in next) {
      entry.push({ el, f, v: old[f] ?? null });
      this.replica.set(el, f, next[f]);
    }
    this.undoStack.push(entry);
  }

  create(kind: string, fields: Record<string, Value>, color = this.tools.color): string {
    const r = this.replica;
    const id = r.newElementId();
    r.set(id, "kind", kind);
    for (const f in fields) r.set(id, f, fields[f]);
    r.set(id, "color", color);
    r.set(id, "z", r.topZ());
    this.undoStack.push([{ el: id, f: "deleted", v: true }]);
    return id;
  }

  remove(el: string): void {
    this.write(el, { deleted: true }, { deleted: false });
    if (this.selected === el) this.selected = null;
  }

  deleteSelected(): void {
    if (this.selected) this.remove(this.selected);
  }

  recolorSelected(color: string): boolean {
    if (!this.selected) return false;
    this.write(this.selected, { color }, { color: this.replica.get(this.selected, "color") });
    return true;
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    for (const { el, f, v } of entry) this.replica.set(el, f, v);
  }

  deselect(): void {
    this.selected = null;
    this.needsDraw = true;
  }

  // ------------------------------------------------------- sticky editor

  private openEditor(id: string): void {
    this.editing = id;
    this.editor.value = this.replica.text(id);
    this.editor.style.display = "block";
    this.placeEditor();
    // Focus now so fast typists don't lose keys, and again next frame in
    // case the pointer sequence that opened us steals focus back.
    this.editor.focus();
    requestAnimationFrame(() => this.editor.focus());
  }

  private closeEditor(): void {
    this.editing = null;
    this.editor.style.display = "none";
    this.needsDraw = true;
  }

  private placeEditor(): void {
    if (!this.editing) return;
    const r = this.replica;
    const s = this.scale;
    const x = num(r.get(this.editing, "x")),
      y = num(r.get(this.editing, "y"));
    Object.assign(this.editor.style, {
      left: `${(x + 10) * s}px`,
      top: `${(y + 10) * s}px`,
      width: `${(num(r.get(this.editing, "w")) - 20) * s}px`,
      height: `${(num(r.get(this.editing, "h")) - 20) * s}px`,
      fontSize: `${15 * s}px`,
      lineHeight: `${20 * s}px`,
    });
  }

  private syncEditor(): void {
    if (!this.editing) return;
    const r = this.replica;
    if (r.get(this.editing, "deleted") === true) return this.editor.blur();
    const t = r.text(this.editing);
    if (t !== this.editor.value) {
      // Someone else typed here. Keep the caret the same distance from the end.
      const fromEnd = this.editor.value.length - this.editor.selectionStart;
      this.editor.value = t;
      const pos = Math.max(0, t.length - fromEnd);
      this.editor.setSelectionRange(pos, pos);
    }
    this.placeEditor();
  }

  // -------------------------------------------------------------- render

  render(now: number): void {
    const v = this.replica.stateVersion;
    const flashing = this.flashes.size > 0;
    if (v === this.seenVersion && !this.needsDraw && !flashing && !this.drag) return;
    if (v !== this.seenVersion) this.syncEditor();
    this.seenVersion = v;
    this.needsDraw = false;

    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    c.fillStyle = "#fffefb";
    c.fillRect(0, 0, W, H);
    c.fillStyle = "rgba(21, 23, 28, 0.13)";
    for (let x = 20; x < W; x += 20) for (let y = 20; y < H; y += 20) c.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);

    const els = this.replica.elements();
    if (this.selected && !els.some((e) => e.id === this.selected)) this.selected = null;

    for (const el of els) {
      const shown = this.withDrag(el);
      this.drawElement(shown, el.id === this.editing);
      const t0 = this.flashes.get(el.id);
      if (t0 !== undefined) {
        const k = (now - t0) / 900;
        if (k >= 1) this.flashes.delete(el.id);
        else this.drawFlash(shown, k);
      }
      if (el.id === this.selected) this.drawSelection(shown);
    }
    for (const id of this.flashes.keys()) if (!els.some((e) => e.id === id)) this.flashes.delete(id);

    const d = this.drag;
    if (d?.kind === "create") {
      const g = this.createGeometry(d);
      c.globalAlpha = 0.6;
      this.drawElement({ id: "", kind: d.tool, fields: { ...g, color: this.tools.color } }, false);
      c.globalAlpha = 1;
    } else if (d?.kind === "pen") {
      c.strokeStyle = this.tools.color;
      c.lineWidth = 3;
      c.lineCap = c.lineJoin = "round";
      c.beginPath();
      for (let i = 0; i < d.pts.length; i += 2) c.lineTo(d.pts[i], d.pts[i + 1]);
      c.stroke();
    }
  }

  private withDrag(el: Element): Element {
    const d = this.drag;
    if (!d) return el;
    if (d.kind === "move" && d.el === el.id)
      return { ...el, fields: { ...el.fields, x: num(el.fields.x) + d.dx, y: num(el.fields.y) + d.dy } };
    if (d.kind === "resize" && d.el === el.id) return { ...el, fields: { ...el.fields, w: d.w, h: d.h } };
    return el;
  }

  private drawElement(el: Element, editing: boolean): void {
    const c = this.ctx;
    const f = el.fields;
    const color = typeof f.color === "string" ? f.color : INK;
    const x = num(f.x),
      y = num(f.y),
      w = num(f.w),
      h = num(f.h);
    c.lineWidth = 2.5;
    c.lineCap = c.lineJoin = "round";
    c.strokeStyle = color;

    switch (el.kind) {
      case "rect": {
        const b = this.box(el);
        c.fillStyle = alpha(color, 0.1);
        c.beginPath();
        c.roundRect(b.x, b.y, b.w, b.h, 6);
        c.fill();
        c.stroke();
        break;
      }
      case "ellipse": {
        const b = this.box(el);
        c.fillStyle = alpha(color, 0.1);
        c.beginPath();
        c.ellipse(b.x + b.w / 2, b.y + b.h / 2, Math.max(1, b.w / 2), Math.max(1, b.h / 2), 0, 0, Math.PI * 2);
        c.fill();
        c.stroke();
        break;
      }
      case "arrow": {
        const x2 = x + w,
          y2 = y + h;
        const a = Math.atan2(h, w);
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x2, y2);
        c.moveTo(x2 - 14 * Math.cos(a - 0.45), y2 - 14 * Math.sin(a - 0.45));
        c.lineTo(x2, y2);
        c.lineTo(x2 - 14 * Math.cos(a + 0.45), y2 - 14 * Math.sin(a + 0.45));
        c.stroke();
        break;
      }
      case "stroke": {
        const pts = Array.isArray(f.points) ? f.points : [];
        c.lineWidth = 3;
        c.beginPath();
        for (let i = 0; i < pts.length; i += 2) c.lineTo(x + pts[i], y + pts[i + 1]);
        c.stroke();
        break;
      }
      case "sticky": {
        const b = this.box(el);
        c.save();
        c.shadowColor = "rgba(21, 23, 28, 0.16)";
        c.shadowBlur = 10;
        c.shadowOffsetY = 3;
        c.fillStyle = tint(color, 0.78);
        c.fillRect(b.x, b.y, b.w, b.h);
        c.restore();
        c.fillStyle = color;
        c.fillRect(b.x, b.y, b.w, 4);
        if (!editing) this.drawText(this.replica.text(el.id), b.x + 10, b.y + 10, b.w - 20, b.h - 20);
        break;
      }
    }
  }

  private drawText(text: string, x: number, y: number, w: number, h: number): void {
    const c = this.ctx;
    c.fillStyle = INK;
    c.font = "15px 'Space Grotesk', system-ui, sans-serif";
    c.textBaseline = "top";
    const lines: string[] = [];
    for (const para of text.split("\n")) {
      let line = "";
      for (const word of para.split(/(\s+)/)) {
        if (c.measureText(line + word).width > w && line.trim()) {
          lines.push(line);
          line = word.trimStart();
        } else line += word;
      }
      lines.push(line);
    }
    const max = Math.max(1, Math.floor(h / 20));
    lines.slice(0, max).forEach((l, i) => c.fillText(l, x, y + i * 20 + 1));
  }

  private drawSelection(el: Element): void {
    const c = this.ctx;
    const b = this.box(el);
    c.save();
    c.setLineDash([5, 4]);
    c.strokeStyle = this.accent;
    c.lineWidth = 1.5;
    c.strokeRect(b.x - 6, b.y - 6, b.w + 12, b.h + 12);
    c.restore();
    if (el.kind !== "stroke") {
      const hx = num(el.fields.x) + num(el.fields.w),
        hy = num(el.fields.y) + num(el.fields.h);
      c.fillStyle = "#fff";
      c.strokeStyle = this.accent;
      c.lineWidth = 2;
      c.beginPath();
      c.arc(hx, hy, 5.5, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }
  }

  private drawFlash(el: Element, k: number): void {
    const c = this.ctx;
    const b = this.box(el);
    const grow = 6 + k * 14;
    c.save();
    c.strokeStyle = alpha(CONFLICT, (1 - k) * 0.95);
    c.lineWidth = 4 * (1 - k) + 1;
    c.beginPath();
    c.roundRect(b.x - grow, b.y - grow, b.w + grow * 2, b.h + grow * 2, 10);
    c.stroke();
    c.restore();
  }
}
