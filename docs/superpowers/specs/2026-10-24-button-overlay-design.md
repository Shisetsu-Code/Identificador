# Identificador: botones sin etiquetas semánticas

## Objetivo
Detectar áreas interactivas de una página/juego y dibujar rectángulos con IDs, incluidos los accesos que abren menús de compra y antebet. El resultado dice `kind: button`; no necesita adivinar qué acción ejecuta. La observación no dispara compras ni giros.

## Decisiones de implementación
Node.js + Playwright, navegador local visible, inspector inyectado antes de cargar cada frame. Un overlay con `pointer-events: none` sigue las coordenadas CSS del elemento. El usuario puede operar el juego y el inspector actualiza las cajas. Se exportan JSON y capturas; el detector no llama a modelos.

Se buscan controles DOM visibles y objetos interactivos de motores canvas compatibles. Las señales son listeners/hit areas/event modes, no listas de palabras como BUY o ANTE. Dos controles que abren menús distintos conservan identidades distintas. Se excluyen invisibles, deshabilitados y objetos sin geometría válida. El soporte real del motor se decide a partir del HAR suministrado y se documenta con sus límites.

La memoria persistente guarda firmas de botones confirmados, separadas por juego/frame/contexto. `all` sirve para dibujar; `unknown` contiene únicamente firmas sin confirmar. Se puede confirmar un conjunto de firmas desde JSON sin asignarles una acción.

## Enfoques considerados
- Solo OCR/visión: encuentra candidatos aunque el motor no sea accesible, pero exige modelo y puede confundir decoración con controles.
- DOM solamente: fiable para HTML, insuficiente para juegos canvas.
- DOM + scene graph del motor (elegido por el implementador): detecta interacción y geometría directamente; necesita adaptadores y reporta falta de cobertura para canvas no soportado.

## Entregables
CLI local con URL o HAR offline, overlay vivo, ejemplo sintético reproducible, salida estructurada y memoria, pruebas locales y CI, README en español. El HAR original, recursos propietarios y credenciales de sesión permanecen fuera del repositorio.

## Verificación
Casos de botones con textos arbitrarios, compra/antebet como accesos distintos, controles creados dinámicamente, elementos ocultos, escalado de canvas, frames y separación de firmas conocidas/desconocidas. Se intenta reproducción offline del HAR para contrastar con el juego real, registrando las limitaciones si el archivo no es reproducible.
