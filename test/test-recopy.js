"use strict";
// Prueba de recopyMismatch de main.js: la recopia selectiva de UN archivo con
// discrepancia (la usa el boton "Recopiar seleccionados" del modal). Carga
// main.js con un stub de "obsidian" (no necesita Obsidian). Comprueba que
// repara un faltante y un truncado (y los reverifica), y que las guardas
// rechazan: origen desaparecido, destino dentro del vault, origen == destino
// y discrepancias sin rutas absolutas.
//   node test/test-recopy.js
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
      Modal: class {},
      Notice: class {},
      Setting: class {},
      setIcon: () => {},
    };
  }
  return origLoad.apply(this, arguments);
};

const { recopyMismatch } = require(path.join(__dirname, "..", "main.js"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vbrecopy-"));
const vault = path.join(tmp, "vault");
const copy = path.join(tmp, "copy");
fs.mkdirSync(path.join(vault, "sub"), { recursive: true });
fs.mkdirSync(copy, { recursive: true });

// a.md truncado en la copia; sub/b.md falta (ni siquiera existe su carpeta).
fs.writeFileSync(path.join(vault, "a.md"), "AAAAAAA");
fs.writeFileSync(path.join(copy, "a.md"), "AAA");
fs.writeFileSync(path.join(vault, "sub", "b.md"), "BBBB");
// c.md existe solo en el vault; su "discrepancia" apuntara a un destino
// DENTRO del vault para probar la guarda.
fs.writeFileSync(path.join(vault, "c.md"), "CCCC");

const mk = (rel, destRel) => ({
  type: "size",
  rel,
  srcSize: 0,
  destSize: 0,
  srcAbs: path.join(vault, rel),
  destAbs: path.join(copy, destRel || rel),
});

(async () => {
  let fail = 0;
  const check = (name, cond) => {
    console.log((cond ? "  ok: " : "  FAIL: ") + name);
    if (!cond) fail++;
  };

  // 1) Repara un archivo truncado.
  const r1 = await recopyMismatch(mk("a.md"), vault);
  check("truncado: ok", r1.ok === true);
  check("truncado: tamanos iguales tras recopiar", r1.srcSize === 7 && r1.destSize === 7);
  check(
    "truncado: el contenido de la copia es el del vault",
    fs.readFileSync(path.join(copy, "a.md"), "utf8") === "AAAAAAA"
  );

  // 2) Repara un faltante creando la carpeta intermedia.
  const r2 = await recopyMismatch(mk(path.join("sub", "b.md")), vault);
  check("faltante: ok", r2.ok === true);
  check(
    "faltante: crea carpeta y archivo",
    fs.readFileSync(path.join(copy, "sub", "b.md"), "utf8") === "BBBB"
  );

  // 3) El origen ya no existe en el vault.
  const r3 = await recopyMismatch(mk("no-existe.md"), vault);
  check("origen desaparecido: rechazado", r3.ok === false && /no existe/.test(r3.reason));

  // 4) Guarda: no se escribe dentro del vault.
  const inVault = mk("c.md");
  inVault.destAbs = path.join(vault, "sub", "c.md");
  const r4 = await recopyMismatch(inVault, vault);
  check("destino dentro del vault: rechazado", r4.ok === false && /dentro del vault/.test(r4.reason));
  check(
    "destino dentro del vault: no escribio nada",
    !fs.existsSync(path.join(vault, "sub", "c.md"))
  );

  // 5) Guarda: origen y destino son el mismo archivo.
  const same = mk("a.md");
  same.destAbs = same.srcAbs;
  const r5 = await recopyMismatch(same, null);
  check("origen == destino: rechazado", r5.ok === false);

  // 6) Discrepancia antigua sin rutas absolutas.
  const r6 = await recopyMismatch({ type: "size", rel: "a.md" }, vault);
  check("sin rutas absolutas: rechazado", r6.ok === false);

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {}

  console.log(fail ? "\nRECOPY: FAIL" : "\nRECOPY: PASS");
  process.exit(fail ? 1 : 0);
})();
