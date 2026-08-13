/**
 * Filesystem API Routes
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { fsService } from '../fs/fs-service';
import * as path from 'path';
import * as os from 'os';
import { privateTmpDir } from '../private-tmp';
import * as nodeFs from 'fs';
import { assertPathMutable, sealedErrorBody, SealedPathLockedError } from '../fs/sealed-path';

function sendSealedError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (!(error instanceof SealedPathLockedError)) return null;
  return reply.code(error.statusCode).send(sealedErrorBody(error));
}

export default async function fsRoutes(fastify: FastifyInstance) {
  /**
   * List directory contents
   */
  fastify.get('/fs/list', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const dirPath = ((request.query as any).path as string) || '~';
      const result = await fsService.listDirectory(dirPath);
      return reply.send(result);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found') || err.message.includes('ENOENT')) {
          return reply.code(404).send({ detail: err.message });
        } else if (err.message.includes('permission') || err.message.includes('EACCES')) {
          return reply.code(403).send({ detail: err.message });
        } else {
          return reply.code(500).send({ detail: err.message });
        }
      } else {
        return reply.code(500).send({ detail: 'Unknown error' });
      }
    }
  });

  /**
   * Get current server root directory
   */
  fastify.get('/fs/root', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ root: fsService.getRootDirectory() });
  });

  /**
   * Set server root directory
   */
  fastify.post('/fs/root', async (request: FastifyRequest, reply: FastifyReply) => {
    const { root } = (request.body as any) || {};
    if (!root || typeof root !== 'string') {
      return reply.code(400).send({ detail: 'root is required' });
    }

    try {
      const updated = fsService.setRootDirectory(root);
      return reply.send({ root: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to set root';
      return reply.code(400).send({ detail: message });
    }
  });

  /**
   * Get directory modification time
   */
  fastify.get('/fs/mtime', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const dirPath = ((request.query as any).path as string) || '~';
      const result = fsService.getDirectoryMtime(dirPath);
      return reply.send(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        return reply.code(404).send({ detail: err.message });
      } else {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({ detail: message });
      }
    }
  });

  /**
   * Get file modification time
   */
  fastify.get('/fs/file-mtime', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const filePath = (request.query as any).path as string;
      if (!filePath) {
        return reply.code(400).send({ detail: 'path query parameter is required' });
      }
      const result = await fsService.getFileMtime(filePath);
      return reply.send(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        return reply.code(404).send({ detail: err.message });
      } else {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({ detail: message });
      }
    }
  });

  /**
   * Read file contents
   */
  fastify.get('/fs/read', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const filePath = (request.query as any).path as string;
      if (!filePath) {
        return reply.code(400).send({ detail: 'path query parameter is required' });
      }
      const result = await fsService.readFile(filePath);
      return reply.send(result);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found') || err.message.includes('ENOENT')) {
          return reply.code(404).send({ detail: err.message });
        } else if (err.message.includes('directory') || err.message.includes('EISDIR')) {
          return reply.code(400).send({ detail: err.message });
        } else {
          return reply.code(500).send({ detail: err.message });
        }
      } else {
        return reply.code(500).send({ detail: 'Unknown error' });
      }
    }
  });

  /**
   * Write content to a file
   */
  fastify.post('/fs/write', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { path: filePath, content, file_type = 'text' } = request.body as any;
      if (!filePath) {
        return reply.code(400).send({ detail: 'path is required' });
      }
      fsService.writeFile(filePath, content, file_type);
      return reply.send({ status: 'ok', path: filePath });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Create a new file or directory
   */
  fastify.post('/fs/create', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { path: filePath, is_directory = false } = request.body as any;
      if (!filePath) {
        return reply.code(400).send({ detail: 'path is required' });
      }
      const info = fsService.createFile(filePath, is_directory);
      return reply.send({ status: 'ok', file: info });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      if (err instanceof Error && err.message.includes('exists')) {
        return reply.code(409).send({ detail: err.message });
      } else {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({ detail: message });
      }
    }
  });

  /**
   * Delete a file or directory
   */
  fastify.delete('/fs/delete', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const filePath = (request.query as any).path as string;
      if (!filePath) {
        return reply.code(400).send({ detail: 'path query parameter is required' });
      }
      fsService.deleteFile(filePath);
      return reply.send({ status: 'ok' });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      if (err instanceof Error && err.message.includes('not found')) {
        return reply.code(404).send({ detail: err.message });
      } else {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.code(500).send({ detail: message });
      }
    }
  });

  /**
   * Rename/move a file or directory
   */
  fastify.post('/fs/rename', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { old_path, new_path } = request.body as any;
      if (!old_path || !new_path) {
        return reply.code(400).send({ detail: 'old_path and new_path are required' });
      }
      const info = fsService.renameFile(old_path, new_path);
      return reply.send({ status: 'ok', file: info });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      if (err instanceof Error) {
        if (err.message.includes('not found')) {
          return reply.code(404).send({ detail: err.message });
        } else if (err.message.includes('exists')) {
          return reply.code(409).send({ detail: err.message });
        } else {
          return reply.code(500).send({ detail: err.message });
        }
      } else {
        return reply.code(500).send({ detail: 'Unknown error' });
      }
    }
  });

  /**
   * Duplicate a file or directory
   */
  fastify.post('/fs/duplicate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { path: filePath } = request.body as any;
      if (!filePath) {
        return reply.code(400).send({ detail: 'path is required' });
      }
      const info = fsService.duplicateFile(filePath);
      return reply.send({ status: 'ok', file: info });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      if (err instanceof Error) {
        if (err.message.includes('not found')) {
          return reply.code(404).send({ detail: err.message });
        } else {
          return reply.code(500).send({ detail: err.message });
        }
      } else {
        return reply.code(500).send({ detail: 'Unknown error' });
      }
    }
  });

  /**
   * Download a file (raw stream with proper headers)
   */
  fastify.get('/fs/download', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const filePath = (request.query as any).path as string;
      if (!filePath) {
        return reply.code(400).send({ detail: 'path query parameter is required' });
      }

      const normalizedPath = fsService.normalizePath(filePath);

      if (!nodeFs.existsSync(normalizedPath)) {
        return reply.code(404).send({ detail: `File not found: ${normalizedPath}` });
      }

      const stat = nodeFs.statSync(normalizedPath);
      if (stat.isDirectory()) {
        return reply.code(400).send({ detail: 'Cannot download a directory' });
      }

      const filename = path.basename(normalizedPath);
      const extension = path.extname(normalizedPath).toLowerCase();

      // Set content type based on extension
      const mimeTypes: Record<string, string> = {
        '.txt': 'text/plain',
        '.json': 'application/json',
        '.ipynb': 'application/json',
        '.py': 'text/x-python',
        '.js': 'application/javascript',
        '.ts': 'application/typescript',
        '.html': 'text/html',
        '.css': 'text/css',
        '.csv': 'text/csv',
        '.md': 'text/markdown',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.pdf': 'application/pdf',
        '.zip': 'application/zip',
      };

      const contentType = mimeTypes[extension] || 'application/octet-stream';

      // Inline viewing (?inline=1): hand the file to the browser's own viewer
      // in a new tab instead of forcing a download. Restricted to an allowlist
      // of types the browser renders SAFELY as data (PDF/images/media/text).
      // HTML is intentionally excluded — served inline same-origin, its JS
      // could read the Nebula auth token; it goes through the trust-gated
      // /?html= view instead. nosniff stops the browser from re-interpreting a
      // mislabeled file as something executable.
      const wantInline = (request.query as any).inline === '1' || (request.query as any).inline === 'true';
      const INLINE_OK = new Set([
        '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif',
        '.mp4', '.webm', '.mov', '.m4v', '.ogv',
        '.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac',
        '.txt', '.csv', '.tsv', '.log', '.json', '.md',
      ]);
      const inline = wantInline && INLINE_OK.has(extension);
      const disposition = inline ? 'inline' : 'attachment';

      const stream = nodeFs.createReadStream(normalizedPath);
      return reply
        .header('Content-Type', contentType)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `${disposition}; filename="${filename}"`)
        .header('Content-Length', stat.size)
        .send(stream);
    } catch (err) {
      if (err instanceof Error) {
        if (err.message.includes('not found') || err.message.includes('ENOENT')) {
          return reply.code(404).send({ detail: err.message });
        } else {
          return reply.code(500).send({ detail: err.message });
        }
      } else {
        return reply.code(500).send({ detail: 'Unknown error' });
      }
    }
  });

  /**
   * Upload a file
   * Uses @fastify/multipart (registered in index.ts)
   */
  fastify.post('/fs/upload', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const data = await request.file();
      if (!data) {
        return reply.code(400).send({ detail: 'file is required' });
      }

      // Read the dest path from the fields
      const destPathField = data.fields.path;
      const destPath = destPathField && 'value' in destPathField ? (destPathField as any).value as string : undefined;

      if (!destPath) {
        return reply.code(400).send({ detail: 'path is required' });
      }
      // Reject sealed destinations before buffering the multipart payload to a
      // temp file. FilesystemService repeats this at the actual write boundary.
      assertPathMutable(fsService.normalizePath(destPath), { operation: 'upload into' });

      // Save the uploaded file to a temp location first
      const tmpPath = path.join(privateTmpDir('uploads'), `upload-${Date.now()}-${path.basename(data.filename || 'file')}`);
      const writeStream = nodeFs.createWriteStream(tmpPath);
      await new Promise<void>((resolve, reject) => {
        data.file.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });

      // Conflict policy comes from the query string (multipart field order is
      // fragile — see the `path` field comment above). Default 'rename'
      // preserves browser drag-drop's never-clobber behavior.
      const rawConflict = (request.query as { on_conflict?: string } | undefined)?.on_conflict;
      const onConflict = rawConflict === 'overwrite' || rawConflict === 'fail' ? rawConflict : 'rename';
      const info = await fsService.uploadFile(destPath, tmpPath, data.filename, onConflict);

      // Clean up temp file
      try { nodeFs.unlinkSync(tmpPath); } catch { /* ignore */ }

      return reply.send({ status: 'ok', file: info });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      if (err instanceof Error) {
        if (err.message.includes('already exists')) {
          return reply.code(409).send({ detail: err.message });
        } else if (err.message.includes('not found')) {
          return reply.code(404).send({ detail: err.message });
        } else if (err.message.includes('permission')) {
          return reply.code(403).send({ detail: err.message });
        } else {
          return reply.code(500).send({ detail: err.message });
        }
      } else {
        return reply.code(500).send({ detail: 'Unknown error' });
      }
    }
  });
}

export { fsService };
