"use strict";
// Prueba de integracion del CLI: crea un vault falso temporal, lanza
// backup-cli.js y muestrea el archivo de estado mientras copia. Verifica el ciclo
// de vida del estado (counting -> copying -> done) y los totales finales.
//   node test/test-cli.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const PLUGIN_DIR = path.join(__dirname, "..");
const CLI = path.join(PLUGIN_DIR, "backup-cli.js");
const STATUS = path.join(PLUGIN_DIR, ".cli-backup-status.json");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vbtest-"));
const fakeVault = path.join(tmp, "FAKE VAULT");
const dest = path.join(tmp, "DEST");
fs.mkdirSync(path.join(fakeVault, ".obsidian"), { recursive: true });
fs.mkdirSync(dest, { recursive: true });

const N = 8000; // notas; mas .obsidian/app.json => total esperado N + 1
const content = "x".repeat(120);
for (let i = 0; i < N; i++) {
  fs.writeFileSync(path.join(fakeVault, `note-${i}.md`), content);
}
fs.writeFileSync(path.join(fakeVault, ".obsidian", "app.json"), "{}");

const phasesSeen = new Set();
let maxCopied = 0;
let sawFile = false;
let samples = 0;

const child = spawn(process.execPath, [CLI, "--vault", fakeVault, dest], { cwd: PLUGIN_DIR });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

const poll = setInterval(() => {
  try {
    const st = JSON.parse(fs.readFileSync(STATUS, "utf8"));
    samples++;
    if (st.phase) phasesSeen.add(st.phase);
    if (typeof st.copied === "number") maxCopied = Math.max(maxCopied, st.copied);
    if (st.file) sawFile = true;
  } catch (e) {}
}, 50);

child.on("exit", (code) => {
  clearInterval(poll);
  setTimeout(() => {
    let finalState = null;
    try {
      finalState = JSON.parse(fs.readFileSync(STATUS, "utf8"));
    } catch (e) {}

    let backedUpFiles = 0;
    try {
      const dir = fs.readdirSync(dest, { withFileTypes: true }).find((e) => e.isDirectory());
      if (dir) {
        const copiedDir = path.join(dest, dir.name, "FAKE VAULT");
        backedUpFiles = fs.readdirSync(copiedDir).filter((f) => f.startsWith("note-")).length;
      }
    } catch (e) {}

    console.log("exit code:", code);
    console.log("muestras:", samples, "| fases:", [...phasesSeen].join(","));
    console.log("maxCopied:", maxCopied, "/ N:", N, "| vi archivo:", sawFile);
    console.log("archivos en backup:", backedUpFiles, "/", N);
    console.log("estado final:", JSON.stringify(finalState));

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    try { fs.unlinkSync(STATUS); } catch (e) {}

    const EXPECTED = N + 1; // notas + .obsidian/app.json
    const ok =
      code === 0 &&
      phasesSeen.has("copying") &&
      maxCopied > 0 &&
      sawFile &&
      backedUpFiles === N &&
      finalState &&
      finalState.phase === "done" &&
      finalState.total === EXPECTED &&
      finalState.copied === EXPECTED;
    console.log(ok ? "\nINTEGRACION: PASS" : "\nINTEGRACION: FAIL");
    process.exit(ok ? 0 : 1);
  }, 350);
});
