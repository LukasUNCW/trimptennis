// scripts/optimize-images.mjs
//
// Generates the web-ready images in site/images/ from the originals in
// assets-src/. Run with `npm run images` after adding or replacing a photo.
//
// assets-src/ holds whatever the academy sends us, at whatever size they send
// it — it is version-controlled but never served. site/images/ is generated and
// IS served, so it only ever contains sizes the page actually displays.
//
// Two rules worth keeping:
//   1. Never enlarge. Upscaling a small source adds bytes and no detail, so a
//      target wider than the original is clamped to the original.
//   2. .rotate() before resizing, so EXIF orientation from phone photos is
//      baked in rather than left for the browser to interpret.

import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
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

  await mkdir(dirname(join(OUT, job.out)), { recursive: true });
  const variants = [];

  for (const width of targets) {
    const resized = original.clone().resize({ width, withoutEnlargement: true });

    const webp = await resized.clone().webp({ quality: 80 }).toBuffer();
    const jpeg = await resized.clone().jpeg({ quality: 80, mozjpeg: true }).toBuffer();

    const base = `${job.out}-${width}`;
    await writeFile(join(OUT, `${base}.jpg`), jpeg);
    outTotal += jpeg.length;

    // WebP is not always smaller. Photos full of fine high-frequency detail —
    // chain-link fencing, foliage, gravel — can encode larger than mozjpeg, and
    // a <picture> would then serve the heavier file simply because it is first.
    // Only keep the WebP when it actually wins.
    const webpWins = webp.length < jpeg.length;
    if (webpWins) {
      await writeFile(join(OUT, `${base}.webp`), webp);
      outTotal += webp.length;
    }

    const dims = await sharp(jpeg).metadata();
    variants.push({ width: dims.width, height: dims.height, webp: webpWins ? webp.length : null, jpeg: jpeg.length });
    console.log(
      `  ${base}.jpg ${kb(jpeg.length)}   ` +
      (webpWins ? `${base}.webp ${kb(webp.length)}   ` : `webp skipped (${kb(webp.length)} > jpeg)   `) +
      `${dims.width}x${dims.height}`
    );
  }

  manifest.push({ out: job.out, variants });
}

console.log(`\noriginals: ${kb(srcTotal)}   generated (all variants): ${kb(outTotal)}`);
console.log('largest single-variant page cost:');
for (const m of manifest) {
  const biggest = m.variants[m.variants.length - 1];
  const bytes = biggest.webp ?? biggest.jpeg;
  const fmt = biggest.webp ? "webp" : "jpg ";
  console.log(`  ${m.out.padEnd(22)} ${biggest.width}x${biggest.height}  ${fmt} ${kb(bytes)}`);
}
