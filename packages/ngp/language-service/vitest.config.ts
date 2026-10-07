import {defineConfig} from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@angular\/compiler-cli\/private\/(.*)$/,
        replacement: path.resolve(__dirname, '../../compiler-cli/private/$1.ts'),
      },
      {
        find: /^@angular\/compiler-cli$/,
        replacement: path.resolve(__dirname, '../../compiler-cli/index.ts'),
      },
      {
        find: /^@angular\/compiler$/,
        replacement: path.resolve(__dirname, '../../compiler/index.ts'),
      },
      {
        find: /^@angular\/language-service\/private$/,
        replacement: path.resolve(__dirname, '../../language-service/private.ts'),
      },
      {
        find: /^@angular\/language-service$/,
        replacement: path.resolve(__dirname, '../../language-service/api.ts'),
      },
    ],
  },
  test: {
    globals: true,
  },
});
