# Vault Backup

Plugin de Obsidian que hace una copia de seguridad del vault entero a una o varias
carpetas externas que tu elijas, con un boton o de forma periodica. El resultado
equivale a copiar la carpeta del vault desde el explorador y pegarla en otra ruta
(o en varias a la vez).

## Que hace

- Copia **todo** el vault, incluida la carpeta `.obsidian` (plugins, temas y
  configuracion) y la papelera.
- Cada copia se guarda en una subcarpeta con el formato `DD MM YYYY - N`, donde `N`
  es el numero de copia hecha ese mismo dia (empezando en 1):

  ```
  <destino>/
    18 06 2026 - 1/
      SECOND BRAIN/
        .obsidian/
        ...notas y adjuntos...
    18 06 2026 - 2/
      SECOND BRAIN/
        ...
  ```

- No borra copias antiguas: se guardan todas.
- Si configuras **varias carpetas de destino**, la copia manual se guarda en todas
  ellas **en paralelo** (a la vez), no una tras otra. Como cada destino suele estar
  en un disco distinto, copiar simultaneamente ahorra tiempo. Si una falla, las
  demas continuan.
- Mientras copia veras **una mini ventana de progreso por cada destino**, apiladas
  en la esquina inferior izquierda, cada una con su ruta, su barra y su recuento.
- Al terminar cada destino, **verifica la copia** automaticamente: comprueba que
  todos los archivos esten en el destino con el mismo tamano. Es una comprobacion
  barata (no vuelve a leer el contenido), pensada para detectar copias incompletas
  o archivos truncados. Si algo no cuadra, te avisa en esa tarjeta y aparece un
  boton **"Ver discrepancias"** que abre una ventana centrada con el detalle: el
  destino y su ruta, cuantos archivos se verificaron, y la lista de archivos
  afectados **agrupada por tipo** (los que faltan y los de distinto tamano), con
  los tamanos en el vault y en la copia, una explicacion de que significa y que
  hacer. Ademas, cada archivo de la lista tiene un boton **"Ver diff"** que abre
  **una segunda ventana** (por encima de la anterior) con una comparacion **estilo
  GitHub en dos columnas**: a la izquierda la version de la copia y a la derecha la
  del vault, alineadas linea a linea (anadidas en verde, quitadas en rojo). Para
  los archivos que faltan en la copia se muestra su contenido como "anadido". Los
  archivos binarios (imagenes, PDFs, adjuntos) y los muy grandes no se difean: en
  su lugar se indica el tamano de cada version.
- Cada carpeta de destino tiene su **propia copia automatica**: puedes activarla de
  forma independiente y con un **intervalo distinto** para cada destino. Asi puedes,
  por ejemplo, copiar a una ruta cada 30 minutos y a otra cada 6 horas.
- Puedes **excluir carpetas o archivos** de la copia (rutas relativas a la raiz del
  vault), util para carpetas pesadas que no son contenido (binarios, modelos...).

## Como se usa

1. Activa el plugin en Ajustes -> Plugins de la comunidad.
2. En los ajustes del plugin, anade una o varias **carpetas de destino** con el
   boton "Anadir carpeta de destino" (deben estar fuera del vault).
3. Haz una copia:
   - Pulsando el boton "save" junto al conmutador de vault (abajo a la izquierda), o
   - Con el atajo `Ctrl+S`, o
   - Con el comando "Hacer copia de seguridad ahora".

### Copia automatica (por destino)

Cada carpeta de destino tiene, debajo de su ruta, su propio interruptor de **copia
automatica** y su propio **intervalo en minutos**. Activa solo los destinos que
quieras automatizar y dale a cada uno la frecuencia que prefieras, mientras
Obsidian este abierto. Los temporizadores son independientes entre si.

> Nota: si un destino dispara su copia mientras otra copia ya esta en curso, se
> omite y se reintentara en su siguiente intervalo (no se solapan copias).

### Lanzar desde la terminal (Claude Code)

Puedes lanzar **la misma copia** que hace el boton o `Ctrl+S` desde la terminal,
con un pequeno script de Node (`backup-cli.js`). Funciona aunque Obsidian este
cerrado y usa la misma configuracion (`data.json`):

```sh
# Copia a TODOS los destinos configurados
node "<vault>/.obsidian/plugins/vault-backup/backup-cli.js"

# Solo a algunos destinos, por numero (segun el orden de los ajustes)
node backup-cli.js 1 3

# Solo a una ruta concreta
node backup-cli.js "C:\Backups\SECOND BRAIN"

# Ver la configuracion (vault, destinos, exclusiones) sin copiar nada
node backup-cli.js --list

# Forzar la raiz del vault (si el script no la detecta bien)
node backup-cli.js --vault "<ruta-al-vault>"

# Ayuda
node backup-cli.js --help
```

Por defecto el script deduce la raiz del vault subiendo tres niveles desde la
carpeta del plugin. Requiere tener Node.js instalado. Devuelve codigo de salida 0
si todo fue bien (copiado **y verificado**) y distinto de 0 si hubo errores o si la
verificacion encontro discrepancias, asi que se puede encadenar en scripts.

La copia desde la terminal tambien va **en paralelo** a todos los destinos, igual
que en Obsidian.

**Panel de progreso tambien desde la terminal:** si Obsidian esta abierto cuando
lanzas la copia desde la terminal, veras un panel de progreso en la esquina
inferior izquierda. A diferencia de la copia desde Obsidian (una tarjeta por
destino), la copia desde la terminal muestra **un solo panel agregado** con el
progreso conjunto de todos los destinos. El script escribe su avance en un archivo
de estado (`.cli-backup-status.json`) y el plugin lo refleja en el panel,
incluido el boton "Ver discrepancias" si la verificacion encuentra diferencias.
Si Obsidian esta cerrado, la copia funciona igual, solo que sin panel.

## Ajustes

- **Carpetas de destino**: una o varias rutas absolutas donde se guardan las
  copias. Cada destino recibe su propia copia. Usa "Anadir carpeta de destino"
  para agregar mas y el icono de papelera para quitar una.
  - Debajo de cada ruta: **Copia automatica** (interruptor) e **intervalo en
    minutos**, configurables de forma independiente para ese destino.
- **Excluir de la copia**: lista de rutas (relativas a la raiz del vault) que NO se
  copiaran. Usa "Anadir exclusion" para agregar y el icono de papelera para quitar.

## Notas

- Solo escritorio (`isDesktopOnly`): usa el sistema de archivos de Node.
- El destino debe estar **fuera** del vault, para evitar una copia recursiva.
- La copia es de **solo lectura** sobre el vault: nunca escribe, renombra ni borra
  tus notas de origen, asi que no puede corromperlas.
- La **verificacion** comprueba recuento y tamano (rapido). NO compara el contenido
  bit a bit (eso obligaria a releer todo, mucho mas lento, sobre todo en unidades de
  red como Google Drive), asi que no detecta una corrupcion bit a bit silenciosa,
  que de todas formas es muy rara en una copia recien hecha. Tampoco es atomica: si
  interrumpes una copia a medias, esa carpeta nueva puede quedar incompleta (las
  copias anteriores no se tocan), y la verificacion lo detectaria.
- Una copia del vault entero puede tardar y ocupar espacio, ya que incluye
  `.obsidian` (y posibles `node_modules` de otros plugins).

## Instalacion manual

Copia `main.js`, `manifest.json` y `styles.css` a
`<tu-vault>/.obsidian/plugins/vault-backup/` y activa el plugin. Incluye tambien
`backup-cli.js` si quieres poder lanzar la copia desde la terminal.

## Licencia

MIT
