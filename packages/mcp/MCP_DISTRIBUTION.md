# Nebula Notebook MCP Server - Distribution Guide

## Publishing to NPM

### 1. Prepare for Publishing

```bash
# Make sure you're logged in to npm
npm login

# Build the package
npm run build

# Test the package locally
npm pack
npm install -g nebula-notebook-mcp-0.1.0.tgz

# Test that the binary works
nebula-mcp --help
```

### 2. Publish to NPM

```bash
# Publish (this will auto-build via prepublishOnly)
npm publish

# Or publish with public access if scoped package
npm publish --access public
```

## Distribution Methods

### Method 1: NPM Global Install (Recommended)

Users install globally:
```bash
npm install -g nebula-notebook-mcp
```

Then add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "nebula-notebook": {
      "command": "nebula-mcp"
    }
  }
}
```

### Method 2: npx (Zero Install)

Users don't need to install, just add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "nebula-notebook": {
      "command": "npx",
      "args": ["-y", "nebula-notebook-mcp"]
    }
  }
}
```

### Method 3: Smithery MCP Registry

Submit to https://smithery.ai/submit:

1. Go to https://smithery.ai/submit
2. Enter your npm package name: `nebula-notebook-mcp`
3. Fill in the form with:
   - **Name**: Nebula Notebook
   - **Description**: MCP server for Nebula Notebook - Jupyter alternative with AI integration
   - **Category**: Development Tools
   - **Environment Variables**: none (server URL is provided via `connect_server(base_url=...)`)

Users can then install with:
```bash
smithery install nebula-notebook-mcp
```

### Method 4: From a git checkout (unreleased builds)

There is no standalone MCP repo to install from: this package lives in the
monorepo at `packages/mcp`, and npm cannot install a subdirectory of a git
repo. To run an unpublished build, clone and link it:

```bash
git clone https://github.com/jzhoulab/nebula-notebook.git
cd nebula-notebook/packages/mcp
npm install && npm run build && npm link
```

Then point the client at the linked binary:
```json
{
  "mcpServers": {
    "nebula-notebook": {
      "command": "nebula-mcp"
    }
  }
}
```

For released versions prefer Method 1 or 2.

## User Documentation

Create a section in your main README:

```markdown
## Using with Claude Code

Nebula Notebook provides an MCP server that allows Claude Code to interact with your notebooks programmatically.

### Installation

**Option 1: NPM**
\`\`\`bash
npm install -g nebula-notebook-mcp
\`\`\`

**Option 2: npx (no install required)**
Just configure Claude Code (see below)

### Configuration

Add to your `~/.claude.json`:

\`\`\`json
{
  "mcpServers": {
    "nebula-notebook": {
      "command": "nebula-mcp"
    }
  }
}
\`\`\`

Or for npx (zero install):

\`\`\`json
{
  "mcpServers": {
    "nebula-notebook": {
      "command": "npx",
      "args": ["-y", "nebula-notebook-mcp"]
    }
  }
}
\`\`\`

### Usage

Once configured, Claude Code can:
- Create and manage notebooks
- Insert and execute cells
- Read notebook contents
- Clear cells
- And more...

Example: "Create a new notebook at /tmp/test.ipynb with a cell that prints hello world"
```

## Testing Before Publishing

```bash
# Build and link locally
npm run build
npm link

# In another project, test the linked version
cd /tmp
cat > ~/.claude.json << 'EOF'
{
  "mcpServers": {
    "nebula-notebook": {
      "command": "nebula-mcp"
    }
  }
}
EOF

# Start Claude Code and test MCP tools
```

## Versioning

Follow semantic versioning:
- **Patch** (0.1.0 → 0.1.1): Bug fixes
- **Minor** (0.1.0 → 0.2.0): New features, backward compatible
- **Major** (0.1.0 → 1.0.0): Breaking changes

Update version:
```bash
npm version patch  # or minor, or major
npm publish
```

## Checklist Before Publishing

- [ ] Update version in package.json
- [ ] Build succeeds: `npm run build`
- [ ] Tests pass: `npm test`
- [ ] README is up to date
- [ ] LICENSE file exists
- [ ] `bin/nebula-mcp.js` has proper shebang (`#!/usr/bin/env node`)
- [ ] Test locally with `npm link`
- [ ] Test with `npx` from tarball: `npm pack && npx ./nebula-notebook-mcp-0.1.0.tgz`
- [ ] Commit and tag: `git tag v0.1.0 && git push --tags`
