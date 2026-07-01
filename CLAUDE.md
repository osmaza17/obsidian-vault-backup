# CLAUDE.md

## Proposito

Plugin local de Obsidian que hace una copia de seguridad del vault entero a una o
varias carpetas externas, ya sea manualmente (boton o atajo) o de forma periodica
mientras Obsidian esta abierto. El efecto equivale a copiar la carpeta del vault
desde el explorador y pegarla en otra ruta (o en varias a la vez). Cuando hay
varios destinos, la copia se hace en PARALELO (todos a la vez), porque suelen estar
en discos distintos y asi se ahorra tiempo; leer el mismo origen desde varias
copias simultaneas es seguro y las escrituras van a carpetas distintas. Cada
carpeta de destino tiene su propio horario de copia automatica (activable de forma
independiente y con su propio intervalo en minutos).

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
      cada carpeta de destino configurada EN PARALELO (`Promise.all`, cada destino
      con su propia tarjeta de progreso); con `onlyPaths` copia solo a esas rutas
      (lo usa cada temporizador para copiar a su propio destino). Guardas de
      validacion y solape. Omite destinos vacios, duplicados o invalidos; cada
      destino captura su propio error sin tumbar a los demas. Tras copiar cada
      destino lo VERIFICA con `verifyCopy` (recuento + tamano); si hay
      discrepancias la tarjeta queda en estado de error aunque la copia en si no
      fallara, y muestra el boton "Ver discrepancias" (`panel.showMismatches`)
      que abre el `MismatchesModal` con la lista de archivos afectados. En copia
      manual, muestra un `Notice` con el resumen al terminar.
    - `countFiles(src, shouldSkip)` - cuenta archivos para el progreso.
    - `copyDir(src, dest, shouldSkip, ctx)` - copia recursiva con `fs/promises`
      reportando el avance por archivo via `ctx.onProgress`.
    - `verifyCopy(src, dest, shouldSkip)` - verificacion BARATA tras copiar cada
      destino: recorre el origen igual que `copyDir` y comprueba via `stat` (sin
      releer el contenido) que cada archivo existe en el destino con el mismo
      tamano. Detecta copias incompletas, truncados o faltantes; NO detecta
      corrupcion bit a bit silenciosa (eso exigiria releer y hashear todo, ~2x
      I/O). Devuelve `{ checked, count, mismatches }`, donde cada discrepancia es
      un objeto `{ type: "missing"|"size", rel, srcSize, destSize }` (el modal las
      pinta con tamanos legibles y agrupadas por tipo).
    - `computeBackupFolderName(destPath)` - calcula la carpeta `DD MM YYYY - N`.
    - `applySchedule()` / `clearSchedule()` - un temporizador independiente por cada
      destino con copia automatica activada, cada uno con su propio intervalo
      (`this.intervalIds`). Cada disparo copia solo a ese destino.
    - `addBottomLeftButton()` / `findVaultSwitcher()` - inserta el boton junto al
      conmutador de vault ("Manage vaults") de la barra inferior izquierda.
    - `startCliWatch()` / `cliWatchTick()` / `readCliStatus()` / `cleanupCliStatus()`
      / `getCliStatusPath()` - vigilan (polling 200 ms) el archivo de estado que
      escribe `backup-cli.js` y, si hay una copia lanzada desde la terminal,
      muestran el MISMO `BackupProgressPanel`. No hacen nada si el propio plugin
      esta copiando (`isBackingUp`); el panel es suyo en ese caso.
  - `interpretCliStatus(st, now, shownStartedAt)` - funcion PURA que decide que
    hacer con el panel a partir del estado del CLI (mostrar progreso, finalizar en
    done/error, ocultar si el estado esta obsoleto). En finalize-error tambien
    propaga `mismatches`/`mismatchCount` del estado para que el panel pueda pintar
    el boton "Ver discrepancias". Se exporta aparte
    (`module.exports.interpretCliStatus`) solo para poder probarla en Node sin
    Obsidian; no afecta a la carga del plugin.
  - `BackupProgressManager` - gestiona una PILA de tarjetas de progreso apiladas en
    la esquina inferior izquierda (contenedor `.vault-backup-stack`). Crea/recupera
    una tarjeta por `id` (`panel(id)`): el plugin usa `dest-0`, `dest-1`... (una por
    destino) y el vigilante del CLI usa `cli` (una sola tarjeta agregada). Retira el
    contenedor cuando no queda ninguna tarjeta visible (`notifyHidden`).
  - `BackupProgressPanel` - una tarjeta flotante no intrusiva (titulo, ruta del
    destino, estado, barra, recuento, archivo actual) que muestra el progreso en
    vivo sin bloquear Obsidian. `setProgress(copied, rel, force)` limita los
    repintados a uno cada 80 ms; el repintado FINAL se llama con `force` para que
    el contador muestre el total exacto y no se quede unos archivos corto por ese
    limite. Al ocultarse avisa a su gestor. Las usan tanto la copia del plugin
    (varias a la vez, una por destino) como la copia lanzada desde la terminal (una
    sola, via el vigilante). Cuando la verificacion falla, `showMismatches(list,
    count, info)` anade un boton "Ver discrepancias" que abre el `MismatchesModal`
    (info opcional: `{ checked, destPath }` para el contexto); `clearMismatches()`
    lo retira al reutilizar la tarjeta en una copia nueva.
  - `MismatchesModal` - modal centrado (`obsidian.Modal`) con contexto de la
    verificacion fallida: nombre y ruta del destino, cuantos archivos se
    verificaron, y la lista de discrepancias AGRUPADA por tipo ("Faltan en la
    copia" / "Tamano distinto") con tamanos legibles (`formatBytes`), que significa
    una discrepancia y que hacer. Recibe `{ title, destPath, checked, count,
    mismatches }`. En copias desde terminal cada discrepancia lleva `label` con el
    destino al que pertenece.
  - `VaultBackupSettingTab` - pestana de ajustes (lista de destinos con
    anadir/elegir/eliminar; cada destino con su propio toggle de copia automatica
    e intervalo en minutos).
- `backup-cli.js` - lanzador de la copia desde la TERMINAL (Node, sin Obsidian).
  Lee `data.json`, deduce la raiz del vault (sube 3 niveles desde la carpeta del
  plugin; se puede forzar con `--vault`) y hace la misma copia que el plugin.
  Tambien copia a todos los destinos EN PARALELO (`Promise.all`), igual que el
  plugin, y verifica cada destino tras copiarlo (`verifyCopy`, recuento + tamano):
  si hay discrepancias termina con codigo de salida 1 aunque la copia no fallara.
  Escribe su progreso en `.cli-backup-status.json` (en la carpeta del plugin) como
  UN solo estado agregado (suma de lo copiado por cada destino) para que, si
  Obsidian esta abierto, el plugin muestre su panel (una sola tarjeta `cli`, no una
  por destino). Si la verificacion encuentra discrepancias, el estado final de
  error tambien incluye `mismatches` (objetos `{ type, rel, srcSize, destSize,
  label }`, el `label` indica el destino) y `mismatchCount` para que el panel del
  plugin pinte el boton "Ver discrepancias".
  La logica de copia esta DUPLICADA a proposito desde
  `main.js` porque el plugin se carga como un unico archivo dentro de Obsidian; si
  cambias la copia en uno, hay que actualizar el otro.
- `.cli-backup-status.json` - archivo EFIMERO de estado que escribe `backup-cli.js`
  durante una copia desde terminal (fase, total, copiados, archivo actual; y en el
  estado final de error por verificacion, `mismatches`/`mismatchCount`). El
  plugin lo vigila para pintar el panel y lo borra al consumir el estado final; el
  CLI lo borra al arrancar una copia nueva. Se excluye de la propia copia y del
  control de versiones (`.gitignore`).
- `test/` - pruebas en Node plano (sin dependencias): `test-interpret.js` (funcion
  pura `interpretCliStatus`, con stub de `obsidian`), `test-cli.js` (integracion
  del CLI contra un vault falso temporal) y `test-verify.js` (la verificacion
  `verifyCopy`: detecta faltantes y truncados, no marca una copia fiel).
- `manifest.json` - metadatos del plugin.
- `styles.css` - tamano del icono del boton, ancho del campo de ruta en ajustes,
  la pila de tarjetas de progreso (`.vault-backup-stack` + `.vault-backup-panel`),
  y el boton/modal de discrepancias (`.vault-backup-mismatch-btn` +
  `.vault-backup-mismatch-list`).
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
  solapes. La copia es de SOLO LECTURA sobre el vault (solo `mkdir`/`copyFile` sobre
  el destino; el unico `unlink` dentro del vault es del propio archivo de estado del
  CLI), asi que no puede corromper el origen.
- Verificacion: tras copiar, `verifyCopy` comprueba recuento + tamano (barato, sin
  releer el contenido). Si se cambia la copia, mantener `verifyCopy` coherente en
  `main.js` y `backup-cli.js` (logica duplicada, igual que la copia).
- El nombre del archivo de estado (`CLI_STATUS_FILE = ".cli-backup-status.json"`)
  esta declarado en `main.js` y en `backup-cli.js`: si cambias uno, cambia el otro,
  o el plugin dejara de ver el progreso del CLI.

## Probar

La UI sobre Electron no se prueba sola, pero la logica si:

- `node test/test-interpret.js` - prueba la funcion pura `interpretCliStatus`
  (transiciones de estado, obsolescencia) cargando `main.js` real con un stub de
  `obsidian`.
- `node test/test-cli.js` - integracion del CLI: crea un vault falso temporal,
  lanza `backup-cli.js`, muestrea el archivo de estado mientras copia y comprueba
  el ciclo `counting -> copying -> done` y los totales. (Si Obsidian esta ABIERTO,
  el plugin puede consumir y borrar el archivo de estado final antes de que el test
  lo lea, dando un falso fallo; correrlo con Obsidian cerrado.)
- `node test/test-verify.js` - prueba la verificacion `verifyCopy`: que detecta un
  archivo faltante y uno truncado, y que no marca nada en una copia fiel.

A mano en Obsidian (lo que NO se puede automatizar): recargar el plugin, lanzar una
copia con el boton o `Ctrl+S` y ver el panel. Para el panel de copias desde
terminal: con Obsidian abierto y el plugin recargado, ejecutar `node backup-cli.js`
y comprobar que aparece el mismo panel con el progreso.

Para `backup-cli.js`: `node backup-cli.js --list` muestra la config sin copiar
nada (comprobacion rapida sin riesgo); `node backup-cli.js` ejecuta la copia real.
