# Intelligent AI Editor
> A Windows-first desktop AI-integrated developer terminal and coding environment engineered with Google Gemini API inference, multi-stage safety validation, native PowerShell/CMD execution, and SQLite audit logging.

---

## 1. Project Overview & Purpose
**Intelligent AI Editor** is an autonomous desktop developer environment that bridges natural language requests with real terminal execution and intelligent code synthesis for Windows developers (with cross-platform support).

Unlike web-only chat interfaces or simulated terminal widgets, Intelligent AI Editor executes **real operating system commands** (PowerShell, CMD) through a native execution backend, validates all commands through an authoritative multi-stage safety engine, and persists every session and execution to a local SQLite database.

```
Natural Language Request ("Show my current directory")
                        ↓
             Google Gemini API
                        ↓
            Structured Intent & Shell
                        ↓
        Local Safety & Sanitization Engine
                        ↓
        Authoritative Risk Classification (LOW / MEDIUM / HIGH / BLOCKED)
                        ↓
        Interactive Confirmation (if required)
                        ↓
        REAL PowerShell / CMD Process Execution
                        ↓
        stdout / stderr + Exit Code + Execution Duration
                        ↓
             SQLite Audit History Log
```

---

## 2. System Architecture

| Component | Technology | Role |
|---|---|---|
| **Desktop Shell** | Tauri 2 (Rust) + Native Windows Subsystem | Native desktop windowing, OS integration, installer generation |
| **Frontend UI** | React 18, TypeScript, Vite, Tailwind CSS | Developer cockpit, terminal emulator, AI command card, code editor |
| **Code Editor** | Monaco Editor | Syntax highlighting, code generation, refactoring, and linting |
| **AI Runtime** | Google Gemini API (`@google/genai` SDK) | Natural language command synthesis, code assistance, chat |
| **Default Model** | `gemini-2.5-flash` | Ultra-fast, low-latency, structured reasoning model |
| **Deterministic Fallback** | Local Offline Rule Engine | Instant synthesis when offline or before API key configuration |
| **Safety Engine** | `CommandSanitizer`, `RiskClassifier`, `SafetyValidator` | Authoritative security gatekeeper preventing dangerous commands |
| **Process Execution** | Node.js / ChildProcess & PowerShell/CMD | Real OS process spawning, stream capture, timeout, interruption |
| **Persistence** | SQLite 3 (`data/terminal_history.db`) | Audit trail: prompt, command, shell, risk, status, exit code, execution time |

---

## 3. Google Gemini AI Integration

The application uses the official `@google/genai` TypeScript SDK on the server side:
- **Server-Side Only**: The Gemini API key is never exposed to the frontend or included in client bundles.
- **Environment Variables**:
  ```env
  GEMINI_API_KEY=your_gemini_api_key_here
  GEMINI_MODEL=gemini-2.5-flash
  ```
- **Supported Models**: `gemini-2.5-flash`, `gemini-3.7-flash`, `gemini-3.1-flash-lite`.
- **Structured JSON Synthesis**: Utilizes Gemini's structured response schema to guarantee typed intent, shell, command, explanation, risk, confirmation flag, and clarification questions.

---

## 4. Multi-Stage Safety & Risk Classification Engine

Gemini generates command suggestions, but **the local safety engine is the final and sole authority** before any command can be executed.

### Risk Levels
- **`LOW`** (e.g. `Get-Location`, `Get-ChildItem`, `Get-Date`, `python --version`, `node --version`, `tasklist`, `dir`):
  Safe read-only or inspection commands.
- **`MEDIUM`** (e.g. `New-Item`, `mkdir`, `npm install`, `pip install`, `Move-Item`):
  Modifies filesystem or package state; requires single-click user confirmation.
- **`HIGH`** (e.g. `Remove-Item`, `rmdir`, `Stop-Process -Force`, `Stop-Service`):
  Destructive operations; requires explicit confirmation dialog.
- **`BLOCKED`** (e.g. `format C:`, system drive root deletion, fork bombs, disk partition overwrite):
  Immediately rejected with security policy violation alert. Never executed.

### Ambiguity Handling
Ambiguous destructive requests (e.g. *"Delete the files"*) return a clarification prompt (`needs_clarification: true`) rather than generating dangerous wildcard deletions (`Remove-Item * -Recurse -Force`).

---

## 5. Shell & Windows Command Support

The application is Windows-first and supports:
1. **Windows PowerShell** (`powershell.exe`) & **PowerShell 7** (`pwsh.exe`)
2. **Command Prompt** (`cmd.exe`)
3. **Bash / POSIX** (when running in WSL or Linux environments)

| Natural Language Request | Target Shell: PowerShell | Target Shell: CMD |
|---|---|---|
| "Show my current directory" | `Get-Location` | `cd` |
| "Show all files" | `Get-ChildItem` | `dir` |
| "Check my Python version" | `python --version` | `python --version` |
| "Show running processes" | `Get-Process` | `tasklist` |
| "Find all Python files" | `Get-ChildItem -Recurse -Filter *.py` | `dir /s /b *.py` |
| "Create a folder called test" | `New-Item -ItemType Directory -Name test` | `mkdir test` |
| "Find files containing the word error" | `Select-String -Path "*.*" -Pattern "error" -SimpleMatch` | `findstr /s /i "error" *.*` |

---

## 6. Real OS Terminal Execution & SQLite History

- **Real Process Execution**: All commands run via actual OS processes with captured standard output, standard error, exit codes, and execution duration in milliseconds.
- **SQLite Audit Trail**: All executions (including blocked security attempts) are logged to `data/terminal_history.db`:
  - `prompt`: Natural language input
  - `command`: Synthesized/executed command string
  - `shell`: Target shell environment
  - `risk_level`: `LOW` / `MEDIUM` / `HIGH` / `BLOCKED`
  - `status`: `SUCCESS`, `FAILED`, or `BLOCKED`
  - `exit_code`: Numeric process return code
  - `stdout` & `stderr`: Full stream capture
  - `execution_time_ms`: Milliseconds taken
  - `created_at`: UTC timestamp

---

## 7. Developer Modules

- **Terminal View**: Interactive AI command input, real-time command card with risk badge, dry-run explanation, and direct execution button.
- **Code Assistant**: Integrated Monaco editor with AI code explanation, refactoring, bug fixing, test generation, and syntax formatting.
- **Project Generator**: Instant scaffolding for desktop apps (`tauri-react`), microservices (`express-microservice`), and backend APIs (`fastapi-ai`).
- **File Explorer**: Real filesystem browser allowing browsing, reading, creating, and editing project files.
- **History View**: Searchable audit log of past executions with risk filters and rerun capabilities.
- **Settings**: Shell selection, Gemini model selection, and security threshold configuration.

---

## 8. Windows Setup & Development Instructions

### Prerequisites on Windows
- **Node.js**: v18.0 or higher
- **Rust toolchain**: `rustup` with `stable-x86_64-pc-windows-msvc`
- **Visual Studio 2022 Build Tools**: C++ build tools (including MSVC compiler and linker)
- **PowerShell**: Windows PowerShell 5.1 or PowerShell 7+

### Step-by-Step Setup Commands on Windows

```powershell
# 1. Clone or navigate to the project directory
cd intelligent-ai-editor

# 2. Configure Environment Variables
Copy-Item .env.example .env

# Edit .env and set your Gemini API key:
# GEMINI_API_KEY=your_gemini_api_key_here
# GEMINI_MODEL=gemini-2.5-flash

# 3. Install dependencies
npm.cmd install

# 4. Start local development server
npm.cmd run dev
```

The app will be accessible at `http://localhost:3000`.

---

## 9. Windows Desktop Packaging (Tauri 2)

To compile and package the native Windows `.exe` and `.msi` desktop installer:

```powershell
# Run the automated desktop build script
.\scripts\build-desktop.ps1

# Or run Tauri CLI directly
npm.cmd run tauri:build
```

The packaged installer will be produced in:
`src-tauri/target/release/bundle/msi/` and `src-tauri/target/release/bundle/nsis/`

---

## 10. Automated Verification & Testing

To verify the TypeScript codebase and build production assets:

```powershell
# Run TypeScript type check
npm.cmd run lint

# Run production frontend & server bundle build
npm.cmd run build
```
