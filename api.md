# Intelligent AI Editor — Backend REST API Specification

Base URL: `http://127.0.0.1:8000/api/v1`

### 1. System Health
- **GET** `/health`
  - Returns CPU, memory, disk percentage, Google Gemini API status, and database state.

### 2. AI Synthesis & Chat
- **POST** `/ai/synthesize`
  - Request: `{ "prompt": str, "working_directory": str, "shell_type": str, "session_id": str }`
  - Returns: `{ "explanation": str, "steps": list[str], "command": str, "risk_level": "LOW"|"MEDIUM"|"HIGH"|"BLOCKED", "requires_confirmation": bool }`
- **POST** `/ai/chat`
  - Request: `{ "session_id": str, "message": str, "model": str }`
  - Returns: `{ "response": str, "extracted_code": str, "timestamp": str }`
- **GET** `/ai/models`
  - Returns list of available Gemini models.

### 3. Terminal Execution
- **POST** `/terminal/execute`
  - Request: `{ "command": str, "working_directory": str, "shell_type": str, "timeout_seconds": int }`
  - Returns: `{ "status": "SUCCESS"|"FAILED"|"BLOCKED", "exit_code": int, "stdout": str, "stderr": str, "execution_time_ms": float }`
- **GET** `/terminal/shells`
  - Lists detected host shells (PowerShell Core, CMD, Bash, WSL).
- **GET** `/terminal/history`
  - Retrieves recent executed commands with status and output previews.
- **DELETE** `/terminal/history`
  - Clears command execution audit logs.

### 4. Project Scaffolding
- **POST** `/projects/scaffold`
  - Request: `{ "name": str, "template_type": str, "target_directory": str }`
  - Scaffolds complete desktop or backend project structure.
- **GET** `/projects/list`
  - Lists generated projects stored in database.
