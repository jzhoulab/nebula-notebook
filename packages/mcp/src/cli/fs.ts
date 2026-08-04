/**
 * `nebula fs …` — file operations on the Nebula SERVER's filesystem
 * (list / cat / write / rm / mv / download / upload).
 *
 * For agents running in a terminal ON the server, plain shell commands are
 * simpler — this group exists for remote agents (laptop ↔ server) and for
 * parity with the MCP file tools. Thin wrappers over the same NebulaClient
 * methods the MCP server uses.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { NebulaClient } from '../notebook/client.js';
import {
  CliError,
  EXIT,
  makeClient,
  parse,
  printHint,
  printJson,
  requirePositional,
  resolveContentInput,
  resolveUrl,
  toCliError,
  type ParsedArgs,
} from './shared.js';

const FS_HELP = `usage: nebula fs <ls|cat|write|rm|mv|download|upload> …

Paths are paths on the Nebula SERVER (in a Nebula terminal that is the local
filesystem — prefer plain shell commands there; this group is for remote use).

examples:
  nebula fs ls data/
  nebula fs cat results/summary.csv
  echo 'hello' | nebula fs write notes.txt -
  nebula fs mv old.csv archive/old.csv
  nebula fs rm scratch.txt --force
  nebula fs download results/fig1.pdf ./fig1.pdf
  nebula fs upload ./local.csv data/

Run 'nebula fs <subcommand> --help' for details.`;

export async function cmdFs(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'ls':
      return fsLs(rest);
    case 'cat':
      return fsCat(rest);
    case 'write':
      return fsWrite(rest);
    case 'rm':
      return fsRm(rest);
    case 'mv':
      return fsMv(rest);
    case 'download':
      return fsDownload(rest);
    case 'upload':
      return fsUpload(rest);
    case undefined:
    case '--help':
    case '-h':
      console.log(FS_HELP);
      return sub === undefined ? EXIT.USAGE : EXIT.OK;
    default:
      throw new CliError(`unknown fs subcommand: ${sub}`, EXIT.USAGE, "run 'nebula fs --help' for the list");
  }
}

function clientFor(values: ParsedArgs['values']): NebulaClient {
  return makeClient(resolveUrl(values.url));
}

// =============================================================================
// fs ls
// =============================================================================

const LS_HELP = `usage: nebula fs ls [path]

Lists a directory on the server (defaults to the server's root directory).

examples:
  nebula fs ls
  nebula fs ls data/raw`;

async function fsLs(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv);
  if (values.help) {
    console.log(LS_HELP);
    return EXIT.OK;
  }
  const dirPath = positionals[0] ?? '.';
  const result = await clientFor(values).listFiles(dirPath);
  if (!result.success) throw toCliError(result.error);

  const items = result.data ?? [];
  if (values.json) {
    printJson(items);
    return EXIT.OK;
  }
  for (const item of items) {
    console.log(item.type === 'directory' ? `${item.name}/` : item.name);
  }
  if (items.length === 0) {
    console.log('(empty)');
  }
  printHint('read a file with: nebula fs cat <path>', values);
  return EXIT.OK;
}

// =============================================================================
// fs cat
// =============================================================================

const CAT_HELP = `usage: nebula fs cat <path>

Prints a text file from the server. Binary files error — use fs download.

examples:
  nebula fs cat results/summary.csv`;

async function fsCat(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv);
  if (values.help) {
    console.log(CAT_HELP);
    return EXIT.OK;
  }
  const filePath = requirePositional(positionals, 0, 'path', 'nebula fs cat <path>');
  const result = await clientFor(values).readFile(filePath);
  if (!result.success) throw toCliError(result.error);

  if (values.json) {
    printJson({ path: filePath, content: result.data!.content });
    return EXIT.OK;
  }
  process.stdout.write(result.data!.content);
  if (!result.data!.content.endsWith('\n')) process.stdout.write('\n');
  return EXIT.OK;
}

// =============================================================================
// fs write
// =============================================================================

const WRITE_HELP = `usage: nebula fs write <path> (--content <str> | --content-file <f> | -)

Writes a text file on the server (creates or overwrites).

examples:
  nebula fs write notes.txt --content 'hello'
  cat local.csv | nebula fs write data/upload.csv -`;

async function fsWrite(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    content: { type: 'string' },
    'content-file': { type: 'string' },
  });
  if (values.help) {
    console.log(WRITE_HELP);
    return EXIT.OK;
  }
  const usage = 'nebula fs write <path> (--content <str> | --content-file <f> | -)';
  const filePath = requirePositional(positionals, 0, 'path', usage);
  const stdinMarker = positionals[1] === '-';
  const content = await resolveContentInput(values.content, values['content-file'], stdinMarker);

  const result = await clientFor(values).writeFile(filePath, content);
  if (!result.success) throw toCliError(result.error);

  if (values.json) {
    printJson({ path: filePath, bytes: Buffer.byteLength(content), written: true });
    return EXIT.OK;
  }
  console.log(`wrote ${filePath} (${Buffer.byteLength(content)} bytes)`);
  printHint(`verify with: nebula fs cat ${filePath}`, values);
  return EXIT.OK;
}

// =============================================================================
// fs rm
// =============================================================================

const RM_HELP = `usage: nebula fs rm <path> --force

Deletes a file (or directory) on the server — --force is required.

examples:
  nebula fs rm scratch.txt --force`;

async function fsRm(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { force: { type: 'boolean' } });
  if (values.help) {
    console.log(RM_HELP);
    return EXIT.OK;
  }
  const filePath = requirePositional(positionals, 0, 'path', 'nebula fs rm <path> --force');
  if (!values.force) {
    throw new CliError('fs rm deletes server files — pass --force to confirm', EXIT.USAGE);
  }
  const result = await clientFor(values).deleteFile(filePath);
  if (!result.success) throw toCliError(result.error);

  if (values.json) {
    printJson({ path: filePath, deleted: true });
    return EXIT.OK;
  }
  console.log(`deleted ${filePath}`);
  return EXIT.OK;
}

// =============================================================================
// fs mv
// =============================================================================

const MV_HELP = `usage: nebula fs mv <old-path> <new-path>

Renames/moves a file or directory on the server.

examples:
  nebula fs mv old.csv archive/old.csv`;

async function fsMv(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv);
  if (values.help) {
    console.log(MV_HELP);
    return EXIT.OK;
  }
  const usage = 'nebula fs mv <old-path> <new-path>';
  const oldPath = requirePositional(positionals, 0, 'old-path', usage);
  const newPath = requirePositional(positionals, 1, 'new-path', usage);

  const result = await clientFor(values).renameFile(oldPath, newPath);
  if (!result.success) throw toCliError(result.error);

  if (values.json) {
    printJson({ from: oldPath, to: newPath, moved: true });
    return EXIT.OK;
  }
  console.log(`moved ${oldPath} -> ${newPath}`);
  return EXIT.OK;
}

// =============================================================================
// fs download
// =============================================================================

const DOWNLOAD_HELP = `usage: nebula fs download <server-path> <local-path>

Downloads a file from the server to THIS machine (text or binary).

examples:
  nebula fs download results/fig1.pdf ./fig1.pdf`;

async function fsDownload(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv);
  if (values.help) {
    console.log(DOWNLOAD_HELP);
    return EXIT.OK;
  }
  const usage = 'nebula fs download <server-path> <local-path>';
  const serverPath = requirePositional(positionals, 0, 'server-path', usage);
  const localPath = requirePositional(positionals, 1, 'local-path', usage);

  const result = await clientFor(values).downloadFile(serverPath);
  if (!result.success) throw toCliError(result.error);

  const target = localPath.endsWith('/') || (fs.existsSync(localPath) && fs.statSync(localPath).isDirectory())
    ? path.join(localPath, path.basename(serverPath))
    : localPath;
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, result.data!.content);

  if (values.json) {
    printJson({ from: serverPath, to: target, bytes: result.data!.content.length });
    return EXIT.OK;
  }
  console.log(`downloaded ${serverPath} -> ${target} (${result.data!.content.length} bytes)`);
  return EXIT.OK;
}

// =============================================================================
// fs upload
// =============================================================================

const UPLOAD_HELP = `usage: nebula fs upload <local-path> <server-dir> [--name NAME] [--overwrite | --rename]

Uploads a local file into a directory on the server (text or binary).

If the destination file already exists the upload FAILS unless you choose:
  --overwrite   replace the existing file (cp semantics)
  --rename      keep both — the server stores under name_1.ext and the real
                stored path is printed (it is NOT the name you asked for)

examples:
  nebula fs upload ./local.csv data/
  nebula fs upload ./model.py scripts/ --overwrite
  nebula fs upload ./local.csv data/ --name renamed.csv`;

async function fsUpload(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    name: { type: 'string' },
    overwrite: { type: 'boolean' },
    rename: { type: 'boolean' },
  });
  if (values.help) {
    console.log(UPLOAD_HELP);
    return EXIT.OK;
  }
  const usage = 'nebula fs upload <local-path> <server-dir> [--name NAME] [--overwrite | --rename]';
  const localPath = requirePositional(positionals, 0, 'local-path', usage);
  const serverDir = requirePositional(positionals, 1, 'server-dir', usage);
  if (values.overwrite && values.rename) {
    throw new CliError('--overwrite and --rename are mutually exclusive', EXIT.USAGE);
  }

  let content: Buffer;
  try {
    content = fs.readFileSync(localPath);
  } catch (e) {
    throw new CliError(`cannot read ${localPath}: ${e instanceof Error ? e.message : String(e)}`, EXIT.USAGE);
  }
  const filename = (values.name as string | undefined) ?? path.basename(localPath);

  // Default is FAIL on conflict: an agent that named an exact destination must
  // hear "that exists" — not have its file silently stored under `name_1.ext`
  // while the success message claims otherwise (lab report: edits went to a
  // dedupe copy nobody was reading).
  const onConflict = values.overwrite ? 'overwrite' : values.rename ? 'rename' : 'fail';
  const result = await clientFor(values).uploadFile(serverDir, content, filename, { onConflict });
  if (!result.success) {
    if (/already exists/i.test(result.error ?? '')) {
      throw new CliError(
        result.error!, EXIT.ERROR,
        'pass --overwrite to replace it, or --rename to keep both (stored as name_1.ext)'
      );
    }
    throw toCliError(result.error);
  }

  // Always report the SERVER-confirmed path — under --rename it differs from
  // the requested name, and that difference must be impossible to miss.
  const dest = result.data!.path;
  const renamed = result.data!.name !== filename;
  if (values.json) {
    printJson({ from: localPath, to: dest, bytes: content.length, renamed });
    return EXIT.OK;
  }
  console.log(`uploaded ${localPath} -> ${dest} (${content.length} bytes)`);
  if (renamed) {
    console.log(`NOTE: ${filename} already existed — stored as ${result.data!.name} instead`);
  }
  printHint(`verify with: nebula fs ls ${serverDir}`, values);
  return EXIT.OK;
}
