// Required semantic checks for the Live emulator. Diagnostic booleans are not
// a pass until every selected contract is present and true.
export const SESSION_CHECKS = {
  machine: [
    "sameSessionBinaryAsLive",
    "liveBoardRuleApplied",
    "fourCoresIsolatedPinned",
    "stickOnUsbStorage",
    "screen800x1280Rotated",
    "twinCards",
    "touchscreenLikeLive",
  ],
  pads: [
    "audioCardAccepted",
    "bothPortsRead",
    "startupBytesExactOnPrivatePort",
    "identityReplyLoggedWithoutSerial",
    "padOneHard",
    "padSixteenSoft",
    "runningStatusOff",
    "buttonLogged",
    "knobLogged",
    "eightAtOnce",
    "soundOnOutputsOneTwoOnly",
    "peakWithinMinus12dBFS",
    "noXruns",
    "powerButtonEndsSession",
    "switchedOff",
    "screenGridDrawn",
    "rootDiskUnchanged",
  ],
  sequencer: [
    "touchesSelectAndProgram",
    "played",
    "recordedLiveHit",
    "tempoChanged",
    "stopped",
    "dataWheelTempo",
    "noLateNotes",
    "stepsAt120BpmExact",
    "stepsAt125BpmExact",
    "patternSavedToStick",
    "soundOnOutputsOneTwoOnly",
    "peakWithinMinus12dBFS",
    "noXruns",
    "screenShowsPlayingAndSteps",
    "switchedOff",
    "rootDiskUnchanged",
  ],
  tracks: [
    "trackButtonsSelect",
    "synthStepsEntered",
    "knobSetsLevel",
    "kitStepsOnTrack1",
    "liveSynthNote",
    "noLateNotes",
    "bassOnQuarterNotes",
    "songSavedToStick",
    "soundOnOutputsOneTwoOnly",
    "peakWithinMinus12dBFS",
    "noXruns",
    "screenShowsTrackStrip",
    "switchedOff",
    "rootDiskUnchanged",
  ],
  project: [
    "controllerFeedbackAllowlisted",
    "projectOpened",
    "playButtonPlaysTheSong",
    "stopButtonStops",
    "soundPresetChosen",
    "soundEngineReloaded",
    "songCaptured",
    "sampleViewRecords",
    "padPlaysOneClip",
    "padLaunchesAtTheBar",
    "shiftMainOpensPlay",
    "wheelLaunchesScene",
    "stepsViewEdits",
    "undoAndRedo",
    "savedToTheStick",
    "wholeSongSavedAtTheEnd",
    "savedProjectOpensWithTheEdit",
    "recCountsIn",
    "recordedATake",
    "overdubbed",
    "savedProjectHasTheTake",
    "knobsChangeTheTrack",
    "savedProjectHasTheKnobs",
    "mixKnobsAfterTheSoundView",
    "wheelValueKeptOnApply",
    "screenMessagesLogged",
    "songViewEdits",
    "songPlaysFromABlock",
    "savedProjectHasTheSong",
    "mixViewMutesAndSolos",
    "savedProjectHasTheMix",
    "pianoRollEdits",
    "savedProjectHasTheRollNote",
    "screenShowsClips",
    "noCommandsDropped",
    "soundOnOutputsOneTwoOnly",
    "peakWithinMinus12dBFS",
    "noXruns",
    "switchedOff",
    "rootDiskUnchanged",
  ],
  bridge: [
    "gadgetUp",
    "wrongTokenRefused",
    "helloLiveBoard",
    "statusFromSession",
    "inputInjected",
    "touchInjected",
    "shellLikeInputRefused",
    "screenshotLandscape",
    "recordHasSound",
    "logRead",
    "pushVerified",
    "rebootedIntoPushedImage",
    "previousImageKept",
    "rootDiskUnchanged",
  ],
};
export const SESSION_GROUPS = Object.freeze({
  pads: ["machine", "pads"],
  seq: ["sequencer"],
  tracks: ["tracks"],
  project: ["project"],
  bridge: ["bridge"],
});
export function evaluateSessionResult(result, only = null) {
  const selected = only ?? Object.keys(SESSION_GROUPS);
  if (!selected.length || selected.some((name) => !Object.hasOwn(SESSION_GROUPS, name)))
    throw new Error("Select known emulator sessions");
  const failures = [];
  if (result.format !== "xmp-session-vm-test" || result.version !== 2)
    failures.push("result format/version");
  if (result.machine?.sameSessionBinaryAsLive !== true)
    failures.push("machine.sameSessionBinaryAsLive");
  for (const name of selected) {
    for (const group of SESSION_GROUPS[name]) {
      for (const check of SESSION_CHECKS[group])
        if (result[group]?.[check] !== true) failures.push(`${group}.${check}`);
      for (const [check, value] of Object.entries(result[group] ?? {}))
        if (typeof value === "boolean" && !value && !failures.includes(`${group}.${check}`))
          failures.push(`${group}.${check}`);
    }
  }
  if (
    selected.includes("pads") &&
    (!Number.isFinite(result.audio?.peakDbfs) ||
      result.audio.peakDbfs > -12 ||
      result.audio.peakDbfs < -90)
  )
    failures.push("audio.peakDbfs");
  if (selected.includes("bridge") && result.bridge?.error != null) failures.push("bridge.error");
  return {
    passed: failures.length === 0,
    complete: Object.keys(SESSION_GROUPS).every((name) => selected.includes(name)),
    sessions: selected,
    notRun: Object.keys(SESSION_GROUPS).filter((name) => !selected.includes(name)),
    failures,
  };
}
