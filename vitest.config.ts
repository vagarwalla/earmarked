import { defineConfig, configDefaults } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Agent worktrees under .claude/ are full checkouts, so without this every
    // test file runs once per worktree — tripling the suite and starving the
    // workers of CPU, which is what makes wall-clock-sensitive tests flake.
    exclude: [...configDefaults.exclude, '**/.claude/worktrees/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
