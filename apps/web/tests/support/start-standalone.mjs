#!/usr/bin/env node
// Starts the Next.js standalone build for browser tests with a fresh, throwaway hub database.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const standalone = path.join(root, ".next/standalone");
if (!fs.existsSync(path.join(standalone, "server.js"))) {
  console.error("No standalone build found. Run `npm run build` first.");
  process.exit(1);
}
// The standalone server expects static assets and public/ next to it (the Dockerfile does the same).
fs.cpSync(path.join(root, ".next/static"), path.join(standalone, ".next/static"), { recursive: true });
fs.cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-e2e-"));
const child = spawn(process.execPath, ["server.js"], { cwd: standalone, env: { ...process.env, HUB_DATA_DIR: dataDir }, stdio: "inherit" });
const stop = () => {
  child.kill("SIGTERM");
  fs.rmSync(dataDir, { recursive: true, force: true });
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("exit", (code) => process.exit(code ?? 0));
