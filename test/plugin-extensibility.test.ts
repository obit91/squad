import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPluginInstallPlan,
  derivePluginRoles,
  parsePluginManifestContent,
  validatePluginManifest,
} from '../packages/squad-sdk/src/marketplace/index.js';
import { AgentLifecycleManager } from '../packages/squad-sdk/src/agents/index.js';
import { runPlugin } from '../packages/squad-cli/src/cli/commands/plugin.js';

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function capturePluginCommand(cwd: string, args: string[]): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    await runPlugin(cwd, args);
    return [...log.mock.calls, ...info.mock.calls].map((call) => call.join(' ')).join('\n');
  } finally {
    log.mockRestore();
    info.mockRestore();
  }
}

describe('plugin manifest parser and validator', () => {
  it('accepts declarative plugin.manifest.json manifests and derives roles from declared components', () => {
    const manifest = parsePluginManifestContent(JSON.stringify({
      id: 'demo-plugin',
      name: 'Demo Plugin',
      version: '1.0.0',
      description: 'A declarative test plugin.',
      authors: ['Squad'],
      license: 'MIT',
      squad: '>=0.9.1',
      components: {
        knowledge: ['demo-plugin'],
        memory: { provider: 'demo-memory' },
      },
      copilot: {
        requires: [
          {
            id: 'github/copilot-plugin-example',
            version: '>=1.0.0',
            optional: true,
            reason: 'Enables Copilot-owned commands when the user has installed it.',
          },
        ],
      },
      files: [
        { source: 'guidance.md', target: 'knowledge/demo-plugin/guidance.md', type: 'knowledge' },
      ],
    }), 'plugin.manifest.json');

    const validation = validatePluginManifest(manifest);
    expect(validation.valid, validation.errors.join(', ')).toBe(true);
    expect(derivePluginRoles(manifest)).toEqual(['knowledge', 'memory']);
    expect(manifest.copilot?.requires?.[0]).toMatchObject({
      id: 'github/copilot-plugin-example',
      optional: true,
    });

    const plan = createPluginInstallPlan(manifest, { dryRun: true });
    expect(plan.dryRun).toBe(true);
    expect(plan.files[0]?.targetRoot).toBe('knowledge');
  });

  it('rejects executable declarations, script files, and path traversal', () => {
    expect(() => parsePluginManifestContent(JSON.stringify({
      id: 'bad-plugin',
      name: 'Bad Plugin',
      version: '1.0.0',
      components: {
        hooks: [{ command: 'node bad.js' }],
      },
      files: [],
    }))).toThrow(/executable key/);

    const manifest = parsePluginManifestContent(JSON.stringify({
      id: 'bad-plugin',
      name: 'Bad Plugin',
      version: '1.0.0',
      files: [
        { source: 'bad.js', target: '../bad.js', type: 'knowledge' },
      ],
    }));
    const validation = validatePluginManifest(manifest);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join('\n')).toMatch(/executable or script|relative path/);
  });

  it('rejects Squad-owned skill components and invalid Copilot dependency declarations', () => {
    const manifest = parsePluginManifestContent(JSON.stringify({
      id: 'bad-plugin',
      name: 'Bad Plugin',
      version: '1.0.0',
      components: {
        skills: ['copilot-owned-skill'],
      },
      copilot: {
        requires: [
          { id: '../not-a-plugin' },
        ],
      },
      files: [
        { source: 'guidance.md', target: 'knowledge/demo-plugin/guidance.md', type: 'knowledge' },
      ],
    }));

    const validation = validatePluginManifest(manifest);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join('\n')).toMatch(/components\.skills is not supported/);
    expect(validation.errors.join('\n')).toMatch(/copilot\.requires\[0\]\.id/);
  });

  it('validates the external integration sample plugins without fake Copilot dependencies', () => {
    const samples = [
      { name: 'plugin-knowledge-graphify', role: 'knowledge', packageName: 'graphifyy' },
      { name: 'plugin-memory-mempalace', role: 'memory', packageName: 'mempalace' },
      { name: 'plugin-knowledge-index-server', role: 'knowledge', packageName: '@jagilber-org/index-server' },
    ];

    for (const sample of samples) {
      const manifestPath = join(process.cwd(), 'samples', sample.name, 'plugin.manifest.json');
      const manifest = parsePluginManifestContent(readFileSync(manifestPath, 'utf8'), 'plugin.manifest.json');
      const validation = validatePluginManifest(manifest);

      expect(validation.valid, `${sample.name}: ${validation.errors.join(', ')}`).toBe(true);
      expect(derivePluginRoles(manifest)).toContain(sample.role);
      expect(manifest.copilot?.requires ?? []).toEqual([]);
      expect(manifest.upstream?.package).toBe(sample.packageName);
      expect(manifest.repository?.url).toMatch(/^https:\/\/github\.com\//);
    }
  });

  it('keeps external install and MCP hints as metadata-only warnings', () => {
    const manifest = parsePluginManifestContent(JSON.stringify({
      id: 'external-tool',
      name: 'External Tool',
      version: '1.0.0',
      components: {
        knowledge: ['external-tool'],
      },
      repository: {
        type: 'github',
        url: 'https://github.com/example/external-tool',
      },
      upstream: {
        package: 'external-tool',
        registry: 'pypi',
        installCommand: 'pip install external-tool',
        docs: 'https://github.com/example/external-tool',
      },
      mcp: {
        available: true,
        server: 'external-tool',
        entryPoint: 'external-tool-mcp',
        installCommand: 'external-tool-mcp',
        reason: 'Optional MCP server users may configure separately.',
      },
      files: [
        { source: 'guidance.md', target: 'knowledge/external-tool/guidance.md', type: 'knowledge' },
      ],
    }), 'plugin.manifest.json');

    const validation = validatePluginManifest(manifest);

    expect(validation.valid, validation.errors.join(', ')).toBe(true);
    expect(validation.warnings.join('\n')).toContain('upstream.installCommand is metadata only');
    expect(validation.warnings.join('\n')).toContain('mcp.installCommand is metadata only');
  });

  it('rejects non-https external metadata URLs', () => {
    const manifest = parsePluginManifestContent(JSON.stringify({
      id: 'external-tool',
      name: 'External Tool',
      version: '1.0.0',
      repository: {
        type: 'github',
        url: 'http://github.com/example/external-tool',
      },
      files: [
        { source: 'guidance.md', target: 'knowledge/external-tool/guidance.md', type: 'knowledge' },
      ],
    }), 'plugin.manifest.json');

    const validation = validatePluginManifest(manifest);

    expect(validation.valid).toBe(false);
    expect(validation.errors.join('\n')).toContain('repository.url must use https');
  });
});

describe('squad plugin lifecycle CLI', () => {
  let tmpDir: string;
  let pluginDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'squad-plugin-lifecycle-'));
    mkdirSync(join(tmpDir, '.squad'), { recursive: true });
    pluginDir = join(tmpDir, 'demo-plugin');
    writeFile(join(pluginDir, 'plugin.manifest.json'), JSON.stringify({
      id: 'demo-plugin',
      name: 'Demo Plugin',
      version: '1.0.0',
      description: 'A declarative test plugin.',
      components: {
        knowledge: ['demo-plugin'],
        memory: { provider: 'demo-memory' },
      },
      copilot: {
        requires: [
          {
            id: 'github/copilot-plugin-example',
            optional: true,
            reason: 'Used by Copilot when installed separately.',
          },
        ],
      },
      files: [
        { source: 'guidance.md', target: 'knowledge/demo-plugin/guidance.md', type: 'knowledge' },
      ],
    }, null, 2));
    writeFile(join(pluginDir, 'guidance.md'), '# Demo Plugin\n\nStatic knowledge content.\n');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('validates and dry-runs without writing plugin state', async () => {
    const output = await capturePluginCommand(tmpDir, ['dry-run', pluginDir]);

    expect(output).toContain('Dry run deployment plan');
    expect(output).toContain('Squad records these dependencies but does not install or run Copilot plugin commands.');
    expect(readFileSync(join(pluginDir, 'guidance.md'), 'utf8')).toContain('Static knowledge content');
    expect(() => readFileSync(join(tmpDir, '.squad', 'plugins', 'installed.json'), 'utf8')).toThrow();
  });

  it('installs disabled, verifies, enables, switches, disables, and uninstalls', async () => {
    await capturePluginCommand(tmpDir, ['install', pluginDir]);
    expect(readFileSync(join(tmpDir, '.squad', 'knowledge', 'demo-plugin', 'guidance.md'), 'utf8'))
      .toBe('# Demo Plugin\n\nStatic knowledge content.\n');

    const installed = JSON.parse(readFileSync(join(tmpDir, '.squad', 'plugins', 'installed.json'), 'utf8')) as {
      plugins: Array<{ id: string; enabled: boolean; roles: string[]; copilot?: { requires?: Array<{ id: string }> } }>;
    };
    expect(installed.plugins[0]).toMatchObject({
      id: 'demo-plugin',
      enabled: false,
      roles: ['knowledge', 'memory'],
      copilot: {
        requires: [
          { id: 'github/copilot-plugin-example' },
        ],
      },
    });

    await capturePluginCommand(tmpDir, ['verify']);
    await capturePluginCommand(tmpDir, ['enable', 'demo-plugin']);
    let runtime = JSON.parse(readFileSync(join(tmpDir, '.squad', 'plugins', 'runtime.json'), 'utf8')) as {
      plugins: Record<string, { enabled: boolean }>;
      active: Record<string, string>;
    };
    expect(runtime.plugins['demo-plugin']?.enabled).toBe(true);
    expect(runtime.active.memory).toBe('demo-plugin');
    expect(runtime.active.knowledge).toBe('demo-plugin');

    await capturePluginCommand(tmpDir, ['switch', 'memory', 'demo-plugin']);
    await capturePluginCommand(tmpDir, ['disable', 'demo-plugin']);
    runtime = JSON.parse(readFileSync(join(tmpDir, '.squad', 'plugins', 'runtime.json'), 'utf8')) as {
      active: Record<string, string>;
    };
    expect(runtime.active.memory).toBeUndefined();
    expect(runtime.active.knowledge).toBeUndefined();

    await capturePluginCommand(tmpDir, ['uninstall', 'demo-plugin']);
    const afterUninstall = JSON.parse(readFileSync(join(tmpDir, '.squad', 'plugins', 'installed.json'), 'utf8')) as {
      plugins: unknown[];
    };
    expect(afterUninstall.plugins).toHaveLength(0);
    expect(() => readFileSync(join(tmpDir, '.squad', 'knowledge', 'demo-plugin', 'guidance.md'), 'utf8')).toThrow();

    const audit = readFileSync(join(tmpDir, '.squad', 'plugins', 'audit.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string });
    expect(audit.map((event) => event.type)).toEqual([
      'install',
      'verify',
      'enable',
      'switch',
      'disable',
      'uninstall',
    ]);
  });

  it('rejects symlinked plugin source files before install writes state', async () => {
    rmSync(join(pluginDir, 'guidance.md'), { force: true });
    symlinkSync(join(tmpDir, 'outside.md'), join(pluginDir, 'guidance.md'));

    await expect(runPlugin(tmpDir, ['install', pluginDir])).rejects.toThrow(/symlink/);
    expect(() => readFileSync(join(tmpDir, '.squad', 'plugins', 'installed.json'), 'utf8')).toThrow();
  });
});

describe('plugin behavioral influence on spawned squad agents', () => {
  const samples = [
    {
      name: 'plugin-knowledge-graphify',
      id: 'graphify-knowledge',
      installedFile: ['knowledge', 'graphify', 'graphify-integration.md'],
      expectedGuidance: 'Graphify is the `safishamsi/graphify` knowledge graph tool',
      expectedPackage: 'Upstream package: graphifyy (pypi)',
    },
    {
      name: 'plugin-memory-mempalace',
      id: 'mempalace-memory',
      installedFile: ['memory', 'providers', 'mempalace-provider.md'],
      expectedGuidance: 'MemPalace is an example memory provider profile',
      expectedPackage: 'Upstream package: mempalace (pypi)',
    },
    {
      name: 'plugin-knowledge-index-server',
      id: 'index-server-knowledge',
      installedFile: ['knowledge', 'index-server', 'index-server-integration.md'],
      expectedGuidance: 'Index Server is the `jagilber-org/index-server` MCP instruction indexing server',
      expectedPackage: 'Upstream package: @jagilber-org/index-server (npm)',
    },
  ];

  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const tmpDir of tmpDirs) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  for (const sample of samples) {
    it(`injects enabled ${sample.name} static guidance into spawned agent system context`, async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), `squad-plugin-behavior-${sample.id}-`));
      tmpDirs.push(tmpDir);
      mkdirSync(join(tmpDir, '.squad'), { recursive: true });
      writeFile(join(tmpDir, '.squad', 'agents', 'data', 'charter.md'), [
        '# Data Charter',
        '',
        '## Identity',
        '',
        '**Name:** Data',
        '**Role:** Code Expert',
        '**Expertise:** C#, Go, .NET',
        '**Style:** Direct',
        '',
        '## Collaboration',
        '',
        'Use installed project context when provided.',
        '',
      ].join('\n'));

      const sampleDir = join(process.cwd(), 'samples', sample.name);
      await capturePluginCommand(tmpDir, ['install', sampleDir]);
      const installedArtifact = join(tmpDir, '.squad', ...sample.installedFile);
      expect(readFileSync(installedArtifact, 'utf8')).toContain(sample.expectedGuidance);

      const disabledPrompt = await spawnAndCaptureSystemPrompt(tmpDir);
      expect(disabledPrompt).not.toContain('## Active Squad Plugins');
      expect(disabledPrompt).not.toContain(sample.expectedGuidance);

      await capturePluginCommand(tmpDir, ['enable', sample.id]);
      const enabledPrompt = await spawnAndCaptureSystemPrompt(tmpDir);

      expect(enabledPrompt).toContain('## Plugin Context');
      expect(enabledPrompt).toContain('## Active Squad Plugins');
      expect(enabledPrompt).toContain('Squad has not installed upstream packages, started MCP servers, or run external plugin commands.');
      expect(enabledPrompt).toContain(`### ${sample.id.includes('graphify') ? 'Graphify Knowledge Graph' : sample.id.includes('mempalace') ? 'MemPalace Memory' : 'Index Server Knowledge'} (${sample.id}@1.0.0)`);
      expect(enabledPrompt).toContain(`#### Installed artifact: .squad/${sample.installedFile.join('/')}`);
      expect(enabledPrompt).toContain(sample.expectedGuidance);
      expect(enabledPrompt).toContain(sample.expectedPackage);
    });
  }

  it('does not read outside .squad when installed plugin state is tampered', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'squad-plugin-behavior-tamper-'));
    tmpDirs.push(tmpDir);
    mkdirSync(join(tmpDir, '.squad'), { recursive: true });
    writeFile(join(tmpDir, '.squad', 'agents', 'data', 'charter.md'), [
      '# Data Charter',
      '',
      '## Identity',
      '',
      '**Name:** Data',
      '**Role:** Code Expert',
      '',
    ].join('\n'));

    const sampleDir = join(process.cwd(), 'samples', 'plugin-knowledge-graphify');
    await capturePluginCommand(tmpDir, ['install', sampleDir]);
    await capturePluginCommand(tmpDir, ['enable', 'graphify-knowledge']);
    writeFile(join(tmpDir, 'outside-secret.md'), 'DO_NOT_INJECT_PLUGIN_SECRET');

    const installedPath = join(tmpDir, '.squad', 'plugins', 'installed.json');
    const installed = JSON.parse(readFileSync(installedPath, 'utf8')) as {
      plugins: Array<{ files: Array<{ target: string }> }>;
    };
    installed.plugins[0]!.files[0]!.target = '../outside-secret.md';
    writeFile(installedPath, `${JSON.stringify(installed, null, 2)}\n`);

    const prompt = await spawnAndCaptureSystemPrompt(tmpDir);

    expect(prompt).toContain('Skipped unsafe plugin state target.');
    expect(prompt).not.toContain('DO_NOT_INJECT_PLUGIN_SECRET');
  });
});

async function spawnAndCaptureSystemPrompt(teamRoot: string): Promise<string> {
  const capturedConfigs: Array<{ systemMessage?: { content?: string } }> = [];
  let sessionCounter = 0;
  const client = {
    async createSession(config: { systemMessage?: { content?: string } }) {
      capturedConfigs.push(config);
      return {
        sessionId: `plugin-behavior-session-${++sessionCounter}`,
        async sendMessage() {},
        async close() {},
        on() {},
        off() {},
      };
    },
  };
  const manager = new AgentLifecycleManager({
    client: client as never,
    teamRoot,
    defaultIdleTimeout: 60_000,
  });
  try {
    await manager.spawnAgent({
      agentName: 'data',
      task: 'Use the available squad context to plan the work.',
    });
  } finally {
    await manager.shutdown();
  }

  return capturedConfigs[0]?.systemMessage?.content ?? '';
}
