"use strict";
// Prueba la funcion pura interpretCliStatus de main.js, cargando main.js en Node
// plano con un stub del modulo "obsidian" (asi no hace falta Obsidian).
//   node test/test-interpret.js
const path = require("path");
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

const { interpretCliStatus } = require(path.join(__dirname, "..", "main.js"));

let pass = 0,
  fail = 0;
function eq(name, got, exp) {
  if (JSON.stringify(got) === JSON.stringify(exp)) {
    pass++;
    console.log("  ok:", name);
  } else {
    fail++;
    console.log("  FAIL:", name, "\n    got", JSON.stringify(got), "\n    exp", JSON.stringify(exp));
  }
}
function check(name, cond) {
  if (cond) {
    pass++;
    console.log("  ok:", name);
  } else {
    fail++;
    console.log("  FAIL:", name);
  }
}

const NOW = 1000000000;

eq("null + nada -> none", interpretCliStatus(null, NOW, null), { action: "none" });
eq("null + mostrando -> hide", interpretCliStatus(null, NOW, 5), { action: "hide" });

{
  const st = { phase: "counting", status: "Preparando copia...", total: 0, copied: 0, file: "", startedAt: 5, updatedAt: NOW - 100 };
  const d = interpretCliStatus(st, NOW, null);
  check("counting -> progress", d.action === "progress");
  check("counting isNew true", d.isNew === true);
  check("counting startedAt 5", d.startedAt === 5);
}

{
  const st = { phase: "copying", status: "Copiando...", total: 100, copied: 40, file: "a/b.md", startedAt: 5, updatedAt: NOW - 100 };
  const d = interpretCliStatus(st, NOW, 5);
  check("copying isNew false", d.isNew === false);
  check("copying copied 40", d.copied === 40);
  check("copying total 100", d.total === 100);
  check("copying file", d.file === "a/b.md");
}

eq(
  "copying estancado mostrado -> hide",
  interpretCliStatus({ phase: "copying", total: 100, copied: 40, startedAt: 5, updatedAt: NOW - 31000 }, NOW, 5),
  { action: "hide" }
);
eq(
  "copying estancado no mostrado -> none",
  interpretCliStatus({ phase: "copying", total: 100, copied: 40, startedAt: 9, updatedAt: NOW - 31000 }, NOW, 5),
  { action: "none" }
);

{
  const st = { phase: "done", status: "Copia completada...", total: 100, copied: 100, startedAt: 5, updatedAt: NOW - 200 };
  const d = interpretCliStatus(st, NOW, 5);
  check("done -> finalize-done", d.action === "finalize-done");
  check("done text", d.text === "Copia completada...");
  check("done total", d.total === 100);
}
eq(
  "done viejo -> none",
  interpretCliStatus({ phase: "done", status: "x", total: 100, copied: 100, startedAt: 5, updatedAt: NOW - 16000 }, NOW, null),
  { action: "none" }
);
{
  const st = { phase: "error", status: "fallo", total: 100, copied: 50, startedAt: 5, updatedAt: NOW - 200 };
  const d = interpretCliStatus(st, NOW, null);
  check("error -> finalize-error", d.action === "finalize-error");
  check("error isNew true", d.isNew === true);
  check("error text", d.text === "fallo");
}
eq("fase rara -> none", interpretCliStatus({ phase: "weird", updatedAt: NOW }, NOW, null), { action: "none" });
{
  const d = interpretCliStatus({ phase: "done", total: 1, copied: 1, startedAt: 5, updatedAt: NOW }, NOW, 5);
  check("done texto por defecto", d.text === "Copia completada");
}

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
