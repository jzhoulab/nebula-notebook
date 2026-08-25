/**
 * Cell Metadata Schema
 *
 * Defines all metadata fields supported by Nebula cells.
 * This schema is the single source of truth - used by:
 * - Nebula UI for metadata handling
 * - MCP server for agent validation
 * - API endpoint for external tools
 *
 * When adding new metadata fields:
 * 1. Add the field here with proper type and description
 * 2. Update Cell interface in types.ts if needed
 * 3. Update fs_service.py to preserve the field on save/load
 */

export interface MetadataFieldSchema {
  type: 'string' | 'number' | 'boolean' | 'enum';
  values?: readonly string[];  // For enum type
  description: string;
  agentMutable: boolean;  // Can MCP agents modify this?
  default?: unknown;
}

export const CELL_METADATA_SCHEMA = {
  id: {
    type: 'string',
    description: 'Unique cell identifier. Agent-created cells should use human-readable IDs.',
    agentMutable: true,
  },
  type: {
    type: 'enum',
    values: ['code', 'markdown'] as const,
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
  sourceCollapsed: {
    type: 'boolean',
    description: 'Whether the cell SOURCE is collapsed to a fixed, scrollable height.',
    agentMutable: true,
    default: false,
  },
  sourceHeight: {
    type: 'number',
    description: 'Height in pixels when the cell source is collapsed.',
    agentMutable: true,
  },
} as const satisfies Record<string, MetadataFieldSchema>;

export type CellMetadataKey = keyof typeof CELL_METADATA_SCHEMA;

/**
 * Get metadata schema as plain object (for API responses)
 */
export function getMetadataSchema(): Record<string, MetadataFieldSchema> {
  return { ...CELL_METADATA_SCHEMA };
}

/**
 * Check if a metadata key is valid and agent-mutable
 */
export function isAgentMutableField(key: string): boolean {
  const field = CELL_METADATA_SCHEMA[key as CellMetadataKey];
  return field?.agentMutable ?? false;
}

/**
 * Validate a value against a metadata field schema
 */
export function validateMetadataValue(
  key: string,
  value: unknown
): { valid: boolean; error?: string } {
  const schema = CELL_METADATA_SCHEMA[key as CellMetadataKey];

  if (!schema) {
    const allowed = Object.keys(CELL_METADATA_SCHEMA).join(', ');
    return { valid: false, error: `Unknown field "${key}". Allowed: ${allowed}` };
  }

  if (!schema.agentMutable) {
    return { valid: false, error: `Field "${key}" is not modifiable` };
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        return { valid: false, error: `Field "${key}" must be a string` };
      }
      break;
    case 'number':
      if (typeof value !== 'number') {
        return { valid: false, error: `Field "${key}" must be a number` };
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        return { valid: false, error: `Field "${key}" must be a boolean` };
      }
      break;
    case 'enum':
      if (!(schema.values as readonly string[] | undefined)?.includes(value as string)) {
        return { valid: false, error: `Field "${key}" must be one of: ${schema.values?.join(', ')}` };
      }
      break;
  }

  return { valid: true };
}
