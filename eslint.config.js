import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'design'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node-side dev tools (map generator etc.)
    files: ['tools/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    // Architecture rule: src/core/ is pure simulation code. It must stay
    // importable by a future Node server, so it may never touch Phaser,
    // the DOM, or any rendering/scene code.
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'phaser',
              message: 'src/core/ is pure simulation code and must never import Phaser.',
            },
          ],
          patterns: [
            {
              group: ['**/game/**', '**/scenes/**', '**/match/**'],
              message:
                'src/core/ must not import from game/, scenes/, or match/ — it is the pure simulation layer.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'src/core/ must not touch the DOM.' },
        { name: 'document', message: 'src/core/ must not touch the DOM.' },
      ],
    },
  },
  {
    // Phase 9: the headless game server runs core/ + match/ + ai/ under Node.
    // It must never pull in Phaser or any render-side code.
    files: ['server/**/*.ts', 'src/match/**/*.ts', 'src/ai/**/*.ts', 'src/net/protocol.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'phaser',
              message: 'Server-shared code is headless and must never import Phaser.',
            },
            {
              name: 'colyseus.js',
              message: 'colyseus.js is the browser client — server code uses the colyseus package.',
            },
          ],
          patterns: [
            {
              group: ['**/game/**', '**/scenes/**'],
              message: 'Server-shared code must not import render-side code (src/game/, src/scenes/).',
            },
          ],
        },
      ],
    },
  },
);
