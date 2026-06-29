# CLAUDE.md

## Proposito

Plugin local de Obsidian que hace una copia de seguridad del vault entero a una o
varias carpetas externas, ya sea manualmente (boton o atajo) o de forma periodica
mientras Obsidian esta abierto. El efecto equivale a copiar la carpeta del vault
desde el explorador y pegarla en otra ruta (o en varias a la vez, de forma
secuencial). Cada carpeta de destino tiene su propio horario de copia automatica
(activable de forma independiente y con su propio intervalo en minutos).

Cada copia se guarda en `<destino>/DD MM YYYY - N/<nombre del vault>/...`, donde `N`
es el numero de copia hecha ese mismo dia (empezando en 1).

## Stack

- JavaScript plano (CommonJS), sin paso de build. Obsidian carga `main.js` directamente.
- API de Obsidian (`require("obsidian")`) y modulos de Node (`fs`, `fs/promises`, `path`)
  via Electron. Por eso `isDesktopOnly: true`.

## Estructura

- `main.js` - todo el codigo del plugin.
  - `VaultBackupPlugin` - clase principal (`onload`/`onunload`, copia, horario).
    - `runBackup(trigger, onlyPaths)` - ejecuta una copia. Sin `onlyPaths` copia a
      cada carpeta de destino configurada (secuencialmente); con `onlyPaths` copia
      solo a esas rutas (lo usa cada temporizador para copiar a su propio destino).
      Guardas de validacion y solape. Omite destinos vacios, duplicados o
      invalidos; si uno falla sigue con los demas.
    - `countFiles(src, shouldSkip)` - cuenta archivos para el progreso.
    - `copyDir(src, dest, shouldSkip, ctx)` - copia recursiva con `fs/promises`
      reportando el avance por archivo via `ctx.onProgress`.
    - `computeBackupFolderName(destPath)` - calcula la carpeta `DD MM YYYY - N`.
    - `applySchedule()` / `clearSchedule()` - un temporizador independiente por cada
      destino con copia automatica activada, cada uno con su propio intervalo
      (`this.intervalIds`). Cada disparo copia solo a ese destino.
    - `addBottomLeftButton()` / `findVaultSwitcher()` - inserta el boton junto al
      conmutador de vault ("Manage vaults") de la barra inferior izquierda.
  - `BackupProgressPanel` - panel flotante no intrusivo en la esquina inferior
    izquierda que muestra el progreso en vivo (estado, barra, recuento, archivo
    actual) sin bloquear el uso de Obsidian.
  - `VaultBackupSettingTab` - pestana de ajustes (lista de destinos con
    anadir/elegir/eliminar; cada destino con su propio toggle de copia automatica
    e intervalo en minutos).
- `backup-cli.js` - lanzador de la copia desde la TERMINAL (Node, sin Obsidian).
  Lee `data.json`, deduce la raiz del vault (sube 3 niveles desde la carpeta del
  plugin; se puede forzar con `--vault`) y hace la misma copia que el plugin.
  La logica de copia esta DUPLICADA a proposito desde `main.js` porque el plugin se
  carga como un unico archivo dentro de Obsidian; si cambias la copia en uno, hay
  que actualizar el otro.
- `manifest.json` - metadatos del plugin.
- `styles.css` - tamano del icono del boton y ancho del campo de ruta en ajustes.
- `data.json` - ajustes del usuario (lo crea/actualiza Obsidian; incluido en el repo).

## Ajustes

- `destinations` - lista de carpetas de destino. Cada una es un objeto
  `{ path, autoEnabled, intervalMinutes }` (cada `path` debe estar fuera del vault).
  Migracion automatica al cargar desde formatos antiguos: `destPaths` (lista de
  strings) y `destPath` (un solo string); cada uno hereda los valores globales
  `autoEnabled`/`intervalMinutes` como horario por defecto.
- `excludePaths` - lista de rutas (relativas a la raiz del vault) que NO se copian.
  Se resuelven a absoluto contra la raiz del vault y se cablean en la funcion `skip`
  de `runBackup` (junto a la guarda de no-copiar-dentro-de-un-destino).
- `autoEnabled` / `intervalMinutes` - ya no controlan un horario global; solo sirven
  como valores por defecto al anadir un destino nuevo (y para la migracion).

## Comandos y atajos

- Comando "Hacer copia de seguridad ahora" con atajo por defecto `Ctrl+S` (`Mod+S`).
- Boton "save" junto al conmutador de vault.
- Terminal: `node backup-cli.js` (todos los destinos), `node backup-cli.js 1 3`
  (destinos por numero), `--list` (ver config), `--vault "<ruta>"` (forzar vault),
  `--help`. Util para que Claude Code dispare la misma copia desde la terminal.

## Convenciones

- Texto de la UI en espanol, sin em dashes.
- Sin dependencias externas ni `node_modules`.
- Guardas de seguridad: sin destinos, destinos vacios/duplicados, destino dentro
  del vault o que lo contiene (evita copia recursiva), y `isBackingUp` para evitar
  solapes.

## Probar

No hay tests automatizados (UI sobre Electron). Recargar el plugin en Obsidian,
fijar una carpeta de destino externa y lanzar una copia con el boton o `Ctrl+S`.

Para `backup-cli.js`: `node backup-cli.js --list` muestra la config sin copiar
nada (comprobacion rapida sin riesgo); `node backup-cli.js` ejecuta la copia real.
