# PI Agent Web IDE

Browser-based IDE with a coding agent (PI) on the left and a live WebContainer preview on the right.

## Architecture

```mermaid
graph TB
    subgraph Browser["🖥️ Browser"]
        direction LR
        subgraph IDE["IDE Layout"]
            direction LR
            ChatPane["Chat Panel"]
            PreviewPane["Preview Panel"]
        end
        
        subgraph Runtime["Runtime Components"]
            direction TB
            Container["WebContainer Runtime"]
            Terminal["Terminal"]
            Container --> Terminal
        end
    end

    subgraph Backend["☁️ Backend Services"]
        direction TB
        WorkspaceAPI["Workspace API"]
        AgentRuntime["PI Agent Runtime"]
        ProjectSource["Project Source"]
        
        WorkspaceAPI --> ProjectSource
        AgentRuntime --> ProjectSource
    end

    %% Force vertical layout: Browser above, Backend below
    Browser --> Backend
    
    IDE -.->|"instructions"| AgentRuntime
    IDE -.->|"1. request"| WorkspaceAPI
    WorkspaceAPI -.->|"2. files"| Runtime
    ProjectSource -.->|"3. updated"| WorkspaceAPI
    WorkspaceAPI -.->|"4. notify"| IDE
```


## Component Responsibilities

| Component | Role | Location |
|-----------|------|----------|
| **Chat Panel** | User interface for PI agent interaction | Left side (1/3 width) |
| **Preview Panel** | Displays the running application | Right side (2/3 width) |
| **WebContainer Runtime** | Executes the project in a sandboxed browser environment | Client-side |
| **Terminal** | Interactive shell inside the container | Bottom of Preview Panel |
| **Workspace API** | Serves project files and tracks versions | Backend service |
| **PI Agent Runtime** | Processes user instructions and modifies code | Backend service |
| **Project Source** | The actual application being developed | File system |

## Workspace API Execution Flow

When the Preview Panel mounts a workspace, the following sequence occurs:

```mermaid
sequenceDiagram
    participant PP as Preview Panel
    participant API as Workspace API
    participant FS as Project Source
    participant WC as WebContainer
    participant Dev as Dev Server

    PP->>API: GET /v1/workspaces/{id}
    API->>FS: Scan directory, compute revision
    API-->>PP: Manifest (revision, available sources)

    PP->>API: GET /v1/workspaces/{id}/snapshot (or /tree)
    API->>FS: Read files, build representation
    API-->>PP: Binary snapshot / JSON tree

    PP->>WC: mount(snapshot/tree)
    WC-->>PP: Filesystem ready

    PP->>WC: spawn("pnpm install")
    WC-->>PP: Dependencies installed

    PP->>WC: spawn("pnpm run dev")
    WC->>Dev: Start dev server
    Dev-->>PP: server-ready event (port, URL)

    PP->>PP: Load URL in iframe
    PP-->>PP: Display running app
```

## PI Agent Modification Flow

```mermaid
sequenceDiagram
    participant User
    participant CP as Chat Panel
    participant Agent as PI Agent Runtime
    participant FS as Project Source
    participant API as Workspace API
    participant PP as Preview Panel

    User->>CP: "Change header to blue"
    CP->>Agent: POST instruction
    Agent->>FS: Read current files
    Agent->>Agent: Analyze & plan changes
    Agent->>FS: Write modified files
    Agent-->>CP: "Updated header styles"

    CP->>User: Show confirmation

    Note over FS,API: Go API detects<br/>revision change

    User->>PP: Click "Refresh"
    PP->>API: GET /v1/workspaces/{id}
    API->>FS: Scan directory
    API-->>PP: New revision

    PP->>API: GET /snapshot
    API-->>PP: Updated snapshot
    PP->>PP: Re-mount & restart dev server
    PP-->>User: Display updated app
```

## Key Characteristics

- **Separation of Concerns** — UI, runtime, and backend services are independently deployable
- **Eventual Consistency** — Code changes propagate from agent → source → API → preview on explicit refresh
- **Sandboxed Execution** — User code runs in an isolated WebContainer, never on the host
- **Stateless Backend** — Workspace API serves files; no session state persists server-side
- **Resizable Layout** — Both vertical (left/right) and horizontal (preview/terminal) dividers are draggable

## Technology Stack

| Layer | Technology |
|-------|------------|
| IDE Shell | Next.js 16 (App Router), React 19, Tailwind CSS v4 |
| Container Runtime | @webcontainer/api (WASM-based Node.js) |
| Terminal Emulator | xterm.js |
| Workspace API | Go 1.26 (custom binary) |
| Agent Runtime | pi CLI (Node.js, litellm → kimi-k3) |
| Project Template | Next.js 15 (Pages Router), React 19, sql.js (SQLite WASM) |
