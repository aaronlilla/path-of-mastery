// Node test hook: renderer modules import their own .css (Vite handles that in the app). Under node --test a
// stylesheet import resolves to an empty module, so presenter/component tests load the real modules unchanged.
export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css')) return { url: 'data:text/javascript,export default {}', shortCircuit: true };
  return next(specifier, context);
}
