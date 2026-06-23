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
- Si configuras **varias carpetas de destino**, la misma copia se guarda en todas
  ellas (de forma secuencial, una tras otra). Si una falla, se intentan las demas.

## Como se usa

1. Activa el plugin en Ajustes -> Plugins de la comunidad.
2. En los ajustes del plugin, anade una o varias **carpetas de destino** con el
   boton "Anadir carpeta de destino" (deben estar fuera del vault).
3. Haz una copia:
   - Pulsando el boton "save" junto al conmutador de vault (abajo a la izquierda), o
   - Con el atajo `Ctrl+S`, o
   - Con el comando "Hacer copia de seguridad ahora".

### Copia automatica

En los ajustes puedes activar la **copia automatica periodica** e indicar cada
cuantos **minutos** se hace, mientras Obsidian este abierto.

## Ajustes

- **Carpetas de destino**: una o varias rutas absolutas donde se guardan las
  copias. Cada destino recibe su propia copia. Usa "Anadir carpeta de destino"
  para agregar mas y el icono de papelera para quitar una.
- **Copia automatica periodica**: activa o desactiva el guardado por intervalos.
- **Intervalo (minutos)**: frecuencia de la copia automatica.

## Notas

- Solo escritorio (`isDesktopOnly`): usa el sistema de archivos de Node.
- El destino debe estar **fuera** del vault, para evitar una copia recursiva.
- Una copia del vault entero puede tardar y ocupar espacio, ya que incluye
  `.obsidian` (y posibles `node_modules` de otros plugins).

## Instalacion manual

Copia `main.js`, `manifest.json` y `styles.css` a
`<tu-vault>/.obsidian/plugins/vault-backup/` y activa el plugin.

## Licencia

MIT
