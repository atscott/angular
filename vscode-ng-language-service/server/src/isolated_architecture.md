# Angular Language Service Architecture for TypeScript 7 (Go)

## 1. Overview & Motivation

With TypeScript 7, the core TypeScript Server implementation moves from a Node.js-based `tsserver` to a native Go binary ("TSGo"). This fundamental shift imposes a hard constraint: **we can no longer perform in-process program manipulations.**

In the legacy Angular Language Service (Node.js), we could:

- Share `ts.Program` instances with TypeScript.
- Hook into strictly internal APIS.
- Mutate source files in memory before they were "seen" by the LS.
- Directly query specific `ts.TypeChecker` APIs.

In the **TS7 / Native** world, the Angular Language Service must run as a separate process (or essentially separate context) and interacts with the TypeScript engine strictly through **LSP-like communication**. The Angular Compiler must run in "isolation" and synchronize its state with the Native TS Server by "speaking its language"—specifically, by feeding it synthetic code (Type Check Blocks) via virtual file events.

## 2. Architecture: The "Isolated Session"

The `IsolatedSession` (`isolated_session.ts`) is the heart of this new architecture. It acts as an **orchestrator** and **middleware** between the VS Code Client and the Angular Compiler.

### High-Level Components

1.  **Angular LS Server (Node.js)**:
    - Hosts the `IsolatedSession`.
    - Manages an independent instances of the Angular Compiler (`NgIsolatedLanguageService`).
    - **Does NOT** share memory with TSGo.
    - **Does NOT** directly spawn TSGo (in the current Relay pattern).

2.  **VS Code Client**:
    - Connects to both the Angular LS Server and the Native TS Server (TSGo).
    - Acts as a **Message Relay** for us.

3.  **Native TS Server (TSGo)**:
    - The source of truth for TypeScript project state (files, dependencies, basic type checking).
    - Owning the "world" of the user's project.

### 3. Key Mechanisms

#### A. Source-to-Source Transformation (`NgtscIsolatedPreprocessor`)

Since we cannot inject behavior into the TS compiler, we use a **Source-to-Source** transformation strategy.

- **Input**: User's Angular templates (.html) and Components (.ts).
- **Process**: The Angular Compiler (`ngtsc`) running in the Isolated Session analyzes the project.
- **Output**:
  - **Type Check Blocks (TCBs)**: Generated `.ngtypecheck.ts` virtual files that represent the type semantics of templates.
  - **Transformed Sources**: Modifications to user `.ts` files (if needed) to enable strictly typed interactions (e.g. signal inputs).

#### B. The Generic Relay

To bridge the gap between our Node.js server and the Native TS Server, we use the Client as a bridge.

1.  **Server -> Client**: The Angular LS sends a generic notification (`angular/sendTsServerNotification`) or request (`angular/sendTsServerRequest`).
2.  **Client Repackaging**: The generic client handler unwraps this and forwards it to the active `ts7Client` (the Native TS extension).
3.  **Client -> TSGo**: The message reaches the Native Server as a standard LSP message (e.g., `textDocument/didOpen`).

This allows the Angular LS to "drive" the Native TS Server without a direct socket connection.

#### C. TCB Synchronization

To get type checking logic (diagnostics, hover, definition) from the Native Server for our Angular templates:

1.  **Generate**: `IsolatedSession` generates `.ngtypecheck.ts` content.
2.  **Sync**: `IsolatedSession` sends `textDocument/didOpen` (via Relay) to TSGo with the TCB content.
3.  **Query**: When a user hovers a template, we calculate the position in the _virtual_ TCB file and send a `textDocument/hover` request (via Relay) to TSGo for that virtual file.
4.  **Result**: TSGo returns the type info for the generated TypeScript code, which we map back to the original HTML template.

## 4. Workflows

### Project Update (File Change)

1.  User types in `app.component.ts`.
2.  Client sends `didChange` to Angular LS.
3.  `IsolatedSession.handleFileChange`:
    - Finds `tsconfig.json`.
    - Updates the internal `NgCompiler` instance.
    - runs `preprocessor.transformAndPrint()` to generate TCBs.
4.  **Diff & Sync**:
    - Checks if `.ngtypecheck.ts` changed.
    - Sends `didChange` (via Relay) to TSGo to update its view of the virtual file.

### Hover Request

1.  Client sends `textDocument/hover` (for `.html` file) to Angular LS.
2.  `IsolatedSession.onHover`:
    - Locates the template node at the position.
    - Determines the corresponding position in the generated `.ngtypecheck.ts`.
    - **Relay Request**: Sends `textDocument/hover` for the `.ngtypecheck.ts` file to TSGo.
3.  TSGo computes type info for the TCB code.
4.  Angular LS receives response, converts range back to source map, and returns to Client.

## 5. Constraints & Properties

- **Zero-Copy ASTs**: We parse our own ASTs; TSGo parses its own. We duplicate some parsing work but gain isolation.
- **LSP Only**: We can only affect TSGo by "acting like a user" (opening/changing files) or acting like a Client (requesting info).
- **Virtual File System**: We must likely maintain a robust mapping of `file://` URIs, as TSGo might be strict about file existence on disk vs. in-memory.
- **Formatting Sensitive**: TCBs must be synchronized _exactly_ as generated. Any whitespace mismatch between what `ngtsc` thinks is there and what we send to TSGo will break source mapping (as seen in the "compact format" bug).
