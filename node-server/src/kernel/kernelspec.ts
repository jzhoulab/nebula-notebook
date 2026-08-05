/**
 * Kernelspec Discovery
 *
 * Discovers Jupyter kernelspecs from standard locations.
 * Similar to jupyter_client.kernelspec.find_kernel_specs()
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KernelSpec } from './types';
import { pythonDiscovery } from '../discovery/discovery-service';
import { prefixForPythonExe } from '../discovery/conda-locations';

// Re-export KernelSpec for convenience
export type { KernelSpec } from './types';

// In-memory cache for kernelspecs (avoids repeated disk I/O)
let kernelspecCache: KernelSpec[] | null = null;
let kernelspecCacheTime: number = 0;
const KERNELSPEC_CACHE_TTL_MS = 60 * 1000; // 60 seconds

/**
 * Standard kernelspec search paths
 */
export function getKernelSearchPaths(): string[] {
  const paths: string[] = [];
  const home = os.homedir();

  // User-local paths
  if (process.platform === 'darwin') {
    paths.push(path.join(home, 'Library', 'Jupyter', 'kernels'));
  } else if (process.platform === 'win32') {
    paths.push(path.join(home, 'AppData', 'Roaming', 'jupyter', 'kernels'));
  } else {
    const xdgDataHome = process.env.XDG_DATA_HOME;
    if (xdgDataHome) {
      paths.push(path.join(xdgDataHome, 'jupyter', 'kernels'));
    }
    paths.push(path.join(home, '.local', 'share', 'jupyter', 'kernels'));
  }

  // System paths
  if (process.platform !== 'win32') {
    paths.push('/usr/local/share/jupyter/kernels');
    paths.push('/usr/share/jupyter/kernels');
  }

  // Conda paths
  const condaPrefix = process.env.CONDA_PREFIX;
  if (condaPrefix) {
    paths.push(path.join(condaPrefix, 'share', 'jupyter', 'kernels'));
  }

  // JUPYTER_PATH environment variable
  const jupyterPath = process.env.JUPYTER_PATH;
  if (jupyterPath) {
    for (const p of jupyterPath.split(path.delimiter)) {
      if (p) {
        paths.push(path.join(p, 'kernels'));
      }
    }
  }

  // Homebrew Python paths (macOS)
  if (process.platform === 'darwin') {
    const brewPaths = [
      '/opt/homebrew/share/jupyter/kernels',
      '/usr/local/opt/python/Frameworks/Python.framework/Versions/Current/share/jupyter/kernels',
    ];
    paths.push(...brewPaths);
  }

  // pyenv paths
  const pyenvRoot = process.env.PYENV_ROOT || path.join(home, '.pyenv');
  if (fs.existsSync(pyenvRoot)) {
    const versionsDir = path.join(pyenvRoot, 'versions');
    if (fs.existsSync(versionsDir)) {
      try {
        const versions = fs.readdirSync(versionsDir);
        for (const version of versions) {
          const kernelPath = path.join(versionsDir, version, 'share', 'jupyter', 'kernels');
          paths.push(kernelPath);
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  return paths;
}

/**
 * Read a kernel.json file and return the kernelspec
 */
function readKernelSpec(kernelDir: string): KernelSpec | null {
  const kernelJsonPath = path.join(kernelDir, 'kernel.json');

  if (!fs.existsSync(kernelJsonPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(kernelJsonPath, 'utf-8');
    const spec = JSON.parse(content);

    return {
      name: path.basename(kernelDir),
      displayName: spec.display_name || path.basename(kernelDir),
      language: spec.language || 'python',
      path: kernelDir,
      argv: spec.argv,
      env: spec.env,
    };
  } catch (err) {
    console.error(`Error reading kernelspec from ${kernelDir}:`, err);
    return null;
  }
}

/**
 * Auto-registered default python specs (`python3`, `python3.11`, …) inside an
 * environment duplicate what the env row in the picker already offers ("run
 * Python here") — showing N identical "Python 3 (ipykernel)" entries would
 * drown the real kernels. VSCode hides these the same way.
 */
const DEFAULT_PYTHON_SPEC_RE = /^python\d*(\.\d+)*$/i;

/**
 * Read kernelspecs from a list of `…/kernels` directories. `seen` dedupes by
 * kernel name across calls (first path wins — Jupyter precedence order).
 */
export function readKernelSpecsFromPaths(
  searchPaths: string[],
  options: { skipDefaultPythonSpecs?: boolean; seen?: Set<string> } = {}
): KernelSpec[] {
  const specs: KernelSpec[] = [];
  const seenNames = options.seen ?? new Set<string>();

  for (const searchPath of searchPaths) {
    if (!fs.existsSync(searchPath)) {
      continue;
    }

    try {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const kernelName = entry.name;
        if (seenNames.has(kernelName)) {
          continue;
        }
        if (options.skipDefaultPythonSpecs && DEFAULT_PYTHON_SPEC_RE.test(kernelName)) {
          continue;
        }

        const kernelDir = path.join(searchPath, kernelName);
        const spec = readKernelSpec(kernelDir);

        if (spec) {
          specs.push(spec);
          seenNames.add(kernelName);
        }
      }
    } catch (err) {
      // Ignore errors reading directories
    }
  }

  return specs;
}

/** The `share/jupyter/kernels` dir belonging to each interpreter's prefix. */
export function envKernelspecDirs(envPythonPaths: string[]): string[] {
  const dirs = envPythonPaths.map(p => path.join(prefixForPythonExe(p), 'share', 'jupyter', 'kernels'));
  return [...new Set(dirs)];
}

/**
 * Perform actual kernelspec discovery (disk I/O): the standard Jupyter search
 * paths first, then every discovered Python environment's own
 * share/jupyter/kernels (how conda-installed kernels like R/Julia surface) —
 * with each env's redundant default python spec hidden.
 */
function performKernelspecDiscovery(): KernelSpec[] {
  const seen = new Set<string>();
  const specs = readKernelSpecsFromPaths(getKernelSearchPaths(), { seen });
  const envPaths = Object.keys(pythonDiscovery.getFromCache() ?? {});
  specs.push(...readKernelSpecsFromPaths(envKernelspecDirs(envPaths), { seen, skipDefaultPythonSpecs: true }));
  return specs;
}

/**
 * Discover all available kernelspecs on the system
 * Uses 60-second in-memory cache to avoid repeated disk I/O
 */
export function discoverKernelSpecs(forceRefresh = false): KernelSpec[] {
  const now = Date.now();

  // Return from cache if valid
  if (!forceRefresh && kernelspecCache && (now - kernelspecCacheTime) < KERNELSPEC_CACHE_TTL_MS) {
    return kernelspecCache;
  }

  // Perform discovery and update cache
  kernelspecCache = performKernelspecDiscovery();
  kernelspecCacheTime = now;

  return kernelspecCache;
}

/**
 * Invalidate the kernelspec cache (call after installing a new kernel)
 */
export function invalidateKernelspecCache(): void {
  kernelspecCache = null;
  kernelspecCacheTime = 0;
}

/**
 * Get a specific kernelspec by name
 */
export function getKernelSpec(name: string): KernelSpec | null {
  const specs = discoverKernelSpecs();
  return specs.find(s => s.name === name) || null;
}

/**
 * Env kernels (VSCode-style raw launch): any Python environment can be used
 * as a kernel WITHOUT registering a kernelspec on disk. The kernel name
 * `env:<pythonPath>` resolves to a synthetic in-memory spec that launches
 * `<python> -m ipykernel_launcher` directly — only ipykernel needs to be
 * importable in the environment; jupyter itself is never required.
 */
export const ENV_KERNEL_PREFIX = 'env:';

export function isEnvKernelName(name: string): boolean {
  return name.startsWith(ENV_KERNEL_PREFIX);
}

/** The interpreter path encoded in an env: kernel name, or null. */
export function envKernelPythonPath(name: string): string | null {
  return isEnvKernelName(name) ? name.slice(ENV_KERNEL_PREFIX.length) : null;
}

export function makeEnvKernelSpec(pythonPath: string, displayName?: string): KernelSpec {
  return {
    name: ENV_KERNEL_PREFIX + pythonPath,
    displayName: displayName || `Python (${pythonPath})`,
    language: 'python',
    path: '', // synthetic — no kernelspec directory on disk
    argv: [pythonPath, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
  };
}

/**
 * Resolve a kernel name to a spec: env: names produce a synthetic raw-launch
 * spec, anything else falls back to registered kernelspecs on disk.
 */
export function resolveKernelSpec(name: string, displayName?: string): KernelSpec | null {
  const pythonPath = envKernelPythonPath(name);
  if (pythonPath) return makeEnvKernelSpec(pythonPath, displayName);
  return getKernelSpec(name);
}

/**
 * Check if a kernelspec exists
 */
export function hasKernelSpec(name: string): boolean {
  return getKernelSpec(name) !== null;
}
