"use strict";
// Prueba los ayudantes puros del diff estilo GitHub (diffLines, collapseOps,
// looksBinary) de main.js, cargandolo con un stub del modulo "obsidian".
//   node test/test-diff.js
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

const { diffLines, alignDiff, collapseRows, looksBinary } = require(
  path.join(__dirname, "..", "main.js")
);

let pass = 0,
  fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log("  ok:", name);
  } else {
    fail++;
    console.log("  FAIL:", name);
  }
}

const changes = (ops) => ops.filter((o) => o.t !== "ctx");
const adds = (ops) => ops.filter((o) => o.t === "add").map((o) => o.text);
const dels = (ops) => ops.filter((o) => o.t === "del").map((o) => o.text);

// --- diffLines ---
{
  const ops = diffLines(["a", "b", "c"], ["a", "b", "c"]);
  check("identico -> sin cambios", changes(ops).length === 0);
  check("identico -> 3 contextos", ops.length === 3);
}
{
  // old = copia, new = vault. Linea nueva en el vault -> add.
  const ops = diffLines(["a", "c"], ["a", "b", "c"]);
  check("insercion en vault -> add 'b'", JSON.stringify(adds(ops)) === JSON.stringify(["b"]));
  check("insercion -> sin del", dels(ops).length === 0);
}
{
  // Linea presente solo en la copia (borrada del vault) -> del.
  const ops = diffLines(["a", "b", "c"], ["a", "c"]);
  check("borrada del vault -> del 'b'", JSON.stringify(dels(ops)) === JSON.stringify(["b"]));
  check("borrada -> sin add", adds(ops).length === 0);
}
{
  // Copia vacia (archivo que falta) -> todo el vault como add.
  const ops = diffLines([], ["x", "y"]);
  check("copia vacia -> todo add", JSON.stringify(adds(ops)) === JSON.stringify(["x", "y"]));
  check("copia vacia -> sin del", dels(ops).length === 0);
}
{
  const ops = diffLines(["a"], ["b"]);
  check("linea cambiada -> del 'a'", dels(ops).indexOf("a") >= 0);
  check("linea cambiada -> add 'b'", adds(ops).indexOf("b") >= 0);
}

// --- alignDiff (filas lado a lado: left = copia, right = vault) ---
{
  // Contexto: misma linea a ambos lados, con sus numeros de linea.
  const rows = alignDiff(diffLines(["a", "b"], ["a", "b"]));
  check("align: contexto empareja lados", rows.every((r) => r.left && r.right && r.left.kind === "ctx" && r.right.kind === "ctx"));
  check("align: numeros de linea 1..2", rows[0].left.num === 1 && rows[1].right.num === 2);
}
{
  // Linea cambiada: del a la izquierda, add a la derecha, en la MISMA fila.
  const rows = alignDiff(diffLines(["a"], ["b"]));
  check("align: cambio en una fila", rows.length === 1);
  check("align: izquierda es del 'a'", rows[0].left && rows[0].left.kind === "del" && rows[0].left.text === "a");
  check("align: derecha es add 'b'", rows[0].right && rows[0].right.kind === "add" && rows[0].right.text === "b");
}
{
  // Linea solo anadida en el vault: hueco a la izquierda, add a la derecha.
  const rows = alignDiff(diffLines(["a", "c"], ["a", "b", "c"]));
  const addRow = rows.find((r) => r.right && r.right.text === "b");
  check("align: insercion -> hueco a la izquierda", addRow && addRow.left === null && addRow.right.kind === "add");
}
{
  // Copia vacia (archivo que falta): todo add a la derecha, hueco a la izquierda.
  const rows = alignDiff(diffLines([], ["x", "y"]));
  check("align: copia vacia -> todo hueco a la izquierda", rows.every((r) => r.left === null && r.right && r.right.kind === "add"));
}

// --- collapseRows ---
{
  // 10 filas de contexto + 1 cambio + 10 de contexto: se pliega lo lejano.
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ left: { num: i, text: "c" + i, kind: "ctx" }, right: { num: i, text: "c" + i, kind: "ctx" } });
  rows.push({ left: null, right: { num: 11, text: "NUEVA", kind: "add" } });
  for (let i = 0; i < 10; i++) rows.push({ left: { num: i, text: "d" + i, kind: "ctx" }, right: { num: i, text: "d" + i, kind: "ctx" } });
  const out = collapseRows(rows, 3);
  const gaps = out.filter((r) => r.gap);
  check("collapse: hay marcadores de hueco", gaps.length === 2);
  check("collapse: primer hueco esconde 7", gaps[0].count === 7);
  check("collapse: conserva el cambio", out.some((r) => r.right && r.right.text === "NUEVA"));
  check("collapse: 3 contextos antes del cambio", out.filter((r) => r.left && r.left.text && r.left.text.startsWith("c")).length === 3);
}
{
  // Sin cambios no hay nada que conservar: todo se pliega en un unico hueco.
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push({ left: { num: i, text: "x", kind: "ctx" }, right: { num: i, text: "x", kind: "ctx" } });
  const out = collapseRows(rows, 3);
  check("collapse sin cambios -> un solo hueco", out.length === 1 && out[0].gap === true && out[0].count === 5);
}

// --- looksBinary ---
check("texto no es binario", looksBinary(Buffer.from("hola\nmundo\n", "utf8")) === false);
check("byte NUL es binario", looksBinary(Buffer.from([0x68, 0x00, 0x69])) === true);

console.log(`\n${pass} ok, ${fail} fail`);
process.exit(fail ? 1 : 0);
