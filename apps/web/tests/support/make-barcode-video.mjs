#!/usr/bin/env node
// Renders an EAN-13 barcode into a looping Y4M video for Chromium's fake camera
// (--use-file-for-fake-video-capture). Usage: node make-barcode-video.mjs <ean13> <out.y4m>
import fs from "node:fs";
import path from "node:path";

const [code, out] = process.argv.slice(2);
if (!/^\d{13}$/.test(code ?? "") || !out) {
  console.error("usage: make-barcode-video.mjs <13-digit EAN> <out.y4m>");
  process.exit(1);
}

const L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
const G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"];
const R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"];
const PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"];

const d = code.split("").map(Number);
let modules = "101";
for (let i = 1; i <= 6; i++) modules += (PARITY[d[0]][i - 1] === "L" ? L : G)[d[i]];
modules += "01010";
for (let i = 7; i <= 12; i++) modules += R[d[i]];
modules += "101";

const W = 640;
const H = 480;
const MODULE = 4;
const left = Math.floor((W - modules.length * MODULE) / 2);
const top = 140;
const bottom = 340;
const y = Buffer.alloc(W * H, 235);
for (let row = top; row < bottom; row++) {
  for (let m = 0; m < modules.length; m++) {
    if (modules[m] !== "1") continue;
    for (let px = 0; px < MODULE; px++) y[row * W + left + m * MODULE + px] = 16;
  }
}
const chroma = Buffer.alloc((W / 2) * (H / 2), 128);
const frame = Buffer.concat([Buffer.from("FRAME\n"), y, chroma, chroma]);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...Array(20).fill(frame)]));
console.log(`wrote ${out} (${code})`);
