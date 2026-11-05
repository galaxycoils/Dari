import { registerHooks } from 'node:module';
const replacement = `
  import { appendFileSync } from 'node:fs';
  export class PokiClient {
    async open() { return [{ name: 'observe_device' }]; }
    async close() {}
    async call(name) {
      appendFileSync(process.env.POKI_TEST_DEVICE_CALLS, name + '\\n');
      throw new Error('Device calls are forbidden in this idle supervisor test.');
    }
  }
`;
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/agent/poki-client.mjs')) return { format: 'module', source: replacement, shortCircuit: true };
  const loaded = nextLoad(url, context);
  if (url.endsWith('/agent/scripts/self-chat.mjs')) return { ...loaded, source: String(loaded.source).replace("for (const name of ['poki-native', 'ocr']) await access(resolve('build', name), constants.X_OK);", "/* Native file checks are supplied by this synthetic supervisor fixture. */") };
  return loaded;
} });
