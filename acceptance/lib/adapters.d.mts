import type { Project } from "../../packages/core/src/index.ts";
export type Capability =
  | "offline-render"
  | "project-persistence"
  | "simulated-pads"
  | "os-boot"
  | "physical-pad-sensor"
  | "usb-session";
export type Profile = "desktop" | "native" | "os-vm" | "usb-lab";
export interface TargetIdentity {
  readonly profile: Profile;
  readonly synthetic: boolean;
  readonly capabilities: readonly Capability[];
  readonly interfaceVersion: 1;
}
export interface RenderFixture {
  readonly sampleRate: 48000;
  readonly frames: number;
  readonly eventFrame: number;
  readonly pcm: readonly number[];
}
export interface OwnedWorkspace {
  readonly directory: string;
  path(name: string): string;
  close(): void;
}
export interface Adapter {
  readonly identity: TargetIdentity;
  readonly render?: (fixture: RenderFixture) => Buffer;
  readonly saveProject?: (project: Project) => void;
  readonly loadProject?: () => Project;
}
export class UnsupportedTarget extends Error {
  readonly outcome: "unsupported";
  readonly profile: string;
  readonly missing: readonly string[];
}
export function preflightAdapter(profile: Profile, required: readonly Capability[]): TargetIdentity;
export function openAdapter(
  profile: Profile,
  required: readonly Capability[],
  workspace: OwnedWorkspace,
): Readonly<Adapter>;
export function fixtureAdapter(
  profile: Profile,
  workspace: OwnedWorkspace,
  options: { synthetic: true },
): Readonly<Adapter>;
