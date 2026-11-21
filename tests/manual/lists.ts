// Which test file performs each of the manual's instruction lists.
export const studioLists = [
  "sounds › Import, trim and slice",
  "patterns › Polyphonic note entry",
  "patterns › Record a note pass",
  "perform › Launch clips independently",
  "perform › Build a finite song",
  "mix › Mixing & effects",
  "recording › Recording & resampling",
  "exchange › Import a MIDI clip",
] as const;
// The hardware setup chapter: steps on the owner's MPC (power, update mode, USB
// keys) and in the native XMP OS Installer, which a browser test cannot perform.
// hardware.test.ts holds their exact wording, so a change still fails and gets
// reviewed. Automating the installer's own screens is still to do.
export const hardwareLists = [
  "hardware-setup › Prepare the files and verify your Live",
  "hardware-setup › Let the installer create the XMP key",
  "hardware-setup › Prepare your XMP USB key",
  "hardware-setup › Check first. Confirm once.",
  "hardware-setup › Insert the key and make a small loop",
  "hardware-setup › Install the loader and boot XMP",
  "hardware-setup › Return to MPC OS",
] as const;

// Current shared C++ Device guide, replayed by native-course.test.ts.
export const deviceLists = [
  "quick-start › Make your first loop",
  "learn › Meet your new workflow",
  "learn › A beat without poking the screen",
  "learn › Make the hats breathe",
  "learn › Give the drums a bass line",
  "learn › Make a variation, keep the original",
  "learn › Play the clip grid",
  "learn › Turn the parts into a song",
  "learn › Make room for each part",
  "learn › Play a part into the track",
  "learn › Change the kit, keep the beat",
  "learn › Shape one drum sound",
  "learn › Save it, then prove it opens",
  "learn › Swap the snare for a clap",
  "learn › Find a synth sound that fits",
  "learn › Choose what a track becomes",
  "learn › Turn a loop into a pad kit",
  "first-beat › Build a loop, then a song",
] as const;
