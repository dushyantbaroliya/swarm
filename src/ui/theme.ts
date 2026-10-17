// Shared palette. Peer colours identify replicas everywhere (cards,
// topology, packets, selection); shape colours are what you draw with.

export const PEER_NAMES = ["ana", "bao", "cyd", "dev", "eli"] as const;

export const PEER_COLORS: Record<string, string> = {
  ana: "#e5484d",
  bao: "#12a594",
  cyd: "#3e63dd",
  dev: "#e28a00",
  eli: "#8e4ec6",
};

export const SHAPE_COLORS = ["#1f2430", "#e5484d", "#e28a00", "#12a594", "#3e63dd", "#8e4ec6"];

export const INK = "#15171c";
export const MUTED = "#6b7080";
export const CONFLICT = "#f5a524";

export function peerColor(peer: string): string {
  const base = peer.replace(/\d+$/, "");
  return PEER_COLORS[base] ?? "#6b7080";
}

export function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Mix a colour toward white; t=1 is pure white. */
export function tint(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * t);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}
