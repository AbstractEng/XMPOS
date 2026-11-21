const common = {
  import: ["acceptance/steps/*.steps.mjs"],
  parallel: 0,
  formatOptions: { snippets: false },
};
export default {
  ...common,
  paths: ["features/00-current-contracts.feature"],
  tags: "@implemented and @standalone",
};
export const foundation = {
  ...common,
  paths: ["features/01-foundation.feature", "features/02-test-harness.feature"],
};
export const planned = {
  ...common,
  paths: ["features/**/*.feature"],
  tags: "@planned and @host_only and not @usb_lab and not @hardware_only and not @fault_injection and not @update_authorization",
};

export const projects = { ...common, paths: ["features/03-projects.feature"] };

export const implemented = {
  ...common,
  paths: [
    "features/00-current-contracts.feature",
    "features/01-foundation.feature",
    "features/02-test-harness.feature",
    "features/03-projects.feature",
    "features/04-audio-engine.feature",
    "features/04-engine-development.feature",
    "features/05-instruments.feature",
    "features/06-sequencer.feature",
    "features/07-performance.feature",
    "features/08-mix-midi-export.feature",
    "features/09-sdk.feature",
    "features/11-usb-hardware.feature",
    "features/12-release.feature",
    "features/13-instrument-design.feature",
    "features/14-acoustic-audio.feature",
    "features/17-drum-kits.feature",
    "features/18-device-workflow.feature",
    "features/28-live-editing.feature",
    "features/19-supported-sdk.feature",
  ],
  tags: "@implemented and not @acoustic_mac and not @manual_layout and not @p12_vm and not @sdk_vm",
};

export const engine = {
  ...common,
  paths: ["features/04-audio-engine.feature", "features/04-engine-development.feature"],
  tags: "@implemented and not @physical_measurement and not @stage_gate",
};

export const design = {
  ...common,
  paths: ["features/13-instrument-design.feature"],
  tags: "@implemented",
};

export const acoustic = {
  ...common,
  paths: ["features/14-acoustic-audio.feature"],
  tags: "@implemented and not @acoustic_mac",
};
// Physical Mac capture has its own bindings; host-only hooks and profiles cannot run it.
export const acousticMac = {
  import: ["acceptance/acoustic/mac.steps.mjs"],
  parallel: 0,
  paths: ["features/14-acoustic-audio.feature"],
  tags: "@acoustic_mac",
  formatOptions: { snippets: false },
};

export const instruments = {
  ...common,
  paths: ["features/05-instruments.feature"],
  tags: "@implemented",
};

export const p05MacRecording = {
  import: ["acceptance/recording/mac.steps.mjs"],
  paths: ["features/15-p05-mac-recording.feature"],
  tags: "@p05_mac_recording",
  parallel: 0,
  formatOptions: { snippets: false },
};

export const sequencer = {
  ...common,
  paths: ["features/06-sequencer.feature"],
  tags: "@implemented",
};

export const performance = {
  ...common,
  paths: ["features/07-performance.feature"],
  tags: "@implemented and not @manual_layout",
};
export const performanceLayout = {
  ...common,
  paths: ["features/07-performance.feature"],
  tags: "@manual_layout",
};

export const mix = {
  ...common,
  paths: ["features/08-mix-midi-export.feature"],
  tags: "@implemented",
};

export const sdk = { ...common, paths: ["features/09-sdk.feature"], tags: "@implemented" };

export const osVm = {
  import: ["acceptance/os/vm.steps.mjs"],
  paths: ["features/10-standalone-os.feature"],
  tags: "@implemented",
  parallel: 0,
  formatOptions: { snippets: false },
};

export const hardwareDevelopment = {
  ...common,
  paths: ["features/11-usb-hardware.feature"],
  tags: "@implemented and @host_only",
};

export const releaseDevelopment = {
  ...common,
  paths: ["features/12-release.feature"],
  tags: "@implemented and @host_only",
};
export const releaseVm = {
  import: ["acceptance/release/vm.steps.mjs"],
  paths: ["features/12-release.feature"],
  tags: "@implemented and @p12_vm",
  parallel: 0,
  formatOptions: { snippets: false },
};

export const drumKits = {
  ...common,
  paths: ["features/17-drum-kits.feature"],
  tags: "@implemented",
};

export const deviceWorkflow = {
  ...common,
  paths: ["features/18-device-workflow.feature"],
  tags: "@implemented",
};

export const supportedSdk = {
  ...common,
  paths: ["features/19-supported-sdk.feature"],
  tags: "@host_only",
};
export const supportedSdkVm = {
  import: ["acceptance/sdk-vm/vm.steps.mjs"],
  parallel: 0,
  paths: ["features/19-supported-sdk.feature"],
  tags: "@sdk_vm",
  formatOptions: { snippets: false },
};

// Real built-browser journeys have isolated bindings and run in the regression CI job.
export const productionE2e = {
  import: ["acceptance/browser/*.steps.mjs"],
  parallel: 0,
  paths: [
    "features/20-production-e2e.feature",
    "features/21-internal-midi-routing.feature",
    "features/22-manual-mobile.feature",
    "features/24-portable-songs.feature",
    "features/25-full-song-e2e.feature",
    "features/26-machine-pages.feature",
  ],
  tags: "@implemented and @browser_e2e",
  formatOptions: { snippets: false },
};
export const manualE2e = {
  ...productionE2e,
  paths: ["features/22-manual-mobile.feature"],
  tags: "@implemented and @manual_e2e",
};
export const machinesE2e = {
  ...productionE2e,
  paths: ["features/26-machine-pages.feature"],
  tags: "@implemented and @machine_pages",
};
export const songE2e = {
  ...productionE2e,
  paths: ["features/24-portable-songs.feature"],
  tags: "@browser_e2e and @song_portability",
};
export const songVm = {
  import: ["acceptance/song-vm/*.steps.mjs"],
  parallel: 0,
  paths: ["features/24-portable-songs.feature"],
  tags: "@song_vm",
  formatOptions: { snippets: false },
};
export const deviceVm = {
  import: ["acceptance/device-vm/*.steps.mjs"],
  parallel: 0,
  paths: ["features/23-device-vm-arm.feature"],
  tags: "@implemented and @device_vm",
  formatOptions: { snippets: false },
};

export const liveMk1 = {
  import: ["acceptance/live-mk1/*.steps.mjs"],
  parallel: 0,
  paths: ["features/25-live-mk1-kernel.feature"],
  tags: "@implemented and @live_mk1",
  formatOptions: { snippets: false },
};
export const liveMk1Host = { ...liveMk1, tags: "@implemented and @live_mk1 and @host_only" };
export const liveMk1Emulated = {
  ...liveMk1,
  tags: "@implemented and @live_mk1 and not @owner_files and not @hardware_only",
};

export const liveEditing = {
  ...common,
  paths: ["features/28-live-editing.feature"],
  tags: "@implemented and @standalone",
};
