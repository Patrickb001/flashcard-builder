/**
 * Lets the test tools import the app's .ts modules directly.
 *
 * Source files use extensionless relative imports ("./layoutAnalysis"), which
 * Vite resolves but Node does not. This hook appends the .ts extension so
 * `node --experimental-strip-types` can run the real modules unbundled.
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // Fall through to the default resolution for genuinely missing files.
    }
  }
  return next(specifier, context);
}
