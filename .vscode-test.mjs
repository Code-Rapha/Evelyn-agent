import { defineConfig } from '@vscode/test-cli';

// `out/core-tests/` is intentionally absent: that suite proves the Core runs
// with no host, which is only meaningful outside an extension host. It runs
// under plain mocha via `npm run test:core`.
export default defineConfig({
	files: 'out/test/**/*.test.js',
});
