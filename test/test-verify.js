"use strict";
// Prueba de la verificacion barata (recuento + tamano) verifyCopy de main.js.
// Carga main.js con un stub de "obsidian" (no necesita Obsidian) e instancia el
// plugin solo para llamar al metodo. Comprueba que NO marca nada en una copia
// fiel y que DETECTA un archivo faltante y uno truncado.
//   node test/test-verify.js
const path = require("path");
const fs = require("fs");
const os = require("os");
const Module = require("module");

const origLoad = Module._load;
Module._load = function (request) {
  if (request === "obsidian") {
    return {
      Plugin: class {},
      PluginSettingTab: class {},
      FileSystemAdapter: class {},
      Notice: class {},
      Setting: class {},
      setIcon: () => {},
    };
  }
  return origLoad.apply(this, arguments);
};

const VaultBackupPlugin = require(path.join(__dirname, "..", "main.js"));
const plugin = new VaultBackupPlugin();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vbverify-"));
const src = path.join(tmp, "src");
const good = path.join(tmp, "good");
const bad = path.join(tmp, "bad");
for (const d of [src, good, bad]) {
  fs.mkdirSync(path.join(d, "sub"), { recursive: true });
}
fs.writeFileSync(path.join(src, "a.md"), "AAAA");
fs.writeFileSync(path.join(src, "sub", "b.md"), "BBBBBBB");
fs.writeFileSync(path.join(src, "sub", "c.md"), "CC");

// good: copia fiel.
fs.writeFileSync(path.join(good, "a.md"), "AAAA");
fs.writeFileSync(path.join(good, "sub", "b.md"), "BBBBBBB");
fs.writeFileSync(path.join(good, "sub", "c.md"), "CC");

// bad: b.md truncado (3 vs 7 bytes) y c.md no copiado (falta).
fs.writeFileSync(path.join(bad, "a.md"), "AAAA");
fs.writeFileSync(path.join(bad, "sub", "b.md"), "BBB");

(async () => {
  const noSkip = () => false;
  const g = await plugin.verifyCopy(src, good, noSkip);
  const b = await plugin.verifyCopy(src, bad, noSkip);

  let fail = 0;
  const check = (name, cond) => {
    console.log((cond ? "  ok: " : "  FAIL: ") + name);
    if (!cond) fail++;
  };

  check("copia fiel: checked === 3", g.checked === 3);
  check("copia fiel: 0 discrepancias", g.count === 0);
  check("copia mala: checked === 3", b.checked === 3);
  check("copia mala: 2 discrepancias", b.count === 2);
  check("copia mala: detalla el faltante (c.md)", b.mismatches.some((m) => /falta.*c\.md/.test(m)));
  check("copia mala: detalla el tamano (b.md)", b.mismatches.some((m) => /tamano distinto.*b\.md/.test(m)));

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {}

  console.log(fail ? "\nVERIFY: FAIL" : "\nVERIFY: PASS");
  process.exit(fail ? 1 : 0);
})();
