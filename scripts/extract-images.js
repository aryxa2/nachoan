const fs = require('fs');
const path = require('path');

const htmlPath = 'C:/Users/aryak/.gemini/antigravity/brain/63a41194-1c69-4c62-a3dd-e2b8fa55f5f5/.user_uploaded/media_1795171344727_4304a33f.html';
const content = fs.readFileSync(htmlPath, 'utf8');

const lines = content.split('\n');
const imLine = lines[57]; // line 58 (0-indexed 57)
console.log('imLine length:', imLine.length, 'starts with:', imLine.slice(0, 30));

const jsonStr = imLine.replace(/^\s*const\s+IM\s*=\s*/, '').replace(/;\s*$/, '');
const IM = JSON.parse(jsonStr);

console.log('IM keys:', Object.keys(IM));

const baseDir = path.join(__dirname, '..', 'public', 'images');
const prodDir = path.join(baseDir, 'products');
const bundleDir = path.join(baseDir, 'bundles');
[baseDir, prodDir, bundleDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

for (const [key, val] of Object.entries(IM)) {
  if (typeof val === 'string' && val.startsWith('data:image/')) {
    const match = val.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (match) {
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      const buffer = Buffer.from(match[2], 'base64');
      let filename;
      let targetDir = baseDir;

      if (key === 'logo' || key === 'cone') {
        filename = `${key}.${ext}`;
      } else if (key === 'combo') {
        targetDir = bundleDir;
        filename = `movie-night-combo.${ext}`;
      } else {
        targetDir = prodDir;
        const slugMap = {
          loaded: 'loaded-nachos',
          cheese: 'cheese-nachos',
          spicy: 'spicy-beef-nachos',
          chicken: 'chicken-nachos',
          dip: 'cheese-dip',
          popper: 'jalapeno-popper',
          fries: 'french-fries',
          choco: 'iced-chocolate'
        };
        const name = slugMap[key] || key;
        filename = `${name}.${ext}`;
      }
      const fullPath = path.join(targetDir, filename);
      fs.writeFileSync(fullPath, buffer);
      console.log(`Saved ${key} -> ${fullPath} (${buffer.length} bytes)`);

      if (key === 'spicy') {
        fs.writeFileSync(path.join(bundleDir, `duo-pedas.${ext}`), buffer);
        console.log(`Saved duo-pedas bundle image`);
      }
    }
  }
}
