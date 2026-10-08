import { builtinModules } from 'node:module'
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import { reactRefresh } from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

// Process boundary: only src/main/*.ts and src/preload may import Electron, and only code that
// runs in Node.js may import Node.js modules. These rules turn a wrong import into a lint error.
const boundaries = [
  {
    files: ['src/core/**'],
    allowNode: false,
    message: 'src/core is pure TypeScript: no Node.js or Electron imports.'
  },
  {
    files: ['src/main/sessions/**'],
    allowNode: true,
    message:
      'src/main/sessions is plain Node.js: only src/main/*.ts and src/preload import Electron.'
  },
  {
    files: ['src/shared/**'],
    allowNode: false,
    message: 'src/shared holds types for both processes: no Node.js or Electron imports.'
  },
  {
    files: ['src/renderer/**'],
    allowNode: false,
    message: 'The renderer has no Node.js or Electron access. Use window.agentpeek instead.'
  }
]

function boundaryRule({ files, allowNode, message }) {
  const paths = [{ name: 'electron', message }]
  const patterns = []
  if (!allowNode) {
    paths.push(...builtinModules.map((name) => ({ name, message })))
    patterns.push({ group: ['node:*'], message })
  }
  return { files, rules: { 'no-restricted-imports': ['error', { paths, patterns }] } }
}

export default defineConfig(
  { ignores: ['out/', 'dist/', 'coverage/', 'plan/', 'docs/'] },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    }
  },
  {
    // Plain JavaScript files (like this one) are not part of a TypeScript project.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked]
  },

  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite()],
    rules: {
      // Message text must never be inserted as raw HTML.
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Do not render raw HTML. Render text through React instead.'
        }
      ]
    }
  },

  boundaries.map(boundaryRule),

  // Turns off style rules that Prettier handles. Keep this last.
  prettier
)
