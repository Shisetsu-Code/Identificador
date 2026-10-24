# Button Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Dibujar controles como botones genéricos e identificar solamente firmas desconocidas para futuras consultas al modelo.

**Architecture:** Inspector de navegador en cada frame, adaptadores DOM/canvas con geometría CSS, runner Playwright y memoria JSON local con escritura atómica.

**Tech Stack:** Node.js >=22, Playwright, node:test. Sin OCR, modelos ni API keys.

**Spec:** docs/superpowers/specs/2026-10-24-button-overlay-design.md

## Global Constraints
- No clicks de juego automatizados, compras ni giros.
- No publicar HAR, cookies, tokens ni recursos de terceros.
- IDs y `kind: button`, sin clasificación por función.
- Geometría CSS local a cada frame, con procedencia y advertencias de cobertura.

## Review Focus
- Canvas escalado y devicePixelRatio: cajas en coordenadas CSS.
- Controles ocultos o tapados: no presentar elementos inactivos como visibles.
- Menús dinámicos: detectar controles nuevos y retirar los viejos.
- Frames distintos: no mezclar sus firmas ni sus coordenadas.
- Memoria: no marcar botones nuevos como conocidos por una colisión trivial.

## Task 1: Runtime detector and overlay
Files: src/browser/inspector.js, test/browser.test.mjs, test/fixtures/controls.html.
Interface: window.__identificador.scan() returns {version, viewport, buttons, coverage}; .setOverlay(boolean); .destroy(). Each button: {id, signature, kind:'button', source, box:{x,y,width,height}, confidence, evidence}.
- [x] Write browser regression cases; observe absence of detector.
- [x] Implement DOM detection and engine adapter based on HAR evidence.
- [x] Verify separate menu controls, dynamic visibility, scaled bounds, frames and click-through overlay.

## Task 2: Persistent knowledge and offline HAR metadata
Files: src/knowledge.mjs, src/har.mjs, test/knowledge.test.mjs, test/har.test.mjs.
Interfaces: KnowledgeStore.open(path), store.partition(buttons, scope) -> {known, unknown}, store.learn(buttons, scope), await store.save(); readHar(path) -> {entryUrl, summary}.
- [x] Test unknown isolation, persistence, game scope, malformed data and privacy of HAR summary.
- [x] Implement store and HAR metadata extraction without copying private data.
- [x] Run node --test for the new cases.

## Task 3: Runner, example, documentation and release
Files: src/runner.mjs, src/frame-visibility.mjs, bin/identificador.mjs, examples/demo.html, README.md, package.json, .github/workflows/ci.yml.
- [x] Integrate live frames and overlay, --url, --har offline, --headless, --seconds, --output, --learn.
- [x] Export full results plus unknown-only queue with frame metadata; preserve private URLs locally only.
- [x] Test real browser on own fixture; attempt supplied HAR offline and inspect screenshot.
- [x] Independent review, full suite, publish validated files to empty requested repository, verify remote commit.

## Resultado

51 pruebas aprobadas tras la revisión independiente. HAR real probado offline: carga incompleta, cero botones; límite documentado. Publicación del repositorio autorizada por la solicitud original de implementarlo en el repositorio vacío indicado.
