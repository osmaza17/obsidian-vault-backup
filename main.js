"use strict";

const obsidian = require("obsidian");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

// Nombre del archivo donde backup-cli.js escribe su progreso para que el plugin,
// si Obsidian esta abierto, pueda mostrar el panel de una copia lanzada desde la
// terminal. Vive en la carpeta del plugin (dentro del vault) y se excluye de la
// copia.
const CLI_STATUS_FILE = ".cli-backup-status.json";

// Tamano legible (B/KB/MB/GB...). Se usa en el modal de discrepancias.
function formatBytes(n) {
  if (n == null || isNaN(n)) return "-";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Convierte una discrepancia estructurada { type, rel, srcSize, destSize, label }
// en una linea legible (para el log de consola). El modal la pinta aparte con mas
// detalle.
function describeMismatch(m) {
  const label = m && m.label ? `[${m.label}] ` : "";
  if (!m) return `${label}discrepancia`;
  if (m.type === "missing") {
    return `${label}falta en la copia: ${m.rel} (${m.srcSize} bytes en el vault)`;
  }
  return `${label}tamano distinto: ${m.rel} (vault ${m.srcSize} vs copia ${m.destSize} bytes)`;
}

/* ------------------------------------------------------------------ */
/* Diff estilo GitHub para el modal de discrepancias                  */
/* ------------------------------------------------------------------ */

// Topes para no congelar la UI ni pintar basura al abrir un diff bajo demanda.
const DIFF_MAX_BYTES = 2 * 1024 * 1024; // no releemos archivos mas grandes que esto
const DIFF_MAX_LINES = 3000; // tope de lineas por lado para el algoritmo LCS
const DIFF_CTX = 3; // lineas de contexto sin cambios alrededor de cada cambio

// Heuristica barata: un byte NUL en el arranque delata un binario (imagenes,
// PDFs, adjuntos). Evita intentar un diff de texto sobre ellos.
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Lee un archivo para el diff decidiendo si es apto (texto y no gigante).
// Devuelve { status: "ok"|"binary"|"toobig"|"missing", size?, text? }.
async function readForDiff(absPath) {
  let st;
  try {
    st = await fsp.stat(absPath);
  } catch (e) {
    return { status: "missing" };
  }
  if (st.size > DIFF_MAX_BYTES) return { status: "toobig", size: st.size };
  let buf;
  try {
    buf = await fsp.readFile(absPath);
  } catch (e) {
    return { status: "missing" };
  }
  if (looksBinary(buf)) return { status: "binary", size: st.size };
  return { status: "ok", size: st.size, text: buf.toString("utf8") };
}

// Parte un texto en lineas tolerando cualquier salto de linea (\n, \r\n, \r).
function splitLines(text) {
  return text.length ? text.split(/\r\n|\r|\n/) : [];
}

// Diff de lineas por LCS. Devuelve una lista de operaciones
// { t: "ctx"|"del"|"add", text }, donde "del" = solo en `oldLines` y
// "add" = solo en `newLines`. Convencion del modal: old = copia, new = vault.
function diffLines(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        oldLines[i] === newLines[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ t: "ctx", text: oldLines[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      ops.push({ t: "del", text: oldLines[i] });
      i++;
    } else {
      ops.push({ t: "add", text: newLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: "del", text: oldLines[i++] });
  while (j < m) ops.push({ t: "add", text: newLines[j++] });
  return ops;
}

// Convierte la lista lineal de ops de diffLines en FILAS para una vista lado a
// lado (copia a la izquierda, vault a la derecha). Cada fila es
// { left, right }, donde cada lado es { num, text, kind } o null (hueco). Los
// bloques de "del"+"add" contiguos se emparejan linea a linea (un cambio), y lo
// que sobra de un lado deja el otro vacio (null).
function alignDiff(ops) {
  const rows = [];
  let ln = 0; // numero de linea en la copia (old)
  let rn = 0; // numero de linea en el vault (new)
  let delBuf = [];
  let addBuf = [];
  const flush = () => {
    const n = Math.max(delBuf.length, addBuf.length);
    for (let i = 0; i < n; i++) {
      rows.push({ left: delBuf[i] || null, right: addBuf[i] || null });
    }
    delBuf = [];
    addBuf = [];
  };
  for (const op of ops) {
    if (op.t === "del") {
      ln++;
      delBuf.push({ num: ln, text: op.text, kind: "del" });
    } else if (op.t === "add") {
      rn++;
      addBuf.push({ num: rn, text: op.text, kind: "add" });
    } else {
      flush();
      ln++;
      rn++;
      rows.push({
        left: { num: ln, text: op.text, kind: "ctx" },
        right: { num: rn, text: op.text, kind: "ctx" },
      });
    }
  }
  flush();
  return rows;
}

// Pliega tramos largos de filas sin cambios en un marcador { gap: true, count },
// dejando solo `ctx` filas alrededor de cada cambio (el look de un diff de GitHub).
function collapseRows(rows, ctx) {
  const isChange = (r) =>
    !(r.left && r.left.kind === "ctx" && r.right && r.right.kind === "ctx");
  const keep = new Array(rows.length).fill(false);
  for (let k = 0; k < rows.length; k++) {
    if (isChange(rows[k])) {
      for (let d = -ctx; d <= ctx; d++) {
        const idx = k + d;
        if (idx >= 0 && idx < rows.length) keep[idx] = true;
      }
    }
  }
  const out = [];
  let hidden = 0;
  for (let k = 0; k < rows.length; k++) {
    if (keep[k]) {
      if (hidden > 0) {
        out.push({ gap: true, count: hidden });
        hidden = 0;
      }
      out.push(rows[k]);
    } else {
      hidden++;
    }
  }
  if (hidden > 0) out.push({ gap: true, count: hidden });
  return out;
}

const DEFAULT_SETTINGS = {
  // Lista de carpetas de destino. Cada destino es un objeto con su propio
  // horario: { path, autoEnabled, intervalMinutes }. La copia manual se guarda
  // en todos; la copia automatica de cada destino corre con su propio intervalo.
  destinations: [],
  // Rutas (relativas a la raiz del vault) que NO se copian en la backup.
  // Util para carpetas pesadas que no son contenido (p.ej. binarios/modelos).
  excludePaths: [],
  // Valores por defecto al anadir una carpeta de destino nueva.
  autoEnabled: false,
  intervalMinutes: 30,
};

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */
/* NOTA: la logica de copia (todayStamp, normForCompare, isInside,     */
/* computeBackupFolderName, countFiles, copyDir y el flujo de          */
/* runBackup) esta DUPLICADA en backup-cli.js para poder lanzar la     */
/* copia desde la terminal sin Obsidian. Si cambias la copia aqui,     */
/* actualiza tambien backup-cli.js para que sigan haciendo lo mismo.   */
/* ------------------------------------------------------------------ */

// Fecha de hoy con formato "DD MM YYYY".
function todayStamp() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return `${dd} ${mm} ${yyyy}`;
}

// Normaliza una ruta para poder compararla sin sorpresas de mayusculas
// (Windows) ni separadores.
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

// Interpreta el estado que escribe backup-cli.js y decide que hacer con el panel,
// SIN tocar el DOM (asi se puede probar aislado). Argumentos:
//   st: objeto leido del archivo de estado, o null si no existe / no se pudo leer.
//   now: Date.now().
//   shownStartedAt: el startedAt de la copia de terminal que el panel ya muestra
//     (o null si no esta mostrando ninguna).
// Devuelve { action, ... }:
//   "none"           -> no hacer nada.
//   "hide"           -> ocultar el panel.
//   "progress"       -> mostrar/actualizar progreso (status, total, copied, file).
//   "finalize-done"  -> marcar copia terminada (text, total).
//   "finalize-error" -> marcar copia con error (text, total).
// isNew indica si es una copia de terminal distinta de la que ya se mostraba.
function interpretCliStatus(st, now, shownStartedAt) {
  if (!st || typeof st !== "object") {
    return shownStartedAt !== null ? { action: "hide" } : { action: "none" };
  }
  const startedAt = Number(st.startedAt) || 0;
  const age = now - (Number(st.updatedAt) || 0);
  const isNew = shownStartedAt !== startedAt;

  if (st.phase === "done" || st.phase === "error") {
    // Un estado final viejo lo limpia el arranque del plugin o el siguiente CLI;
    // aqui no lo mostramos para no resucitar copias antiguas.
    if (age > 15000) return { action: "none" };
    return {
      action: st.phase === "done" ? "finalize-done" : "finalize-error",
      startedAt,
      isNew,
      total: Number(st.total) || 0,
      text:
        st.status ||
        (st.phase === "done" ? "Copia completada" : "Error en la copia"),
      // Lista de discrepancias de la verificacion (para el boton "Ver
      // discrepancias" del panel); solo la escribe el CLI cuando verifica mal.
      mismatches: Array.isArray(st.mismatches) ? st.mismatches : [],
      mismatchCount: Number(st.mismatchCount) || 0,
    };
  }

  if (st.phase === "counting" || st.phase === "copying") {
    // Si el estado activo lleva mucho sin refrescarse, la copia de terminal
    // murio o se colgo: ocultamos el panel si era esa copia la que mostrabamos.
    if (age > 30000) {
      return shownStartedAt === startedAt ? { action: "hide" } : { action: "none" };
    }
    return {
      action: "progress",
      startedAt,
      isNew,
      status: st.status || "",
      total: Number(st.total) || 0,
      copied: Number(st.copied) || 0,
      file: st.file || "",
    };
  }

  return { action: "none" };
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class VaultBackupPlugin extends obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.isBackingUp = false;
    // Un temporizador por destino con copia automatica activada.
    this.intervalIds = [];
    this.bottomBtn = null;
    this.statusBtn = null;
    // Gestor de la pila de tarjetas de progreso (una por copia en curso).
    // Le pasamos la app para que las tarjetas puedan abrir el modal de
    // discrepancias cuando la verificacion falla.
    this.progress = new BackupProgressManager(this.app);
    // Vigilante del archivo de estado de backup-cli.js (copias por terminal).
    this.cliWatchId = null;
    // startedAt de la copia de terminal que el panel muestra ahora (o null).
    this.cliShownFor = null;
  }

  async onload() {
    await this.loadSettings();

    // Boton en la barra inferior izquierda (junto a ayuda/ajustes).
    this.app.workspace.onLayoutReady(() => this.addBottomLeftButton());

    this.addCommand({
      id: "backup-now",
      name: "Hacer copia de seguridad ahora",
      hotkeys: [{ modifiers: ["Mod"], key: "s" }],
      callback: () => this.runBackup("manual"),
    });

    this.addSettingTab(new VaultBackupSettingTab(this.app, this));

    this.applySchedule();

    // Si la copia se lanza desde backup-cli.js (terminal), mostramos el mismo
    // panel leyendo el archivo de estado que escribe el CLI. Limpiamos primero
    // cualquier estado viejo que hubiera quedado de una sesion anterior.
    this.cleanupCliStatus();
    this.startCliWatch();

    console.log("[vault-backup] cargado");
  }

  onunload() {
    this.clearSchedule();
    if (this.cliWatchId) {
      window.clearInterval(this.cliWatchId);
      this.cliWatchId = null;
    }
    if (this.bottomBtn) {
      this.bottomBtn.remove();
      this.bottomBtn = null;
    }
    if (this.progress) this.progress.hideAll();
  }

  /* ----------------------- boton inferior ------------------------ */

  // Inserta el boton de copia justo al lado del boton "Manage vaults"
  // (el conmutador de vault de la barra inferior izquierda). Si no lo
  // encuentra todavia, reintenta unas cuantas veces; como ultimo recurso
  // cae a un item de barra de estado para que el boton exista siempre.
  addBottomLeftButton(attempt = 0) {
    if (this.bottomBtn && this.bottomBtn.isConnected) return;

    const anchor = this.findVaultSwitcher();
    if (anchor && anchor.parentElement) {
      const btn = document.createElement("div");
      btn.addClass("clickable-icon");
      btn.addClass("vault-backup-btn");
      btn.setAttr("aria-label", "Copia de seguridad del vault");
      obsidian.setIcon(btn, "save");
      this.registerDomEvent(btn, "click", () => this.runBackup("manual"));
      // Justo despues del boton de "Manage vaults".
      anchor.parentElement.insertBefore(btn, anchor.nextSibling);
      this.bottomBtn = btn;
      return;
    }

    // El perfil del vault puede tardar en montarse: reintentar.
    if (attempt < 10) {
      window.setTimeout(() => this.addBottomLeftButton(attempt + 1), 300);
      return;
    }

    // Respaldo: barra de estado (abajo a la derecha).
    if (!this.statusBtn) {
      const el = this.addStatusBarItem();
      el.addClass("clickable-icon");
      el.addClass("vault-backup-btn");
      el.setAttr("aria-label", "Copia de seguridad del vault");
      obsidian.setIcon(el, "save");
      this.registerDomEvent(el, "click", () => this.runBackup("manual"));
      this.statusBtn = el;
      this.bottomBtn = el;
    }
  }

  // Localiza el boton "Manage vaults" / conmutador de vault de la barra
  // inferior izquierda.
  findVaultSwitcher() {
    // 1) Clase conocida del conmutador de vault.
    const byClass = document.querySelector(".workspace-drawer-vault-switcher");
    if (byClass) return byClass;

    // 2) Por texto: el boton "Manage vaults" muestra el nombre del vault.
    //    Elegimos el match que este mas abajo en pantalla, que es el del
    //    pie de la barra lateral (y no, p.ej., una pestana).
    const base = this.getVaultBasePath();
    const vaultName = base ? path.basename(base).trim() : "";
    if (!vaultName) return null;

    let best = null;
    let bestTop = -1;
    const candidates = document.querySelectorAll(
      "[class*='vault'], .workspace-ribbon *, .workspace-drawer *, .status-bar *, .titlebar *"
    );
    candidates.forEach((el) => {
      if ((el.textContent || "").trim() !== vaultName) return;
      // Solo nodos "hoja" pequenos, no contenedores grandes.
      if (el.children.length > 2) return;
      const top = el.getBoundingClientRect().top;
      if (top > bestTop) {
        bestTop = top;
        best = el;
      }
    });
    if (!best) return null;
    // Subimos al ancestro clicable del conmutador, si existe.
    return (
      best.closest("[class*='vault-switcher'], .clickable-icon") || best
    );
  }

  /* --------------------------- ajustes --------------------------- */

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    if (!Array.isArray(this.settings.excludePaths)) this.settings.excludePaths = [];

    // Valores por defecto de horario, tomados de los ajustes globales antiguos.
    const defAuto = !!this.settings.autoEnabled;
    const defMinsRaw = Number(this.settings.intervalMinutes);
    const defMins = defMinsRaw > 0 ? defMinsRaw : 30;

    // Reunimos los destinos de todos los formatos historicos.
    let raw = Array.isArray(this.settings.destinations)
      ? this.settings.destinations.slice()
      : [];
    // Migracion desde destPaths (lista de strings).
    if (Array.isArray(data.destPaths)) {
      for (const p of data.destPaths) raw.push(p);
    }
    // Migracion desde destPath (un solo string, formato mas antiguo).
    if (typeof data.destPath === "string" && data.destPath.trim()) {
      raw.push(data.destPath);
    }

    // Normalizamos cada entrada a { path, autoEnabled, intervalMinutes }.
    this.settings.destinations = raw
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

    delete this.settings.destPaths;
    delete this.settings.destPath;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* --------------------------- horario --------------------------- */

  clearSchedule() {
    if (Array.isArray(this.intervalIds)) {
      for (const id of this.intervalIds) window.clearInterval(id);
    }
    this.intervalIds = [];
  }

  // Programa un temporizador independiente por cada destino que tenga la copia
  // automatica activada, con su propio intervalo en minutos. Cada disparo solo
  // copia a ESE destino.
  applySchedule() {
    this.clearSchedule();
    const dests = Array.isArray(this.settings.destinations)
      ? this.settings.destinations
      : [];
    for (const dest of dests) {
      const p = (dest.path || "").trim();
      const mins = Number(dest.intervalMinutes);
      if (!p || !dest.autoEnabled || !(mins > 0)) continue;
      const id = window.setInterval(
        () => this.runBackup("auto", [p]),
        mins * 60000
      );
      this.intervalIds.push(id);
      // Para que Obsidian lo limpie tambien al descargar el plugin.
      this.registerInterval(id);
    }
  }

  /* --------------------------- vault ----------------------------- */

  getVaultBasePath() {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof obsidian.FileSystemAdapter) {
      return adapter.getBasePath();
    }
    return null;
  }

  // Devuelve "DD MM YYYY - N" con N = siguiente iteracion del dia.
  computeBackupFolderName(destPath) {
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

  /* --------------------------- copia ----------------------------- */

  // Cuenta los archivos que se van a copiar (sin leerlos), para poder
  // mostrar el progreso. shouldSkip excluye rutas.
  async countFiles(src, shouldSkip) {
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
        n += await this.countFiles(p, shouldSkip);
      } else if (ent.isFile() || ent.isSymbolicLink()) {
        n++;
      }
    }
    return n;
  }

  // Copia recursiva de src a dest. shouldSkip(absPath) permite excluir
  // rutas (p.ej. la propia carpeta de destino si estuviera dentro del
  // vault). ctx = { copied, onProgress } reporta el avance por archivo.
  // Devuelve el numero de archivos copiados.
  async copyDir(src, dest, shouldSkip, ctx) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const ent of entries) {
      const srcPath = path.join(src, ent.name);
      if (shouldSkip && shouldSkip(srcPath)) continue;
      const destPath = path.join(dest, ent.name);
      if (ent.isDirectory()) {
        await this.copyDir(srcPath, destPath, shouldSkip, ctx);
      } else if (ent.isSymbolicLink()) {
        // Copia el destino real del enlace como archivo normal.
        try {
          await fsp.copyFile(srcPath, destPath);
          ctx.copied++;
          if (ctx.onProgress) ctx.onProgress(ctx.copied, srcPath);
        } catch (e) {
          console.error("[vault-backup] no se pudo copiar el enlace:", srcPath, e);
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

  // Verificacion barata tras copiar: recorre el origen igual que copyDir y
  // comprueba que cada archivo existe en el destino con el MISMO tamano
  // (`stat`, sin releer el contenido, asi que apenas anade coste). Detecta
  // copias incompletas, archivos truncados o que falten. NO detecta corrupcion
  // bit a bit silenciosa (eso exigiria releer y hashear todo, ~2x I/O). Devuelve
  // { checked, count, mismatches } con hasta MAX_REPORT discrepancias como
  // objetos { type: "missing"|"size", rel, srcSize, destSize }.
  async verifyCopy(src, dest, shouldSkip) {
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
        return; // el origen pudo cambiar entre copia y verificacion; no es cosa nuestra
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
            continue; // el archivo de origen desaparecio tras copiarse; lo ignoramos
          }
          let ds;
          try {
            ds = await fsp.stat(dp);
          } catch (e) {
            flag({
              type: "missing",
              rel: path.relative(src, sp),
              srcSize: ss.size,
              destSize: null,
              srcAbs: sp,
              destAbs: dp,
            });
            continue;
          }
          if (ss.size !== ds.size) {
            flag({
              type: "size",
              rel: path.relative(src, sp),
              srcSize: ss.size,
              destSize: ds.size,
              srcAbs: sp,
              destAbs: dp,
            });
          }
        }
      }
    };
    await walk(src, dest);
    return { checked, count, mismatches: detailed };
  }

  // trigger: "manual" | "auto". onlyPaths (opcional): si se pasa, solo se copia
  // a esas rutas (lo usa cada temporizador para copiar a su propio destino). Sin
  // onlyPaths se copia a todos los destinos configurados.
  async runBackup(trigger, onlyPaths) {
    if (this.isBackingUp) {
      if (trigger === "manual") {
        new obsidian.Notice("Ya hay una copia de seguridad en curso.");
      }
      return;
    }

    const basePath = this.getVaultBasePath();
    if (!basePath) {
      new obsidian.Notice(
        "Vault Backup: no se puede acceder al sistema de archivos (solo escritorio)."
      );
      return;
    }

    // Lista de destinos: sin vacios y sin duplicados.
    const rawDests = Array.isArray(onlyPaths)
      ? onlyPaths
      : (Array.isArray(this.settings.destinations)
          ? this.settings.destinations.map((d) => (d && d.path) || "")
          : []);
    const seen = new Set();
    const destRoots = [];
    for (const raw of rawDests) {
      const d = (raw || "").trim();
      if (!d) continue;
      const key = normForCompare(d);
      if (seen.has(key)) continue;
      seen.add(key);
      destRoots.push(d);
    }

    if (destRoots.length === 0) {
      if (trigger === "manual") {
        new obsidian.Notice(
          "Vault Backup: configura primero al menos una carpeta de destino en los ajustes."
        );
      }
      return;
    }

    // Ningun destino puede estar dentro del vault (copia recursiva infinita)
    // ni contener el vault. Los invalidos se omiten avisando.
    const validDests = [];
    const invalidDests = [];
    for (const d of destRoots) {
      if (isInside(basePath, d) || isInside(d, basePath)) {
        invalidDests.push(d);
      } else {
        validDests.push(d);
      }
    }

    if (invalidDests.length > 0) {
      new obsidian.Notice(
        "Vault Backup: se omiten destinos dentro del vault (o que lo contienen): " +
          invalidDests.join(", ")
      );
    }

    if (validDests.length === 0) {
      new obsidian.Notice(
        "Vault Backup: ningun destino valido. Elige carpetas externas al vault."
      );
      return;
    }

    this.isBackingUp = true;
    const started = Date.now();
    const mgr = this.progress;
    try {
      const vaultName = path.basename(basePath);

      // Rutas excluidas por el usuario, resueltas a absoluto contra el vault.
      const excluded = (
        Array.isArray(this.settings.excludePaths) ? this.settings.excludePaths : []
      )
        .map((rel) => (rel || "").trim())
        .filter(Boolean)
        .map((rel) => path.resolve(basePath, rel));

      // Red de seguridad: nunca copiar dentro de un destino, ni de una ruta
      // excluida por el usuario, ni el archivo de estado del CLI.
      const cliStatusPath = this.getCliStatusPath();
      const cliStatusNorm = cliStatusPath ? normForCompare(cliStatusPath) : null;
      const skip = (absPath) =>
        validDests.some((d) => isInside(d, absPath)) ||
        excluded.some((ex) => isInside(ex, absPath)) ||
        (cliStatusNorm !== null && normForCompare(absPath) === cliStatusNorm);

      // Una tarjeta de progreso por destino, creada ya (antes de contar) para
      // dar feedback inmediato. La id "dest-N" reutiliza la misma tarjeta entre
      // copias sucesivas a ese destino.
      const panels = validDests.map((destRoot, i) => {
        const panel = mgr.panel("dest-" + i);
        panel.show();
        panel.setTitle(`Destino ${i + 1}`);
        panel.setDest(destRoot);
        panel.setStatus("Preparando copia...");
        panel.setProgress(0, "");
        return panel;
      });

      // Mismos archivos en cada destino: cada tarjeta muestra su propio total.
      const perDest = await this.countFiles(basePath, skip);
      panels.forEach((p) => p.setTotal(perDest));

      // Copia en PARALELO: cada destino esta en su propio disco, asi que copiar
      // a todos a la vez (en vez de uno tras otro) ahorra tiempo. Leer el mismo
      // origen desde varias copias simultaneas es seguro; las escrituras van a
      // carpetas distintas, asi que no hay conflicto. Cada destino reporta su
      // avance en su propia tarjeta y captura su propio error sin tumbar a los
      // demas.
      const results = await Promise.all(
        validDests.map(async (destRoot, i) => {
          const panel = panels[i];
          try {
            fs.mkdirSync(destRoot, { recursive: true });
            const folderName = this.computeBackupFolderName(destRoot);
            const targetDir = path.join(destRoot, folderName, vaultName);
            panel.setStatus(`Copiando "${folderName}"...`);
            const ctx = {
              copied: 0,
              onProgress: (copied, srcPath) =>
                panel.setProgress(copied, path.relative(basePath, srcPath)),
            };
            await this.copyDir(basePath, targetDir, skip, ctx);
            // Repintado FINAL forzado: el contador debe mostrar el total exacto,
            // no quedarse unos archivos corto por el throttle de repintado.
            panel.setProgress(ctx.copied, "", true);

            // Verificacion barata (recuento + tamano) antes de dar por buena la
            // copia de este destino.
            panel.setStatus("Verificando copia...");
            const v = await this.verifyCopy(basePath, targetDir, skip);
            const secs = ((Date.now() - started) / 1000).toFixed(1);
            if (v.count === 0) {
              panel.setDone(`Verificado: ${ctx.copied} archivos en ${secs}s`);
              console.log(
                `[vault-backup] copia "${folderName}" -> ${destRoot}: ${ctx.copied} archivos, verificado (${v.checked})`
              );
              return { ok: true, copied: ctx.copied, verified: true };
            }
            panel.setError(
              `Copiado, pero la verificacion encontro ${v.count} discrepancia(s)`
            );
            panel.showMismatches(v.mismatches, v.count, {
              checked: v.checked,
              destPath: targetDir,
            });
            console.warn(
              `[vault-backup] verificacion de "${destRoot}": ${v.count} discrepancia(s):\n  ` +
                v.mismatches.map(describeMismatch).join("\n  ")
            );
            return { ok: true, copied: ctx.copied, verified: false, verifyCount: v.count };
          } catch (e) {
            console.error(`[vault-backup] error copiando a ${destRoot}:`, e);
            const msg = e && e.message ? e.message : String(e);
            panel.setError(`Error: ${msg}`);
            return { ok: false, error: `${destRoot}: ${msg}` };
          }
        })
      );

      const okCount = results.filter((r) => r.ok).length;
      const copyErrors = results.filter((r) => !r.ok).map((r) => r.error);
      const verifyIssues = results.filter((r) => r.ok && r.verified === false);
      const copiedTotal = results.reduce((n, r) => n + (r.copied || 0), 0);
      const secs = ((Date.now() - started) / 1000).toFixed(1);

      // Resumen global solo en copia manual (la automatica no molesta con avisos).
      if (trigger === "manual") {
        if (copyErrors.length === 0 && verifyIssues.length === 0) {
          new obsidian.Notice(
            `Copia completada y verificada en ${okCount} destino(s): ${copiedTotal} archivos en ${secs}s`
          );
        } else if (copyErrors.length === 0) {
          new obsidian.Notice(
            `Copia hecha, pero la verificacion fallo en ${verifyIssues.length} destino(s). Revisa el panel.`
          );
        } else if (okCount > 0) {
          new obsidian.Notice(
            `Copia parcial: ${okCount} ok, ${copyErrors.length} con error.`
          );
        } else {
          new obsidian.Notice(`Error en la copia: ${copyErrors.join(" | ")}`);
        }
      }
    } catch (e) {
      console.error("[vault-backup] error en la copia:", e);
      if (trigger === "manual") {
        new obsidian.Notice(`Error en la copia: ${e && e.message ? e.message : e}`);
      }
    } finally {
      this.isBackingUp = false;
    }
  }

  /* ---------------- panel para copias desde terminal ---------------- */

  // Ruta del archivo de estado que escribe backup-cli.js (en la carpeta del
  // plugin). Debe coincidir con la que usa el CLI (su __dirname).
  getCliStatusPath() {
    const base = this.getVaultBasePath();
    if (!base) return null;
    const dir =
      this.manifest && this.manifest.dir
        ? this.manifest.dir
        : ".obsidian/plugins/vault-backup";
    return path.join(base, dir, CLI_STATUS_FILE);
  }

  cleanupCliStatus() {
    try {
      const p = this.getCliStatusPath();
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      // Solo es el archivo de estado del CLI; si falla, no pasa nada.
    }
  }

  readCliStatus() {
    try {
      const p = this.getCliStatusPath();
      if (!p) return null;
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      return null;
    }
  }

  startCliWatch() {
    const id = window.setInterval(() => this.cliWatchTick(), 200);
    this.cliWatchId = id;
    this.registerInterval(id);
  }

  // Lee el estado del CLI y refleja su progreso en el panel. No hace nada si el
  // propio plugin esta copiando (en ese caso el panel ya es suyo).
  cliWatchTick() {
    if (this.isBackingUp) return;
    const decision = interpretCliStatus(
      this.readCliStatus(),
      Date.now(),
      this.cliShownFor
    );
    // En ticks inactivos no tocamos el gestor (evita crear una tarjeta "cli"
    // vacia que dejaria la pila sin vaciarse nunca).
    if (decision.action === "none") return;
    // La copia desde terminal usa una unica tarjeta agregada ("cli").
    const panel = this.progress.panel("cli");
    switch (decision.action) {
      case "hide":
        panel.hide();
        this.cliShownFor = null;
        return;
      case "progress":
        if (decision.isNew) {
          panel.show();
          panel.setTitle("Copia desde terminal");
          panel.setDest("");
          this.cliShownFor = decision.startedAt;
        }
        panel.setTotal(decision.total);
        panel.setStatus(decision.status);
        panel.setProgress(decision.copied, decision.file);
        return;
      case "finalize-done":
      case "finalize-error":
        if (decision.isNew) {
          panel.show();
          panel.setTitle("Copia desde terminal");
          panel.setDest("");
          this.cliShownFor = decision.startedAt;
        }
        panel.setTotal(decision.total);
        if (decision.action === "finalize-done") {
          // Repintado final forzado para que el contador llegue al total.
          panel.setProgress(decision.total, "", true);
          panel.setDone(decision.text);
        } else {
          panel.setError(decision.text);
          panel.showMismatches(decision.mismatches, decision.mismatchCount, {
            checked: decision.total,
          });
        }
        this.cliShownFor = null;
        // Consumido: borramos el archivo para no volver a procesarlo.
        this.cleanupCliStatus();
        return;
      default:
        return; // "none"
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pila de tarjetas de progreso (esquina inferior izquierda)          */
/* ------------------------------------------------------------------ */

// Gestiona una pila de tarjetas apiladas en la esquina inferior izquierda: una
// por copia en curso (un destino del plugin, o la copia desde terminal). Crea
// el contenedor cuando hace falta y lo retira cuando ya no queda ninguna.
class BackupProgressManager {
  constructor(app) {
    this.app = app || null;
    this.stackEl = null;
    this.panels = new Map(); // id -> BackupProgressPanel
  }

  ensureStack() {
    if (this.stackEl && this.stackEl.isConnected) return this.stackEl;
    this.stackEl = document.body.createDiv({ cls: "vault-backup-stack" });
    return this.stackEl;
  }

  // Devuelve la tarjeta de un id dado (la crea si no existe). La id agrupa la
  // copia: "dest-0", "dest-1"... para el plugin; "cli" para la copia desde
  // terminal.
  panel(id) {
    let p = this.panels.get(id);
    if (!p) {
      p = new BackupProgressPanel(this, id);
      this.panels.set(id, p);
    }
    return p;
  }

  // La tarjeta avisa al ocultarse para que la olvidemos y, si no queda
  // ninguna visible, retiremos el contenedor de la pila.
  notifyHidden(id) {
    this.panels.delete(id);
    if (this.panels.size === 0 && this.stackEl) {
      this.stackEl.remove();
      this.stackEl = null;
    }
  }

  hideAll() {
    for (const p of Array.from(this.panels.values())) p.hide();
  }
}

// Una tarjeta de progreso individual dentro de la pila.
class BackupProgressPanel {
  constructor(manager, id) {
    this.manager = manager || null;
    this.id = id != null ? id : "default";
    this.el = null;
    this.titleEl = null;
    this.destEl = null;
    this.statusEl = null;
    this.barEl = null;
    this.countEl = null;
    this.fileEl = null;
    // Boton "Ver discrepancias" y datos que muestra su modal. Solo aparece
    // cuando la verificacion posterior a la copia encuentra diferencias.
    this.mismatchBtnEl = null;
    this.mismatches = [];
    this.mismatchCount = 0;
    this.mismatchInfo = {};
    this.total = 0;
    this.lastPaint = 0;
    this.hideTimer = null;
  }

  ensure() {
    if (this.el && this.el.isConnected) return;
    if (this.hideTimer) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    const parent = this.manager ? this.manager.ensureStack() : document.body;
    const el = parent.createDiv({ cls: "vault-backup-panel" });

    const header = el.createDiv({ cls: "vault-backup-panel-header" });
    this.titleEl = header.createSpan({
      cls: "vault-backup-panel-title",
      text: "Copia de seguridad",
    });
    const close = header.createSpan({ cls: "vault-backup-panel-close", text: "×" });
    close.setAttr("aria-label", "Cerrar");
    close.addEventListener("click", () => this.hide());

    this.destEl = el.createDiv({ cls: "vault-backup-dest", text: "" });
    this.statusEl = el.createDiv({ cls: "vault-backup-status", text: "" });

    const barWrap = el.createDiv({ cls: "vault-backup-bar-wrap" });
    this.barEl = barWrap.createDiv({ cls: "vault-backup-bar" });

    this.countEl = el.createDiv({ cls: "vault-backup-count", text: "" });
    this.fileEl = el.createDiv({ cls: "vault-backup-file", text: "" });

    this.el = el;
  }

  show() {
    this.ensure();
    this.el.removeClass("vault-backup-done");
    this.el.removeClass("vault-backup-error");
    // Una copia nueva empieza limpia: fuera el boton de una copia anterior.
    this.clearMismatches();
  }

  // Titulo de la tarjeta (p.ej. "Destino 1" o "Copia desde terminal").
  setTitle(text) {
    this.ensure();
    if (this.titleEl) this.titleEl.setText(text || "Copia de seguridad");
  }

  // Linea con la ruta del destino. Vacia para la copia desde terminal.
  setDest(text) {
    if (!this.destEl) return;
    this.destEl.setText(text || "");
    if (text) this.destEl.setAttr("aria-label", text);
    this.destEl.toggleClass("vault-backup-dest-hidden", !text);
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.setText(text);
  }

  setTotal(n) {
    this.total = n || 0;
  }

  // force omite el limite de repintado: lo usa la actualizacion FINAL (al
  // terminar de copiar) para que el contador muestre el total exacto y no se
  // quede congelado unos archivos antes por el throttle.
  setProgress(copied, relPath, force) {
    if (!this.el) return;
    const now = Date.now();
    // Limita los repintados para no saturar la UI (salvo el final forzado).
    if (!force && now - this.lastPaint < 80) return;
    this.lastPaint = now;
    const pct = this.total > 0 ? Math.min(100, Math.round((copied / this.total) * 100)) : 0;
    this.barEl.style.width = pct + "%";
    this.countEl.setText(
      this.total > 0 ? `${copied} / ${this.total} archivos (${pct}%)` : `${copied} archivos`
    );
    if (relPath) this.fileEl.setText(relPath);
  }

  setDone(text) {
    this.ensure();
    this.el.addClass("vault-backup-done");
    this.barEl.style.width = "100%";
    this.setStatus(text);
    this.fileEl.setText("");
    // Se oculta solo pasados unos segundos.
    this.scheduleHide(6000);
  }

  setError(text) {
    this.ensure();
    this.el.addClass("vault-backup-error");
    this.setStatus(text);
    this.fileEl.setText("");
  }

  // Muestra el boton "Ver discrepancias" con la lista de archivos que no
  // coincidieron en la verificacion. Al pulsarlo abre un modal centrado.
  // list: hasta MAX_REPORT objetos de discrepancia; count: total real;
  // info (opcional): { checked, destPath } para dar contexto en el modal.
  showMismatches(list, count, info) {
    this.ensure();
    this.mismatches = Array.isArray(list) ? list : [];
    this.mismatchCount = count || this.mismatches.length;
    this.mismatchInfo = info || {};
    if (!this.mismatches.length) return;
    if (!this.mismatchBtnEl) {
      this.mismatchBtnEl = this.el.createEl("button", {
        cls: "vault-backup-mismatch-btn",
      });
      this.mismatchBtnEl.addEventListener("click", () => {
        const app = this.manager ? this.manager.app : null;
        new MismatchesModal(app, {
          title: this.titleEl ? this.titleEl.getText() : "",
          destPath: this.mismatchInfo.destPath || "",
          checked: this.mismatchInfo.checked,
          count: this.mismatchCount,
          mismatches: this.mismatches,
        }).open();
      });
    }
    this.mismatchBtnEl.setText(`Ver discrepancias (${this.mismatchCount})`);
  }

  // Quita el boton de discrepancias (al reutilizar la tarjeta en una copia nueva).
  clearMismatches() {
    this.mismatches = [];
    this.mismatchCount = 0;
    this.mismatchInfo = {};
    if (this.mismatchBtnEl) {
      this.mismatchBtnEl.remove();
      this.mismatchBtnEl = null;
    }
  }

  scheduleHide(ms) {
    if (this.hideTimer) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), ms);
  }

  hide() {
    if (this.hideTimer) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
    this.mismatchBtnEl = null;
    this.mismatches = [];
    this.mismatchCount = 0;
    this.mismatchInfo = {};
    if (this.manager) this.manager.notifyHidden(this.id);
  }
}

/* ------------------------------------------------------------------ */
/* Modal de discrepancias                                             */
/* ------------------------------------------------------------------ */

// Ventana centrada que lista los archivos con discrepancias detectados por la
// verificacion. La abre el boton "Ver discrepancias" de una tarjeta de progreso.
// info: { title, destPath, checked, count, mismatches } (mismatches como objetos
// { type: "missing"|"size", rel, srcSize, destSize, label? }).
class MismatchesModal extends obsidian.Modal {
  constructor(app, info) {
    super(app);
    const i = info || {};
    this.destTitle = i.title || "";
    this.destPath = i.destPath || "";
    this.checked = i.checked;
    this.mismatches = Array.isArray(i.mismatches) ? i.mismatches : [];
    this.count = i.count || this.mismatches.length;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass("vault-backup-mismatch-modal");
    titleEl.setText("Discrepancias en la verificacion");

    // --- Contexto: que destino y donde estaba la copia ---
    if (this.destTitle) {
      contentEl.createEl("div", {
        cls: "vault-backup-mismatch-dest",
        text: this.destTitle,
      });
    }
    if (this.destPath) {
      const p = contentEl.createEl("div", {
        cls: "vault-backup-mismatch-path",
        text: this.destPath,
      });
      p.setAttr("aria-label", this.destPath);
    }

    // --- Resumen ---
    const missing = this.mismatches.filter((m) => m.type === "missing").length;
    const sized = this.mismatches.filter((m) => m.type === "size").length;
    const summary = contentEl.createEl("p", {
      cls: "vault-backup-mismatch-summary",
    });
    summary.setText(
      (this.checked ? `Se verificaron ${this.checked} archivos. ` : "") +
        `${this.count} no coinciden entre el vault y la copia.`
    );

    // --- Que significa esto ---
    contentEl.createEl("p", {
      cls: "vault-backup-mismatch-help",
      text:
        "La verificacion comprueba que cada archivo del vault exista en la copia " +
        "con el mismo tamano (no compara el contenido byte a byte). Estos archivos " +
        "no pasaron esa comprobacion:",
    });

    // --- Lista agrupada por tipo de discrepancia ---
    const groups = [
      {
        key: "missing",
        label: "Faltan en la copia",
        items: this.mismatches.filter((m) => m.type === "missing"),
      },
      {
        key: "size",
        label: "Tamano distinto",
        items: this.mismatches.filter((m) => m.type === "size"),
      },
    ];

    for (const g of groups) {
      if (!g.items.length) continue;
      contentEl.createEl("h3", {
        cls: "vault-backup-mismatch-group",
        text: `${g.label} (${g.items.length})`,
      });
      const list = contentEl.createEl("ul", {
        cls: "vault-backup-mismatch-list",
      });
      for (const m of g.items) {
        this.renderItem(list, m);
      }
    }

    // La verificacion guarda un maximo de discrepancias por destino; si el total
    // real es mayor, avisamos de cuantas quedan sin listar.
    if (this.count > this.mismatches.length) {
      contentEl.createEl("p", {
        cls: "vault-backup-mismatch-note",
        text: `Solo se muestran ${this.mismatches.length} de ${this.count}. Revisa la consola de Obsidian (Ctrl+Shift+I) para el detalle completo.`,
      });
    }

    // --- Que hacer ---
    contentEl.createEl("p", {
      cls: "vault-backup-mismatch-hint",
      text:
        "Sugerencia: vuelve a lanzar la copia. Si el problema persiste, comprueba " +
        "que el disco de destino tenga espacio libre y no este protegido contra " +
        "escritura. Las copias anteriores no se tocan.",
    });
  }

  // Pinta una fila: etiqueta de destino (solo en copias desde terminal, que
  // agregan varios destinos), ruta (con la carpeta atenuada y el nombre resaltado)
  // y el detalle de tamanos.
  renderItem(list, m) {
    const li = list.createEl("li", { cls: "vault-backup-mismatch-item" });

    const head = li.createDiv({ cls: "vault-backup-mismatch-item-head" });
    if (m.label) {
      head.createSpan({ cls: "vault-backup-mismatch-tag", text: m.label });
    }
    const rel = m.rel || "";
    const cut = Math.max(rel.lastIndexOf("/"), rel.lastIndexOf("\\"));
    const dir = cut >= 0 ? rel.slice(0, cut + 1) : "";
    const name = cut >= 0 ? rel.slice(cut + 1) : rel;
    const fileEl = head.createSpan({ cls: "vault-backup-mismatch-file" });
    if (dir) fileEl.createSpan({ cls: "vault-backup-mismatch-dir", text: dir });
    fileEl.createSpan({ cls: "vault-backup-mismatch-name", text: name });

    const detail = li.createDiv({ cls: "vault-backup-mismatch-sizes" });
    if (m.type === "missing") {
      detail.setText(
        `No existe en la copia. En el vault ocupa ${formatBytes(m.srcSize)}.`
      );
    } else {
      const diff = (m.srcSize || 0) - (m.destSize || 0);
      const word = diff > 0 ? "faltan" : "sobran";
      detail.setText(
        `Vault: ${formatBytes(m.srcSize)} · Copia: ${formatBytes(m.destSize)} ` +
          `(${word} ${formatBytes(Math.abs(diff))} en la copia)`
      );
    }

    this.addDiffButton(li, m);
  }

  // Anade un boton "Ver diff" que abre un NUEVO modal (DiffModal) por encima de
  // este, con la comparacion lado a lado. Solo si la discrepancia trae las rutas
  // absolutas (datos nuevos); en discrepancias antiguas sin rutas no aparece.
  addDiffButton(li, m) {
    if (!m.srcAbs) return;
    const btn = li.createEl("button", {
      cls: "vault-backup-diff-toggle",
      text: "Ver diff",
    });
    btn.addEventListener("click", () => {
      new DiffModal(this.app, { mismatch: m }).open();
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ */
/* Modal de diff lado a lado (copia | vault)                          */
/* ------------------------------------------------------------------ */

// Modal que se abre POR ENCIMA del de discrepancias y muestra la comparacion de
// un archivo en dos columnas: a la izquierda la copia, a la derecha el vault.
// Lee ambas versiones bajo demanda (por sus rutas absolutas) al abrirse.
// info: { mismatch } con { rel, srcSize, destSize, srcAbs, destAbs, ... }.
class DiffModal extends obsidian.Modal {
  constructor(app, info) {
    super(app);
    this.m = (info && info.mismatch) || {};
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass("vault-backup-diff-modal");
    titleEl.setText("Diff: " + (this.m.rel || ""));
    this.bodyEl = contentEl.createDiv({ cls: "vault-backup-diff-modal-body" });
    this.bodyEl.setText("Cargando diff...");
    this.load().catch((e) => {
      this.bodyEl.empty();
      this.bodyEl.createEl("div", {
        cls: "vault-backup-diff-msg",
        text:
          "No se pudo leer el archivo para el diff: " +
          (e && e.message ? e.message : String(e)),
      });
    });
  }

  // Lee ambas versiones, decide si un diff de texto tiene sentido y lo pinta.
  async load() {
    const m = this.m;
    const src = await readForDiff(m.srcAbs); // vault (origen)
    const dst = m.destAbs
      ? await readForDiff(m.destAbs) // copia
      : { status: "missing" };
    const body = this.bodyEl;
    body.empty();
    const msg = (t) =>
      body.createEl("div", { cls: "vault-backup-diff-msg", text: t });
    const copySize = m.destSize == null ? "no existe" : formatBytes(m.destSize);

    if (src.status === "binary" || dst.status === "binary") {
      msg(
        `Archivo binario: no se muestra diff de texto. Vault: ${formatBytes(m.srcSize)} · Copia: ${copySize}.`
      );
      return;
    }
    if (src.status === "toobig" || dst.status === "toobig") {
      msg(
        `Archivo demasiado grande para el diff (mas de ${formatBytes(DIFF_MAX_BYTES)}). Vault: ${formatBytes(m.srcSize)} · Copia: ${copySize}.`
      );
      return;
    }
    if (src.status === "missing") {
      msg("No se pudo leer el archivo del vault (pudo cambiar tras la copia).");
      return;
    }

    // old = copia, new = vault. Si la copia falta, se lee como vacia: todo el
    // contenido del vault sale como "anadido" (lo que le falta a la copia).
    const oldText = dst.status === "ok" ? dst.text : "";
    const newText = src.text;
    if (dst.status === "missing") {
      msg(
        'Este archivo no existe en la copia. Su contenido en el vault aparece como "anadido" (en verde a la derecha).'
      );
    }
    const oldLines = splitLines(oldText);
    const newLines = splitLines(newText);
    if (oldLines.length > DIFF_MAX_LINES || newLines.length > DIFF_MAX_LINES) {
      msg(
        `El archivo tiene demasiadas lineas (${Math.max(oldLines.length, newLines.length)}) para un diff comodo. Vault: ${formatBytes(m.srcSize)} · Copia: ${copySize}.`
      );
      return;
    }
    const ops = diffLines(oldLines, newLines);
    if (!ops.some((o) => o.t !== "ctx")) {
      msg(
        "El contenido de texto es identico; la diferencia de tamano viene de los saltos de linea o la codificacion."
      );
      return;
    }
    this.renderSideBySide(body, collapseRows(alignDiff(ops), DIFF_CTX));
  }

  // Pinta las filas en una tabla de dos columnas (copia | vault) alineadas.
  renderSideBySide(body, rows) {
    const wrap = body.createDiv({ cls: "vault-backup-diff-split-wrap" });
    const table = wrap.createEl("table", { cls: "vault-backup-diff-split" });

    const cg = table.createEl("colgroup");
    cg.createEl("col", { cls: "vault-backup-diff-col-num" });
    cg.createEl("col", { cls: "vault-backup-diff-col-code" });
    cg.createEl("col", { cls: "vault-backup-diff-col-num" });
    cg.createEl("col", { cls: "vault-backup-diff-col-code" });

    const thead = table.createEl("thead");
    const htr = thead.createEl("tr");
    htr.createEl("th", {
      cls: "vault-backup-diff-th",
      text: "Copia de seguridad",
      attr: { colspan: "2" },
    });
    htr.createEl("th", {
      cls: "vault-backup-diff-th",
      text: "Vault (origen)",
      attr: { colspan: "2" },
    });

    const tbody = table.createEl("tbody");
    for (const row of rows) {
      const tr = tbody.createEl("tr");
      if (row.gap) {
        tr.createEl("td", {
          cls: "vault-backup-diff-gap",
          text: `⋯ ${row.count} linea(s) sin cambios`,
          attr: { colspan: "4" },
        });
        continue;
      }
      this.renderCell(tr, row.left);
      this.renderCell(tr, row.right);
    }
  }

  // Pinta el par de celdas (numero de linea + codigo) de un lado; null = hueco.
  renderCell(tr, side) {
    if (!side) {
      tr.createEl("td", {
        cls: "vault-backup-diff-num vault-backup-diff-empty",
      });
      tr.createEl("td", { cls: "vault-backup-diff-code vault-backup-diff-empty" });
      return;
    }
    const kind =
      side.kind === "del"
        ? "vault-backup-diff-del"
        : side.kind === "add"
          ? "vault-backup-diff-add"
          : "vault-backup-diff-ctx";
    tr.createEl("td", {
      cls: `vault-backup-diff-num ${kind}`,
      text: String(side.num),
    });
    tr.createEl("td", { cls: `vault-backup-diff-code ${kind}`, text: side.text });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ */
/* Pestana de ajustes                                                 */
/* ------------------------------------------------------------------ */

class VaultBackupSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vault Backup" });

    const info = containerEl.createEl("p", {
      text:
        "Copia el vault entero (incluida la carpeta .obsidian) a cada una de las carpetas de destino. " +
        "Cada copia se guarda en una subcarpeta con formato 'DD MM YYYY - N'. Los destinos deben estar FUERA del vault. " +
        "Cada destino tiene su propia copia automatica con su propio intervalo.",
    });
    info.style.opacity = "0.8";
    info.style.fontSize = "0.85em";

    // --- Carpetas de destino (varias, con horario propio) ---
    new obsidian.Setting(containerEl)
      .setName("Carpetas de destino")
      .setDesc(
        "Anade una o varias rutas. La copia manual se guarda en todas a la vez (en " +
          "paralelo). Cada destino puede ademas tener su propia copia automatica."
      )
      .setHeading();

    const dests = this.plugin.settings.destinations;
    if (dests.length === 0) {
      const empty = containerEl.createEl("p", {
        text: "Todavia no hay carpetas de destino. Anade al menos una.",
      });
      empty.style.opacity = "0.8";
      empty.style.fontSize = "0.85em";
    }

    dests.forEach((dest, index) => {
      // Fila 1: ruta del destino + elegir carpeta + eliminar.
      // El campo de texto ocupa todo el ancho disponible para ver bien la ruta.
      const pathSetting = new obsidian.Setting(containerEl)
        .setName(`Destino ${index + 1}`)
        .addText((text) => {
          text
            .setPlaceholder("C:\\Backups\\SECOND BRAIN")
            .setValue(dest.path)
            .onChange(async (value) => {
              dest.path = value;
              await this.plugin.saveSettings();
              this.plugin.applySchedule();
            });
          text.inputEl.addClass("vault-backup-path-input");
          text.inputEl.setAttr("aria-label", "Ruta de la carpeta de destino");
        })
        .addExtraButton((btn) =>
          btn
            .setIcon("folder")
            .setTooltip("Elegir carpeta con el explorador")
            .onClick(async () => {
              const picked = await this.pickFolder();
              if (picked) {
                dest.path = picked;
                await this.plugin.saveSettings();
                this.plugin.applySchedule();
                this.display();
              }
            })
        )
        .addExtraButton((btn) =>
          btn
            .setIcon("trash")
            .setTooltip("Eliminar esta carpeta")
            .onClick(async () => {
              this.plugin.settings.destinations.splice(index, 1);
              await this.plugin.saveSettings();
              this.plugin.applySchedule();
              this.display();
            })
        );
      // Que el control (input + botones) se lleve el ancho, no el nombre.
      pathSetting.settingEl.addClass("vault-backup-path-setting");

      // Fila 2 (sangrada): copia automatica e intervalo para este destino.
      const schedSetting = new obsidian.Setting(containerEl)
        .setName("Copia automatica")
        .setDesc("Copia periodica solo de este destino mientras Obsidian este abierto.")
        .addToggle((tog) =>
          tog.setValue(dest.autoEnabled).onChange(async (value) => {
            dest.autoEnabled = value;
            await this.plugin.saveSettings();
            this.plugin.applySchedule();
          })
        )
        .addText((text) =>
          text
            .setPlaceholder("min")
            .setValue(String(dest.intervalMinutes))
            .onChange(async (value) => {
              const n = parseInt(value, 10);
              if (!isNaN(n) && n > 0) {
                dest.intervalMinutes = n;
                await this.plugin.saveSettings();
                this.plugin.applySchedule();
              }
            })
        );
      schedSetting.controlEl
        .querySelectorAll("input[type='text']")
        .forEach((el) => el.setAttr("aria-label", "Intervalo en minutos"));
      schedSetting.settingEl.style.paddingLeft = "2em";
      schedSetting.settingEl.style.opacity = "0.9";
    });

    new obsidian.Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("Anadir carpeta de destino")
        .onClick(async () => {
          this.plugin.settings.destinations.push({
            path: "",
            autoEnabled: this.plugin.settings.autoEnabled,
            intervalMinutes: this.plugin.settings.intervalMinutes,
          });
          await this.plugin.saveSettings();
          this.display();
        })
    );

    // --- Carpetas/archivos excluidos ---
    new obsidian.Setting(containerEl)
      .setName("Excluir de la copia")
      .setDesc(
        "Rutas (relativas a la raiz del vault) que NO se copiaran. Util para " +
          "carpetas pesadas que no son contenido, como binarios o modelos."
      )
      .setHeading();

    const excludes = this.plugin.settings.excludePaths;
    if (excludes.length === 0) {
      const empty = containerEl.createEl("p", {
        text: "No hay nada excluido. La copia incluye todo el vault.",
      });
      empty.style.opacity = "0.8";
      empty.style.fontSize = "0.85em";
    }

    excludes.forEach((relPath, index) => {
      new obsidian.Setting(containerEl)
        .setName(`Exclusion ${index + 1}`)
        .addText((text) =>
          text
            .setPlaceholder(".claude/skills/.../offline")
            .setValue(relPath)
            .onChange(async (value) => {
              this.plugin.settings.excludePaths[index] = value;
              await this.plugin.saveSettings();
            })
        )
        .addExtraButton((btn) =>
          btn
            .setIcon("trash")
            .setTooltip("Quitar esta exclusion")
            .onClick(async () => {
              this.plugin.settings.excludePaths.splice(index, 1);
              await this.plugin.saveSettings();
              this.display();
            })
        );
    });

    new obsidian.Setting(containerEl).addButton((btn) =>
      btn.setButtonText("Anadir exclusion").onClick(async () => {
        this.plugin.settings.excludePaths.push("");
        await this.plugin.saveSettings();
        this.display();
      })
    );

    // --- Boton manual ---
    new obsidian.Setting(containerEl)
      .setName("Copia manual")
      .setDesc("Lanza una copia de seguridad ahora mismo.")
      .addButton((btn) =>
        btn
          .setButtonText("Hacer copia ahora")
          .setCta()
          .onClick(() => this.plugin.runBackup("manual"))
      );
  }

  // Intenta abrir el dialogo nativo de Electron para elegir carpeta.
  // Si no esta disponible, devuelve null sin romper.
  async pickFolder() {
    try {
      const electron = require("electron");
      const dialog =
        (electron.remote && electron.remote.dialog) || electron.dialog;
      if (!dialog || typeof dialog.showOpenDialog !== "function") return null;
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory", "createDirectory"],
      });
      if (result && !result.canceled && result.filePaths && result.filePaths[0]) {
        return result.filePaths[0];
      }
      return null;
    } catch (e) {
      new obsidian.Notice(
        "No se pudo abrir el selector de carpetas; escribe la ruta a mano."
      );
      return null;
    }
  }
}

module.exports = VaultBackupPlugin;
// Ayudantes puros expuestos solo para pruebas; no afectan a la carga en Obsidian.
module.exports.interpretCliStatus = interpretCliStatus;
module.exports.diffLines = diffLines;
module.exports.alignDiff = alignDiff;
module.exports.collapseRows = collapseRows;
module.exports.looksBinary = looksBinary;
