/**
 * File Tools
 *
 * Tools for file system operations on the Nebula server.
 * These operate on the server's filesystem, not the local MCP client filesystem.
 */

import type { Tool, ToolResult, MCPContent } from './types.js';

// =============================================================================
// read_file
// =============================================================================

export interface ReadFileParams {
  path: string;
}

export interface ReadFileResult {
  path: string;
  content: string;
  type: 'text' | 'notebook';
}

export const readFileTool: Tool<ReadFileParams, ReadFileResult> = {
  definition: {
    name: 'read_file',
    description: 'Read the contents of a text file from the server. Returns file content as string. For .ipynb notebooks, returns JSON string; .py/.qmd notebooks are plain text.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file on the server' },
      },
      required: ['path'],
    },
    annotations: { readOnlyHint: true },
  },

  async execute(params, client) {
    const result = await client.readFile(params.path);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      data: {
        path: params.path,
        content: result.data!.content,
        type: 'text',
      },
    };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { path, content } = result.data!;
    const lines = content.split('\n').length;
    const chars = content.length;
    return [{ type: 'text', text: `File: ${path} (${lines} lines, ${chars} chars)\n\n${content}` }];
  },
};

// =============================================================================
// write_file
// =============================================================================

export interface WriteFileParams {
  path: string;
  content: string;
}

export interface WriteFileResult {
  path: string;
}

export const writeFileTool: Tool<WriteFileParams, WriteFileResult> = {
  definition: {
    name: 'write_file',
    description: 'Write content to a file on the server. Creates the file and parent directories if they do not exist. Overwrites existing file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file on the server' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'],
    },
    annotations: { destructiveHint: true },
  },

  async execute(params, client) {
    const result = await client.writeFile(params.path, params.content);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return { success: true, data: { path: params.path } };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    return [{ type: 'text', text: `File written: ${result.data!.path}` }];
  },
};

// =============================================================================
// list_directory
// =============================================================================

export interface ListDirectoryParams {
  path?: string;
}

export interface ListDirectoryResult {
  path: string;
  entries: Array<{ name: string; type: string }>;
}

export const listDirectoryTool: Tool<ListDirectoryParams, ListDirectoryResult> = {
  definition: {
    name: 'list_directory',
    description: 'List contents of a directory on the server. Returns file and directory names with types.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the directory (defaults to home directory)' },
      },
      required: [],
    },
    annotations: { readOnlyHint: true },
  },

  async execute(params, client) {
    const dirPath = params.path || '~';
    const result = await client.listFiles(dirPath);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      data: {
        path: dirPath,
        entries: result.data || [],
      },
    };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { path, entries } = result.data!;
    if (entries.length === 0) {
      return [{ type: 'text', text: `Directory: ${path}\n(empty)` }];
    }
    const lines = entries.map(e => {
      const icon = e.type === 'directory' ? '📁' : '📄';
      return `  ${icon} ${e.name}`;
    });
    return [{ type: 'text', text: `Directory: ${path} (${entries.length} items)\n${lines.join('\n')}` }];
  },
};

// =============================================================================
// delete_file
// =============================================================================

export interface DeleteFileParams {
  path: string;
}

export const deleteFileTool: Tool<DeleteFileParams, void> = {
  definition: {
    name: 'delete_file',
    description: 'Delete a file or directory from the server. Directories are deleted recursively.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file or directory to delete' },
      },
      required: ['path'],
    },
    annotations: { destructiveHint: true },
  },

  async execute(params, client) {
    const result = await client.deleteFile(params.path);
    return result.success ? { success: true } : { success: false, error: result.error };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    return [{ type: 'text', text: 'File deleted' }];
  },
};

// =============================================================================
// rename_file
// =============================================================================

export interface RenameFileParams {
  old_path: string;
  new_path: string;
}

export interface RenameFileResult {
  oldPath: string;
  newPath: string;
}

export const renameFileTool: Tool<RenameFileParams, RenameFileResult> = {
  definition: {
    name: 'rename_file',
    description: 'Rename or move a file or directory on the server.',
    inputSchema: {
      type: 'object',
      properties: {
        old_path: { type: 'string', description: 'Current path of the file or directory' },
        new_path: { type: 'string', description: 'New path for the file or directory' },
      },
      required: ['old_path', 'new_path'],
    },
    annotations: { destructiveHint: true },
  },

  async execute(params, client) {
    const result = await client.renameFile(params.old_path, params.new_path);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return {
      success: true,
      data: {
        oldPath: params.old_path,
        newPath: params.new_path,
      },
    };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { oldPath, newPath } = result.data!;
    return [{ type: 'text', text: `Renamed: ${oldPath} → ${newPath}` }];
  },
};

// =============================================================================
// download_file
// =============================================================================

export interface DownloadFileParams {
  server_path: string;
  local_path: string;
}

export interface DownloadFileResult {
  serverPath: string;
  localPath: string;
  size: number;
}

export const downloadFileTool: Tool<DownloadFileParams, DownloadFileResult> = {
  definition: {
    name: 'download_file',
    description: 'Download a file from the server to a local path. Supports both text and binary files.',
    inputSchema: {
      type: 'object',
      properties: {
        server_path: { type: 'string', description: 'Path to the file on the server' },
        local_path: { type: 'string', description: 'Local path to save the file' },
      },
      required: ['server_path', 'local_path'],
    },
    annotations: { readOnlyHint: true },
  },

  async execute(params, client) {
    // Fetch from server (returns Buffer)
    const result = await client.downloadFile(params.server_path);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Write to local filesystem (MCP server runs locally)
    try {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');

      // Create parent directories if needed
      const parentDir = path.dirname(params.local_path);
      await fs.mkdir(parentDir, { recursive: true });

      // Write content as binary Buffer
      await fs.writeFile(params.local_path, result.data!.content);

      const stats = await fs.stat(params.local_path);

      return {
        success: true,
        data: {
          serverPath: params.server_path,
          localPath: params.local_path,
          size: stats.size,
        },
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { success: false, error: `Failed to write local file: ${error}` };
    }
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { serverPath, localPath, size } = result.data!;
    return [{ type: 'text', text: `Downloaded: ${serverPath} → ${localPath} (${size} bytes)` }];
  },
};

// =============================================================================
// upload_file
// =============================================================================

export interface UploadFileParams {
  local_path: string;
  server_path: string;
  /** What an existing file of the same name means. Default: fail loudly. */
  on_conflict?: 'fail' | 'overwrite' | 'rename';
}

export interface UploadFileResult {
  localPath: string;
  serverPath: string;
  size: number;
  /** True when the server stored under a deduped name ('rename' policy). */
  renamed: boolean;
}

export const uploadFileTool: Tool<UploadFileParams, UploadFileResult> = {
  definition: {
    name: 'upload_file',
    description:
      'Upload a local file to the server. Supports both text and binary files. ' +
      'Fails if the destination file already exists unless on_conflict says otherwise.',
    inputSchema: {
      type: 'object',
      properties: {
        local_path: { type: 'string', description: 'Local path of the file to upload' },
        server_path: { type: 'string', description: 'Destination path on the server' },
        on_conflict: {
          type: 'string',
          enum: ['fail', 'overwrite', 'rename'],
          description:
            "If the file already exists: 'fail' (default) refuses, 'overwrite' replaces it, " +
            "'rename' keeps both (server stores name_1.ext — check the reported path)",
        },
      },
      required: ['local_path', 'server_path'],
    },
    annotations: { destructiveHint: true },
  },

  async execute(params, client) {
    // Read from local filesystem and upload via multipart
    try {
      const fs = await import('node:fs/promises');
      const pathModule = await import('node:path');

      const content = await fs.readFile(params.local_path);
      const stats = await fs.stat(params.local_path);
      const filename = pathModule.basename(params.local_path);

      // Default FAIL on conflict: the caller named an exact destination, and
      // silently storing under `name_1.ext` while reporting success sent an
      // agent's edits to a dedupe copy nobody was reading (lab report).
      const result = await client.uploadFile(params.server_path, content, filename, {
        onConflict: params.on_conflict ?? 'fail',
      });
      if (!result.success) {
        const conflictHint = /already exists/i.test(result.error ?? '')
          ? " — pass on_conflict: 'overwrite' to replace it, or 'rename' to keep both"
          : '';
        return { success: false, error: `${result.error}${conflictHint}` };
      }

      return {
        success: true,
        data: {
          localPath: params.local_path,
          // The server's answer, not the request: under 'rename' they differ.
          serverPath: result.data!.path,
          size: stats.size,
          renamed: result.data!.name !== filename,
        },
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { success: false, error: `Failed to upload file: ${error}` };
    }
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { localPath, serverPath, size, renamed } = result.data!;
    const note = renamed ? ' — NOTE: destination existed, stored under a deduped name' : '';
    return [{ type: 'text', text: `Uploaded: ${localPath} → ${serverPath} (${size} bytes)${note}` }];
  },
};

// =============================================================================
// Export all file tools
// =============================================================================

export const fileTools = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  deleteFileTool,
  renameFileTool,
  downloadFileTool,
  uploadFileTool,
];
