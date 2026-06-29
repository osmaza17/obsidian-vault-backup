"use strict";

const obsidian = require("obsidian");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

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
    this.progress = new BackupProgressPanel();
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

    console.log("[vault-backup] cargado");
  }

  onunload() {
    this.clearSchedule();
    if (this.bottomBtn) {
      this.bottomBtn.remove();
      this.bottomBtn = null;
    }
    if (this.progress) this.progress.hide();
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
    const panel = this.progress;
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
      // excluida por el usuario.
      const skip = (absPath) =>
        validDests.some((d) => isInside(d, absPath)) ||
        excluded.some((ex) => isInside(ex, absPath));

      panel.show();
      panel.setStatus("Preparando copia...");
      panel.setProgress(0, "");

      // Mismos archivos en cada destino: total global = por copia x destinos.
      const perDest = await this.countFiles(basePath, skip);
      panel.setTotal(perDest * validDests.length);

      let copiedTotal = 0;
      let okCount = 0;
      const errors = [];

      for (let i = 0; i < validDests.length; i++) {
        const destRoot = validDests[i];
        const label = `destino ${i + 1}/${validDests.length}`;
        try {
          fs.mkdirSync(destRoot, { recursive: true });
          const folderName = this.computeBackupFolderName(destRoot);
          const targetDir = path.join(destRoot, folderName, vaultName);
          panel.setStatus(`Copiando a ${label}: "${folderName}"...`);

          const base = copiedTotal;
          const ctx = {
            copied: 0,
            onProgress: (copied, srcPath) =>
              panel.setProgress(base + copied, path.relative(basePath, srcPath)),
          };
          await this.copyDir(basePath, targetDir, skip, ctx);
          copiedTotal += ctx.copied;
          okCount++;
          console.log(
            `[vault-backup] copia "${folderName}" -> ${destRoot}: ${ctx.copied} archivos`
          );
        } catch (e) {
          console.error(`[vault-backup] error copiando a ${destRoot}:`, e);
          errors.push(`${destRoot}: ${e && e.message ? e.message : e}`);
        }
      }

      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (errors.length === 0) {
        panel.setDone(
          `Copia completada en ${okCount} destino(s): ${copiedTotal} archivos en ${secs}s`
        );
      } else if (okCount > 0) {
        panel.setError(
          `Copia parcial: ${okCount} ok, ${errors.length} con error. ${errors.join(" | ")}`
        );
      } else {
        panel.setError(`Error en todos los destinos: ${errors.join(" | ")}`);
      }
    } catch (e) {
      console.error("[vault-backup] error en la copia:", e);
      panel.setError(`Error: ${e && e.message ? e.message : e}`);
    } finally {
      this.isBackingUp = false;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Panel de progreso flotante (esquina inferior izquierda)            */
/* ------------------------------------------------------------------ */

class BackupProgressPanel {
  constructor() {
    this.el = null;
    this.statusEl = null;
    this.barEl = null;
    this.countEl = null;
    this.fileEl = null;
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
    const el = document.body.createDiv({ cls: "vault-backup-panel" });

    const header = el.createDiv({ cls: "vault-backup-panel-header" });
    header.createSpan({ cls: "vault-backup-panel-title", text: "Copia de seguridad" });
    const close = header.createSpan({ cls: "vault-backup-panel-close", text: "×" });
    close.setAttr("aria-label", "Cerrar");
    close.addEventListener("click", () => this.hide());

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
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.setText(text);
  }

  setTotal(n) {
    this.total = n || 0;
  }

  setProgress(copied, relPath) {
    if (!this.el) return;
    const now = Date.now();
    // Limita los repintados para no saturar la UI.
    if (now - this.lastPaint < 80) return;
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
        "Anade una o varias rutas. La copia manual se guarda en todas (de forma " +
          "secuencial). Cada destino puede ademas tener su propia copia automatica."
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
