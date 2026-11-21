// Decoration remains outside the six-step lesson content and the videos.
export const sketchFigure = (name, type = "chapter") =>
  `<!-- BEGIN MANUAL SKETCH ${name} --><figure class="manual-sketch manual-sketch--${type}" aria-hidden="true"><img src="%BASE_URL%manual-media/sketches/${name}.svg" alt="" width="800" height="360" loading="lazy" decoding="async"></figure><!-- END MANUAL SKETCH -->`;
export const lessonSketches = new Map([
  [1, "pulse-study"],
  [3, "phrase-study"],
  [5, "arrangement-study"],
  [7, "listening-study"],
  [9, "sound-study"],
  [11, "return-study"],
]);
export function decorateManual(manual) {
  // Remove only our own reference decorations; the generated lessons already carry theirs.
  const begin = manual.indexOf("<!-- END MUSIC LESSONS -->");
  const before = manual.slice(0, begin),
    after = manual
      .slice(begin)
      .replace(/<!-- BEGIN MANUAL SKETCH [a-z-]+ -->[\s\S]*?<!-- END MANUAL SKETCH -->/g, "");
  manual = before + after;
  for (const [id, art] of Object.entries({
    overview: "pulse-study",
    sounds: "sound-study",
    patterns: "pulse-study",
    automation: "phrase-study",
    perform: "arrangement-study",
    mix: "listening-study",
    recording: "sound-study",
    projects: "keepsake-study",
    exchange: "return-study",
  })) {
    const pattern = new RegExp(`(<section id="${id}"[\\s\\S]*?</h2>)`);
    manual = manual.replace(pattern, (match) => match + sketchFigure(art));
  }
  return manual;
}
