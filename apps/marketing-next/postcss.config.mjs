/**
 * Identical in content to apps/web/postcss.config.js, but `.mjs`:
 * this package has no `"type": "module"` (Next's own tooling reads the
 * app package.json and a bare `"type": "module"` breaks `next build`'s
 * generated `.next/standalone/server.js` require graph), so a `.js`
 * config would be parsed as CommonJS and the `export default` below
 * would be a syntax error. Next resolves `.mjs` config files natively.
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
