# Isolated Language Service Architecture

This document outlines the architecture of the **Isolated Angular Language Service**, which is designed to run in a separate process from the TypeScript Language Service (tsserver). This separation decoupling allows for better performance and stability, as the Angular analysis does not block the main TypeScript server.

## Overview

The Angular Language Service currently supports two modes of operation:

1.  **Legacy (Plugin Mode)**: Runs as a TypeScript Server Plugin. It shares the same `ts.Program` and `ts.TypeChecker` as tsserver. All operations must be **synchronous**.
2.  **Isolated (Server Mode)**: Runs in its own process (e.g., initialized via `server/src/isolated_session.ts`). It manages its own `NgCompiler` and `ts.Program`. Operations can be **asynchronous**.

## Shared Logic & Adapters

To support both modes without duplicating logic, we use a shared "core" implementation pattern with adapters.

### `LSRequestAdapter`

Located in `src/types.ts`.
This interface abstracts the operations required from the underlying TypeScript language service.

```typescript
export interface LSRequestAdapter {
  getQuickInfoAtPosition(fileName: string, position: number): SyncOrAsync<ts.QuickInfo | undefined>;
  getTypeDefinitionAtPosition(
    fileName: string,
    position: number,
  ): SyncOrAsync<readonly ts.DefinitionInfo[] | undefined>;
}
```

### `SyncOrAsync<T>`

Located in `src/types.ts`.
A utility type `T | Promise<T>` that allows the same implementation to return a value directly (for Legacy) or a Promise (for Isolated).

### `QuickInfoImpl`

Located in `src/quick_info_adapter.ts`.
Contains the core logic for Angular Quick Info (Hover). It accepts:

- `ts.TypeChecker`: For resolving symbol types.
- `LSRequestAdapter`: For querying TypeScript info (e.g., "what is the quick info for this symbol in the generated TCB?").
- `TmplAstNode`: The Angular template node being hovered.

## Implementation details

### Legacy Implementation (`src/quick_info.ts`)

- **Synchronous**: Implements `LSRequestAdapter` by delegating directly to `ts.LanguageService`.
- **Adapter**: `QuickInfoBuilder` implements `LSRequestAdapter`.

### Isolated Implementation (`isolated.ts`)

- **Asynchronous**: Implements `LSRequestAdapter` by delegating to an LSP-based mechanism or local TCB lookup.
- **Entry Point**: `NgIsolatedLanguageService.getQuickInfoAtPosition`.
- **Adapter**: The `lsHandler` passed to `getQuickInfoAtPosition` implements `LSRequestAdapter`.

### Isolated Session (`vscode-ng-language-service/server/src/isolated_session.ts`)

The `IsolatedSession` class manages the isolated server process. It acts as the "Client" to the underlying TypeScript Server for the purpose of the Isolated Language Service.

- **TCB Synchronization**: It syncs generated Type Check Block (TCB) files with the client (or manages them internally) to allow TypeScript requests to succeed on them.
- **LSP Delegation**: When `QuickInfoImpl` asks for `getQuickInfoAtPosition` on a TCB file, `IsolatedSession`'s adapter implementation fetches this data, often by sending an LSP request to the TypeScript server (or acting on its own managed `ts.Program`).

## Diagram

```mermaid
graph TD
    User[User Hover] --> Client[VSCode Client]
    Client -- LSP (textDocument/hover) --> Server[Angular LS Server (Isolated)]

    subgraph "Isolated Process"
        Server --> Session[IsolatedSession]
        Session --> NgLS[NgIsolatedLanguageService]
        NgLS --> QI[QuickInfoImpl]

        QI -- "1. Identify Symbol" --> Compiler[NgCompiler]
        QI -- "2. Get TS Info (Adapter)" --> Adapter[LSRequestAdapter]

        Adapter -.->|Async Call| Session
    end

    Session -- "3. LSP Request (or local)" --> TS[TypeScript Server]
    TS -- "4. TS QuickInfo" --> Session
    Session -- "5. Result" --> Adapter
    Adapter --> QI
    QI --> NgLS
    NgLS --> Session
    Session -- "LSP Response" --> Client
```
