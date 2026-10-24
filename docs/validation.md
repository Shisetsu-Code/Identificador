# Validación y alcance

## Comprobación en navegador real

Se ejecutó Chromium local sobre fixtures originales con el inspector inyectado antes de cargar la página.

La demo canvas expone el contrato UHT que inspecciona el adaptador. Se comprobaron dos accesos a menús independientes, cuatro controles al abrir un menú y recuperación de las mismas firmas al cerrarlo. Las imágenes de `docs/images` son capturas de esa demo; no corresponden al juego del HAR.

Las pruebas DOM verifican controles nativos y registrados por listeners o propiedades, exclusión de decoración, controles ocultos/deshabilitados/tapados, altas y bajas dinámicas, frames, coordenadas CSS con devicePixelRatio 2, overlay que permite los clicks y limpieza que conserva la semántica de los listeners.

Las pruebas UHT de contrato verifican proyección por cámara, radio de colliders esféricos, jerarquía activa, transparencia, bloqueo de entrada, controles con arte en hermanos, oclusión y ausencia de despacho de acciones.

Las pruebas de memoria verifican persistencia, separación de juegos/contextos, desconocidos, importaciones inválidas y conservación del archivo ante corrupción. Las de runner verifican exportación, ausencia de clicks automáticos, privacidad de query strings y cierre de ventana.

Última suite completa: **51 pruebas aprobadas, 0 fallidas, 0 omitidas**. También se verificó la sintaxis de los scripts y se revisaron visualmente ambas capturas de la demo.

La revisión independiente identificó cuatro regresiones que quedaron cubiertas y corregidas: botones dentro de iframes transparentes o tapados por el documento padre, opacidad de hosts shadow, transparencia de ancestros del canvas y duplicación de un listener `once` al retirar el inspector.

## Evidencia del HAR recibido

Archivo analizado: `www.pragmaticplay.com_Archive [26-10-24 07-43-21].har`.

- 344 entradas y 18 documentos HTML.
- Juego: Rat Royale; símbolo `vswaysratking`.
- Interacción: UHT (`GameObject`, `Transform`, `Collider`, `UIButton`, `CATButton`, `XTButton`). Renderizado asociado con PIXI; no se determinó su versión exacta.
- Los fragmentos `GUI000`–`GUI006` reconstruyen una escena con 440 colliders.
- Los fragmentos `game000`–`game003` reconstruyen otra escena con 64 colliders.
- Esos conteos incluyen variantes inactivas, prefabs y regiones que no son botones. **No son cantidades de controles visibles.**

Se comprobó la rama de escena `GameRoot/…/GameFeatures/AnteBet/MainButton/…/Colliders/Collider0`, junto con controles de compra y sus menús. Por eso el adaptador recorre todas las raíces y no se limita a la GUI estándar.

`logo_info.js` contiene usos de estas APIs: `GetTransformedCenterAndSize`, `Globals.GetCameraForObject`, `WorldToScreenPoint`, `ScreenToWorldPoint`, `getHoveredCollider`, `globalRenderer.renderer.view`, `activeInHierarchy` y handlers `OnClick`/`OnPress`. El código del repositorio implementa un adaptador propio basado en ese contrato; no distribuye el código del proveedor.

## Límite de reproducción

El manifiesto de `bootstrap.js` referencia recursos que no están en el HAR:

- `desktop/build.js`, con tamaño declarado de 4.793.253 bytes.
- `desktop/client/resources.json`, con tamaño declarado de 1.477.756 bytes.
- 12 fragmentos de `main_resources`: `002`, `003`, `011`–`014`, `023` y `025`–`029`.

Se revisaron las entradas binarias y las URLs data: no contienen un bundle equivalente. `logo_info.js` utiliza el motor preexistente, no lo reemplaza.

Se intentó además la reproducción real con `--har --headless --seconds 2`, exclusivamente offline: el documento abrió, 7 solicitudes no pudieron reproducirse y la última observación tuvo 0 botones. El runner informó recursos ausentes y ausencia de detecciones; no presentó ese resultado como validación del juego.

El HAR sirve para estudiar el contrato y la estructura, pero no permite arrancar todo el juego desde cero. **No se afirma que el adaptador esté validado sobre Rat Royale en ejecución.** Para esa comprobación hay que cargar una demo completa con `--url` o aportar un HAR completo, abrir los menús manualmente y contrastar visualmente las cajas.

## Alcance de las cifras de confianza

Las cifras de confianza son puntuaciones fijas de evidencia estructural, no probabilidades estadísticas. El hit test confirma una zona interactiva en el estado observado; no determina la acción que ejecuta ni garantiza estabilidad después de un cambio de pantalla.
