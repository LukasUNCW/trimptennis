// scripts/optimize-images.mjs
//
// Generates the web-ready images in site/images/ from the originals in
// assets-src/. Run with `npm run images` after adding or replacing a photo.
//
// assets-src/ holds whatever the academy sends us, at whatever size they send
// it — it is version-controlled but never served. site/images/ is generated and
// IS served, so it only ever contains sizes the page actually displays.
//
// Three rules worth keeping:
//   1. Never enlarge. Upscaling a small source adds bytes and no detail, so a
//      target wider than the original is clamped to the original.
//   2. .rotate() before resizing, so EXIF orientation from phone photos is
//      baked in rather than left for the browser to interpret.
//   3. WebP is emitted only when it beats mozjpeg at EVERY width — see the
//      comment on webpWins below for why partial coverage is worse than none.

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const SRC = 'assets-src';
const OUT = 'site/images';

// Widths are CSS-pixel display sizes doubled for retina. The hero renders ~507px
// wide on desktop and near-viewport-width on mobile; the staff cards ~264px.
const JOBS = [
  { src: 'ball-crew-2025.jpg', out: 'ball-crew-2025',       widths: [800, 1600] },
  // sits in the Elite page's ~410px aside column, so 440 plus a retina 880
  { src: 'elite-squad-2025.jpg', out: 'elite-squad-2025',   widths: [440, 880] },
  // full content width on /juniors (~1124px), so 800 for mobile and 1600 above
  { src: 'juniors-section-champs-2015.jpg', out: 'juniors-champs-2015', widths: [800, 1600] },
  // adult offering tiles are ~359px wide in the 3-up grid, so 400 plus retina 800
  { src: 'adults-ladies-team.jpg', out: 'adults-ladies-team', widths: [400, 800] },
  { src: 'adults-mens-team.jpg',   out: 'adults-mens-team',   widths: [400, 800] },
  { src: 'logan-trimp.jpg',    out: 'staff/logan-trimp',    widths: [320, 640] },
  { src: 'mait-dubois.jpg',    out: 'staff/mait-dubois',    widths: [320, 640] },
  { src: 'john-trimp.jpg',     out: 'staff/john-trimp',     widths: [320, 640] },
  { src: 'taylor-vaughn.jpg',  out: 'staff/taylor-vaughn',  widths: [320, 640] }
];

const kb = (n) => (n / 1024).toFixed(0).padStart(5) + ' KB';

let srcTotal = 0;
let outTotal = 0;
const manifest = [];

for (const job of JOBS) {
  const srcPath = join(SRC, job.src);
  const original = sharp(srcPath).rotate();
  const meta = await original.metadata();
  srcTotal += (await stat(srcPath)).size;

  // Clamp to the source width and drop duplicates, so a 200px original yields
  // one 200px output instead of two identical files named 320 and 640.
  const targets = [...new Set(job.widths.map((w) => Math.min(w, meta.width)))]
    .sort((a, b) => a - b);

  if (targets[targets.length - 1] < Math.max(...job.widths)) {
    console.log(`  note: ${job.src} is only ${meta.width}px wide — capped, not upscaled`);
  }

  // Encode every width before deciding anything, because the WebP decision has
  // to be made for the image as a whole.
  const encoded = [];
  for (const width of targets) {
    const resized = original.clone().resize({ width, withoutEnlargement: true });
    encoded.push({
      width,
      webp: await resized.clone().webp({ quality: 80 }).toBuffer(),
      jpeg: await resized.clone().jpeg({ quality: 80, mozjpeg: true }).toBuffer()
    });
  }

  // WebP is not always smaller: photos full of fine high-frequency detail —
  // chain-link fencing, foliage, grass — can encode larger than mozjpeg.
  //
  // The decision is all-or-nothing per image, deliberately. Emitting WebP only
  // at the widths where it happens to win produces a <picture> whose WebP
  // srcset covers some widths but not others, and a WebP-capable phone would
  // then pick the one large WebP over the small JPEG it should have had. Partial
  // coverage is worse than no coverage.
  const webpWins = encoded.every((e) => e.webp.length < e.jpeg.length);

  await mkdir(dirname(join(OUT, job.out)), { recursive: true });
  const variants = [];

  for (const e of encoded) {
    const base = `${job.out}-${e.width}`;
    await writeFile(join(OUT, `${base}.jpg`), e.jpeg);
    outTotal += e.jpeg.length;
    if (webpWins) {
      await writeFile(join(OUT, `${base}.webp`), e.webp);
      outTotal += e.webp.length;
    }
    const dims = await sharp(e.jpeg).metadata();
    variants.push({ width: dims.width, height: dims.height, jpeg: e.jpeg.length, webp: webpWins ? e.webp.length : null });
    console.log(
      `  ${base}.jpg ${kb(e.jpeg.length)}   ` +
      (webpWins ? `${base}.webp ${kb(e.webp.length)}   ` : `webp ${kb(e.webp.length)} not written   `) +
      `${dims.width}x${dims.height}`
    );
  }

  if (!webpWins) {
    const worst = encoded.find((e) => e.webp.length >= e.jpeg.length);
    console.log(`  → ${job.out}: JPEG only (webp lost at ${worst.width}px), use a plain <img srcset>`);
  }

  manifest.push({ out: job.out, variants, webpWins });
}

console.log(`\noriginals: ${kb(srcTotal)}   generated (all variants): ${kb(outTotal)}`);
console.log('largest variant per image, and the markup it needs:');
for (const m of manifest) {
  const biggest = m.variants[m.variants.length - 1];
  const bytes = m.webpWins ? biggest.webp : biggest.jpeg;
  console.log(
    `  ${m.out.padEnd(22)} ${String(biggest.width + 'x' + biggest.height).padEnd(11)} ` +
    `${kb(bytes)}  ${m.webpWins ? '<picture> + webp' : '<img> jpeg only'}`
  );
}
