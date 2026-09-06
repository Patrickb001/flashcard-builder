import { register } from 'node:module';

/**
 * Installs the .ts resolution hooks, for `node --import ./tools/register.mjs`.
 *
 * `--import` runs a module; it does not install loader hooks, so pointing it
 * straight at ts-ext-hooks.mjs silently resolved nothing and every harness
 * script failed on the app's first extensionless import. Registering here is
 * what actually connects them, and it avoids the deprecated `--loader` flag.
 */
// import.meta.url is already a file: URL and resolves the sibling correctly.
// Running it through pathToFileURL would encode it a second time.
register('./ts-ext-hooks.mjs', import.meta.url);
