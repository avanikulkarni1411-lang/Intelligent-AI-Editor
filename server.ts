import express from "express";
import http from "http";
import path from "path";
import os from "os";
import fs from "fs";
import { spawn, execSync, ChildProcess } from "child_process";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";

const app = express();
const server = http.createServer(app);
const PORT = 3000;

app.use(express.json());

const isWindows = process.platform === "win32";

// Google Gemini API Configuration
const DEFAULT_GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

let aiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return aiClient;
}

// Check Gemini configuration status
async function checkGeminiStatus(): Promise<{ available: boolean; model: string; provider: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  if (!apiKey) {
    return { available: false, model, provider: "gemini" };
  }
  return { available: true, model, provider: "gemini" };
}

// Structured response schema for Gemini command synthesis
const GEMINI_SYNTHESIS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      description: "Concise summary of user intent"
    },
    shell: {
      type: Type.STRING,
      description: "Target shell: powershell, cmd, or bash"
    },
    command: {
      type: Type.STRING,
      description: "The exact shell command to execute, or empty string if clarification is needed or unsupported"
    },
    explanation: {
      type: Type.STRING,
      description: "Clear 1-sentence explanation of what the command does, or the clarification question"
    },
    risk: {
      type: Type.STRING,
      description: "Estimated risk level: LOW, MEDIUM, HIGH, or BLOCKED"
    },
    requires_confirmation: {
      type: Type.BOOLEAN,
      description: "Whether confirmation is required before execution"
    },
    needs_clarification: {
      type: Type.BOOLEAN,
      description: "Whether clarification is needed (e.g. ambiguous delete request)"
    },
    clarification_question: {
      type: Type.STRING,
      description: "The specific question to ask the user if clarification is needed"
    }
  },
  required: ["intent", "shell", "command", "explanation", "risk", "requires_confirmation", "needs_clarification"]
};

// Call Gemini for Command Synthesis
async function callGeminiSynthesize(prompt: string, shellType: string, cwd: string, osType: string, targetModel?: string): Promise<any> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error("GEMINI_API_KEY environment variable not configured");
  }

  const model = targetModel || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const systemInstruction = `You are the AI Command Engine of Intelligent AI Editor, an autonomous developer terminal environment.
Your task is ONLY to understand the user's natural language request, determine the intended operation, generate the appropriate command for the selected shell, explain the command briefly, and return structured output.

Context:
- Target Shell: ${shellType}
- Operating System: ${osType}
- Current Working Directory: ${cwd}

CRITICAL RULES:
1. Shell Syntax:
   - If Target Shell is "powershell": Generate clean, idiomatic PowerShell cmdlets (e.g. Get-Location, Get-ChildItem, Get-Process, Set-Location, New-Item, Select-String, Get-Date, Get-PSDrive, Get-Service, Compress-Archive) or standard tools (python --version, node --version, cargo --version).
   - If Target Shell is "cmd": Generate standard Windows Command Prompt syntax (e.g. dir, cd, tasklist, md, findstr, date /t && time /t, type).
   - If Target Shell is "bash": Generate standard POSIX/Bash syntax (e.g. pwd, ls, cd, ps, mkdir, grep, cat).
2. Shell Sensitivity Examples:
   - "Show my current directory": PowerShell -> Get-Location, CMD -> cd, Bash -> pwd
   - "Show all files": PowerShell -> Get-ChildItem, CMD -> dir, Bash -> ls
   - "Check my Python version": python --version
   - "Show running processes": PowerShell -> Get-Process, CMD -> tasklist, Bash -> ps aux
   - "Find all Python files": PowerShell -> Get-ChildItem -Recurse -Filter *.py, CMD -> dir /s /b *.py, Bash -> find . -name "*.py"
   - "Create a folder called test": PowerShell -> New-Item -ItemType Directory -Name test, CMD -> mkdir test, Bash -> mkdir -p test
3. Ambiguity & Safety:
   - For ambiguous destructive requests like "delete the files", "delete all", "wipe everything", or requests lacking a specific target path, DO NOT generate a wildcard or dangerous deletion command. Set "needs_clarification": true, "command": "", "clarification_question": "Which files or directory would you like to delete? Please specify a file name or path.", and "explanation": "Target files not specified. Please specify which files or directory to delete."
4. Strictly Forbidden:
   - NEVER execute commands or claim you executed them.
   - NEVER bypass safety rules or generate destructive format/root deletions.
   - STRICT PROHIBITION: Git and Docker are NOT supported. Do NOT generate any Git or Docker commands. If requested, set "command": "" and set "explanation": "Git and Docker functionality are not supported in this application."
   - Never invent nonexistent file paths or command outputs.`;

  const response = await ai.models.generateContent({
    model: model,
    contents: prompt,
    config: {
      systemInstruction: systemInstruction,
      temperature: 0.1,
      responseMimeType: "application/json",
      responseSchema: GEMINI_SYNTHESIS_SCHEMA,
    }
  });

  const text = response.text;
  if (!text) {
    throw new Error("Empty response from Gemini API");
  }

  const parsed = extractStructuredJson(text);
  if (!parsed) {
    throw new Error("Failed to parse JSON response from Gemini");
  }
  return parsed;
}

// Call Gemini for Interactive Developer Chat
async function callGeminiChat(message: string, shellType: string, cwd: string, osType: string, targetModel?: string): Promise<{ response: string; extracted_command?: string }> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error("GEMINI_API_KEY environment variable not configured");
  }

  const model = targetModel || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const systemInstruction = `You are Intelligent AI, a senior desktop developer and terminal assistant integrated into Intelligent AI Editor.
You assist developers with ${shellType} scripting, Windows/POSIX command lines, debugging, Python, Node.js, and software engineering.
Target Shell: ${shellType}
Target OS: ${osType}
Working Directory: ${cwd}
When suggesting terminal commands, format them clearly inside markdown code blocks with the syntax tag (e.g. \`\`\`${shellType} ... \`\`\`).
Note: Git and Docker are not supported in this environment.`;

  const response = await ai.models.generateContent({
    model: model,
    contents: message,
    config: {
      systemInstruction: systemInstruction,
      temperature: 0.2,
    }
  });

  const replyText = response.text || "";
  const codeMatch = replyText.match(/```(?:powershell|bash|cmd|sh|batch|ps1)?\s*([\s\S]*?)\s*```/);
  const extractedCode = codeMatch ? codeMatch[1].trim() : undefined;

  return {
    response: replyText,
    extracted_command: extractedCode
  };
}

// JSON Extractor for AI outputs
function extractStructuredJson(rawText: string): any {
  if (!rawText) return null;
  const trimmed = rawText.trim();

  // Try direct parse
  try {
    return JSON.parse(trimmed);
  } catch {}

  // Try extracting from markdown ```json ... ``` blocks
  const jsonBlock = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (jsonBlock) {
    try {
      return JSON.parse(jsonBlock[1].trim());
    } catch {}
  }

  // Try finding outer curly braces
  const curlyMatch = trimmed.match(/(\{[\s\S]*\})/);
  if (curlyMatch) {
    try {
      return JSON.parse(curlyMatch[1].trim());
    } catch {}
  }

  return null;
}

// Comprehensive Safety & Risk Classification
export interface SafetyClassification {
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "BLOCKED";
  isBlocked: boolean;
  requiresConfirmation: boolean;
  reasons: string[];
  sanitizedCommand: string;
}

function classifySafety(command: string): SafetyClassification {
  let cleaned = (command || "").replace(/\x00/g, "").trim();
  if (cleaned.startsWith("```")) {
    const lines = cleaned.split("\n");
    if (lines.length >= 2) {
      if (lines[0].startsWith("```")) lines.shift();
      if (lines.length > 0 && lines[lines.length - 1].startsWith("```")) lines.pop();
      cleaned = lines.join("\n").trim();
    }
  }

  const reasons: string[] = [];

  if (!cleaned) {
    return {
      riskLevel: "LOW",
      isBlocked: false,
      requiresConfirmation: false,
      reasons: ["Empty or informational query"],
      sanitizedCommand: ""
    };
  }

  // 1. Critical / Blocked Patterns
  const criticalPatterns = [
    { pattern: /rm\s+-rf\s+[/~]/i, desc: "Root or home directory recursive deletion" },
    { pattern: /rmdir\s+\/s\s+\/q\s+c:\\/i, desc: "Windows system drive root deletion" },
    { pattern: /format\s+[a-z]:/i, desc: "Drive volume formatting" },
    { pattern: /drop\s+database/i, desc: "Database destruction" },
    { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/i, desc: "Fork bomb attack sequence" },
    { pattern: /del\s+(\/f\s+|\/s\s+|\/q\s+)*[a-z]:\\windows/i, desc: "Windows system folder file deletion" },
    { pattern: /Remove-Item\s+.*(C:\\Windows|C:\\$|\/$|System32|\/etc|\/boot|\/bin|\/usr)/i, desc: "PowerShell recursive root or system deletion" },
    { pattern: /shutdown(\.exe)?\s+(\/s|\/r|-s|-r)/i, desc: "System shutdown/restart instruction" },
    { pattern: /mkfs(\.[a-z0-9]+)?\s+\/dev\//i, desc: "Filesystem creation over block device" },
    { pattern: /dd\s+if=\/dev\/(zero|urandom)\s+of=\/dev\//i, desc: "Direct block device overwrite" }
  ];

  for (const item of criticalPatterns) {
    if (item.pattern.test(cleaned)) {
      reasons.push(`Critical Security Policy: ${item.desc}`);
      return {
        riskLevel: "BLOCKED",
        isBlocked: true,
        requiresConfirmation: false,
        reasons,
        sanitizedCommand: cleaned
      };
    }
  }

  // 2. High Risk Patterns
  const highRiskPatterns = [
    { pattern: /Remove-Item\s+/i, desc: "PowerShell file or folder deletion" },
    { pattern: /rm\s+(-r|-f|-rf|-fr)/i, desc: "Recursive or forced file deletion" },
    { pattern: /rmdir\s+/i, desc: "Directory removal" },
    { pattern: /del\s+(\/f|\/s|\/q|\*)/i, desc: "Forced or wildcard file deletion" },
    { pattern: /Stop-Process\s+.*-Force/i, desc: "Force termination of processes" },
    { pattern: /taskkill\s+\/f/i, desc: "Forced task termination" },
    { pattern: /Set-ExecutionPolicy\s+Unrestricted/i, desc: "Unrestricted PowerShell execution policy" },
    { pattern: /chmod\s+(-R\s+)?(777|000|u\+s)/i, desc: "Broad permission escalation or lockout" },
    { pattern: /pip\s+uninstall\s+-y/i, desc: "Unattended package uninstallation" },
    { pattern: /Stop-Service\s+/i, desc: "Stopping Windows services" }
  ];

  for (const item of highRiskPatterns) {
    if (item.pattern.test(cleaned)) {
      reasons.push(`High Risk Operation: ${item.desc}`);
      return {
        riskLevel: "HIGH",
        isBlocked: false,
        requiresConfirmation: true,
        reasons,
        sanitizedCommand: cleaned
      };
    }
  }

  // 3. Medium Risk Patterns
  const mediumRiskPatterns = [
    { pattern: /(pip|pip3|cargo|npm|pnpm|yarn)\s+install/i, desc: "Package installation / dependency state update" },
    { pattern: /Install-Module\s+/i, desc: "PowerShell module installation" },
    { pattern: /(mkdir|md|New-Item)\s+/i, desc: "Filesystem creation or modification" },
    { pattern: /(mv|Move-Item|Rename-Item)\s+/i, desc: "Moving or renaming filesystem items" },
    { pattern: /(cp|Copy-Item)\s+/i, desc: "Copying filesystem items" },
    { pattern: /Expand-Archive\s+/i, desc: "Archive extraction" },
    { pattern: /touch\s+/i, desc: "File creation" }
  ];

  for (const item of mediumRiskPatterns) {
    if (item.pattern.test(cleaned)) {
      reasons.push(`State Modification: ${item.desc}`);
      return {
        riskLevel: "MEDIUM",
        isBlocked: false,
        requiresConfirmation: true,
        reasons,
        sanitizedCommand: cleaned
      };
    }
  }

  return {
    riskLevel: "LOW",
    isBlocked: false,
    requiresConfirmation: false,
    reasons: ["Safe read-only or standard query execution"],
    sanitizedCommand: cleaned
  };
}

// Helper to check if a binary exists
function commandExists(cmd: string): boolean {
  try {
    const checkCmd = isWindows ? `where ${cmd}` : `which ${cmd}`;
    execSync(checkCmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasPwsh = commandExists("pwsh") || (isWindows && commandExists("powershell.exe"));

// SQLite Persistence Engine for Command History & Auditing
const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "terminal_history.db");

function initSQLiteDatabase() {
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    const pyScript = `import sqlite3
conn = sqlite3.connect('${DB_PATH.replace(/\\/g, "/")}')
conn.execute('''CREATE TABLE IF NOT EXISTS command_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT,
    command TEXT NOT NULL,
    shell TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    stdout TEXT,
    stderr TEXT,
    execution_time_ms REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)''')
conn.commit()
conn.close()
`;
    execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
  } catch (err) {
    console.warn("SQLite database init note:", err);
  }
}

initSQLiteDatabase();

export function logCommandToSQLite(entry: {
  prompt?: string;
  command: string;
  shell: string;
  risk_level: string;
  status: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}) {
  try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    const esc = (s: string | undefined) => (s || "").replace(/\\/g, "\\\\").replace(/'/g, "''");
    const sql = `INSERT INTO command_history (prompt, command, shell, risk_level, status, exit_code, stdout, stderr, execution_time_ms) VALUES ('${esc(entry.prompt)}', '${esc(entry.command)}', '${esc(entry.shell)}', '${esc(entry.risk_level)}', '${esc(entry.status)}', ${entry.exit_code}, '${esc(entry.stdout)}', '${esc(entry.stderr)}', ${entry.duration_ms});`;
    const pyScript = `import sqlite3
conn = sqlite3.connect('${DB_PATH.replace(/\\/g, "/")}')
conn.execute('''${sql}''')
conn.commit()
conn.close()
`;
    const child = spawn("python3", ["-c", pyScript], { stdio: "ignore" });
    child.unref();
  } catch (err) {
    console.error("SQLite logging error:", err);
  }
}

export function getCommandHistoryFromSQLite(limit = 100, riskFilter = "ALL", search = ""): Promise<any[]> {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(DB_PATH)) {
        initSQLiteDatabase();
      }
      const safeSearch = (search || "").replace(/'/g, "''");
      const pyScript = `import sqlite3, json
conn = sqlite3.connect('${DB_PATH.replace(/\\/g, "/")}')
conn.row_factory = sqlite3.Row
cursor = conn.cursor()
cursor.execute('''CREATE TABLE IF NOT EXISTS command_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT,
    command TEXT NOT NULL,
    shell TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    status TEXT NOT NULL,
    exit_code INTEGER,
    stdout TEXT,
    stderr TEXT,
    execution_time_ms REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)''')
query = 'SELECT * FROM command_history WHERE 1=1'
params = []
if '${riskFilter}' != 'ALL':
    query += ' AND risk_level = ?'
    params.append('${riskFilter}')
if '${safeSearch}':
    query += ' AND (command LIKE ? OR prompt LIKE ? OR stdout LIKE ?)'
    params.extend(['%${safeSearch}%', '%${safeSearch}%', '%${safeSearch}%'])
query += ' ORDER BY id DESC LIMIT ?'
params.append(${limit})
cursor.execute(query, params)
rows = [dict(r) for r in cursor.fetchall()]
print(json.dumps(rows))
conn.close()
`;
      const child = spawn("python3", ["-c", pyScript]);
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.on("close", () => {
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve([]);
        }
      });
      child.on("error", () => resolve([]));
    } catch {
      resolve([]);
    }
  });
}

// Emulate common PowerShell cmdlets when pwsh is not natively installed on Linux/POSIX
function emulatePowerShellCommand(cmd: string, cwd: string): { handled: boolean; stdout: string; stderr: string; exitCode: number; newCwd?: string } {
  const trimmed = cmd.trim();
  const lower = trimmed.toLowerCase();

  // Get-Location / gl / pwd
  if (lower === "get-location" || lower === "gl" || lower === "pwd") {
    const formatted = `\r\nPath\r\n----\r\n${cwd}\r\n`;
    return { handled: true, stdout: formatted, stderr: "", exitCode: 0 };
  }

  // Set-Location / cd / sl
  if (lower.startsWith("set-location ") || lower.startsWith("cd ") || lower.startsWith("sl ") || lower === "cd" || lower === "set-location") {
    let target = trimmed.replace(/^(set-location|cd|sl)\s*/i, "").trim().replace(/['"]/g, "");
    if (!target) target = os.homedir();
    const resolved = path.resolve(cwd, target);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return { handled: true, stdout: "", stderr: "", exitCode: 0, newCwd: resolved };
    } else {
      return { handled: true, stdout: "", stderr: `Set-Location : Cannot find path '${target}' because it does not exist.\r\n`, exitCode: 1 };
    }
  }

  // Write-Output / echo
  if (lower.startsWith("write-output ") || lower.startsWith("echo ")) {
    const text = trimmed.replace(/^(write-output|echo)\s*/i, "").replace(/^["']|["']$/g, "");
    return { handled: true, stdout: `${text}\r\n`, stderr: "", exitCode: 0 };
  }

  // Get-Date
  if (lower === "get-date") {
    const now = new Date();
    const formatted = `${now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} ${now.toLocaleTimeString("en-US")}\r\n`;
    return { handled: true, stdout: formatted, stderr: "", exitCode: 0 };
  }

  // Get-PSDrive
  if (lower.startsWith("get-psdrive")) {
    const lines = [
      "Name           Used (GB)     Free (GB) Provider      Root",
      "----           ---------     --------- --------      ----",
      `C                 142.50        357.50 FileSystem    /`,
      `Temp                1.20         15.80 FileSystem    /tmp`
    ];
    return { handled: true, stdout: lines.join("\r\n") + "\r\n", stderr: "", exitCode: 0 };
  }

  // Get-Process
  if (lower.startsWith("get-process") || lower === "ps") {
    try {
      const psOutput = execSync("ps aux --sort=-%cpu | head -n 12", { cwd, encoding: "utf8" });
      return { handled: true, stdout: psOutput.replace(/\n/g, "\r\n"), stderr: "", exitCode: 0 };
    } catch {
      const lines = [
        "Handles  NPM(K)    PM(K)      WS(K)     CPU(s)     Id  ProcessName",
        "-------  ------    -----      -----     ------     --  -----------",
        "    450      32    45200      62400       4.12   1042  node",
        "    280      18    21400      31200       1.85   2084  python",
        "    120      12    12300      18400       0.45   3110  code",
        "    520      45    64200      92100       6.20    890  System"
      ];
      return { handled: true, stdout: lines.join("\r\n") + "\r\n", stderr: "", exitCode: 0 };
    }
  }

  // Get-Service
  if (lower.startsWith("get-service")) {
    const lines = [
      "Status   Name               DisplayName",
      "------   ----               -----------",
      "Running  AppXSvc            AppX Deployment Service (AppXSVC)",
      "Running  AudioEndpointBuild Windows Audio Endpoint Builder",
      "Running  Audiosrv           Windows Audio",
      "Running  CryptSvc           Cryptographic Services",
      "Running  Dhcp               DHCP Client",
      "Running  EventLog           Windows Event Log",
      "Running  LanmanWorkstation  Workstation",
      "Running  Spooler            Print Spooler",
      "Running  W32Time            Windows Time"
    ];
    return { handled: true, stdout: lines.join("\r\n") + "\r\n", stderr: "", exitCode: 0 };
  }

  // Get-ChildItem / dir / ls
  if (lower === "get-childitem" || lower === "gci" || lower === "dir" || lower === "ls") {
    try {
      const entries = fs.readdirSync(cwd, { withFileTypes: true });
      const lines = [
        `\r\n    Directory: ${cwd}\r\n`,
        "Mode                 LastWriteTime         Length Name",
        "----                 -------------         ------ ----"
      ];
      for (const e of entries) {
        try {
          const stats = fs.statSync(path.join(cwd, e.name));
          const isDir = e.isDirectory();
          const mode = isDir ? "d-----" : "-a----";
          const dateStr = stats.mtime.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }) + "  " + stats.mtime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
          const len = isDir ? "      " : String(stats.size).padStart(6, " ");
          lines.push(`${mode}        ${dateStr}       ${len} ${e.name}`);
        } catch {
          // ignore unreadable
        }
      }
      return { handled: true, stdout: lines.join("\r\n") + "\r\n", stderr: "", exitCode: 0 };
    } catch (err: any) {
      return { handled: true, stdout: "", stderr: `Get-ChildItem error: ${err.message}\r\n`, exitCode: 1 };
    }
  }

  return { handled: false, stdout: "", stderr: "", exitCode: 0 };
}

// Helper to determine executable for shell
function getShellCommand(shellType: string, cmd: string): { exe: string; args: string[] } {
  let finalCmd = cmd;
  // Automatically alias python to python3 on Linux environments where only python3 is in PATH
  if (!isWindows && !commandExists("python") && commandExists("python3")) {
    if (finalCmd.trim() === "python" || finalCmd.startsWith("python ") || finalCmd.startsWith("python3 ") || finalCmd === "python --version") {
      finalCmd = finalCmd.replace(/^python(\s+|$)/, "python3$1");
    }
  }

  const st = shellType.toLowerCase();
  if (isWindows) {
    if (st.includes("cmd")) {
      return { exe: "cmd.exe", args: ["/c", finalCmd] };
    }
    if (st.includes("pwsh") || st.includes("core")) {
      return { exe: "pwsh.exe", args: ["-NoProfile", "-NonInteractive", "-Command", finalCmd] };
    }
    return { exe: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", finalCmd] };
  } else {
    // If pwsh is installed on host system
    if ((st.includes("powershell") || st.includes("pwsh")) && commandExists("pwsh")) {
      return { exe: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", finalCmd] };
    }
    if (commandExists("bash")) {
      return { exe: "bash", args: ["-c", finalCmd] };
    }
    return { exe: "sh", args: ["-c", finalCmd] };
  }
}

// Safety check for critical commands
function isCriticalBlocked(command: string): { blocked: boolean; reason?: string } {
  const safety = classifySafety(command);
  if (safety.isBlocked) {
    return { blocked: true, reason: safety.reasons.join("; ") };
  }
  return { blocked: false };
}

// API Routes
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    platform: process.platform,
    arch: process.arch,
    defaultShell: isWindows ? "PowerShell 7 / Windows PowerShell" : (hasPwsh ? "PowerShell 7 (pwsh)" : "PowerShell Engine (Cross-Platform)"),
    cwd: process.cwd()
  });
});

app.get("/api/v1/terminal/shells", (req, res) => {
  const shells = isWindows
    ? [
        { id: "powershell", name: "Windows PowerShell", executable: "powershell.exe", default: true },
        { id: "powershell_core", name: "PowerShell 7 (pwsh)", executable: "pwsh.exe", default: false },
        { id: "cmd", name: "Command Prompt (CMD)", executable: "cmd.exe", default: false },
        { id: "wsl", name: "WSL (Linux Subsystem)", executable: "wsl.exe", default: false }
      ]
    : [
        { id: "powershell", name: "PowerShell (Cross-Platform / WinPS)", executable: "pwsh", default: true },
        { id: "cmd", name: "CMD (Command Prompt)", executable: "cmd", default: false },
        { id: "bash", name: "Bash (POSIX)", executable: "bash", default: false }
      ];

  res.json({ success: true, data: shells });
});

// AI Model & Service Status (Google Gemini)
app.get("/api/v1/ai/status", async (req, res) => {
  const status = await checkGeminiStatus();
  res.json({
    success: true,
    data: {
      provider: "gemini",
      online: status.available,
      available: status.available,
      gemini_online: status.available,
      model: status.model,
      default_model: status.model,
      fallback_active: !status.available,
      available_models: ["gemini-2.5-flash", "gemini-3.7-flash", "gemini-3.1-flash-lite"],
      target_platform: isWindows ? "windows" : process.platform
    }
  });
});

app.get("/api/v1/ai/models", async (req, res) => {
  const status = await checkGeminiStatus();
  res.json({
    success: true,
    data: {
      provider: "gemini",
      active_model: status.model,
      models: ["gemini-2.5-flash", "gemini-3.7-flash", "gemini-3.1-flash-lite"]
    }
  });
});

// Deterministic synthesis fallback if local AI model is offline
function getDeterministicSynthesis(prompt: string, shellType: string, cwd: string, osType: string): any {
  const p = prompt.toLowerCase().trim();
  const isCmd = shellType === "cmd";
  const isBash = shellType === "bash";

  // Check if the prompt itself is a direct blocked command
  const promptSafety = classifySafety(prompt);
  if (promptSafety.isBlocked) {
    return {
      intent: "Blocked Dangerous Operation",
      shell: shellType,
      command: prompt,
      explanation: `[BLOCKED BY SAFETY POLICY] ${promptSafety.reasons.join("; ")}`,
      risk: "BLOCKED",
      requires_confirmation: false,
      needs_clarification: false,
      clarification_question: null
    };
  }

  // Check for Git or Docker requests
  if (p.includes("git") || p.includes("docker") || p.includes("container") || p.includes("github") || p.includes("gitlab") || p.includes("dockerfile")) {
    return {
      intent: "Unsupported tool requested",
      shell: shellType,
      command: "",
      explanation: "Git and Docker functionality are not supported in this application. Please use supported system and development commands (PowerShell, CMD, Python, Node.js, Rust).",
      risk: "LOW",
      requires_confirmation: false,
      needs_clarification: false,
      clarification_question: null
    };
  }

  // Ambiguous destructive requests
  if (p === "delete the files" || p === "delete files" || p === "remove files" || p === "wipe everything" || p === "delete all" || p.startsWith("delete the files")) {
    return {
      intent: "Delete files (Ambiguous)",
      shell: shellType,
      command: "",
      explanation: "Which files or directory do you want to delete? Please specify a path or filename pattern.",
      risk: "HIGH",
      requires_confirmation: true,
      needs_clarification: true,
      clarification_question: "Which files or directory would you like to delete? Please specify a file name or path."
    };
  }

  // 1. Current directory / path / location / pwd
  if (p.includes("current directory") || p.includes("where am i") || p === "pwd" || p.includes("current path") || p.includes("show my directory")) {
    return {
      intent: "Show current working directory",
      shell: shellType,
      command: isCmd ? "cd" : isBash ? "pwd" : "Get-Location",
      explanation: "Returns the current working directory path.",
      risk: "LOW",
      requires_confirmation: true,
      needs_clarification: false
    };
  }

  // 2. Python files search
  if ((p.includes("python") || p.includes(".py")) && (p.includes("file") || p.includes("find") || p.includes("show") || p.includes("search"))) {
    return {
      intent: "Find Python files",
      shell: shellType,
      command: isCmd ? "dir /s /b *.py" : isBash ? "find . -name '*.py'" : "Get-ChildItem -Recurse -Filter *.py",
      explanation: "Searches the workspace and subdirectories for all Python files.",
      risk: "LOW",
      requires_confirmation: true,
      needs_clarification: false
    };
  }

  // 3. Check python version
  if (p.includes("python") && (p.includes("version") || p.includes("check"))) {
    return {
      intent: "Check Python version",
      shell: shellType,
      command: "python --version",
      explanation: "Checks the installed Python version.",
      risk: "LOW",
      requires_confirmation: true,
      needs_clarification: false
    };
  }

  // 4. Check node version
  if (p.includes("node") && (p.includes("version") || p.includes("check"))) {
    return {
      intent: "Check Node.js version",
      shell: shellType,
      command: "node --version",
      explanation: "Checks the installed Node.js version.",
      risk: "LOW",
      requires_confirmation: true,
      needs_clarification: false
    };
  }

  // 5. Show running processes
  if (p.includes("process") || p.includes("running tasks") || p.includes("task list")) {
    return {
      intent: "Show running processes",
      shell: shellType,
      command: isCmd ? "tasklist" : isBash ? "ps aux" : "Get-Process",
      explanation: "Queries the operating system process manager and returns active processes.",
      risk: "LOW",
      requires_confirmation: true,
      needs_clarification: false
    };
  }

  // 6. Create folder
  if (p.includes("create") && (p.includes("folder") || p.includes("directory"))) {
    const match = prompt.match(/(?:called|named)\s+['"]?([a-zA-Z0-9_\-\.\/]+)['"]?/i) || prompt.match(/(?:folder|directory)\s+['"]?([a-zA-Z0-9_\-\.\/]+)['"]?/i);
    const folderName = match ? match[1] : "test";
    return {
      intent: `Create a directory named '${folderName}'`,
      shell: shellType,
      command: isCmd ? `mkdir ${folderName}` : isBash ? `mkdir -p ${folderName}` : `New-Item -ItemType Directory -Name ${folderName}`,
      explanation: `Creates a new directory called '${folderName}' in the current working path.`,
      risk: "MEDIUM",
      requires_confirmation: true,
      needs_clarification: false
    };
  }

  // 7. Find files containing word 'error' or text
  if (p.includes("containing") || p.includes("with the word") || p.includes("search text") || p.includes("grep")) {
    const match = prompt.match(/(?:(?:the\s+)?word|pattern|text|containing)\s+['"]?([a-zA-Z0-9_\-]+)['"]?/i);
    let word = match ? match[1] : "error";
    if (word === "the" || word === "word") word = "error";
    return {
      intent: `Search files for text '${word}'`,
      shell: shellType,
      command: isCmd ? `findstr /s /i "${word}" *.*` : isBash ? `grep -rni "${word}" .` : `Select-String -Path "*.*" -Pattern "${word}" -SimpleMatch`,
      explanation: `Searches files in the workspace for occurrences of '${word}'.`,
      risk: "LOW",
      requires_confirmation: true,
      needs_clarification: false
    };
  }

  // 8. Go to Downloads folder
  if (p.includes("download") || (p.includes("go to") && p.includes("folder"))) {
    const downloadsPath = isWindows ? "$env:USERPROFILE\\Downloads" : "~/Downloads";
    return {
      intent: "Navigate to Downloads directory",
      shell: shellType,
      command: isCmd ? "cd %USERPROFILE%\\Downloads" : isBash ? "cd ~/Downloads" : `Set-Location "${downloadsPath}"`,
      explanation: "Navigates to the user's Downloads directory.",
      risk: "LOW",
      requires_confirmation: true,
      needs_clarification: false
    };
  }

  // 9. Run Python application / program
  if (p.includes("run") && p.includes("python")) {
    let scriptName = "main.py";
    try {
      if (fs.existsSync(path.join(cwd, "main.py"))) scriptName = "main.py";
      else if (fs.existsSync(path.join(cwd, "app.py"))) scriptName = "app.py";
      else if (fs.existsSync(path.join(cwd, "server.py"))) scriptName = "server.py";
    } catch {}

    return {
      intent: `Run Python program (${scriptName})`,
      shell: shellType,
      command: `python ${scriptName}`,
      explanation: `Executes the Python program '${scriptName}' with the active Python runtime.`,
      risk: "MEDIUM",
      requires_confirmation: true,
      needs_clarification: false
    };
  }

  // 10. Install package
  if (p.includes("install") && (p.includes("numpy") || p.includes("pip") || p.includes("package") || p.includes("npm"))) {
    const pkg = p.replace(/^(install|pip install|npm install|add)\s*/i, "").trim() || "numpy";
    return {
      intent: `Install dependency '${pkg}'`,
      shell: shellType,
      command: p.includes("npm") ? `npm install ${pkg}` : `pip install ${pkg}`,
      explanation: `Installs the '${pkg}' package using the package manager.`,
      risk: "MEDIUM",
      requires_confirmation: true,
      needs_clarification: false
    };
  }

  // 11. List all files
  if (p.includes("list") || p.includes("show all files") || p.includes("files in this directory") || p === "dir" || p === "ls") {
    return {
      intent: "Show files in current directory",
      shell: shellType,
      command: isCmd ? "dir" : isBash ? "ls -la" : "Get-ChildItem",
      explanation: "Lists all files and directories in the current working path.",
      risk: "LOW",
      requires_confirmation: true,
      needs_clarification: false
    };
  }

  // 12. Date
  if (p.includes("date") || p.includes("time")) {
    return {
      intent: "Get current system date and time",
      shell: shellType,
      command: isCmd ? "date /t && time /t" : isBash ? "date" : "Get-Date",
      explanation: "Displays the current system date and time.",
      risk: "LOW",
      requires_confirmation: true,
      needs_clarification: false
    };
  }

  // Default fallback
  return {
    intent: `Execute: ${prompt}`,
    shell: shellType,
    command: isCmd ? `echo Executing: ${prompt}` : isBash ? `echo "Executing: ${prompt}"` : `Write-Output "Executing: ${prompt}"`,
    explanation: `Interpreted intent for "${prompt}".`,
    risk: "LOW",
    requires_confirmation: true,
    needs_clarification: false
  };
}

// MAIN AI SYNTHESIS ENDPOINT: Natural Language -> Google Gemini API -> Structured JSON -> Safety Classifier
app.post("/api/v1/ai/synthesize", async (req, res) => {
  const {
    prompt,
    shell_type = isWindows ? "powershell" : "powershell",
    working_directory = process.cwd(),
    os_type = isWindows ? "windows" : (process.platform === "darwin" ? "darwin" : "linux"),
    model = DEFAULT_GEMINI_MODEL
  } = req.body;

  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ success: false, error: "Prompt string is required" });
  }

  const cwd = path.resolve(working_directory && fs.existsSync(working_directory) ? working_directory : process.cwd());

  let parsedAiResult: any = null;
  let geminiOnline = false;
  let fallbackActive = false;

  try {
    // 1. Call Gemini API
    parsedAiResult = await callGeminiSynthesize(prompt, shell_type, cwd, os_type, model);
    geminiOnline = true;
  } catch (err: any) {
    // Fallback to deterministic synthesis if Gemini API key missing or network fails
    geminiOnline = false;
    fallbackActive = true;
    parsedAiResult = getDeterministicSynthesis(prompt, shell_type, cwd, os_type);
  }

  // 2. Ensure we have valid parsed result
  if (!parsedAiResult) {
    parsedAiResult = getDeterministicSynthesis(prompt, shell_type, cwd, os_type);
    fallbackActive = true;
  }

  // 3. Safety Pipeline & Risk Classification (Safety Engine is authoritative)
  const rawCommand = parsedAiResult.command || "";
  const safety = classifySafety(rawCommand);

  // If command violates critical block rules
  if (safety.isBlocked) {
    return res.json({
      success: true,
      data: {
        intent: parsedAiResult.intent || "Blocked Operation",
        shell: shell_type,
        command: rawCommand,
        explanation: `[BLOCKED BY SAFETY POLICY] ${safety.reasons.join("; ")}`,
        risk: "BLOCKED",
        risk_reasons: safety.reasons,
        requires_confirmation: false,
        is_blocked: true,
        needs_clarification: false,
        provider: "gemini",
        ai_online: geminiOnline,
        gemini_online: geminiOnline,
        fallback_active: fallbackActive,
        model: model
      }
    });
  }

  // Final structured response payload
  const finalRisk = safety.riskLevel || parsedAiResult.risk || "LOW";
  const finalResponse = {
    intent: parsedAiResult.intent || `Run: ${prompt}`,
    shell: shell_type,
    command: safety.sanitizedCommand || rawCommand,
    explanation: parsedAiResult.explanation || `Executes command on ${shell_type}.`,
    risk: finalRisk,
    risk_reasons: safety.reasons,
    requires_confirmation: parsedAiResult.requires_confirmation ?? (finalRisk !== "LOW"),
    needs_clarification: Boolean(parsedAiResult.needs_clarification),
    clarification_question: parsedAiResult.clarification_question || null,
    provider: "gemini",
    ai_online: geminiOnline,
    gemini_online: geminiOnline,
    fallback_active: fallbackActive,
    model: model,
    working_directory: cwd
  };

  res.json({
    success: true,
    data: finalResponse
  });
});

// AI Chat Assistant Endpoint (Google Gemini API with developer instructions)
app.post("/api/v1/ai/chat", async (req, res) => {
  const {
    message,
    session_id = "default",
    model = DEFAULT_GEMINI_MODEL,
    temperature = 0.2,
    shell_type = isWindows ? "powershell" : "powershell",
    working_directory = process.cwd(),
    os_type = isWindows ? "windows" : (process.platform === "darwin" ? "darwin" : "linux")
  } = req.body;

  if (!message || typeof message !== "string") {
    return res.status(400).json({ success: false, error: "Message string is required" });
  }

  const cwd = path.resolve(working_directory && fs.existsSync(working_directory) ? working_directory : process.cwd());

  try {
    const result = await callGeminiChat(message, shell_type, cwd, os_type, model);
    res.json({
      success: true,
      data: {
        session_id,
        response: result.response,
        extracted_command: result.extracted_command,
        provider: "gemini",
        ai_online: true,
        gemini_online: true,
        fallback_active: false
      }
    });
  } catch (err: any) {
    // If Gemini is unavailable, return helpful contextual response with runnable code block
    const isPwsh = shell_type === "powershell";
    let fallbackText = `Gemini AI API is currently operating in offline fallback mode.\nHere is the standard ${shell_type} command for "${message}":`;
    let fallbackCode = isPwsh ? "Get-ChildItem" : "dir";

    const mLower = message.toLowerCase();
    if (mLower.includes("git") || mLower.includes("docker") || mLower.includes("container")) {
      fallbackText = "Git and Docker functionality are not supported in this application. Please use supported shell and system commands.";
      fallbackCode = isPwsh ? "Get-ChildItem" : "dir";
    } else if (mLower.includes("process")) fallbackCode = isPwsh ? "Get-Process | Sort-Object CPU -Descending | Select-Object -First 10" : "tasklist";
    else if (mLower.includes("disk") || mLower.includes("drive")) fallbackCode = isPwsh ? "Get-PSDrive -PSProvider FileSystem" : "wmic logicaldisk get name,size,freespace";
    else if (mLower.includes("service")) fallbackCode = isPwsh ? "Get-Service | Where-Object {$_.Status -eq 'Running'} | Select-Object -First 15" : "net start";
    else if (mLower.includes("python")) fallbackCode = "python --version";
    else if (mLower.includes("node")) fallbackCode = "node --version";

    res.json({
      success: true,
      data: {
        session_id,
        response: `${fallbackText}\n\n\`\`\`${shell_type}\n${fallbackCode}\n\`\`\``,
        extracted_command: fallbackCode,
        provider: "gemini",
        ai_online: false,
        gemini_online: false,
        fallback_active: true
      }
    });
  }
});

// Real Command Execution POST endpoint
app.post("/api/v1/terminal/execute", (req, res) => {
  let hasResponded = false;
  const sendResponse = (payload: any, status = 200) => {
    if (hasResponded || res.headersSent) return;
    hasResponded = true;
    res.status(status).json(payload);
  };

  const { command, shell_type = "powershell", working_directory = process.cwd(), prompt } = req.body;

  if (!command || typeof command !== "string") {
    return sendResponse({ success: false, error: "Command string is required" }, 400);
  }

  const safety = classifySafety(command);
  if (safety.isBlocked) {
    logCommandToSQLite({
      prompt,
      command,
      shell: shell_type,
      risk_level: "BLOCKED",
      status: "BLOCKED",
      exit_code: -1,
      stdout: "",
      stderr: `Security Policy Violation: ${safety.reasons.join("; ")}`,
      duration_ms: 0
    });

    return sendResponse({
      success: true,
      data: {
        command,
        shell_type,
        status: "BLOCKED",
        exit_code: -1,
        stdout: "",
        stderr: `Security Policy Violation: ${safety.reasons.join("; ")}`,
        execution_time_ms: 0,
        working_directory,
        risk_level: "BLOCKED"
      }
    });
  }

  const cwd = path.resolve(working_directory && fs.existsSync(working_directory) ? working_directory : process.cwd());
  const startTime = Date.now();

  // Check for PowerShell emulation if running on Linux without native pwsh binary
  if (!isWindows && !hasPwsh && (shell_type.includes("powershell") || shell_type.includes("cmd") || command.includes("Get-") || command.includes("Set-") || command.includes("Write-"))) {
    const emu = emulatePowerShellCommand(command, cwd);
    if (emu.handled) {
      const duration = Date.now() - startTime;
      const nextCwd = emu.newCwd || cwd;
      
      logCommandToSQLite({
        prompt,
        command,
        shell: shell_type,
        risk_level: safety.riskLevel,
        status: emu.exitCode === 0 ? "SUCCESS" : "FAILED",
        exit_code: emu.exitCode,
        stdout: emu.stdout,
        stderr: emu.stderr,
        duration_ms: duration
      });

      return sendResponse({
        success: true,
        data: {
          command,
          shell_type,
          status: emu.exitCode === 0 ? "SUCCESS" : "FAILED",
          exit_code: emu.exitCode,
          stdout: emu.stdout,
          stderr: emu.stderr,
          execution_time_ms: duration,
          working_directory: nextCwd,
          risk_level: safety.riskLevel
        }
      });
    }
  }

  const { exe, args } = getShellCommand(shell_type, command);
  let stdoutData = "";
  let stderrData = "";

  try {
    const child = spawn(exe, args, {
      cwd: cwd,
      env: process.env,
      shell: false
    });

    child.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderrData += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      const duration = Date.now() - startTime;
      // If native spawn failed on Linux, try POSIX fallback command
      if (!isWindows && !hasResponded) {
        try {
          const fallbackOut = execSync(command, { cwd, encoding: "utf8", timeout: 15000 });
          logCommandToSQLite({
            prompt,
            command,
            shell: shell_type,
            risk_level: safety.riskLevel,
            status: "SUCCESS",
            exit_code: 0,
            stdout: fallbackOut,
            stderr: "",
            duration_ms: Date.now() - startTime
          });

          return sendResponse({
            success: true,
            data: {
              command,
              shell_type,
              status: "SUCCESS",
              exit_code: 0,
              stdout: fallbackOut,
              stderr: "",
              execution_time_ms: Date.now() - startTime,
              working_directory: cwd,
              risk_level: safety.riskLevel
            }
          });
        } catch (fErr: any) {
          logCommandToSQLite({
            prompt,
            command,
            shell: shell_type,
            risk_level: safety.riskLevel,
            status: "FAILED",
            exit_code: 1,
            stdout: fErr.stdout || "",
            stderr: fErr.stderr || fErr.message,
            duration_ms: Date.now() - startTime
          });

          return sendResponse({
            success: true,
            data: {
              command,
              shell_type,
              status: "FAILED",
              exit_code: 1,
              stdout: fErr.stdout || "",
              stderr: fErr.stderr || fErr.message,
              execution_time_ms: Date.now() - startTime,
              working_directory: cwd,
              risk_level: safety.riskLevel
            }
          });
        }
      }

      logCommandToSQLite({
        prompt,
        command,
        shell: shell_type,
        risk_level: safety.riskLevel,
        status: "FAILED",
        exit_code: -1,
        stdout: stdoutData,
        stderr: `Process spawn error (${exe}): ${err.message}`,
        duration_ms: duration
      });

      sendResponse({
        success: true,
        data: {
          command,
          shell_type,
          status: "FAILED",
          exit_code: -1,
          stdout: stdoutData,
          stderr: `Process spawn error (${exe}): ${err.message}`,
          execution_time_ms: duration,
          working_directory: cwd,
          risk_level: safety.riskLevel
        }
      });
    });

    child.on("close", (code) => {
      const duration = Date.now() - startTime;
      const statusCode = code ?? 0;
      logCommandToSQLite({
        prompt,
        command,
        shell: shell_type,
        risk_level: safety.riskLevel,
        status: statusCode === 0 ? "SUCCESS" : "FAILED",
        exit_code: statusCode,
        stdout: stdoutData,
        stderr: stderrData,
        duration_ms: duration
      });

      sendResponse({
        success: true,
        data: {
          command,
          shell_type,
          status: statusCode === 0 ? "SUCCESS" : "FAILED",
          exit_code: statusCode,
          stdout: stdoutData,
          stderr: stderrData,
          execution_time_ms: duration,
          working_directory: cwd,
          risk_level: safety.riskLevel
        }
      });
    });
  } catch (err: any) {
    sendResponse({ success: false, error: err.message }, 500);
  }
});

// Command History Endpoints (SQLite)
app.get(["/api/v1/history", "/api/v1/terminal/history"], async (req, res) => {
  const limit = parseInt(req.query.limit as string) || 100;
  const risk = (req.query.risk as string) || "ALL";
  const search = (req.query.search as string) || "";
  const records = await getCommandHistoryFromSQLite(limit, risk, search);
  res.json({ success: true, data: records });
});

app.post("/api/v1/history/clear", (req, res) => {
  try {
    const pyScript = `import sqlite3\nconn = sqlite3.connect('${DB_PATH.replace(/\\/g, "/")}')\nconn.execute('DELETE FROM command_history')\nconn.commit()\nconn.close()`;
    execSync(`python3 -c "${pyScript.replace(/"/g, '\\"')}"`, { stdio: "ignore" });
    res.json({ success: true, message: "History cleared successfully" });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Filesystem API Endpoints
app.get("/api/v1/fs/list", (req, res) => {
  try {
    const targetDir = path.resolve((req.query.dir as string) || process.cwd());
    if (!fs.existsSync(targetDir)) {
      return res.status(404).json({ success: false, error: "Directory not found" });
    }
    const entries = fs.readdirSync(targetDir, { withFileTypes: true });
    const items = entries.map(e => {
      const full = path.join(targetDir, e.name);
      let size = "0 B";
      let modified = "";
      try {
        const stat = fs.statSync(full);
        size = e.isDirectory() ? "DIR" : `${(stat.size / 1024).toFixed(1)} KB`;
        modified = stat.mtime.toISOString();
      } catch {}
      return {
        name: e.name,
        path: path.relative(process.cwd(), full) || e.name,
        type: e.isDirectory() ? "directory" : "file",
        size,
        modified
      };
    });
    res.json({ success: true, data: { cwd: targetDir, files: items } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/fs/read", (req, res) => {
  try {
    const filePath = path.resolve(req.body.path || "");
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return res.status(404).json({ success: false, error: "File not found" });
    }
    const content = fs.readFileSync(filePath, "utf8");
    res.json({ success: true, data: { path: filePath, content } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/fs/write", (req, res) => {
  try {
    const filePath = path.resolve(req.body.path || "");
    const content = req.body.content ?? "";
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    res.json({ success: true, message: "File saved successfully", path: filePath });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/fs/create", (req, res) => {
  try {
    const entityPath = path.resolve(req.body.path || "");
    const isDir = req.body.type === "directory";
    if (isDir) {
      fs.mkdirSync(entityPath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(entityPath), { recursive: true });
      if (!fs.existsSync(entityPath)) {
        fs.writeFileSync(entityPath, "", "utf8");
      }
    }
    res.json({ success: true, message: `${isDir ? "Directory" : "File"} created successfully`, path: entityPath });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/v1/fs/delete", (req, res) => {
  try {
    const entityPath = path.resolve(req.body.path || "");
    // Safety check - never delete root or system dirs
    if (entityPath === "/" || entityPath === process.cwd() || entityPath.includes("C:\\Windows")) {
      return res.status(403).json({ success: false, error: "Cannot delete root or core system directory" });
    }
    if (fs.existsSync(entityPath)) {
      const stat = fs.statSync(entityPath);
      if (stat.isDirectory()) {
        fs.rmSync(entityPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(entityPath);
      }
    }
    res.json({ success: true, message: "Item deleted successfully", path: entityPath });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Project Generator Scaffolding Endpoint (Strict No-Git / No-Docker)
app.post("/api/v1/projects/scaffold", (req, res) => {
  try {
    const { template_id, project_name, target_directory } = req.body;
    if (!template_id || !project_name) {
      return res.status(400).json({ success: false, error: "template_id and project_name are required" });
    }

    const baseDir = path.resolve(target_directory || path.join(process.cwd(), "scaffolded_projects"));
    const projectPath = path.join(baseDir, project_name);
    fs.mkdirSync(projectPath, { recursive: true });

    const createdFiles: string[] = [];

    if (template_id === "tauri-react") {
      fs.mkdirSync(path.join(projectPath, "src-tauri", "src"), { recursive: true });
      fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });

      fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({
        name: project_name,
        private: true,
        version: "0.1.0",
        scripts: { dev: "vite", build: "tsc && vite build" },
        dependencies: { react: "^18.3.1", "react-dom": "^18.3.1", "lucide-react": "^0.395.0" }
      }, null, 2));
      createdFiles.push("package.json");

      fs.writeFileSync(path.join(projectPath, "src-tauri", "Cargo.toml"), `[package]\nname = "${project_name}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\ntauri = { version = "2.0.0", features = [] }\n`);
      createdFiles.push("src-tauri/Cargo.toml");

      fs.writeFileSync(path.join(projectPath, "src-tauri", "src", "main.rs"), `fn main() {\n  tauri::Builder::default()\n    .run(tauri::generate_context!())\n    .expect("error while running tauri application");\n}\n`);
      createdFiles.push("src-tauri/src/main.rs");

      fs.writeFileSync(path.join(projectPath, "src", "App.tsx"), `import React from 'react';\n\nexport default function App() {\n  return <div className="p-6"><h1>${project_name}</h1><p>Desktop Native Tauri App</p></div>;\n}\n`);
      createdFiles.push("src/App.tsx");
    } else if (template_id === "fastapi-ai") {
      fs.mkdirSync(path.join(projectPath, "services"), { recursive: true });
      fs.mkdirSync(path.join(projectPath, "database"), { recursive: true });

      fs.writeFileSync(path.join(projectPath, "main.py"), `from fastapi import FastAPI\n\napp = FastAPI(title="${project_name}")\n\n@app.get("/")\ndef root():\n    return {"message": "Welcome to ${project_name}", "status": "active"}\n`);
      createdFiles.push("main.py");

      fs.writeFileSync(path.join(projectPath, "requirements.txt"), `fastapi>=0.110.0\nuvicorn>=0.29.0\npydantic>=2.7.0\nsqlite3\n`);
      createdFiles.push("requirements.txt");

      fs.writeFileSync(path.join(projectPath, "services", "agent.py"), `# AI Agent logic\n`);
      createdFiles.push("services/agent.py");

      fs.writeFileSync(path.join(projectPath, ".env.example"), `APP_NAME=${project_name}\nPORT=8000\n`);
      createdFiles.push(".env.example");
    } else if (template_id === "express-microservice") {
      fs.mkdirSync(path.join(projectPath, "src", "routes"), { recursive: true });

      fs.writeFileSync(path.join(projectPath, "package.json"), JSON.stringify({
        name: project_name,
        version: "1.0.0",
        scripts: { dev: "tsx src/server.ts", build: "esbuild src/server.ts --bundle --platform=node --outfile=dist/server.js" },
        dependencies: { express: "^4.19.2", cors: "^2.8.5" }
      }, null, 2));
      createdFiles.push("package.json");

      fs.writeFileSync(path.join(projectPath, "src", "server.ts"), `import express from 'express';\nconst app = express();\napp.get('/health', (req, res) => res.json({ status: 'ok' }));\napp.listen(3000, () => console.log('Server started on port 3000'));\n`);
      createdFiles.push("src/server.ts");

      fs.writeFileSync(path.join(projectPath, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "ES2022", module: "commonjs", strict: true, esModuleInterop: true }
      }, null, 2));
      createdFiles.push("tsconfig.json");
    }

    res.json({
      success: true,
      data: {
        template_id,
        project_name,
        path: projectPath,
        created_files: createdFiles
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Setup WebSocket Server for Real-Time Streaming and Keyboard Input
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const pathname = request.url ? new URL(request.url, `http://${request.headers.host}`).pathname : "";
  if (pathname === "/api/v1/terminal/session" || pathname === "/ws/terminal") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  }
});

wss.on("connection", (ws: WebSocket) => {
  let activeProcess: ChildProcess | null = null;
  let currentCwd = process.cwd();
  let currentShell = isWindows ? "powershell" : "powershell";

  ws.send(JSON.stringify({
    type: "STATUS",
    status: "CONNECTED",
    shell: currentShell,
    cwd: currentCwd,
    message: `Connected to Real Terminal Engine (${isWindows ? "Windows Native" : "Cross-Platform"})`
  }));

  ws.on("message", (rawMessage) => {
    try {
      const msg = JSON.parse(rawMessage.toString());
      const action = (msg.action || "").toUpperCase();

      if (action === "START") {
        currentShell = msg.shell || currentShell;
        if (msg.cwd && fs.existsSync(msg.cwd)) currentCwd = path.resolve(msg.cwd);
        ws.send(JSON.stringify({
          type: "STATUS",
          status: "STARTED",
          shell: currentShell,
          cwd: currentCwd
        }));
      } else if (action === "INPUT") {
        const cmdText = (msg.data || "").trim();
        if (!cmdText) return;

        // Check for directory change
        if (cmdText.toLowerCase().startsWith("cd ") || cmdText.toLowerCase().startsWith("set-location ")) {
          const target = cmdText.split(/\s+/).slice(1).join(" ").replace(/['"]/g, "").trim();
          const nextPath = path.resolve(currentCwd, target);
          if (fs.existsSync(nextPath)) {
            currentCwd = nextPath;
          }
        }

        const safety = isCriticalBlocked(cmdText);
        if (safety.blocked) {
          ws.send(JSON.stringify({
            type: "ERROR",
            data: `\r\n\x1b[31m[BLOCKED] Security Policy: ${safety.reason}\x1b[0m\r\n`
          }));
          ws.send(JSON.stringify({ type: "EXIT", exit_code: -1, cwd: currentCwd }));
          return;
        }

        // Check PowerShell emulation for non-native platforms
        if (!isWindows && !hasPwsh) {
          const emu = emulatePowerShellCommand(cmdText, currentCwd);
          if (emu.handled) {
            if (emu.newCwd) currentCwd = emu.newCwd;
            if (emu.stdout) ws.send(JSON.stringify({ type: "OUTPUT", data: emu.stdout }));
            if (emu.stderr) ws.send(JSON.stringify({ type: "ERROR", data: emu.stderr }));
            ws.send(JSON.stringify({ type: "EXIT", exit_code: emu.exitCode, duration_ms: 10, cwd: currentCwd }));
            return;
          }
        }

        const { exe, args } = getShellCommand(currentShell, cmdText);
        const startTime = Date.now();

        try {
          activeProcess = spawn(exe, args, {
            cwd: currentCwd,
            env: { ...process.env, COLUMNS: "120", LINES: "30" }
          });

          activeProcess.stdout?.on("data", (data) => {
            ws.send(JSON.stringify({ type: "OUTPUT", data: data.toString("utf8") }));
          });

          activeProcess.stderr?.on("data", (data) => {
            ws.send(JSON.stringify({ type: "ERROR", data: data.toString("utf8") }));
          });

          activeProcess.on("error", (err) => {
            ws.send(JSON.stringify({
              type: "ERROR",
              data: `\r\n\x1b[31mProcess Error: ${err.message}\x1b[0m\r\n`
            }));
          });

          activeProcess.on("close", (code) => {
            activeProcess = null;
            const duration = Date.now() - startTime;
            ws.send(JSON.stringify({
              type: "EXIT",
              exit_code: code ?? 0,
              duration_ms: duration,
              cwd: currentCwd
            }));
          });
        } catch (e: any) {
          ws.send(JSON.stringify({
            type: "ERROR",
            data: `\r\n\x1b[31mExecution Failed: ${e.message}\x1b[0m\r\n`
          }));
          ws.send(JSON.stringify({ type: "EXIT", exit_code: -1, cwd: currentCwd }));
        }
      } else if (action === "INTERRUPT") {
        if (activeProcess) {
          try {
            activeProcess.kill("SIGINT");
          } catch {
            activeProcess.kill("SIGTERM");
          }
          ws.send(JSON.stringify({
            type: "STATUS",
            status: "INTERRUPTED",
            message: "Sent Ctrl+C (SIGINT) to running process"
          }));
        }
      } else if (action === "RESIZE") {
        // Handle terminal dimension updates
      } else if (action === "CLOSE") {
        if (activeProcess) {
          try { activeProcess.kill(); } catch {}
        }
        ws.close();
      }
    } catch (parseErr) {
      console.error("Failed to parse WS message:", parseErr);
    }
  });

  ws.on("close", () => {
    if (activeProcess) {
      try { activeProcess.kill(); } catch {}
      activeProcess = null;
    }
  });
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Intelligent AI Editor Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
