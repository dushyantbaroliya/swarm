// Real peer-to-peer transport over WebRTC data channels.
//
// No signaling server: the offer and answer are packed into copy-pasteable
// codes (SDP, deflated, base64url). We wait for ICE gathering to finish
// before producing a code, so one round trip of codes is all it takes.
// A public STUN server helps peers discover their public address; it never
// sees whiteboard data.

import type { PeerId } from "../crdt/types";
import type { Msg, Transport } from "../sync/node";

const ICE: RTCConfiguration = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
const PREFIX = "SW1.";

type Wire = { t: "hello"; id: PeerId } | { t: "msg"; msg: Msg };

async function pack(desc: RTCSessionDescriptionInit): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ t: desc.type, s: desc.sdp }));
  let out = bytes;
  if (typeof CompressionStream !== "undefined") {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    out = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  let bin = "";
  out.forEach((b) => (bin += String.fromCharCode(b)));
  return PREFIX + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function unpack(code: string): Promise<RTCSessionDescriptionInit> {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error("That doesn't look like a Swarm code.");
  const b64 = trimmed.slice(PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  let bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (typeof DecompressionStream !== "undefined") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { t, s } = JSON.parse(new TextDecoder().decode(bytes));
  return { type: t, sdp: s };
}

function iceDone(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && finish();
    pc.addEventListener("icegatheringstatechange", check);
    // Some networks never report "complete"; what we have after 4s is usually enough.
    setTimeout(finish, 4000);
  });
}

export class RtcMesh implements Transport {
  private channels = new Map<PeerId, RTCDataChannel>();
  private pendingHost: RTCPeerConnection | null = null;

  constructor(
    private self: PeerId,
    private onMessage: (from: PeerId, msg: Msg) => void,
    private onPeersChanged: (peers: PeerId[]) => void,
  ) {}

  neighbours(): PeerId[] {
    return [...this.channels.keys()];
  }

  send(to: PeerId, msg: Msg): void {
    const ch = this.channels.get(to);
    if (ch?.readyState === "open") ch.send(JSON.stringify({ t: "msg", msg } satisfies Wire));
  }

  /** Host side, step 1: returns an invite code. */
  async createInvite(): Promise<string> {
    const pc = new RTCPeerConnection(ICE);
    this.pendingHost = pc;
    this.wire(pc.createDataChannel("swarm"));
    await pc.setLocalDescription(await pc.createOffer());
    await iceDone(pc);
    return pack(pc.localDescription!);
  }

  /** Host side, step 2: accept the guest's reply code. */
  async acceptReply(code: string): Promise<void> {
    if (!this.pendingHost) throw new Error("Create an invite first.");
    await this.pendingHost.setRemoteDescription(await unpack(code));
    this.pendingHost = null;
  }

  /** Guest side: turn an invite code into a reply code. */
  async join(code: string): Promise<string> {
    const pc = new RTCPeerConnection(ICE);
    pc.addEventListener("datachannel", (e) => this.wire(e.channel));
    await pc.setRemoteDescription(await unpack(code));
    await pc.setLocalDescription(await pc.createAnswer());
    await iceDone(pc);
    return pack(pc.localDescription!);
  }

  private wire(ch: RTCDataChannel): void {
    let remote: PeerId | null = null;
    ch.addEventListener("open", () => ch.send(JSON.stringify({ t: "hello", id: this.self } satisfies Wire)));
    ch.addEventListener("message", (e) => {
      const w = JSON.parse(e.data) as Wire;
      if (w.t === "hello") {
        remote = w.id;
        this.channels.set(remote, ch);
        this.onPeersChanged(this.neighbours());
      } else if (remote) this.onMessage(remote, w.msg);
    });
    ch.addEventListener("close", () => {
      if (remote && this.channels.get(remote) === ch) {
        this.channels.delete(remote);
        this.onPeersChanged(this.neighbours());
      }
    });
  }
}
