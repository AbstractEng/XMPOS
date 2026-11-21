import type { Project } from "./index.ts";
import { musicalSeconds } from "./mix.ts";
export interface VirtualPort {
  kind: "virtual";
  id: string;
  generation: number;
  connected: boolean;
}
export interface MidiPacket {
  frame: number;
  bytes: number[];
}
// No OS MIDI API exists here. This fixture cannot enumerate or open a physical port.
export class VirtualMidiRoute {
  private input?: VirtualPort;
  private output?: VirtualPort;
  private identity = "";
  private held = new Map<string, [number, number]>();
  readonly capture: MidiPacket[] = [];
  valid = false;
  select(input: VirtualPort, output: VirtualPort) {
    for (const p of [input, output])
      if (
        p.kind !== "virtual" ||
        !/^fixture-[a-z0-9_-]{1,64}$/.test(p.id) ||
        !Number.isSafeInteger(p.generation) ||
        p.generation < 0 ||
        !p.connected
      )
        throw new Error("Only explicit virtual fixtures are available");
    if (this.held.size) throw new Error("Stop notes before replacing the route");
    this.input = input;
    this.output = output;
    this.identity = `${input.id}:${input.generation}/${output.id}:${output.generation}`;
    this.valid = true;
  }
  revalidate(ports: VirtualPort[]) {
    this.valid =
      this.valid &&
      [this.input, this.output].every(
        (p) => p?.connected && ports.some((candidate) => candidate === p && candidate.connected),
      ) &&
      this.identity ===
        `${this.input?.id}:${this.input?.generation}/${this.output?.id}:${this.output?.generation}`;
    if (!this.valid) this.held.clear();
    return this.valid;
  }
  send(packet: MidiPacket) {
    if (
      !this.valid ||
      !this.input?.connected ||
      !this.output?.connected ||
      this.identity !==
        `${this.input.id}:${this.input.generation}/${this.output.id}:${this.output.generation}`
    ) {
      this.valid = false;
      this.held.clear();
      return false;
    }
    const { frame, bytes } = packet,
      status = bytes[0] ?? 0;
    if (
      !Number.isSafeInteger(frame) ||
      frame < 0 ||
      bytes.length < 1 ||
      bytes.length > 3 ||
      bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255) ||
      !(
        ([0xf8, 0xfa, 0xfc].includes(status) && bytes.length === 1) ||
        ([0x80, 0x90, 0xb0].includes(status & 0xf0) &&
          bytes.length === 3 &&
          bytes.slice(1).every((b) => b < 128))
      )
    )
      throw new Error("Unsupported virtual MIDI packet");
    if (this.capture.length >= 65536) {
      this.valid = false;
      this.held.clear();
      throw new Error("MIDI fixture budget exceeded");
    }
    const key = `${status & 15}:${bytes[1]}`;
    if ((status & 0xf0) === 0x90 && (bytes[2] ?? 0) > 0)
      this.held.set(key, [status & 15, bytes[1] ?? 0]);
    if ((status & 0xf0) === 0x80 || ((status & 0xf0) === 0x90 && bytes[2] === 0))
      this.held.delete(key);
    this.capture.push({ frame, bytes: [...bytes] });
    return true;
  }
  stop(frame: number) {
    for (const [channel, note] of this.held.values())
      this.send({ frame, bytes: [0x80 | channel, note, 0] });
    this.held.clear();
    this.send({ frame, bytes: [0xfc] });
  }
  get activeNotes() {
    return this.held.size;
  }
}
export function virtualClock(project: Project, steps: number, route: VirtualMidiRoute) {
  if (!Number.isInteger(steps) || steps < 1 || steps > 1024)
    throw new Error("Invalid clock budget");
  route.send({ frame: 0, bytes: [0xfa] });
  for (let pulse = 0; pulse < steps * 6; pulse++)
    route.send({ frame: Math.round(musicalSeconds(project, pulse / 6) * 48000), bytes: [0xf8] });
  route.stop(Math.round(musicalSeconds(project, steps) * 48000));
  return route.capture;
}
