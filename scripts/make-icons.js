const { PNG } = require('pngjs');
const fs = require('fs');
const path = require('path');

function makeIcon(size, outPath) {
  const png = new PNG({ width: size, height: size });
  const bg = [0x2c, 0x6e, 0xf2]; // brand blue
  const fg = [0xff, 0xff, 0xff];
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.32;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) << 2;
      const dx = x - cx;
      const dy = y - cy;
      const inCircle = dx * dx + dy * dy <= r * r;
      const [cr, cg, cb] = inCircle ? fg : bg;
      png.data[idx] = cr;
      png.data[idx + 1] = cg;
      png.data[idx + 2] = cb;
      png.data[idx + 3] = 0xff;
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  png.pack().pipe(fs.createWriteStream(outPath));
}

makeIcon(180, path.join(__dirname, '..', 'public', 'apple-touch-icon.png'));
makeIcon(192, path.join(__dirname, '..', 'public', 'icon-192.png'));
makeIcon(512, path.join(__dirname, '..', 'public', 'icon-512.png'));
console.log('icons generated');
