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

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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
  { src: 'adults-ladies-team.jpg', out: 'adults-ladies-team', widths: [400, 800], ratio: 4/3 },
  { src: 'adults-mens-team.jpg',   out: 'adults-mens-team',   widths: [400, 800], ratio: 4/3 },
  // Portrait selfie with one face high and one low. focusY pushes the window
  // below centre so both smiles survive the crop to a landscape tile.
  { src: 'adults-private-lesson.jpg', out: 'adults-private-lesson', widths: [400, 800], ratio: 4/3, focusY: 0.62 },
  { src: 'logan-trimp.jpg',    out: 'staff/logan-trimp',    widths: [320, 640] },
  { src: 'mait-dubois.jpg',    out: 'staff/mait-dubois',    widths: [320, 640] },
  { src: 'john-trimp.jpg',     out: 'staff/john-trimp',     widths: [320, 640] },
  { src: 'taylor-vaughn.jpg',  out: 'staff/taylor-vaughn',  widths: [320, 640] }
];

// Favicons, kept out of JOBS on purpose: that pipeline is built for photographs
// — EXIF rotation, mozjpeg-vs-WebP, display widths — and none of it applies to a
// square vector mark that needs transparency and PNG.
//
// The SVG itself is the primary icon; browsers that support it render the mark
// crisply at any size. The PNGs are for everything else: 32px is what a browser
// tab actually uses, and 180px is the iOS home-screen size.
const FAVICON_SRC = 'site/images/uncw-logo.svg';
const FAVICONS = [
  { size: 32,  out: 'favicon-32.png' },
  { size: 180, out: 'apple-touch-icon.png' }
];

const kb = (n) => (n / 1024).toFixed(0).padStart(5) + ' KB';

let srcTotal = 0;
let outTotal = 0;
const manifest = [];

for (const job of JOBS) {
  const srcPath = join(SRC, job.src);
  srcTotal += (await stat(srcPath)).size;

  // Rotation is materialised BEFORE anything measures the image, because
  // sharp().metadata() reports the dimensions as stored, not as displayed. A
  // phone photo with EXIF orientation 6 is stored landscape and shown portrait,
  // so measuring first swaps width and height — which silently pointed the crop
  // window and the never-enlarge clamp at the wrong axis.
  const rotated = await sharp(srcPath).rotate().toBuffer();
  const original = sharp(rotated);
  const meta = await sharp(rotated).metadata();

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
    // `ratio` bakes the crop into the file instead of leaving it to CSS
    // object-fit. Tiles that must line up in a grid should always use it:
    // depending on the browser to crop at render time meant three tiles of
    // three different heights, which dragged every card's text out of line.
    let resized;
    if (job.ratio) {
      // focusY picks where the crop window sits vertically: 0 = flush top,
      // 0.5 = centred, 1 = flush bottom. A centred window is wrong whenever the
      // subject is not centred — on a selfie with one face high and one low it
      // clipped both chins.
      const focusY = job.focusY ?? 0.5;
      const winH = Math.round(meta.width / job.ratio);
      if (winH < meta.height) {
        const top = Math.round((meta.height - winH) * focusY);
        resized = original.clone()
          .extract({ left: 0, top, width: meta.width, height: winH })
          .resize({ width, withoutEnlargement: true });
      } else {
        // source is not tall enough to crop vertically, so crop the sides
        const winW = Math.round(meta.height * job.ratio);
        resized = original.clone()
          .extract({ left: Math.round((meta.width - winW) / 2), top: 0, width: winW, height: meta.height })
          .resize({ width, withoutEnlargement: true });
      }
    } else {
      resized = original.clone().resize({ width, withoutEnlargement: true });
    }
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

// ── favicons ─────────────────────────────────────────────────────────────
console.log('\nfavicons, from ' + FAVICON_SRC + ':');
{
  const svg = await readFile(FAVICON_SRC);
  for (const icon of FAVICONS) {
    // Rasterised at 8x and scaled down rather than rendered straight to 32px:
    // rendering a vector directly at tiny sizes leaves the thin white lines in
    // this mark aliased away, and downsampling keeps them as grey rather than
    // losing them.
    const png = await sharp(svg, { density: 72 * 8 })
      .resize(icon.size, icon.size, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }   // keep the mark transparent
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
    await writeFile(join(OUT, icon.out), png);
    outTotal += png.length;
    console.log(`  ${icon.out.padEnd(22)} ${icon.size}x${icon.size}  ${kb(png.length)}`);
  }
  console.log('  the .svg is served as the primary icon; these are the fallbacks');
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
