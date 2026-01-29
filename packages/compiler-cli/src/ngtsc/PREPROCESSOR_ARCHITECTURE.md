# Angular Pre-Processor Architecture

## Overview

The `NgtscIsolatedPreprocessor` is a specialized driver for the Angular Compiler that performs **Source-to-Source** transformation. Unlike the standard `NgtscProgram`, which drives a full TypeScript compilation/emit cycle, the pre-processor is designed to sit _upstream_ of a separate TypeScript compiler (such as TSGo or standard `tsc`).

## Goals

1.  **Intermediate TypeScript Generation**: Emits TypeScript code where Angular decorators are replaced by explicit, reified static fields (e.g., `static ɵcmp: i0.ɵɵComponentDeclaration`).
2.  **Type Check Block (TCB) Generation**: Produces "sidecar" `.ngtypecheck.ts` files containing Template Type Check Blocks (TCBs) to support strict template type checking.
3.  **Strict Isolation**: Operates in `experimental-local` mode, ensuring that the compilation of one file does not depend on the global analysis of the entire program. This is critical for performance and scalability in monorepos.
4.  **Valid Output**: The emitted code (both transformed sources and TCBs) must be valid, compilable TypeScript.

## Architecture

### `NgtscIsolatedPreprocessor`

Located in `packages/compiler-cli/src/ngtsc/preprocessor.ts`.

- **Driver**: Orchestrates `NgCompiler` without calling `program.emit()`.
- **Analysis**: Calls `compiler.analyzeAsync()` to populate metadata.
- **Transformation**:
  - Uses `ts.transform` with Angular's Ivy transformers (specifically `ivyTransformFactory`).
  - Uses `ts.createPrinter` to print the transformed source AST back to a string.
- **TCB Generation**: Explicitly calls `compiler.getTemplateTypeChecker().generateAllTypeCheckBlocks()` and captures the resulting `sf.fileName.endsWith('.ngtypecheck.ts')` files.

### Configuration

- **Mode**: `compilationMode: 'experimental-local'`
- **Flags**: `_experimentalEmitIntermediateTs: true` (Critical for enabling type reification in `TraitCompiler`).

## Constraints & Implementation Details

### 1. TCB Syntax Validity

The `TemplateTypeChecker` generates "Completion Ops" (e.g., for `this.` completions) that are designed for the Language Service. By default, these can result in incomplete syntax (e.g., `this.;`).

- **Implementation**: `TcbComponentContextCompletionOp` emits `// @ts-ignore` followed by `this._COMPLETION;`. This preserves the type of `this` for the Language Service while providing a syntactically valid property access that suppresses errors in standard TypeScript compilation.

### 2. Mocking Environment

To verify the output in isolation, the `isolated_compliance` tests simulate the runtime environment:

- Global variables like `ngDevMode` are handled by injecting a `globals.d.ts`.
- Module resolution for `@angular/core` imports is handled by using `moduleResolution: Node10` or `Bundler` with appropriate path mappings in the test `CompilerOptions`.

### 3. Option Configuration

The pre-processor relies on `_experimentalEmitIntermediateTs: true` to trigger Type Reification in the `TraitCompiler`. This flag ensures that `static` fields are emitted with explicit types instead of being emitted as standard Angular static properties.

## Verification

The implementation is verified by:

1.  **`packages/compiler-cli/test/isolated_compliance/isolated_spec.ts`**: A comprehensive test suite that:
    - Runs the pre-processor on test cases.
    - Asserts the existence and content of `.ngtypecheck.ts` files.
    - **Crucially**: Creates an in-memory `ts.Program` from the output and asserts that there are **no pre-emit diagnostics** (syntax or semantic), ensuring downstream compatibility.

## Future Direction

This pre-processor is the foundational block for the "Connected" architecture, where the Angular Language Service (or other tools) can use a lightweight, isolated Angular compiler to prepare sources for a high-performance, native TypeScript server (e.g., TSGo).
