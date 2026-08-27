import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('client bundle uses the Harness module-loader contract and registers both UI slots', () => {
  const code = fs.readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8');
  let handoff;
  const styles = [];
  const document = {
    querySelector() { return null; },
    createElement() { return { dataset: {}, textContent: '' }; },
    head: { appendChild(value) { styles.push(value); } },
  };
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { handoff = value; } } },
    document,
    CustomEvent: class CustomEvent {},
  };
  vm.runInNewContext(code, sandbox);
  assert.equal(handoff.id, 'dsh-agentgit');
  const react = { useEffect() {}, useState(initial) { return [initial, () => {}]; } };
  const plugin = handoff.factory((specifier) => {
    if (specifier === 'react') return react;
    if (specifier === 'react/jsx-runtime') return { jsx() {}, jsxs() {} };
    throw new Error(`unexpected client dependency: ${specifier}`);
  });
  assert.equal(styles[0].dataset.plugin, 'dsh-agentgit');
  const registrations = [];
  const ctx = {
    slots: {
      inject(_name, setup) { setup(); },
      register(options, component) { registrations.push({ options, component }); return () => {}; },
    },
  };
  plugin.apply(ctx);
  assert.deepEqual(registrations.map((entry) => entry.options.name), ['sidebar.footer.action', 'shell.overlay']);
  assert.deepEqual(Array.from(plugin.inject), ['slots']);
});
