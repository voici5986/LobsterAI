'use strict';

/**
 * Ensure preinstalled OpenClaw plugins are downloaded and placed into the
 * runtime extensions directory.
 *
 * Uses the OpenClaw CLI (`openclaw plugins install`) to handle downloading,
 * dependency resolution, and proper module setup for each plugin declared in
 * package.json ("openclaw.plugins").
 *
 * Flow per plugin:
 *   1. Checks a local cache in vendor/openclaw-plugins/{id}/
 *   2. Installs via `openclaw plugins install` if not cached at the right version
 *   3. Copies the plugin into vendor/openclaw-runtime/current/extensions/{id}/
 *
 * Environment variables:
 *   OPENCLAW_SKIP_PLUGINS          – Set to "1" to skip this script entirely
 *   OPENCLAW_FORCE_PLUGIN_INSTALL  – Set to "1" to force re-download all plugins
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const rootDir = path.resolve(__dirname, '..');

function log(msg) {
  console.log(`[openclaw-plugins] ${msg}`);
}

function die(msg) {
  console.error(`[openclaw-plugins] ERROR: ${msg}`);
  process.exit(1);
}

function copyDirRecursive(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

/**
 * Fix broken symlinks in node_modules/.bin/ directories.
 *
 * npm creates absolute symlinks during `openclaw plugins install` that point
 * into the temporary staging directory.  After copying out of staging those
 * symlinks are broken.  This rewrites each one to a correct relative path
 * based on the symlink target structure (../pkgName/relative/to/bin).
 */
function fixBinSymlinks(baseDir) {
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isSymbolicLink()) {
        const binDir = path.dirname(full);
        if (path.basename(binDir) !== '.bin') continue;
        const target = fs.readlinkSync(full);
        if (!path.isAbsolute(target)) continue;
        // Extract the path relative to node_modules/ from the absolute target.
        // e.g. "/tmp/.../extensions/moltbot-popo/node_modules/qrcode/bin/qrcode"
        //   -> "qrcode/bin/qrcode"
        const nmSegment = '/node_modules/';
        const nmIdx = target.lastIndexOf(nmSegment);
        if (nmIdx === -1) continue;
        const relToNm = target.slice(nmIdx + nmSegment.length); // "qrcode/bin/qrcode"
        const newTarget = path.join('..', relToNm);              // "../qrcode/bin/qrcode"
        try {
          fs.unlinkSync(full);
          fs.symlinkSync(newTarget, full);
        } catch {
          // best-effort; signing can still proceed if the symlink is removed
        }
      }
    }
  };
  walk(baseDir);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Run the OpenClaw CLI with the given arguments.
 *
 * Uses the bundled runtime's openclaw.mjs entry point and sets
 * OPENCLAW_STATE_DIR to control where plugins are installed.
 */
function runOpenClawCli(args, opts = {}) {
  const openclawMjs = path.join(
    rootDir, 'vendor', 'openclaw-runtime', 'current', 'openclaw.mjs'
  );

  if (!fs.existsSync(openclawMjs)) {
    throw new Error(`OpenClaw CLI not found at ${openclawMjs}`);
  }

  const result = spawnSync(process.execPath, [openclawMjs, ...args], {
    encoding: 'utf-8',
    stdio: opts.stdio || 'inherit',
    cwd: opts.cwd || rootDir,
    env: { ...process.env, ...opts.env },
    timeout: opts.timeout || 5 * 60 * 1000,
  });

  if (result.error) {
    throw new Error(`openclaw ${args.join(' ')} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(
      `openclaw ${args.join(' ')} exited with code ${result.status}` +
      (stderr ? `\n${stderr}` : '')
    );
  }

  return (result.stdout || '').trim();
}

/**
 * Run npm to pack a plugin from a custom registry into a .tgz file.
 * Returns the path to the packed .tgz.
 */
function npmPack(npmSpec, version, registry, outputDir) {
  const isWin = process.platform === 'win32';
  const npmBin = isWin ? 'npm.cmd' : 'npm';
  const args = ['pack', `${npmSpec}@${version}`, '--pack-destination', outputDir];
  if (registry) {
    args.push(`--registry=${registry}`);
  }

  const result = spawnSync(npmBin, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: outputDir,
    shell: isWin,
    timeout: 3 * 60 * 1000,
    windowsVerbatimArguments: isWin,
  });

  if (result.error) {
    throw new Error(`npm pack ${npmSpec}@${version} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(
      `npm pack ${npmSpec}@${version} exited with code ${result.status}` +
      (stderr ? `\n${stderr}` : '')
    );
  }

  // npm pack outputs the filename of the tarball
  const tgzName = (result.stdout || '').trim().split('\n').pop();
  return path.join(outputDir, tgzName);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (process.env.OPENCLAW_SKIP_PLUGINS === '1') {
  log('Skipped (OPENCLAW_SKIP_PLUGINS=1).');
  process.exit(0);
}

// Read plugin declarations from package.json
const pkg = require(path.join(rootDir, 'package.json'));
const plugins = (pkg.openclaw && pkg.openclaw.plugins) || [];

if (!Array.isArray(plugins) || plugins.length === 0) {
  log('No plugins declared in package.json, nothing to do.');
  process.exit(0);
}

// Validate plugin declarations
for (const plugin of plugins) {
  if (!plugin.id || !plugin.npm || !plugin.version) {
    die(
      `Invalid plugin declaration: ${JSON.stringify(plugin)}. ` +
      'Each plugin must have "id", "npm", and "version" fields.'
    );
  }
}

const forceInstall = process.env.OPENCLAW_FORCE_PLUGIN_INSTALL === '1';
const pluginCacheBase = path.join(rootDir, 'vendor', 'openclaw-plugins');
const runtimeCurrentDir = path.join(rootDir, 'vendor', 'openclaw-runtime', 'current');
// Third-party plugins go into `third-party-extensions/` — a directory the gateway's
// bundled-channel metadata scan never touches.  When the gateway runs from
// `gateway-bundle.mjs` (root, not dist/), `RUNNING_FROM_BUILT_ARTIFACT` is false
// and `resolveBundledPluginScanDir` falls back to `extensions/`.  Placing our
// plugins there caused them to fail the `bundled-channel-entry` contract check
// and wasted ~30s on serial load failures.  `third-party-extensions/` is discovered
// solely via `plugins.load.paths` (origin="config"), bypassing the bundled contract.
// See openclaw/openclaw#60196.
const runtimeExtensionsDir = path.join(runtimeCurrentDir, 'third-party-extensions');

ensureDir(runtimeExtensionsDir);
ensureDir(pluginCacheBase);

log(`Processing ${plugins.length} plugin(s)...`);

for (const plugin of plugins) {
  const { id, npm: npmSpec, version, registry, optional } = plugin;
  const cacheDir = path.join(pluginCacheBase, id);
  const installInfoPath = path.join(cacheDir, 'plugin-install-info.json');
  const targetDir = path.join(runtimeExtensionsDir, id);

  log(`--- Plugin: ${id} (${npmSpec}@${version}) ---`);

  // Check cache
  let needsDownload = true;
  if (!forceInstall && fs.existsSync(installInfoPath)) {
    const info = readJsonFile(installInfoPath);
    if (info && info.version === version && info.npmSpec === npmSpec) {
      log(`Cache hit (version=${version}), skipping download.`);
      needsDownload = false;
    } else {
      log(`Cache version mismatch (cached=${info?.version || 'none'}, wanted=${version}).`);
    }
  }

  if (needsDownload) {
    log(`Installing ${npmSpec}@${version} via OpenClaw CLI...`);

    // Use a temporary OPENCLAW_STATE_DIR so the CLI installs plugins
    // into a staging directory rather than the user's global config.
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-plugin-staging-`));

    try {
      let installSpec;

      if (registry) {
        // For plugins with a custom registry, first download the tarball via
        // `npm pack`, then install the local .tgz via the OpenClaw CLI.
        log(`  Packing from custom registry: ${registry}`);
        const tgzPath = npmPack(npmSpec, version, registry, stagingDir);
        installSpec = tgzPath;
      } else {
        // Standard npm/ClawHub package — the CLI handles resolution.
        installSpec = `${npmSpec}@${version}`;
      }

      runOpenClawCli(
        ['plugins', 'install', installSpec, '--force', '--dangerously-force-unsafe-install'],
        {
          env: {
            OPENCLAW_STATE_DIR: stagingDir,
            // Prevent npm from auto-installing peerDependencies (npm v7+).
            // Channel plugins declare openclaw as a peerDep, but the host
            // gateway already provides the SDK at runtime.  Without this,
            // npm installs the full openclaw SDK + transitive deps (~738 MB)
            // into each plugin's node_modules.
            npm_config_legacy_peer_deps: 'true',
          },
          stdio: 'inherit',
        }
      );

      // The CLI installs to {OPENCLAW_STATE_DIR}/extensions/{pluginId}/
      const installedDir = path.join(stagingDir, 'extensions', id);
      if (!fs.existsSync(installedDir)) {
        // Some plugins use a different directory name than the declared id.
        // Scan the extensions directory for the installed plugin.
        const extDir = path.join(stagingDir, 'extensions');
        const entries = fs.existsSync(extDir) ? fs.readdirSync(extDir) : [];
        if (entries.length === 0) {
          throw new Error(`No plugin found in staging directory after install`);
        }
        // Use the first (and likely only) directory
        const actualDir = path.join(extDir, entries[0]);
        if (!fs.existsSync(path.join(actualDir, 'openclaw.plugin.json')) &&
            !fs.existsSync(path.join(actualDir, 'package.json'))) {
          throw new Error(`Installed plugin directory ${entries[0]} has no plugin manifest`);
        }
        // Copy the actual directory
        if (fs.existsSync(cacheDir)) {
          fs.rmSync(cacheDir, { recursive: true, force: true });
        }
        ensureDir(path.dirname(cacheDir));
        copyDirRecursive(actualDir, cacheDir);
        fixBinSymlinks(cacheDir);
      } else {
        // Replace cache dir with new content
        if (fs.existsSync(cacheDir)) {
          fs.rmSync(cacheDir, { recursive: true, force: true });
        }
        ensureDir(path.dirname(cacheDir));
        copyDirRecursive(installedDir, cacheDir);
        fixBinSymlinks(cacheDir);
      }

      // Write install info for cache validation
      fs.writeFileSync(
        installInfoPath,
        JSON.stringify(
          {
            pluginId: id,
            npmSpec,
            version,
            installedAt: new Date().toISOString(),
          },
          null,
          2
        ) + '\n',
        'utf-8'
      );

      log(`Downloaded and cached ${id}@${version}.`);
    } catch (err) {
      if (optional) {
        log(`WARNING: Failed to install optional plugin ${id}: ${err.message}`);
        log(`Skipping ${id} — it may not be available from this network.`);
        continue;
      }
      die(`Failed to install plugin ${id}: ${err.message}`);
    } finally {
      // Clean up staging directory
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  // Copy from cache to runtime extensions directory
  if (!fs.existsSync(cacheDir)) {
    if (optional) {
      log(`Skipping ${id} — cache not available (optional plugin).`);
      continue;
    }
    die(`Plugin cache directory missing after install: ${cacheDir}`);
  }

  // Remove existing target and copy fresh
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  copyDirRecursive(cacheDir, targetDir);

  // Remove the plugin-install-info.json from the target (it's cache metadata only)
  const targetInfoPath = path.join(targetDir, 'plugin-install-info.json');
  if (fs.existsSync(targetInfoPath)) {
    fs.unlinkSync(targetInfoPath);
  }

  log(`Installed ${id} -> ${path.relative(rootDir, targetDir)}`);
}

log(`All ${plugins.length} plugin(s) installed successfully.`);

// --- Post-install patch: openclaw-weixin gatewayMethods ---
// The openclaw-weixin plugin defines loginWithQrStart/loginWithQrWait in its
// gateway adapter but does not declare gatewayMethods on the channel plugin
// object.  Without this declaration, the gateway's resolveWebLoginProvider()
// cannot discover the plugin for web.login.start/web.login.wait RPC calls
// (used by our embedded web UI — the standard CLI login path uses
// plugin.auth.login instead and does not need this).
const weixinChannelPath = path.join(runtimeExtensionsDir, 'openclaw-weixin', 'src', 'channel.ts');
if (fs.existsSync(weixinChannelPath)) {
  let src = fs.readFileSync(weixinChannelPath, 'utf8');
  if (!src.includes('gatewayMethods')) {
    const marker = 'configSchema: {';
    const idx = src.indexOf(marker);
    if (idx !== -1) {
      src = src.slice(0, idx) + 'gatewayMethods: ["web.login.start", "web.login.wait"],\n  ' + src.slice(idx);
      fs.writeFileSync(weixinChannelPath, src);
      log('Patched openclaw-weixin/src/channel.ts: added gatewayMethods declaration');
    }
  } else {
    log('openclaw-weixin/src/channel.ts already has gatewayMethods, skipping patch');
  }
}
