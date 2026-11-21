#pragma once
// Mirrors packages/core/src/pad-scale.ts (same scales, in the same order). Does
// not transpose saved events.
namespace xmp::music {
enum class Scale { major, chromatic, harmonic_minor, minor, melodic_minor, dorian, phrygian, lydian, mixolydian, locrian };
constexpr int kScales = 10;
inline const char* scale_name(Scale s) {
  static constexpr const char* names[kScales] = {"Major (Ionian)", "Chromatic",  "Harmonic minor", "Natural minor (Aeolian)",
                                                 "Melodic minor",  "Dorian",     "Phrygian",       "Lydian",
                                                 "Mixolydian",     "Locrian"};
  const int i = static_cast<int>(s);
  return i >= 0 && i < kScales ? names[i] : "Major (Ionian)";
}
// The root note: 0 = C ... 11 = B. Pad 1 plays it in octave 3 (MIDI 48 + root).
inline const char* root_name(int root) {
  static constexpr const char* names[12] = {"C", "C\xE2\x99\xAF", "D", "D\xE2\x99\xAF", "E", "F",
                                            "F\xE2\x99\xAF", "G", "G\xE2\x99\xAF", "A", "A\xE2\x99\xAF", "B"};
  return names[((root % 12) + 12) % 12];
}
inline int pad_note(int pad, int octave = 0, Scale scale = Scale::major, int root = 48) {
  if (pad < 0 || pad > 15)
    return root;
  static constexpr int modes[kScales][7] = {
      {0, 2, 4, 5, 7, 9, 11}, {0, 0, 0, 0, 0, 0, 0},  {0, 2, 3, 5, 7, 8, 11}, {0, 2, 3, 5, 7, 8, 10}, {0, 2, 3, 5, 7, 9, 11},
      {0, 2, 3, 5, 7, 9, 10}, {0, 1, 3, 5, 7, 8, 10}, {0, 2, 4, 6, 7, 9, 11}, {0, 2, 4, 5, 7, 9, 10}, {0, 1, 3, 5, 6, 8, 10}};
  int i = static_cast<int>(scale);
  if (i < 0 || i >= kScales)
    i = 0;
  const int offset = scale == Scale::chromatic ? pad : pad / 7 * 12 + modes[i][pad % 7];
  const int note = root + octave * 12 + offset;
  return note < 0 ? 0 : note > 127 ? 127 : note;
}
} // namespace xmp::music
