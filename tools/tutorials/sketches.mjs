// Original vector studies extending the supplied Soft Resonance illustration library.
// No logo artwork, product screenshot, instrument measurement or vendor asset.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const destination = resolve(root, "apps/studio/public/manual-media/sketches");
await mkdir(destination, { recursive: true });
const c = { forest: "#35473E", rose: "#C88E91", butter: "#E6C779", iris: "#5862BF" };
const line = (d, color = "forest", width = 3, opacity = 0.9, rough = false) =>
  `<path d="${d}" fill="none" stroke="${c[color]}" stroke-width="${width}" opacity="${opacity}" stroke-linecap="round" stroke-linejoin="round"${rough ? ' filter="url(#pastel)"' : ""}/>`;
const field = (d, color, opacity = 0.35) =>
  `<path d="${d}" fill="${c[color]}" opacity="${opacity}" filter="url(#pastel)"/>`;
const studies = [
  [
    "loop-study",
    "A loose rose loop, a butter field and small iris marks",
    field(
      "M365 254 C293 188 367 83 516 91 C665 99 685 242 561 292 C472 329 417 301 365 254Z",
      "butter",
      0.62,
    ) +
      line(
        "M92 267 C42 195 113 103 249 100 C399 97 414 253 300 282 C182 309 155 210 241 165 C315 127 434 136 490 193",
        "rose",
        19,
        0.9,
        true,
      ) +
      line(
        "M111 285 C204 308 245 218 350 200 C441 184 486 231 565 204 C619 185 633 134 599 105",
        "forest",
        2.6,
      ) +
      line("M88 260 C49 190 122 111 253 109 C379 109 402 248 301 271", "rose", 1.5, 0.55) +
      line("M655 164 l30 -17 M662 187 l38 -1 M660 210 l25 15", "iris", 5) +
      line("M529 302 l6 -13 M547 313 l9 -22 M568 313 l6 -18", "forest", 2.2, 0.7),
  ],
  [
    "pulse-study",
    "Uneven pastel beat marks above a loose pencil thread",
    field(
      "M74 161 C226 93 381 164 560 110 L736 177 C638 258 424 210 288 259 L86 239Z",
      "butter",
      0.5,
    ) +
      line("M111 243 Q119 211 123 150", "forest", 15, 0.82, true) +
      line("M171 278 Q184 222 184 169", "rose", 21, 0.92, true) +
      line("M247 238 Q251 210 270 151", "iris", 12, 0.8, true) +
      line("M318 257 Q317 203 338 125", "forest", 9, 0.85, true) +
      line("M392 265 Q408 210 419 151", "rose", 17, 0.9, true) +
      line("M481 224 Q474 190 490 133", "forest", 12, 0.9, true) +
      line("M549 261 Q563 209 575 150", "iris", 18, 0.82, true) +
      line("M627 244 Q636 201 654 145", "rose", 11, 0.9, true) +
      line(
        "M94 303 C180 271 245 309 323 287 C402 265 475 310 560 282 C604 266 661 280 699 263",
        "forest",
        2.4,
        0.8,
      ) +
      line("M720 112 l16 -18 M739 126 l21 -9", "iris", 3),
  ],
  [
    "phrase-study",
    "A fine travelling pencil line through rose and iris colour",
    field(
      "M113 254 C95 156 217 102 329 136 C393 155 382 267 275 288 C202 303 147 292 113 254Z",
      "rose",
      0.42,
    ) +
      field(
        "M492 124 C535 76 676 102 692 178 C711 271 589 286 540 247 C489 208 465 162 492 124Z",
        "iris",
        0.18,
      ) +
      line(
        "M67 227 C139 283 178 257 229 205 C270 161 308 165 336 214 C372 275 431 284 486 216 C546 144 591 150 633 185 C664 213 702 205 732 172",
        "forest",
        3.2,
        0.9,
      ) +
      line("M196 133 C222 89 285 76 336 108", "butter", 17, 0.9, true) +
      line("M354 281 Q405 314 462 283", "rose", 13, 0.8, true) +
      line("M619 102 l15 -24 M641 114 l28 -19 M663 135 l28 -4", "iris", 3.6, 0.9) +
      line("M96 308 l24 -6 M130 305 l16 -5", "forest", 1.8, 0.7),
  ],
  [
    "arrangement-study",
    "Three asymmetrical pastel forms connected by an exploratory line",
    field(
      "M110 129 C161 88 235 132 260 195 C284 252 204 280 141 245 C89 219 81 162 110 129Z",
      "butter",
      0.62,
    ) +
      field(
        "M326 263 C271 193 344 126 423 142 C512 158 499 266 426 287 C385 299 349 288 326 263Z",
        "rose",
        0.52,
      ) +
      field(
        "M548 100 C616 74 718 154 685 223 C651 291 573 278 555 207 C540 161 509 121 548 100Z",
        "iris",
        0.24,
      ) +
      line(
        "M69 236 C134 293 232 292 254 204 C275 111 218 85 194 125 C170 172 283 197 328 211 C410 239 450 118 488 127 C528 139 460 255 550 270 C622 283 700 226 725 163",
        "forest",
        2.8,
        0.9,
      ) +
      line("M359 107 Q399 81 439 104", "rose", 10, 0.88, true) +
      line("M720 253 l17 14 M710 275 l8 22 M688 286 l-2 22", "forest", 3, 0.7),
  ],
  [
    "listening-study",
    "Open concentric gestures and quiet pastel hatching",
    field(
      "M233 301 C160 242 207 129 305 118 C453 99 524 181 470 272 C431 339 294 350 233 301Z",
      "butter",
      0.55,
    ) +
      line(
        "M130 262 C81 216 97 138 166 110 C249 71 347 108 368 179 C393 260 312 306 240 284",
        "rose",
        18,
        0.85,
        true,
      ) +
      line("M170 265 C103 196 162 108 253 131 C323 149 342 228 290 263", "forest", 2.7, 0.9) +
      line(
        "M370 286 C453 282 551 215 541 159 C529 98 453 111 467 155 C483 201 586 192 665 139",
        "iris",
        6,
        0.85,
        true,
      ) +
      line(
        "M484 287 l20 -22 M506 295 l24 -27 M532 303 l19 -29 M557 307 l20 -25",
        "rose",
        3.6,
        0.8,
      ) +
      line("M652 260 Q688 257 705 235", "forest", 2.3),
  ],
  [
    "sound-study",
    "An iris flourish, rose scribble and soft butter shape",
    field(
      "M465 267 C411 210 452 127 565 130 C683 133 729 212 663 279 C602 334 500 306 465 267Z",
      "butter",
      0.6,
    ) +
      line(
        "M98 218 C85 130 208 98 250 176 C287 250 172 294 158 238 C149 199 250 167 293 208 C332 247 288 291 260 275",
        "rose",
        16,
        0.9,
        true,
      ) +
      line(
        "M356 280 C349 211 372 108 432 111 C509 113 463 254 397 224 C347 202 457 165 548 182 C603 194 653 170 695 136",
        "iris",
        11,
        0.75,
        true,
      ) +
      line("M99 299 C200 316 315 263 410 269 C515 278 591 211 675 215", "forest", 2.6, 0.9) +
      line("M542 105 l7 -23 M565 108 l17 -24 M591 115 l21 -17", "forest", 3.3, 0.8) +
      line("M173 99 l16 -10 M190 85 l14 -10", "rose", 2.5),
  ],
  [
    "return-study",
    "A wandering return loop and expressive colour strokes",
    field(
      "M94 246 C51 177 116 92 234 114 C343 136 354 226 286 280 C223 328 130 309 94 246Z",
      "rose",
      0.32,
    ) +
      line(
        "M366 235 C315 173 356 90 462 90 C606 90 629 247 521 284 C412 320 384 225 458 187 C528 148 647 175 708 130",
        "butter",
        25,
        0.95,
        true,
      ) +
      line(
        "M110 236 C181 304 286 286 302 199 C320 102 244 95 236 144 C225 217 367 278 461 246 C540 218 574 137 546 126",
        "forest",
        2.8,
      ) +
      line("M643 258 l25 -28 M668 271 l30 -29 M692 286 l28 -27", "iris", 6, 0.85, true),
  ],
  [
    "keepsake-study",
    "A suspended rose arc and small marks over translucent colour",
    field(
      "M165 122 C228 89 367 118 356 207 C350 270 208 273 173 222 C149 185 133 143 165 122Z",
      "iris",
      0.18,
    ) +
      field(
        "M443 254 C386 198 445 138 531 153 C610 164 631 265 556 293 C505 310 464 281 443 254Z",
        "butter",
        0.57,
      ) +
      line(
        "M83 249 C178 307 203 186 253 159 C321 120 379 151 387 201 C402 292 328 290 329 235 C331 179 495 93 579 125 C681 162 611 288 666 282",
        "rose",
        17,
        0.9,
        true,
      ) +
      line(
        "M91 266 C153 289 221 238 278 225 C364 203 422 258 495 245 C556 235 617 172 690 181",
        "forest",
        2.3,
        0.9,
      ) +
      line("M664 112 l18 -19 M682 128 l23 -10 M693 151 l24 -2", "iris", 4.1, 0.85),
  ],
];
const assets = [];
for (const [id, title, drawing] of studies) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="360" viewBox="0 0 800 360" role="img"><title>${title}</title><defs><filter id="pastel" x="-6%" y="-8%" width="112%" height="116%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency=".55" numOctaves="2" seed="${assets.length + 7}" result="grain"/><feColorMatrix in="grain" type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 .9 .9 .9 0 -.4" result="tooth"/><feComposite in="SourceGraphic" in2="tooth" operator="in"/></filter></defs>${drawing}</svg>\n`;
  await writeFile(`${destination}/${id}.svg`, svg);
  assets.push({ file: `${id}.svg`, title, sha256: createHash("sha256").update(svg).digest("hex") });
}
await writeFile(
  `${destination}/manifest.json`,
  `${JSON.stringify(
    {
      collection: "Abstract Engineering · music sketch studies",
      identityVersion: "1.0",
      created: "2026-11-15",
      method:
        "Original hand-authored SVG paths, dry-pastel grain, variable strokes and translucent fields; extends the supplied vector illustration library.",
      styleSource: "brand/abstract-engineering/guidelines/AI-STYLE-GUIDE.md",
      decorative: true,
      palette: c,
      assets,
    },
    null,
    2,
  )}\n`,
);
console.log(`Created ${assets.length} original vector sketch studies.`);
