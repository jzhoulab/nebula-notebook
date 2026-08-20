/**
 * Notebook API Routes
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { drivingContext } from '../terminal/driving-context';
import { fsService } from '../fs/fs-service';
import { NebulaCell } from '../fs/types';
import { operationRouter } from '../notebook/operation-router';
import { HeadlessOperationHandler } from '../notebook/headless-handler';
import { kernelService } from './kernel';
import {
  classifySealedPath,
  sealedErrorBody,
  SealedPathLockedError,
} from '../fs/sealed-path';
import replaySealRoutes from './replay-seal';

// Initialize headless handler with kernel service for cell execution
const headlessHandler = new HeadlessOperationHandler(fsService, operationRouter, kernelService);
operationRouter.setHeadlessHandler(headlessHandler);

function sendSealedError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (!(error instanceof SealedPathLockedError)) return null;
  return reply.code(error.statusCode).send(sealedErrorBody(error));
}

export default async function notebookRoutes(fastify: FastifyInstance) {
  await fastify.register(replaySealRoutes);

  /**
   * Get cell metadata schema
   */
  fastify.get('/cell/metadata-schema', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      id: {
        type: 'string',
        description: 'Unique cell identifier. Agent-created cells should use human-readable IDs.',
        agentMutable: true,
      },
      type: {
        type: 'enum',
        values: ['code', 'markdown'],
        description: 'Cell type: code for executable cells, markdown for documentation.',
        agentMutable: true,
      },
      scrolled: {
        type: 'boolean',
        description: 'Whether cell output is collapsed (Jupyter standard).',
        agentMutable: true,
        default: false,
      },
      scrolledHeight: {
        type: 'number',
        description: 'Height in pixels when output is collapsed.',
        agentMutable: true,
      },
    });
  });

  /**
   * Get notebook cells in internal format
   */
  fastify.get('/notebook/cells', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const filePath = (request.query as any).path as string;
      if (!filePath) {
        return reply.code(400).send({ detail: 'path query parameter is required' });
      }
      const normalizedPath = fsService.normalizePath(filePath);
      const sealInfo = classifySealedPath(normalizedPath);
      const sealHint = (request.query as any).seal as string | undefined;
      if (sealHint && (!sealInfo.sealed || sealInfo.sealId !== sealHint)) {
        return reply.code(409).send({
          code: 'seal_mismatch',
          detail: sealInfo.sealed
            ? `Seal hint ${sealHint} does not match canonical path seal ${sealInfo.sealId}`
            : `Seal hint ${sealHint} does not identify the requested notebook path`,
        });
      }
      const result = await fsService.getNotebookCellsWithKernel(filePath);
      return reply.send({
        path: normalizedPath,
        cells: result.cells,
        metadata: result.metadata,
        kernelspec: result.kernelspec,
        mtime: result.mtime,
        access: sealInfo.sealed
          ? { read_only: true, reason: 'sealed', seal_id: sealInfo.sealId }
          : { read_only: false },
      });
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
   * Save notebook cells
   */
  fastify.post('/notebook/save', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { path: filePath, cells, kernel_name, history } = request.body as any;
      if (!filePath) {
        return reply.code(400).send({ detail: 'path is required' });
      }
      if (!cells) {
        return reply.code(400).send({ detail: 'cells is required' });
      }

      const result = await fsService.saveNotebookBundle(
        filePath,
        cells as NebulaCell[],
        kernel_name,
        history
      );

      // Outputs-unchanged sentinel couldn't be resolved against the file on
      // disk (first save, changed ids, external rewrite…) — tell the client
      // to resend the full payload.
      if (!result.success && result.needsFull) {
        return reply.code(409).send({ detail: 'unchanged-outputs sentinel unresolved; resend full payload', code: 'needs_full' });
      }

      // The UI just wrote newer content than whatever the headless handler may
      // have cached. Drop the cache so headless ops (an agent working after the
      // user closes the tab) reload from disk instead of serving — or worse,
      // OCC-validating against — stale cells.
      headlessHandler.invalidate(filePath);
      headlessHandler.invalidate(fsService.normalizePath(filePath));

      return reply.send({ status: 'ok', path: filePath, mtime: result.mtime });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Load operation history for a notebook
   */
  fastify.get('/notebook/history', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const notebookPath = (request.query as any).notebook_path as string;
      if (!notebookPath) {
        return reply.code(400).send({ detail: 'notebook_path query parameter is required' });
      }
      const history = await fsService.loadHistory(notebookPath);
      return reply.send({ notebook_path: notebookPath, history });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Save operation history for a notebook
   */
  fastify.post('/notebook/history', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { notebook_path, history } = request.body as any;
      if (!notebook_path) {
        return reply.code(400).send({ detail: 'notebook_path is required' });
      }
      await fsService.saveHistory(notebook_path, history || []);
      return reply.send({ status: 'ok', notebook_path });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Load session state for a notebook
   */
  fastify.get('/notebook/session', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const notebookPath = (request.query as any).notebook_path as string;
      if (!notebookPath) {
        return reply.code(400).send({ detail: 'notebook_path query parameter is required' });
      }
      const session = fsService.loadSession(notebookPath);
      return reply.send({ notebook_path: notebookPath, session });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Save session state for a notebook
   */
  fastify.post('/notebook/session', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { notebook_path, session } = request.body as any;
      if (!notebook_path) {
        return reply.code(400).send({ detail: 'notebook_path is required' });
      }
      await fsService.saveSession(notebook_path, session || {});
      return reply.send({ status: 'ok', notebook_path });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Grant or revoke agent permission to modify a notebook
   */
  fastify.post('/notebook/permit-agent', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { notebook_path, permitted = true } = request.body as any;
      if (!notebook_path) {
        return reply.code(400).send({ detail: 'notebook_path is required' });
      }

      const result = await fsService.setAgentPermission(notebook_path, permitted);

      if (!result.success) {
        return reply.code(400).send({ detail: result.error || 'Failed to update notebook' });
      }

      return reply.send({
        status: 'ok',
        notebook_path,
        mtime: result.mtime,
        ...(result.status || await fsService.getAgentPermissionStatusAsync(notebook_path)),
      });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Get agent permission status for a notebook
   */
  fastify.get('/notebook/agent-status', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const filePath = (request.query as any).path as string;
      if (!filePath) {
        return reply.code(400).send({ detail: 'path query parameter is required' });
      }

      const status = await fsService.getAgentPermissionStatusAsync(filePath);

      return reply.send({
        notebook_path: filePath,
        ...status,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Read notebook via operation router
   *
   * Supports output truncation for large outputs.
   * When include_outputs=true (default), outputs are truncated with defaults.
   *
   * Uses operation router to get live state from UI if connected,
   * otherwise reads from file.
   */
  fastify.get('/notebook/read', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const filePath = (request.query as any).path as string;
      if (!filePath) {
        return reply.code(400).send({ detail: 'path query parameter is required' });
      }

      const includeOutputs = (request.query as any).include_outputs !== 'false';
      const maxLines = (request.query as any).max_lines ? parseInt((request.query as any).max_lines as string, 10) : undefined;
      const maxChars = (request.query as any).max_chars ? parseInt((request.query as any).max_chars as string, 10) : undefined;
      const maxLinesError = (request.query as any).max_lines_error ? parseInt((request.query as any).max_lines_error as string, 10) : undefined;
      const maxCharsError = (request.query as any).max_chars_error ? parseInt((request.query as any).max_chars_error as string, 10) : undefined;

      // Use operation router to get state from UI if connected, otherwise from file
      const result = await operationRouter.readNotebook(
        filePath,
        includeOutputs,
        maxLines,
        maxChars,
        maxLinesError,
        maxCharsError
      );

      return reply.send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.send({ success: false, error: message });
    }
  });

  /**
   * Check if UI is connected for a notebook
   */
  fastify.get('/notebook/has-ui', async (request: FastifyRequest, reply: FastifyReply) => {
    const filePath = (request.query as any).path as string;
    if (!filePath) {
      return reply.code(400).send({ detail: 'path query parameter is required' });
    }
    const hasUI = operationRouter.hasUI(filePath);
    return reply.send({ hasUI, path: filePath });
  });

  /**
   * Apply a notebook operation
   *
   * Routes to UI if connected, otherwise uses headless handler.
   */
  fastify.post('/notebook/operation', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      // Python uses {operation: {...}} wrapper via NotebookOperationRequest model
      const operation = (request.body as any).operation || request.body;
      if (!operation || !operation.type) {
        return reply.code(400).send({ detail: 'Operation with type is required' });
      }

      const result = await operationRouter.applyOperation(operation);
      if (result.code === 'sealed_read_only') {
        return reply.code(403).send(result);
      }
      // Drift notice: when the calling agent declared its terminal (env var →
      // header) and the user is viewing a DIFFERENT notebook than this
      // operation targets, say so once per switch — in the one channel the
      // agent cannot miss. Never blocks the operation.
      const agentTerminal = request.headers['x-nebula-agent-terminal'];
      const opPath = typeof operation.notebookPath === 'string' ? operation.notebookPath : '';
      if (typeof agentTerminal === 'string' && agentTerminal && opPath && result.success !== false) {
        const notice = drivingContext.driftNotice(agentTerminal, opPath);
        if (notice) (result as Record<string, unknown>).notice = notice;
      }
      return reply.send(result);
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.send({ success: false, error: message });
    }
  });

  /**
   * Get notebook settings (nebula metadata)
   */
  fastify.get('/notebook/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const filePath = (request.query as any).path as string;
      if (!filePath) {
        return reply.code(400).send({ detail: 'path query parameter is required' });
      }

      const metadata = fsService.getNotebookMetadata(filePath);
      const nebula = (metadata.nebula || {}) as Record<string, unknown>;

      return reply.send({
        notebook_path: filePath,
        output_logging: nebula.output_logging || 'minimal',
        full_width: nebula.full_width === true,
      });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Update notebook settings (nebula metadata)
   */
  fastify.post('/notebook/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { path: filePath, output_logging, full_width } = request.body as any;
      if (!filePath) {
        return reply.code(400).send({ detail: 'path is required' });
      }

      // Validate output_logging value
      if (output_logging !== undefined && output_logging !== 'minimal' && output_logging !== 'full') {
        return reply.code(400).send({ detail: 'output_logging must be "minimal" or "full"' });
      }
      if (full_width !== undefined && typeof full_width !== 'boolean') {
        return reply.code(400).send({ detail: 'full_width must be a boolean' });
      }

      // Get existing metadata
      const metadata = fsService.getNotebookMetadata(filePath);
      const nebula = (metadata.nebula || {}) as Record<string, unknown>;

      // Update settings
      if (output_logging !== undefined) {
        nebula.output_logging = output_logging;
      }
      if (full_width !== undefined) {
        nebula.full_width = full_width;
      }

      // Save back
      const updateResult = await fsService.updateNotebookMetadata(filePath, { nebula });
      if (!updateResult.success) {
        return reply.code(500).send({ detail: updateResult.error || 'Failed to update notebook metadata' });
      }

      return reply.send({
        status: 'ok',
        notebook_path: filePath,
        output_logging: nebula.output_logging || 'minimal',
        full_width: nebula.full_width === true,
        mtime: updateResult.mtime,
      });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });

  /**
   * Persist live ipywidgets state into notebook metadata.widgets
   * (application/vnd.jupyter.widget-state+json), making saved notebooks
   * render static widgets in Jupyter/nbviewer.
   */
  fastify.post('/notebook/widget-state', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { path: filePath, widget_state } = request.body as { path?: string; widget_state?: unknown };
      if (!filePath) {
        return reply.code(400).send({ detail: 'path is required' });
      }
      if (!widget_state || typeof widget_state !== 'object') {
        return reply.code(400).send({ detail: 'widget_state must be an object' });
      }

      const updateResult = await fsService.updateNotebookMetadata(filePath, {
        widgets: { 'application/vnd.jupyter.widget-state+json': widget_state },
      });
      if (!updateResult.success) {
        return reply.code(500).send({ detail: updateResult.error || 'Failed to update notebook metadata' });
      }

      return reply.send({ status: 'ok', notebook_path: filePath, mtime: updateResult.mtime });
    } catch (err) {
      const sealed = sendSealedError(reply, err);
      if (sealed) return sealed;
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.code(500).send({ detail: message });
    }
  });
}

export { fsService, operationRouter, headlessHandler };
