import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: (name: string) => {
      if (name === 'home') return os.homedir();
      return os.tmpdir();
    },
  },
}));

vi.mock('./claudeSettings', () => ({
  getAllServerModelMetadata: () => [],
  resolveAllEnabledProviderConfigs: () => [],
  resolveAllProviderApiKeys: () => ({}),
  resolveRawApiConfig: () => ({
    config: {
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      apiType: 'openai',
    },
    providerMetadata: {
      providerName: 'openai',
      codingPlanEnabled: false,
      supportsImage: false,
      modelName: 'GPT Test',
    },
  }),
}));

vi.mock('./openclawLocalExtensions', () => ({
  findThirdPartyExtensionsDir: () => null,
  hasBundledOpenClawExtension: () => true,
}));

vi.mock('./openclawTokenProxy', () => ({
  getOpenClawTokenProxyPort: () => null,
}));

describe('OpenClawConfigSync runtime config output', () => {
  let tmpDir: string;
  let configPath: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-config-sync-'));
    stateDir = path.join(tmpDir, 'state');
    configPath = path.join(stateDir, 'openclaw.json');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('writes Telegram streaming in the nested schema expected by current OpenClaw', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramOpenClawConfig: () => ({
        enabled: true,
        botToken: 'tg-token',
        dmPolicy: 'open',
        allowFrom: ['*'],
        groupPolicy: 'allowlist',
        groupAllowFrom: [],
        groups: { '*': { requireMention: true } },
        historyLimit: 50,
        replyToMode: 'off',
        linkPreview: true,
        streaming: 'off',
        mediaMaxMb: 5,
        proxy: '',
        webhookUrl: '',
        webhookSecret: '',
        debug: false,
      }),
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getPopoConfig: () => null,
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    });

    const result = sync.sync('test');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.channels.telegram.streaming).toEqual({ mode: 'off' });
  });

  test('does not inject unsupported _agentBinding channel metadata and requests restart when bindings change', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const baseDeps = {
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramOpenClawConfig: () => null,
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [{
        enabled: true,
        clientId: 'ding-client-id',
        clientSecret: 'ding-secret',
        dmPolicy: 'open',
        allowFrom: ['*'],
        groupPolicy: 'open',
        sessionTimeout: 0,
        separateSessionByConversation: false,
        groupSessionScope: 'group',
        sharedMemoryAcrossConversations: false,
        gatewayBaseUrl: '',
        debug: false,
        instanceId: 'b8a32c47-c852-4ad2-bbfa-631797fc56ea',
        instanceName: 'DingTalk Bot 1',
      }],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getPopoConfig: () => null,
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => null,
      getSkillsList: () => [],
      getAgents: () => [{
        id: 'worker-agent',
        enabled: true,
        name: 'Worker Agent',
        prompt: '',
        model: 'openai/gpt-test',
        source: 'user',
      }],
    };

    let currentBindings: Record<string, string> = {};
    const sync = new OpenClawConfigSync({
      ...baseDeps,
      getIMSettings: () => ({
        platformAgentBindings: currentBindings,
      }),
    } as never);

    expect(sync.sync('baseline').ok).toBe(true);

    currentBindings = {
      'dingtalk:b8a32c47-c852-4ad2-bbfa-631797fc56ea': 'worker-agent',
    };
    const result = sync.sync('binding-changed');

    expect(result.ok).toBe(true);
    expect(result.bindingsChanged).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.channels.dingtalk).not.toHaveProperty('_agentBinding');
  });

  test('writes weixin channel config using dmPolicy and allowFrom instead of unsupported accountId', async () => {
    const { OpenClawConfigSync } = await import('./openclawConfigSync');

    const sync = new OpenClawConfigSync({
      engineManager: {
        getConfigPath: () => configPath,
        getGatewayToken: () => 'gateway-token',
        getStateDir: () => stateDir,
      } as never,
      getCoworkConfig: () => ({
        workingDirectory: tmpDir,
        systemPrompt: '',
        executionMode: 'local',
        agentEngine: 'openclaw',
        memoryEnabled: false,
        memoryImplicitUpdateEnabled: false,
        memoryLlmJudgeEnabled: false,
        memoryGuardLevel: 'balanced',
        memoryUserMemoriesMaxItems: 100,
        skipMissedJobs: false,
      }),
      isEnterprise: () => false,
      getTelegramOpenClawConfig: () => null,
      getDiscordOpenClawConfig: () => null,
      getDingTalkInstances: () => [],
      getFeishuInstances: () => [],
      getQQInstances: () => [],
      getWecomConfig: () => null,
      getPopoConfig: () => null,
      getNimConfig: () => null,
      getNeteaseBeeChanConfig: () => null,
      getWeixinConfig: () => ({
        enabled: true,
        accountId: '97a130e3b62f@im.bot',
        dmPolicy: 'open',
        allowFrom: [],
        debug: false,
      }),
      getIMSettings: () => null,
      getSkillsList: () => [],
      getAgents: () => [],
    });

    const result = sync.sync('weixin-schema');
    expect(result.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.channels['openclaw-weixin']).toEqual({
      enabled: true,
      dmPolicy: 'open',
      allowFrom: ['*'],
    });
    expect(config.channels['openclaw-weixin']).not.toHaveProperty('accountId');
  });
});
