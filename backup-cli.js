#!/usr/bin/env node
"use strict";

/*
 * Lanzador de la copia de seguridad desde la TERMINAL.
 *
 * Hace exactamente la misma copia que el boton de ajustes, el boton de guardado
 * o el atajo Ctrl+S del plugin, pero sin necesidad de Obsidian (funciona aunque
 * Obsidian este cerrado). Pensado para que Claude Code u otros scripts puedan
 * disparar la copia.
 *
 * Uso (desde cualquier carpeta):
 *   node "<ruta-al-plugin>/backup-cli.js"            -> copia a TODOS los destinos
 *   node backup-cli.js 1 3                           -> solo a los destinos 1 y 3
 *   node backup-cli.js "C:\\Backups\\X"             -> solo a esa ruta
 *   node backup-cli.js --list                        -> muestra la configuracion
 *   node backup-cli.js --vault "<ruta-al-vault>"     -> fuerza la raiz del vault
 *   node backup-cli.js --help
 *
 * IMPORTANTE: la logica de copia esta DUPLICADA a proposito desde main.js (el
 * plugin se carga como un unico archivo dentro de Obsidian). Si cambias la copia
 * en main.js, actualiza tambien este archivo para que sigan haciendo lo mismo.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

/* ------------------------------------------------------------------ */
/* Estado para el panel del plugin                                     */
/* ------------------------------------------------------------------ */
/* El CLI escribe su progreso en este archivo (dentro de la carpeta    */
/* del plugin). Si Obsidian esta abierto, el plugin lo vigila y muestra */
/* su panel de progreso. Es best-effort: si escribir falla, la copia   */
/* continua igual. El nombre debe coincidir con CLI_STATUS_FILE de      */
/* main.js.                                                            */

const CLI_STATUS_FILE = ".cli-backup-status.json";
const STATUS_PATH = path.join(__dirname, CLI_STATUS_FILE);
let statusStartedAt = 0;

function writeStatus(obj) {
  try {
    const payload = Object.assign(
      { pid: process.pid, startedAt: statusStartedAt, updatedAt: Date.now() },
      obj
    );
    fs.writeFileSync(STATUS_PATH, JSON.stringify(payload));
  } catch (e) {
    // Ignorado a proposito: el estado es solo para la UI de Obsidian.
  }
}

function clearStatus() {
  try {
    fs.unlinkSync(STATUS_PATH);
  } catch (e) {
    // No existia; nada que limpiar.
  }
}

/* ------------------------------------------------------------------ */
/* Logica de copia (replica de main.js)                                */
/* ------------------------------------------------------------------ */

// Fecha de hoy con formato "DD MM YYYY".
function todayStamp() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return `${dd} ${mm} ${yyyy}`;
}

// Normaliza una ruta para compararla sin sorpresas de mayusculas ni separadores.
function normForCompare(p) {
  return path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
}

// True si "child" esta dentro de (o es igual a) "parent".
function isInside(parent, child) {
  const a = normForCompare(parent);
  const b = normForCompare(child);
  if (a === b) return true;
  return b.startsWith(a + path.sep.toLowerCase()) || b.startsWith(a + "/");
}

// Normaliza la lista de destinos desde cualquier formato historico de data.json:
// destinations (objetos), destPaths (lista de strings) o destPath (un string).
function normalizeDestinations(data) {
  const defAuto = !!(data && data.autoEnabled);
  const defMinsRaw = Number(data && data.intervalMinutes);
  const defMins = defMinsRaw > 0 ? defMinsRaw : 30;

  let raw = [];
  if (data && Array.isArray(data.destinations)) raw = data.destinations.slice();
  if (data && Array.isArray(data.destPaths)) {
    for (const p of data.destPaths) raw.push(p);
  }
  if (data && typeof data.destPath === "string" && data.destPath.trim()) {
    raw.push(data.destPath);
  }

  return raw
    .map((d) => {
      if (typeof d === "string") d = { path: d };
      if (!d || typeof d !== "object") return null;
      const mins = Number(d.intervalMinutes);
      return {
        path: typeof d.path === "string" ? d.path : "",
        autoEnabled: typeof d.autoEnabled === "boolean" ? d.autoEnabled : defAuto,
        intervalMinutes: mins > 0 ? mins : defMins,
      };
    })
    .filter(Boolean);
}

// Devuelve "DD MM YYYY - N" con N = siguiente iteracion del dia.
function computeBackupFolderName(destPath) {
  const stamp = todayStamp();
  let maxN = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(destPath, { withFileTypes: true });
  } catch (e) {
    entries = [];
  }
  const re = /^(\d{2}) (\d{2}) (\d{4}) - (\d+)$/;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const m = ent.name.match(re);
    if (!m) continue;
    const entStamp = `${m[1]} ${m[2]} ${m[3]}`;
    if (entStamp !== stamp) continue;
    const n = parseInt(m[4], 10);
    if (!isNaN(n) && n > maxN) maxN = n;
  }
  return `${stamp} - ${maxN + 1}`;
}

// Cuenta los archivos que se van a copiar (para el progreso). shouldSkip excluye.
async function countFiles(src, shouldSkip) {
  let n = 0;
  let entries;
  try {
    entries = await fsp.readdir(src, { withFileTypes: true });
  } catch (e) {
    return 0;
  }
  for (const ent of entries) {
    const p = path.join(src, ent.name);
    if (shouldSkip && shouldSkip(p)) continue;
    if (ent.isDirectory()) {
      n += await countFiles(p, shouldSkip);
    } else if (ent.isFile() || ent.isSymbolicLink()) {
      n++;
    }
  }
  return n;
}

// Copia recursiva de src a dest. shouldSkip(absPath) permite excluir rutas.
// ctx = { copied, onProgress } reporta el avance por archivo.
async function copyDir(src, dest, shouldSkip, ctx) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    const srcPath = path.join(src, ent.name);
    if (shouldSkip && shouldSkip(srcPath)) continue;
    const destPath = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      await copyDir(srcPath, destPath, shouldSkip, ctx);
    } else if (ent.isSymbolicLink()) {
      try {
        await fsp.copyFile(srcPath, destPath);
        ctx.copied++;
        if (ctx.onProgress) ctx.onProgress(ctx.copied, srcPath);
      } catch (e) {
        console.error("\n[vault-backup] no se pudo copiar el enlace:", srcPath, e.message || e);
      }
    } else if (ent.isFile()) {
      await fsp.copyFile(srcPath, destPath);
      ctx.copied++;
      if (ctx.onProgress) ctx.onProgress(ctx.copied, srcPath);
    }
    // Otros tipos (sockets, FIFOs...) se ignoran.
  }
  return ctx.copied;
}

// Verificacion barata tras copiar (replica de main.js): recorre el origen igual
// que copyDir y comprueba que cada archivo existe en el destino con el MISMO
// tamano (stat, sin releer el contenido). Detecta copias incompletas, truncados
// o que falten; NO detecta corrupcion bit a bit silenciosa. Devuelve
// { checked, count, mismatches }.
async function verifyCopy(src, dest, shouldSkip) {
  const MAX_REPORT = 20;
  const detailed = [];
  let checked = 0;
  let count = 0;
  const flag = (msg) => {
    count++;
    if (detailed.length < MAX_REPORT) detailed.push(msg);
  };
  const walk = async (s, d) => {
    let entries;
    try {
      entries = await fsp.readdir(s, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const sp = path.join(s, ent.name);
      if (shouldSkip && shouldSkip(sp)) continue;
      const dp = path.join(d, ent.name);
      if (ent.isDirectory()) {
        await walk(sp, dp);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        checked++;
        let ss;
        try {
          ss = await fsp.stat(sp);
        } catch (e) {
          continue;
        }
        let ds;
        try {
          ds = await fsp.stat(dp);
        } catch (e) {
          flag(`falta en el destino: ${path.relative(src, sp)}`);
          continue;
        }
        if (ss.size !== ds.size) {
          flag(`tamano distinto: ${path.relative(src, sp)} (${ss.size} vs ${ds.size} bytes)`);
        }
      }
    }
  };
  await walk(src, dest);
  return { checked, count, mismatches: detailed };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function printHelp() {
  console.log(
    [
      "Vault Backup - copia de seguridad desde la terminal",
      "",
      "Uso:",
      '  node backup-cli.js                 Copia a TODOS los destinos configurados',
      '  node backup-cli.js 1 3             Copia solo a los destinos 1 y 3 (por numero)',
      '  node backup-cli.js "C:\\ruta"      Copia solo a esa ruta',
      "  node backup-cli.js --list          Muestra la configuracion (vault, destinos, exclusiones)",
      '  node backup-cli.js --vault "<ruta>"  Fuerza la raiz del vault',
      "  node backup-cli.js --help          Esta ayuda",
      "",
      "Lee la configuracion de data.json (la misma que usa el plugin en Obsidian).",
    ].join("\n")
  );
}

function readSettings(pluginDir) {
  try {
    const raw = fs.readFileSync(path.join(pluginDir, "data.json"), "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return 0;
  }

  const pluginDir = __dirname;

  // Raiz del vault: por defecto, sube 3 niveles desde el plugin
  // (<vault>/.obsidian/plugins/vault-backup). Se puede forzar con --vault.
  let basePath = path.resolve(pluginDir, "..", "..", "..");
  const vIdx = argv.indexOf("--vault");
  if (vIdx !== -1 && argv[vIdx + 1]) {
    basePath = path.resolve(argv[vIdx + 1]);
  }
  if (!fs.existsSync(path.join(basePath, ".obsidian"))) {
    console.warn(
      `[vault-backup] Aviso: no encuentro ".obsidian" en "${basePath}". ` +
        "Si la raiz del vault no es correcta, pasala con --vault \"<ruta>\"."
    );
  }

  const data = readSettings(pluginDir);
  const destinations = normalizeDestinations(data);

  if (argv.includes("--list")) {
    console.log("Vault:", basePath);
    console.log("Destinos:");
    if (destinations.length === 0) {
      console.log("  (ninguno configurado)");
    } else {
      destinations.forEach((d, i) =>
        console.log(
          `  ${i + 1}. ${d.path}  [auto: ${d.autoEnabled ? "si" : "no"}, cada ${d.intervalMinutes} min]`
        )
      );
    }
    const ex = Array.isArray(data.excludePaths) ? data.excludePaths.filter(Boolean) : [];
    console.log("Exclusiones:", ex.length ? ex.join(", ") : "(ninguna)");
    return 0;
  }

  // Destinos a copiar: por defecto todos; si hay argumentos posicionales, se
  // restringe a esos (numero de destino o ruta literal).
  const picks = argv.filter((a, i) => {
    if (a.startsWith("-")) return false;
    if (argv[i - 1] === "--vault") return false; // valor de --vault, no un destino
    return true;
  });
  let destPaths = destinations.map((d) => d.path);
  if (picks.length) {
    destPaths = picks.map((p) => {
      const idx = parseInt(p, 10);
      if (!isNaN(idx) && idx >= 1 && idx <= destinations.length) {
        return destinations[idx - 1].path;
      }
      return p;
    });
  }

  // Dedupe + trim.
  const seen = new Set();
  const destRoots = [];
  for (const raw of destPaths) {
    const d = (raw || "").trim();
    if (!d) continue;
    const key = normForCompare(d);
    if (seen.has(key)) continue;
    seen.add(key);
    destRoots.push(d);
  }

  if (destRoots.length === 0) {
    console.error(
      "[vault-backup] No hay carpetas de destino. Configura destinos en Obsidian " +
        "(o revisa data.json)."
    );
    return 1;
  }

  // Ningun destino dentro del vault ni que lo contenga.
  const validDests = [];
  const invalidDests = [];
  for (const d of destRoots) {
    if (isInside(basePath, d) || isInside(d, basePath)) invalidDests.push(d);
    else validDests.push(d);
  }
  if (invalidDests.length) {
    console.warn(
      "[vault-backup] Se omiten destinos dentro del vault (o que lo contienen): " +
        invalidDests.join(", ")
    );
  }
  if (validDests.length === 0) {
    console.error("[vault-backup] Ningun destino valido. Elige carpetas externas al vault.");
    return 1;
  }

  const vaultName = path.basename(basePath);
  const excluded = (Array.isArray(data.excludePaths) ? data.excludePaths : [])
    .map((rel) => (rel || "").trim())
    .filter(Boolean)
    .map((rel) => path.resolve(basePath, rel));

  const statusNorm = normForCompare(STATUS_PATH);
  const skip = (absPath) =>
    validDests.some((d) => isInside(d, absPath)) ||
    excluded.some((ex) => isInside(ex, absPath)) ||
    normForCompare(absPath) === statusNorm;

  // Estado para el panel del plugin: arranca limpio y marca el inicio.
  statusStartedAt = Date.now();
  clearStatus();
  writeStatus({ phase: "counting", status: "Preparando copia...", total: 0, copied: 0, file: "" });

  console.log(`[vault-backup] Vault: ${basePath}`);
  console.log(`[vault-backup] Destinos validos: ${validDests.length}`);

  const started = Date.now();
  console.log("[vault-backup] Contando archivos...");
  const perDest = await countFiles(basePath, skip);
  const total = perDest * validDests.length;
  console.log(`[vault-backup] ${perDest} archivos por destino (total ${total}).`);
  writeStatus({ phase: "copying", status: "Iniciando copia...", total, copied: 0, file: "" });

  // Copia en PARALELO (igual que el plugin): cada destino suele estar en su
  // propio disco, asi que copiar a la vez ahorra tiempo. El panel del plugin
  // muestra UN solo progreso agregado, asi que sumamos lo copiado por cada
  // destino en cada repintado. Leer el mismo origen a la vez es seguro y las
  // escrituras van a carpetas distintas, sin conflicto.
  const errors = [];
  let lastPaint = 0;
  const copiedByDest = new Array(validDests.length).fill(0);
  const okFlags = new Array(validDests.length).fill(false);
  const verifyFails = []; // destinos copiados pero con discrepancias al verificar

  const paintAggregate = (file) => {
    const done = copiedByDest.reduce((a, b) => a + b, 0);
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    process.stdout.write(`\r[vault-backup] ${done} / ${total} archivos (${pct}%)   `);
    writeStatus({
      phase: "copying",
      status: `Copiando ${validDests.length} destino(s) en paralelo...`,
      total,
      copied: done,
      file: file || "",
    });
  };

  await Promise.all(
    validDests.map(async (destRoot, i) => {
      const label = `destino ${i + 1}/${validDests.length}`;
      try {
        fs.mkdirSync(destRoot, { recursive: true });
        const folderName = computeBackupFolderName(destRoot);
        const targetDir = path.join(destRoot, folderName, vaultName);
        console.log(`[vault-backup] Copiando a ${label}: "${folderName}" -> ${destRoot}`);

        const ctx = {
          copied: 0,
          onProgress: (copied, srcPath) => {
            copiedByDest[i] = copied;
            const now = Date.now();
            if (now - lastPaint < 250) return;
            lastPaint = now;
            paintAggregate(path.relative(basePath, srcPath));
          },
        };
        await copyDir(basePath, targetDir, skip, ctx);
        copiedByDest[i] = ctx.copied;
        okFlags[i] = true;

        // Verificacion barata (recuento + tamano) de este destino.
        const v = await verifyCopy(basePath, targetDir, skip);
        if (v.count === 0) {
          console.log(
            `\n[vault-backup] OK "${folderName}" (${label}): ${ctx.copied} archivos, verificado (${v.checked})`
          );
        } else {
          verifyFails.push(`${destRoot}: ${v.count} discrepancia(s)`);
          console.warn(
            `\n[vault-backup] AVISO verificacion "${folderName}" (${label}): ${v.count} discrepancia(s):\n  ` +
              v.mismatches.join("\n  ")
          );
        }
      } catch (e) {
        console.error(`\n[vault-backup] ERROR copiando a ${destRoot}:`, e.message || e);
        errors.push(`${destRoot}: ${e && e.message ? e.message : e}`);
      }
    })
  );

  const okCount = okFlags.filter(Boolean).length;
  const copiedTotal = copiedByDest.reduce((a, b) => a + b, 0);
  process.stdout.write("\n");

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (errors.length === 0 && verifyFails.length === 0) {
    const msg = `Copia completada y verificada en ${okCount} destino(s): ${copiedTotal} archivos en ${secs}s`;
    console.log(`[vault-backup] ${msg}`);
    writeStatus({ phase: "done", status: msg, total, copied: copiedTotal, file: "" });
    return 0;
  }
  if (errors.length === 0) {
    // Se copio todo, pero la verificacion encontro discrepancias en algun destino.
    const msg = `Copia hecha pero verificacion con discrepancias en ${verifyFails.length} destino(s): ${verifyFails.join(" | ")}`;
    console.error(`[vault-backup] ${msg}`);
    writeStatus({ phase: "error", status: msg, total, copied: copiedTotal, file: "" });
    return 1;
  }
  if (okCount > 0) {
    const extra = verifyFails.length ? ` (+${verifyFails.length} con discrepancias al verificar)` : "";
    const msg = `Copia parcial: ${okCount} ok, ${errors.length} con error en ${secs}s${extra}`;
    console.error(`[vault-backup] ${msg}`);
    writeStatus({ phase: "error", status: msg, total, copied: copiedTotal, file: "" });
    return 1;
  }
  const msg = `Error en todos los destinos: ${errors.join(" | ")}`;
  console.error(`[vault-backup] ${msg}`);
  writeStatus({ phase: "error", status: msg, total, copied: copiedTotal, file: "" });
  return 1;
}

main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error("[vault-backup] Error:", e);
    process.exit(1);
  });
