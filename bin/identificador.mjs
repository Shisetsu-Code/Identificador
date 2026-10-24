#!/usr/bin/env node
import { parseArgs } from 'node:util';

const help = `Identificador — observa botones genéricos sin realizar clics ni llamar a modelos.

Uso:
  npm start -- --url https://ejemplo.test/juego
  npm start -- --har captura.har
  npm start -- --demo
  npm start -- --learn output/all.json

Opciones:
  --url URL                 Página HTTP/HTTPS que quieres observar.
  --har ARCHIVO             Reproduce un HAR offline; bloquea recursos ausentes.
  --demo                    Abre el ejemplo local (origen predeterminado).
  --headless                Ejecuta sin ventana; observa 5 segundos por defecto.
  --seconds N               Termina tras N segundos (admite decimales).
  --output DIRECTORIO       Guarda all.json, unknown.json, overlay.png y la memoria.
                            Predeterminado: ./output.
  --learn JSON              Confirma firmas del JSON respetando sus scopes.
                            Sin origen explícito, solo importa y termina.
  --remember                Confirma los botones visibles al finalizar la observación.
  --scope CONTEXTO           Distingue juegos que comparten URL; usa un nombre sin secretos.
                            Con una lista --learn sin contexto, fija su scope exacto.
  --executable-path RUTA     Usa un ejecutable Chromium instalado.
  --no-screenshot            Omite overlay.png.
  --help, -h                Muestra esta ayuda.

La ventana visible permanece abierta hasta que la cierres o pulses Ctrl+C.
Puedes operar el juego manualmente; el inspector no hace clics automáticos.
El overlay ámbar indica desconocidos y el verde firmas confirmadas.
--learn acepta exportaciones con frames[].scope, {scope, buttons}, o listas
de {scope, signature}; las firmas sin contexto necesitan --scope.
No incluyas tokens ni credenciales en --scope. Las URL exportadas omiten query y hash.
`;

let controller;
let stop;
try {
  let values;
  try {
    ({ values } = parseArgs({
      strict: true, allowPositionals: false,
      options: {
        url: { type: 'string' }, har: { type: 'string' }, demo: { type: 'boolean' },
        headless: { type: 'boolean' }, seconds: { type: 'string' }, output: { type: 'string' },
        learn: { type: 'string' }, remember: { type: 'boolean' }, scope: { type: 'string' },
        'executable-path': { type: 'string' }, 'no-screenshot': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch { throw new Error('Argumentos no válidos o valor ausente. Usa --help para consultar las opciones.'); }

  if (values.help) {
    process.stdout.write(help);
  } else {
    for (const key of ['url', 'har', 'output', 'learn', 'scope', 'executable-path', 'seconds']) {
      if (values[key] !== undefined && !values[key].trim()) throw new Error(`--${key} necesita un valor no vacío.`);
    }
    const options = {
      url: values.url, har: values.har, demo: values.demo, headless: values.headless,
      seconds: values.seconds === undefined ? undefined : Number(values.seconds),
      output: values.output, learn: values.learn, remember: values.remember, scope: values.scope,
      executablePath: values['executable-path'], screenshot: !values['no-screenshot'],
    };
    const { run } = await import('../src/runner.mjs');
    controller = new AbortController();
    stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (!options.learn || options.url || options.har || options.demo) {
      process.stdout.write('Observación local sin clics. Cierra la ventana o pulsa Ctrl+C para guardar.\n');
    }
    const result = await run({ ...options, signal: controller.signal });
    if (result.snapshot) {
      const total = result.snapshot.totals;
      process.stdout.write(`Captura: ${total.buttons} botones; ${total.known} conocidos y ${total.unknown} desconocidos, en ${total.frames} frames.\n`);
      process.stdout.write(`Resultados: ${result.files.all}\nSolo desconocidos: ${result.files.unknown}\n`);
      if (result.files.screenshot) process.stdout.write(`Imagen: ${result.files.screenshot}\n`);
      for (const warning of result.warnings) process.stderr.write(`Aviso: ${warning}\n`);
    }
    if (options.learn) process.stdout.write(`Firmas nuevas confirmadas: ${result.learned}. Memoria: ${result.files.knowledge}\n`);
  }
} catch (error) {
  // Errors emitted by the runner are deliberately contextual and contain no request URLs.
  const message = error?.code === 'ERR_MODULE_NOT_FOUND'
    ? 'Faltan dependencias. Ejecuta npm install y vuelve a intentarlo.'
    : error.message || 'La observación no pudo completarse.';
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
} finally {
  if (stop) {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
