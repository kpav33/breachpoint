import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
);
