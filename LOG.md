# LOG del plugin Vault Backup

Registro de trabajo del plugin, en pasado y con lo mas reciente arriba.

## 30 06 2026

Hice que el panel de progreso aparezca tambien cuando la copia se lanza desde la
terminal (`backup-cli.js`), no solo desde el boton o `Ctrl+S` dentro de Obsidian.

Que hice:
- `backup-cli.js`: ahora escribe su progreso en un archivo de estado
  `.cli-backup-status.json` (en la carpeta del plugin): fases `counting`,
  `copying`, `done` y `error`, con total, copiados y archivo actual. Limpia el
  estado viejo al arrancar y excluye ese archivo de la propia copia (`skip`).
  Escribir el estado es best-effort: si falla, la copia sigue igual.
- `main.js`: anadi un vigilante por polling (200 ms, `startCliWatch`/`cliWatchTick`)
  que lee ese archivo y, si hay una copia de terminal en curso, muestra el MISMO
  `BackupProgressPanel`. No actua si el propio plugin esta copiando (`isBackingUp`).
  Limpia el estado viejo al cargar (`onload`) y para el vigilante en `onunload`.
  Excluye el archivo de estado del `skip` de `runBackup`.
- Extraje la decision a una funcion PURA `interpretCliStatus(st, now, shownStartedAt)`
  (mostrar progreso / finalizar / ocultar si esta obsoleto), exportada aparte para
  poder probarla sin Obsidian. Maneja estados estancados (copia muerta > 30 s) y
  finales viejos (> 15 s) para no resucitar copias antiguas.
- El nombre del archivo de estado (`CLI_STATUS_FILE`) esta declarado en los dos
  archivos; quedan acoplados como ya lo estaba la logica de copia.
- Anadi `test/test-interpret.js` (20 casos de la funcion pura, con stub de
  `obsidian`) y `test/test-cli.js` (integracion: vault falso, muestrea el estado
  durante la copia). Anadi `.cli-backup-status.json` al `.gitignore`. Actualice
  `CLAUDE.md` y `README.md`.

Como lo probe:
- `node test/test-interpret.js`: 20/20 OK (carga el `main.js` real).
- `node test/test-cli.js`: PASS (ciclo `counting -> copying -> done`, 8001/8001).
- Copia real solo al destino local: el archivo de estado quedo EXCLUIDO de la copia
  (verificado) y se escribio bien el estado final `done`.
- Pendiente de comprobacion VISUAL del panel: requiere recargar el plugin en
  Obsidian (la version en ejecucion era la anterior, sin el vigilante) y lanzar
  `node backup-cli.js`. Eso no se puede automatizar desde la terminal.
