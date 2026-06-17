"use strict";

const obsidian = require("obsidian");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const DEFAULT_SETTINGS = {
  destPath: "",
  autoEnabled: false,
  intervalMinutes: 30,
};

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
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
    this.intervalId = null;
    this.bottomBtn = null;
    this.statusBtn = null;
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* --------------------------- horario --------------------------- */

  clearSchedule() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  applySchedule() {
    this.clearSchedule();
    const mins = Number(this.settings.intervalMinutes);
    if (!this.settings.autoEnabled || !(mins > 0)) return;
    this.intervalId = window.setInterval(
      () => this.runBackup("auto"),
      mins * 60000
    );
    // Para que Obsidian lo limpie tambien al descargar el plugin.
    this.registerInterval(this.intervalId);
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

  // Copia recursiva de src a dest. shouldSkip(absPath) permite excluir
  // rutas (p.ej. la propia carpeta de destino si estuviera dentro del
  // vault). Devuelve el numero de archivos copiados.
  async copyDir(src, dest, shouldSkip) {
    let count = 0;
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src, { withFileTypes: true });
    for (const ent of entries) {
      const srcPath = path.join(src, ent.name);
      if (shouldSkip && shouldSkip(srcPath)) continue;
      const destPath = path.join(dest, ent.name);
      if (ent.isDirectory()) {
        count += await this.copyDir(srcPath, destPath, shouldSkip);
      } else if (ent.isSymbolicLink()) {
        // Copia el destino real del enlace como archivo normal.
        try {
          await fsp.copyFile(srcPath, destPath);
          count++;
        } catch (e) {
          console.error("[vault-backup] no se pudo copiar el enlace:", srcPath, e);
        }
      } else if (ent.isFile()) {
        await fsp.copyFile(srcPath, destPath);
        count++;
      }
      // Otros tipos (sockets, FIFOs...) se ignoran.
    }
    return count;
  }

  async runBackup(trigger) {
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

    const destRoot = (this.settings.destPath || "").trim();
    if (!destRoot) {
      if (trigger === "manual") {
        new obsidian.Notice(
          "Vault Backup: configura primero una carpeta de destino en los ajustes."
        );
      }
      return;
    }

    // El destino no puede estar dentro del vault (copia recursiva infinita).
    if (isInside(basePath, destRoot) || isInside(destRoot, basePath)) {
      new obsidian.Notice(
        "Vault Backup: el destino no puede estar dentro del vault (ni al reves). Elige una carpeta externa."
      );
      return;
    }

    this.isBackingUp = true;
    const started = Date.now();
    try {
      fs.mkdirSync(destRoot, { recursive: true });

      const folderName = this.computeBackupFolderName(destRoot);
      const vaultName = path.basename(basePath);
      const targetDir = path.join(destRoot, folderName, vaultName);

      new obsidian.Notice(`Vault Backup: copiando a "${folderName}"...`);

      // Red de seguridad: nunca copiar dentro del propio destino.
      const skip = (absPath) => isInside(destRoot, absPath);
      const count = await this.copyDir(basePath, targetDir, skip);

      const secs = ((Date.now() - started) / 1000).toFixed(1);
      new obsidian.Notice(
        `Vault Backup: copia completada (${count} archivos, ${secs}s) -> ${folderName}`
      );
      console.log(
        `[vault-backup] copia "${folderName}" completada: ${count} archivos en ${secs}s`
      );
    } catch (e) {
      console.error("[vault-backup] error en la copia:", e);
      new obsidian.Notice(
        `Vault Backup: error en la copia: ${e && e.message ? e.message : e}`
      );
    } finally {
      this.isBackingUp = false;
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
        "Copia el vault entero (incluida la carpeta .obsidian) a la carpeta de destino. " +
        "Cada copia se guarda en una subcarpeta con formato 'DD MM YYYY - N'. El destino debe estar FUERA del vault.",
    });
    info.style.opacity = "0.8";
    info.style.fontSize = "0.85em";

    // --- Carpeta de destino ---
    new obsidian.Setting(containerEl)
      .setName("Carpeta de destino")
      .setDesc("Ruta absoluta donde se guardaran las copias (p.ej. C:\\Backups\\SECOND BRAIN).")
      .addText((text) =>
        text
          .setPlaceholder("C:\\Backups\\SECOND BRAIN")
          .setValue(this.plugin.settings.destPath)
          .onChange(async (value) => {
            this.plugin.settings.destPath = value;
            await this.plugin.saveSettings();
          })
      )
      .addButton((btn) =>
        btn
          .setButtonText("Elegir...")
          .setTooltip("Elegir carpeta con el explorador")
          .onClick(async () => {
            const picked = await this.pickFolder();
            if (picked) {
              this.plugin.settings.destPath = picked;
              await this.plugin.saveSettings();
              this.display();
            }
          })
      );

    // --- Copia automatica ---
    new obsidian.Setting(containerEl)
      .setName("Copia automatica periodica")
      .setDesc("Hace una copia cada cierto tiempo mientras Obsidian este abierto.")
      .addToggle((tog) =>
        tog.setValue(this.plugin.settings.autoEnabled).onChange(async (value) => {
          this.plugin.settings.autoEnabled = value;
          await this.plugin.saveSettings();
          this.plugin.applySchedule();
        })
      );

    new obsidian.Setting(containerEl)
      .setName("Intervalo (minutos)")
      .setDesc("Cada cuantos minutos se hace la copia automatica.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.intervalMinutes))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.intervalMinutes = n;
              await this.plugin.saveSettings();
              this.plugin.applySchedule();
            }
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
