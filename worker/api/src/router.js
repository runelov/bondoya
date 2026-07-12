// Minimal, null-avhengigheter sti+metode-router (ki-proxy hadde ikke behov
// for dette — ett endepunkt, ingen dispatch — men denne workeren har flere
// ruter fra start og mange flere i senere milestones).
export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const paramNames = [];
    const regexStr = pattern.replace(/:[^/]+/g, (m) => {
      paramNames.push(m.slice(1));
      return '([^/]+)';
    });
    routes.push({ method, regex: new RegExp(`^${regexStr}$`), paramNames, handler });
  }

  async function handle(request, env, ctx) {
    const url = new URL(request.url);
    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const params = {};
      route.paramNames.forEach((name, i) => { params[name] = match[i + 1]; });
      return route.handler({ request, env, ctx, url, params });
    }
    return null; // ingen rute matchet — src/index.js gir 404
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),
    handle,
  };
}
