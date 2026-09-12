# Nebula Notebook API Documentation

Base URL: `http://localhost:8000`

## Overview

The Nebula Notebook backend provides REST APIs for:
- **Kernel Management** - Start, stop, and manage Jupyter kernel sessions
- **Code Execution** - Execute code via WebSocket with streaming output
- **LLM Integration** - Generate code and chat with AI providers
- **Filesystem Operations** - Read, write, and manage notebook files
- **Python Discovery** - Discover and install Python environments

## Authentication

Every `/api/*` route except the ones listed as public below requires a session token, sent as
`Authorization: Bearer <token>` (or `?token=` on WebSocket upgrades). Tokens are JWTs issued by
the login routes; the default session is 30 days, or 24 hours when the client sends `trusted: false`.
Run the server with `--noauth` / `NO_AUTH=true` to disable authentication for local development.

### TOTP

```
GET  /api/auth/status                       (public)  → { configured, authenticated }
POST /api/auth/verify                       (public)  { code, trusted? | trustBrowser? } → { success, token } | 401 { success:false, error }
```

`trusted` (alias `trustBrowser`) defaults to `true` (30-day session); only an explicit `false` yields the 24 h one.
Rate limit: 5 failed attempts per 30 s, shared with passkey login.

### Passkeys (WebAuthn)

The rpID is the hostname of the request's `Host` (or `X-Forwarded-Host`) with the port stripped; the
origin is `${proto}://${host}` where `proto` honors `X-Forwarded-Proto` and otherwise defaults to `https`,
or `http` for `localhost`. An IP-literal host is rejected with `400 { ok:false, code:"invalid_rp_id", error }`
telling the user to open `http://localhost:PORT` instead.

```
POST   /api/auth/passkeys/login-options     (public)  → { ok:true, token, options } | { ok:false, error }   (none enrolled for this rpID)
POST   /api/auth/passkeys/login             (public, rate-limited)  { token, response } → { success, token } | 401 { success:false, error }
POST   /api/auth/passkeys/register-options  (auth)    → { ok:true, token, options }
POST   /api/auth/passkeys/register          (auth)    { token, response, label? } → { ok:true, passkey } | 400 { ok:false, error }
GET    /api/auth/passkeys                   (auth)    → { ok:true, rpID, rpError, passkeys:[{ id, rpID, label, createdAt, lastUsedAt }] }
DELETE /api/auth/passkeys/:id               (auth)    → { ok:true, removed:1 } | 404
```

`token` is an opaque challenge handle: in-memory, single-use, 120 s TTL, typed (login vs register) and
bound to the rpID it was issued for. `response` is the JSON produced by `@simplewebauthn/browser`'s
`startAuthentication` / `startRegistration`. A passkey login issues the same 30-day session token as
TOTP, in the same response shape. Public keys are never returned by the list route.

## Error Responses

All endpoints return standard HTTP error codes:
- `400` - Bad request (invalid parameters)
- `403` - Permission denied
- `404` - Resource not found
- `409` - Conflict (e.g., file already exists)
- `500` - Internal server error
- `503` - Service unavailable (during initialization)

Error response format:
```json
{
  "detail": "Error message describing the issue"
}
```

---

## Kernel Endpoints

### List Available Kernels

```
GET /api/kernels
```

Returns available Jupyter kernelspecs.

**Response:**
```json
{
  "kernels": [
    {
      "name": "python3",
      "display_name": "Python 3",
      "language": "python"
    }
  ]
}
```

### Start Kernel Session

```
POST /api/kernels/start
```

Start a new kernel session.

**Request Body:**
```json
{
  "kernel_name": "python3",
  "cwd": "/path/to/working/directory",
  "file_path": "/path/to/notebook.ipynb"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| kernel_name | string | No | Kernel name (default: "python3") |
| cwd | string | No | Working directory for the kernel |
| file_path | string | No | Notebook file path for session mapping |

**Response:**
```json
{
  "session_id": "uuid-string",
  "kernel_name": "python3"
}
```

### Get or Create Kernel for File

```
POST /api/kernels/for-file
```

Get existing kernel for a notebook or create a new one. Implements "one notebook = one kernel" - multiple tabs share the same kernel.

**Request Body:**
```json
{
  "file_path": "/path/to/notebook.ipynb",
  "kernel_name": "python3"
}
```

**Response:**
```json
{
  "session_id": "uuid-string",
  "kernel_name": "python3",
  "file_path": "/path/to/notebook.ipynb"
}
```

### Check Kernel for File

```
GET /api/kernels/for-file?file_path=/path/to/notebook.ipynb
```

Check if a kernel exists for a notebook file.

**Response:**
```json
{
  "session_id": "uuid-string",
  "exists": true
}
```

### List Active Sessions

```
GET /api/kernels/sessions
```

List all active kernel sessions with memory usage.

**Response:**
```json
{
  "sessions": [
    {
      "session_id": "uuid-string",
      "kernel_name": "python3",
      "file_path": "/path/to/notebook.ipynb",
      "status": "idle"
    }
  ]
}
```

### Stop Kernel

```
DELETE /api/kernels/{session_id}
```

Stop a kernel session.

**Response:**
```json
{
  "status": "ok"
}
```

### Interrupt Kernel

```
POST /api/kernels/{session_id}/interrupt
```

Interrupt current kernel execution.

**Response:**
```json
{
  "status": "ok"
}
```

### Restart Kernel

```
POST /api/kernels/{session_id}/restart
```

Restart a kernel (clears all state).

**Response:**
```json
{
  "status": "ok"
}
```

### Get Kernel Status

```
GET /api/kernels/{session_id}/status
```

Get kernel session status.

**Response:**
```json
{
  "status": "idle",
  "execution_count": 5
}
```

---

## WebSocket: Code Execution

```
WS /api/kernels/{session_id}/ws
```

WebSocket endpoint for code execution with streaming output.

### Client Messages

**Execute Code:**
```json
{
  "type": "execute",
  "code": "print('Hello, world!')"
}
```

### Server Messages

**Status Update:**
```json
{
  "type": "status",
  "status": "busy"
}
```

**Output (stdout/stderr/images/rich display):**
```json
{
  "type": "output",
  "output": {
    "type": "display_data",
    "content": "Plotly figure",
    "preferredMimeType": "application/vnd.plotly.v1+json",
    "mimeBundle": {
      "application/vnd.plotly.v1+json": {
        "data": [],
        "layout": {
          "title": "Example"
        }
      },
      "text/plain": "Plotly figure"
    },
    "metadata": {}
  }
}
```

Output types: `stdout`, `stderr`, `image`, `html`, `display_data`, `error`

For `display_data`, Nebula preserves the MIME bundle when available:

- `mimeBundle`: normalized Jupyter MIME bundle
- `preferredMimeType`: MIME type selected for rendering
- `metadata`: Jupyter output metadata

Currently prioritized rich MIME types include:

- `application/vnd.plotly.v1+json`
- `application/vnd.nebula.web+json`
- `text/html`
- `image/png`
- `text/plain`

See [RICH_OUTPUTS.md](RICH_OUTPUTS.md) for the full rendering model and examples.

**Execution Result:**
```json
{
  "type": "result",
  "result": {
    "status": "ok",
    "execution_count": 1
  }
}
```

**Error:**
```json
{
  "type": "error",
  "error": "Error message"
}
```

### Execution Flow

1. Client sends `execute` message
2. Server sends `status: busy`
3. Server streams `output` messages as execution produces output
4. Server sends `result` with final status
5. Server sends `status: idle`

---

## LLM Endpoints

### List Providers

```
GET /api/llm/providers
```

List available LLM providers and their models.

**Response:**
```json
{
  "providers": {
    "google": {
      "name": "Google Gemini",
      "available": true,
      "models": ["gemini-2.5-flash", "gemini-2.5-pro"]
    },
    "openai": {
      "name": "OpenAI",
      "available": true,
      "models": ["gpt-4o", "gpt-4o-mini"]
    },
    "anthropic": {
      "name": "Anthropic",
      "available": true,
      "models": ["claude-3-5-sonnet-20241022"]
    }
  }
}
```

### Generate Text/Code

```
POST /api/llm/generate
```

Generate text or code from an LLM.

**Request Body:**
```json
{
  "prompt": "Write a function to calculate fibonacci numbers",
  "system_prompt": "You are a helpful coding assistant.",
  "provider": "google",
  "model": "gemini-2.5-flash",
  "temperature": 0.2,
  "images": [
    {
      "type": "base64",
      "data": "...",
      "mime_type": "image/png"
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| prompt | string | Yes | The prompt to send |
| system_prompt | string | Yes | System instructions |
| provider | string | No | LLM provider (default: "google") |
| model | string | No | Model name (default: "gemini-2.5-flash") |
| temperature | float | No | Generation temperature (default: 0.2) |
| images | array | No | Images for multimodal models |

**Response:**
```json
{
  "response": "def fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)"
}
```

### Generate Structured JSON

```
POST /api/llm/generate-structured
```

Generate structured JSON response.

**Request Body:**
```json
{
  "prompt": "List 3 programming languages with their key features",
  "system_prompt": "Respond with valid JSON only.",
  "provider": "google",
  "model": "gemini-2.5-flash",
  "temperature": 0.2
}
```

**Response:**
```json
{
  "response": {
    "languages": [...]
  }
}
```

### Chat with History

```
POST /api/llm/chat
```

Chat with LLM including conversation history.

**Request Body:**
```json
{
  "message": "How do I fix this error?",
  "history": [
    {"role": "user", "content": "What is Python?"},
    {"role": "assistant", "content": "Python is a programming language..."}
  ],
  "system_prompt": "You are a helpful coding assistant.",
  "provider": "google",
  "model": "gemini-2.5-flash",
  "temperature": 0.2,
  "images": []
}
```

**Response:**
```json
{
  "response": "To fix that error, you should..."
}
```

---

## Filesystem Endpoints

### List Directory

```
GET /api/fs/list?path=/path/to/directory
```

List directory contents.

**Query Parameters:**
- `path` - Directory path (default: "~" for home)

**Response:**
```json
{
  "path": "/Users/user/projects",
  "files": [
    {
      "name": "notebook.ipynb",
      "path": "/Users/user/projects/notebook.ipynb",
      "type": "file",
      "size": 1234,
      "mtime": 1704067200.123
    },
    {
      "name": "data",
      "path": "/Users/user/projects/data",
      "type": "directory",
      "mtime": 1704067200.123
    }
  ]
}
```

### Get Directory Mtime

```
GET /api/fs/mtime?path=/path/to/directory
```

Get directory modification time (for polling/change detection).

**Response:**
```json
{
  "mtime": 1704067200.123
}
```

### Get File Mtime

```
GET /api/fs/file-mtime?path=/path/to/file.ipynb
```

Get file modification time (for conflict detection).

**Response:**
```json
{
  "mtime": 1704067200.123
}
```

### Read File

```
GET /api/fs/read?path=/path/to/file.txt
```

Read file contents.

**Response:**
```json
{
  "content": "File contents here...",
  "type": "text",
  "mtime": 1704067200.123
}
```

### Write File

```
POST /api/fs/write
```

Write content to a file.

**Request Body:**
```json
{
  "path": "/path/to/file.txt",
  "content": "New file contents",
  "file_type": "text"
}
```

**Response:**
```json
{
  "status": "ok",
  "path": "/path/to/file.txt"
}
```

### Create File/Directory

```
POST /api/fs/create
```

Create a new file or directory.

**Request Body:**
```json
{
  "path": "/path/to/new/file.txt",
  "is_directory": false
}
```

**Response:**
```json
{
  "status": "ok",
  "file": {
    "name": "file.txt",
    "path": "/path/to/new/file.txt",
    "type": "file"
  }
}
```

### Delete File/Directory

```
DELETE /api/fs/delete?path=/path/to/file.txt
```

Delete a file or directory.

**Response:**
```json
{
  "status": "ok"
}
```

### Rename/Move File

```
POST /api/fs/rename
```

Rename or move a file/directory.

**Request Body:**
```json
{
  "old_path": "/path/to/old.txt",
  "new_path": "/path/to/new.txt"
}
```

**Response:**
```json
{
  "status": "ok",
  "file": {
    "name": "new.txt",
    "path": "/path/to/new.txt",
    "type": "file"
  }
}
```

### Upload File

```
POST /api/fs/upload
```

Upload a file (multipart form data).

**Form Fields:**
- `file` - The file to upload
- `path` - Target directory path

**Response:**
```json
{
  "status": "ok",
  "file": {
    "name": "uploaded.txt",
    "path": "/path/to/uploaded.txt",
    "type": "file",
    "size": 1234
  }
}
```

---

## Notebook Endpoints

### Get Notebook Cells

```
GET /api/notebook/cells?path=/path/to/notebook.ipynb
```

Read a notebook file and return cells in internal format.

**Response:**
```json
{
  "path": "/path/to/notebook.ipynb",
  "cells": [
    {
      "id": "cell-uuid",
      "type": "code",
      "content": "print('Hello')",
      "outputs": [],
      "isExecuting": false,
      "executionCount": 1
    }
  ],
  "kernelspec": "python3",
  "mtime": 1704067200.123
}
```

### Save Notebook

```
POST /api/notebook/save
```

Save cells to a notebook file.

**Request Body:**
```json
{
  "path": "/path/to/notebook.ipynb",
  "cells": [
    {
      "id": "cell-uuid",
      "type": "code",
      "content": "print('Hello')",
      "outputs": [],
      "isExecuting": false
    }
  ],
  "kernel_name": "python3",
  "history": []
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| path | string | Yes | Notebook file path |
| cells | array | Yes | Array of cell objects |
| kernel_name | string | No | Kernel to persist in metadata |
| history | array | No | Operation history to save |

**Response:**
```json
{
  "status": "ok",
  "path": "/path/to/notebook.ipynb",
  "mtime": 1704067200.123
}
```

### Get Notebook History

```
GET /api/notebook/history?notebook_path=/path/to/notebook.ipynb
```

Load operation history from .nebula directory.

**Response:**
```json
{
  "notebook_path": "/path/to/notebook.ipynb",
  "history": [
    {
      "type": "insertCell",
      "index": 0,
      "cell": {...}
    }
  ]
}
```

### Save Notebook History

```
POST /api/notebook/history
```

Save operation history to .nebula directory.

**Request Body:**
```json
{
  "notebook_path": "/path/to/notebook.ipynb",
  "history": [...]
}
```

**Response:**
```json
{
  "status": "ok",
  "notebook_path": "/path/to/notebook.ipynb"
}
```

### Get Session State

```
GET /api/notebook/session?notebook_path=/path/to/notebook.ipynb
```

Load session state from .nebula directory.

**Response:**
```json
{
  "notebook_path": "/path/to/notebook.ipynb",
  "session": {
    "activeCellId": "cell-uuid",
    "scrollPosition": 100
  }
}
```

### Save Session State

```
POST /api/notebook/session
```

Save session state to .nebula directory.

**Request Body:**
```json
{
  "notebook_path": "/path/to/notebook.ipynb",
  "session": {
    "activeCellId": "cell-uuid",
    "scrollPosition": 100
  }
}
```

**Response:**
```json
{
  "status": "ok",
  "notebook_path": "/path/to/notebook.ipynb"
}
```

---

## Python Discovery Endpoints

### List Python Environments

```
GET /api/python/environments?refresh=false
```

List discovered Python environments.

**Query Parameters:**
- `refresh` - Force refresh cache (default: false)

**Response:**
```json
{
  "kernelspecs": [...],
  "environments": [
    {
      "path": "/usr/local/bin/python3",
      "version": "3.11.5",
      "type": "system",
      "has_ipykernel": true,
      "kernel_name": "python3"
    }
  ],
  "cache_info": {
    "cached_at": "2024-01-01T00:00:00Z",
    "expires_at": "2024-01-02T00:00:00Z"
  }
}
```

### Install Kernel

```
POST /api/python/install-kernel
```

Install ipykernel and register a Python environment.

**Request Body:**
```json
{
  "python_path": "/path/to/python",
  "kernel_name": "my-python"
}
```

**Response:**
```json
{
  "status": "ok",
  "kernel_name": "my-python"
}
```

### Refresh Environments

```
POST /api/python/refresh
```

Force refresh the Python environment cache.

**Response:**
```json
{
  "count": 5,
  "cache_info": {...}
}
```

---

## Health Endpoints

### Health Check

```
GET /api/health
```

Health check (responds immediately, even during initialization).

**Response:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "ready": true,
  "llm_providers": ["google", "openai", "anthropic"]
}
```

### Readiness Check

```
GET /api/ready
```

Readiness check (returns 503 if not fully initialized).

**Response (when ready):**
```json
{
  "status": "ready"
}
```

**Response (when initializing):**
```
HTTP 503 Service Unavailable
{
  "detail": "Service initializing, kernel discovery in progress"
}
```

---

## Example: Execute Code via WebSocket

```javascript
const ws = new WebSocket('ws://localhost:8000/api/kernels/SESSION_ID/ws');

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  switch (msg.type) {
    case 'status':
      console.log('Kernel status:', msg.status);
      break;
    case 'output':
      console.log('Output:', msg.output);
      break;
    case 'result':
      console.log('Execution complete:', msg.result);
      break;
    case 'error':
      console.error('Error:', msg.error);
      break;
  }
};

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'execute',
    code: 'print("Hello, World!")'
  }));
};
```

## Example: Save Notebook with Conflict Detection

```javascript
// 1. Load notebook and get initial mtime
const loadResponse = await fetch('/api/notebook/cells?path=/notebook.ipynb');
const { cells, mtime } = await loadResponse.json();

// 2. Check mtime before saving to detect external modifications
const mtimeResponse = await fetch('/api/fs/file-mtime?path=/notebook.ipynb');
const { mtime: currentMtime } = await mtimeResponse.json();

if (currentMtime > mtime + 0.5) {
  // File was modified externally - handle conflict
  console.warn('File was modified by another process');
}

// 3. Save notebook
const saveResponse = await fetch('/api/notebook/save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    path: '/notebook.ipynb',
    cells: updatedCells,
    kernel_name: 'python3'
  })
});

const { mtime: newMtime } = await saveResponse.json();
// Update local mtime reference for next save
```
