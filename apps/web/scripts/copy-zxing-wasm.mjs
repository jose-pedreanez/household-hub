// Copies the ZXing-C++ WebAssembly reader into public/ so camera decoding never depends on a CDN.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const candidates = [
  path.join(root, "node_modules/zxing-wasm"),
  path.join(root, "node_modules/barcode-detector/node_modules/zxing-wasm"),
];
const pkgDir = candidates.find((d) => fs.existsSync(path.join(d, "dist/reader/zxing_reader.wasm")));
if (!pkgDir) {
  console.error("zxing-wasm reader not found; run npm install first");
  process.exit(1);
}
const version = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version;
const dest = path.join(root, "public/zxing/zxing_reader.wasm");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(path.join(pkgDir, "dist/reader/zxing_reader.wasm"), dest);
console.log(`zxing reader ${version} → public/zxing/`);
