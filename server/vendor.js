// Copies xterm UMD builds + css into public/vendor so the frontend never
// depends on a CDN (important behind the GFW). Runs on postinstall.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'public', 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

const files = [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
];

for (const [from, to] of files) {
  const src = path.join(root, 'node_modules', from);
  const dst = path.join(vendorDir, to);
  try {
    fs.copyFileSync(src, dst);
    console.log(`vendored ${to}`);
  } catch (e) {
    console.warn(`WARN could not vendor ${from}: ${e.message}`);
  }
}
