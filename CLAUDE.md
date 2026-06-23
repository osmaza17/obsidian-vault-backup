# CLAUDE.md

## Proposito

Plugin local de Obsidian que hace una copia de seguridad del vault entero a una o
varias carpetas externas, ya sea manualmente (boton o atajo) o de forma periodica
mientras Obsidian esta abierto. El efecto equivale a copiar la carpeta del vault
desde el explorador y pegarla en otra ruta (o en varias a la vez, de forma
secuencial).

Cada copia se guarda en `<destino>/DD MM YYYY - N/<nombre del vault>/...`, donde `N`
es el numero de copia hecha ese mismo dia (empezando en 1).

## Stack

- JavaScript plano (CommonJS), sin paso de build. Obsidian carga `main.js` directamente.
- API de Obsidian (`require("obsidian")`) y modulos de Node (`fs`, `fs/promises`, `path`)
  via Electron. Por eso `isDesktopOnly: true`.

## Estructura

- `main.js` - todo el codigo del plugin.
  - `VaultBackupPlugin` - clase principal (`onload`/`onunload`, copia, horario).
    - `runBackup(trigger)` - ejecuta una copia a cada carpeta de destino
      configurada (secuencialmente), con guardas de validacion y solape. Omite
      destinos vacios, duplicados o invalidos; si uno falla sigue con los demas.
    - `countFiles(src, shouldSkip)` - cuenta archivos para el progreso.
    - `copyDir(src, dest, shouldSkip, ctx)` - copia recursiva con `fs/promises`
      reportando el avance por archivo via `ctx.onProgress`.
    - `computeBackupFolderName(destPath)` - calcula la carpeta `DD MM YYYY - N`.
    - `applySchedule()` / `clearSchedule()` - intervalo de copia automatica.
    - `addBottomLeftButton()` / `findVaultSwitcher()` - inserta el boton junto al
      conmutador de vault ("Manage vaults") de la barra inferior izquierda.
  - `BackupProgressPanel` - panel flotante no intrusivo en la esquina inferior
    izquierda que muestra el progreso en vivo (estado, barra, recuento, archivo
    actual) sin bloquear el uso de Obsidian.
  - `VaultBackupSettingTab` - pestana de ajustes (lista de destinos con
    anadir/elegir/eliminar, automatico, intervalo).
- `manifest.json` - metadatos del plugin.
- `styles.css` - tamano del icono del boton.
- `data.json` - ajustes del usuario (lo crea Obsidian; ignorado por git).

## Ajustes

- `destPaths` - lista de carpetas de destino (cada una debe estar fuera del vault).
  Se migra automaticamente desde el antiguo campo `destPath` (string) al cargar.
- `autoEnabled` - activa la copia periodica.
- `intervalMinutes` - intervalo en minutos.

## Comandos y atajos

- Comando "Hacer copia de seguridad ahora" con atajo por defecto `Ctrl+S` (`Mod+S`).
- Boton "save" junto al conmutador de vault.

## Convenciones

- Texto de la UI en espanol, sin em dashes.
- Sin dependencias externas ni `node_modules`.
- Guardas de seguridad: sin destinos, destinos vacios/duplicados, destino dentro
  del vault o que lo contiene (evita copia recursiva), y `isBackingUp` para evitar
  solapes.

## Probar

No hay tests automatizados (UI sobre Electron). Recargar el plugin en Obsidian,
fijar una carpeta de destino externa y lanzar una copia con el boton o `Ctrl+S`.
