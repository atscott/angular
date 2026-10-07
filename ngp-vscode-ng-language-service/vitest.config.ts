import {defineConfig} from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@angular\/compiler-cli\/private\/(.*)$/,
        replacement: path.resolve(__dirname, '../packages/compiler-cli/private/$1.ts'),
      },
      {
        find: /^@angular\/compiler-cli$/,
        replacement: path.resolve(__dirname, '../packages/compiler-cli/index.ts'),
      },
      {
        find: /^@angular\/compiler$/,
        replacement: path.resolve(__dirname, '../packages/compiler/index.ts'),
      },
      {
        find: /^@angular\/language-service\/private$/,
        replacement: path.resolve(__dirname, '../packages/language-service/private.ts'),
      },
      {
        find: /^@angular\/language-service\/api$/,
        replacement: path.resolve(__dirname, '../packages/language-service/api.ts'),
      },
      {
        find: /^@angular\/language-service$/,
        replacement: path.resolve(__dirname, '../packages/language-service/api.ts'),
      },
      {
        find: /^@angular\/core$/,
        replacement: path.resolve(__dirname, '../packages/core/index.ts'),
      },
    ],
  },
  test: {
    globals: true,
  },
});
