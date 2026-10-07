import { pathToFileURL } from 'node:url';
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
    try {
      const r = await next(specifier.slice(0, -3) + '.ts', context);
      return r;
    } catch {
      // fall through
    }
  }
  const r = await next(specifier, context);
  // Windows: ensure returned url is a proper file:// URL
  if (typeof r.url === 'string' && /^[a-zA-Z]:/.test(r.url)) {
    return { ...r, url: pathToFileURL(r.url).href };
  }
  return r;
}
