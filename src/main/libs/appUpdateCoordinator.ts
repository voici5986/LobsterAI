import crypto from 'crypto';
import { app, BrowserWindow, session } from 'electron';

import {
  type AppUpdateCheckResult,
  type AppUpdateInfo,
  AppUpdateIpc,
  type AppUpdateRuntimeState,
  AppUpdateStatus,
} from '../../shared/appUpdate/constants';
import type { SqliteStore } from '../sqliteStore';
import { cancelActiveDownload, downloadUpdate, installUpdate } from './appUpdateInstaller';
import { getFallbackDownloadUrl, getManualUpdateCheckUrl, getUpdateCheckUrl } from './endpoints';

type ChangeLogLang = {
  title?: string;
  content?: string[];
};

type PlatformDownload = {
  url?: string;
};

type UpdateApiResponse = {
  code?: number;
  data?: {
    value?: {
      version?: string;
      date?: string;
      changeLog?: {
        ch?: ChangeLogLang;
        en?: ChangeLogLang;
      };
      macIntel?: PlatformDownload;
      macArm?: PlatformDownload;
      windowsX64?: PlatformDownload;
    };
  };
};

const INSTALLATION_UUID_KEY = 'installation_uuid';
const APP_UPDATE_TEST_CURRENT_VERSION_ENV = 'LOBSTERAI_UPDATE_CURRENT_VERSION';

const initialState = (): AppUpdateRuntimeState => ({
  status: AppUpdateStatus.Idle,
  info: null,
  progress: null,
  readyFilePath: null,
  errorMessage: null,
});

export class AppUpdateCoordinator {
  private state: AppUpdateRuntimeState = initialState();
  private readonly store: SqliteStore;
  private autoOpenReadyModal = false;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  getState(): AppUpdateRuntimeState {
    return { ...this.state };
  }

  shouldAutoOpenReadyModal(): boolean {
    return this.autoOpenReadyModal;
  }

  consumeAutoOpenReadyModal(): void {
    this.autoOpenReadyModal = false;
  }

  async checkNow(options?: { manual?: boolean }): Promise<AppUpdateCheckResult> {
    if (this.isUpdateDisabled()) {
      console.log('[AppUpdate] updates are disabled by enterprise config');
      const state = this.resetToIdle();
      return { success: true, state, updateFound: false };
    }

    if (
      this.state.status === AppUpdateStatus.Downloading ||
      this.state.status === AppUpdateStatus.Installing
    ) {
      return { success: true, state: this.getState(), updateFound: this.state.info !== null };
    }

    const previousState = this.getState();
    this.setState({
      ...this.state,
      status: AppUpdateStatus.Checking,
      errorMessage: null,
    });

    try {
      const currentVersion = this.resolveCurrentVersion();
      const info = await this.fetchUpdateInfo(currentVersion, options?.manual === true);
      if (!info) {
        const state = this.resetToIdle();
        return { success: true, state, updateFound: false };
      }

      const updateFound = true;

      if (
        this.state.status === AppUpdateStatus.Ready &&
        this.state.info?.latestVersion === info.latestVersion &&
        this.state.readyFilePath
      ) {
        const state = this.setState({
          ...this.state,
          info,
          status: AppUpdateStatus.Ready,
          errorMessage: null,
        });
        return { success: true, state, updateFound };
      }

      if (!this.canPredownload(info.url)) {
        const state = this.setState({
          status: AppUpdateStatus.Available,
          info,
          progress: null,
          readyFilePath: null,
          errorMessage: null,
        });
        return { success: true, state, updateFound };
      }

      if (previousState.readyFilePath && previousState.info?.latestVersion !== info.latestVersion) {
        await this.cleanupReadyFile(previousState.readyFilePath);
      }

      const state = await this.startDownload(info);
      return { success: true, state, updateFound };
    } catch (error) {
      console.error('[AppUpdate] check failed:', error);
      const state = this.setState({
        ...previousState,
        status: previousState.info ? AppUpdateStatus.Error : AppUpdateStatus.Idle,
        errorMessage: error instanceof Error ? error.message : 'Check failed',
      });
      return {
        success: false,
        state,
        updateFound: previousState.info !== null,
        error: state.errorMessage ?? 'Check failed',
      };
    }
  }

  async retryDownload(): Promise<AppUpdateRuntimeState> {
    if (!this.state.info) {
      return this.getState();
    }
    if (!this.canPredownload(this.state.info.url)) {
      return this.getState();
    }
    return this.startDownload(this.state.info);
  }

  cancelDownload(): AppUpdateRuntimeState {
    const cancelled = cancelActiveDownload();
    if (!cancelled) {
      return this.getState();
    }
    return this.setState({
      status: AppUpdateStatus.Available,
      info: this.state.info,
      progress: null,
      readyFilePath: null,
      errorMessage: null,
    });
  }

  async installReadyUpdate(): Promise<{
    success: boolean;
    state: AppUpdateRuntimeState;
    error?: string;
  }> {
    if (!this.state.readyFilePath || this.state.status !== AppUpdateStatus.Ready) {
      return {
        success: false,
        state: this.getState(),
        error: 'Update is not ready to install',
      };
    }

    const filePath = this.state.readyFilePath;
    this.setState({
      ...this.state,
      status: AppUpdateStatus.Installing,
      errorMessage: null,
    });

    try {
      await installUpdate(filePath);
      return { success: true, state: this.getState() };
    } catch (error) {
      console.error('[AppUpdate] install failed:', error);
      const state = this.setState({
        ...this.state,
        status: AppUpdateStatus.Error,
        errorMessage: error instanceof Error ? error.message : 'Installation failed',
      });
      return {
        success: false,
        state,
        error: state.errorMessage ?? 'Installation failed',
      };
    }
  }

  private resetToIdle(): AppUpdateRuntimeState {
    const previousReadyFilePath = this.state.readyFilePath;
    const state = this.setState(initialState());
    if (previousReadyFilePath) {
      void this.cleanupReadyFile(previousReadyFilePath);
    }
    return state;
  }

  private async startDownload(info: AppUpdateInfo): Promise<AppUpdateRuntimeState> {
    this.setState({
      status: AppUpdateStatus.Downloading,
      info,
      progress: null,
      readyFilePath: null,
      errorMessage: null,
    });

    try {
      const filePath = await downloadUpdate(info.url, progress => {
        this.setState({
          ...this.state,
          status: AppUpdateStatus.Downloading,
          info,
          progress,
          errorMessage: null,
        });
      });

      this.autoOpenReadyModal = true;
      return this.setState({
        status: AppUpdateStatus.Ready,
        info,
        progress: null,
        readyFilePath: filePath,
        errorMessage: null,
      });
    } catch (error) {
      const cancelled = error instanceof Error && error.message === 'Download cancelled';
      if (cancelled) {
        return this.setState({
          status: AppUpdateStatus.Available,
          info,
          progress: null,
          readyFilePath: null,
          errorMessage: null,
        });
      }

      console.error('[AppUpdate] background download failed:', error);
      return this.setState({
        status: AppUpdateStatus.Error,
        info,
        progress: null,
        readyFilePath: null,
        errorMessage: error instanceof Error ? error.message : 'Download failed',
      });
    }
  }

  private async fetchUpdateInfo(
    currentVersion: string,
    manual: boolean,
  ): Promise<AppUpdateInfo | null> {
    const baseUrl = manual ? getManualUpdateCheckUrl() : getUpdateCheckUrl();
    const qs = this.getUpdateQueryString();
    const url = qs ? `${baseUrl}?${qs}` : baseUrl;
    console.log(`[AppUpdate] checking update, currentVersion=${currentVersion}, url=${url}`);

    const response = await session.defaultSession.fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Update check failed (HTTP ${response.status})`);
    }

    const payload = (await response.json()) as UpdateApiResponse;
    if (payload.code !== 0) {
      throw new Error(`Update check failed with code ${payload.code ?? 'unknown'}`);
    }

    const value = payload.data?.value;
    const latestVersion = value?.version?.trim();
    if (!latestVersion || !this.isNewerVersion(latestVersion, currentVersion)) {
      console.log(
        `[AppUpdate] no update available, latestVersion=${latestVersion || 'N/A'}, currentVersion=${currentVersion}`,
      );
      return null;
    }

    const toEntry = (log?: ChangeLogLang) => ({
      title: typeof log?.title === 'string' ? log.title : '',
      content: Array.isArray(log?.content) ? log.content : [],
    });

    const result: AppUpdateInfo = {
      latestVersion,
      date: value?.date?.trim() || '',
      changeLog: {
        zh: toEntry(value?.changeLog?.ch),
        en: toEntry(value?.changeLog?.en),
      },
      url: this.getPlatformDownloadUrl(value),
    };
    console.log(
      `[AppUpdate] update available: ${currentVersion} -> ${latestVersion}, downloadUrl=${result.url}`,
    );
    return result;
  }

  private getPlatformDownloadUrl(
    value: NonNullable<NonNullable<UpdateApiResponse['data']>['value']> | undefined,
  ): string {
    if (process.platform === 'darwin') {
      const download = process.arch === 'arm64' ? value?.macArm : value?.macIntel;
      return download?.url?.trim() || getFallbackDownloadUrl();
    }

    if (process.platform === 'win32') {
      return value?.windowsX64?.url?.trim() || getFallbackDownloadUrl();
    }

    return getFallbackDownloadUrl();
  }

  private canPredownload(url: string): boolean {
    if (process.platform !== 'darwin' && process.platform !== 'win32') {
      return false;
    }
    return this.isDirectInstallerUrl(url);
  }

  private isDirectInstallerUrl(url: string): boolean {
    if (!url || url.includes('#') || url.endsWith('/download-list')) {
      return false;
    }
    const normalizedPath = new URL(url).pathname.toLowerCase();
    if (process.platform === 'darwin') {
      return normalizedPath.endsWith('.dmg');
    }
    if (process.platform === 'win32') {
      return normalizedPath.endsWith('.exe');
    }
    return false;
  }

  private isUpdateDisabled(): boolean {
    const enterprise = this.store.get<{ disableUpdate?: boolean }>('enterprise_config');
    return enterprise?.disableUpdate === true;
  }

  private resolveCurrentVersion(): string {
    const overriddenVersion = process.env[APP_UPDATE_TEST_CURRENT_VERSION_ENV]?.trim();
    if (overriddenVersion) {
      console.log(
        `[AppUpdate] using overridden current version from ${APP_UPDATE_TEST_CURRENT_VERSION_ENV}: ${overriddenVersion}`,
      );
      return overriddenVersion;
    }

    return app.getVersion();
  }

  private getUpdateQueryString(): string {
    const params = new URLSearchParams();
    const installationId = this.getOrCreateInstallationId();
    if (installationId) {
      params.append('uuid', installationId);
    }
    return params.toString();
  }

  private getOrCreateInstallationId(): string | null {
    try {
      const existing = this.store.get<string>(INSTALLATION_UUID_KEY);
      if (typeof existing === 'string' && existing.trim()) {
        return existing;
      }
      const nextId = crypto.randomUUID();
      this.store.set(INSTALLATION_UUID_KEY, nextId);
      return nextId;
    } catch (error) {
      console.warn('[AppUpdate] failed to get installation uuid:', error);
      return null;
    }
  }

  private isNewerVersion(latestVersion: string, currentVersion: string): boolean {
    return this.compareVersions(latestVersion, currentVersion) > 0;
  }

  private compareVersions(a: string, b: string): number {
    const aParts = this.toVersionParts(a);
    const bParts = this.toVersionParts(b);
    const maxLength = Math.max(aParts.length, bParts.length);

    for (let index = 0; index < maxLength; index += 1) {
      const left = aParts[index] ?? 0;
      const right = bParts[index] ?? 0;
      if (left > right) return 1;
      if (left < right) return -1;
    }

    return 0;
  }

  private toVersionParts(version: string): number[] {
    return version.split('.').map(part => {
      const match = part.trim().match(/^\d+/);
      return match ? Number.parseInt(match[0], 10) : 0;
    });
  }

  private setState(nextState: AppUpdateRuntimeState): AppUpdateRuntimeState {
    this.state = { ...nextState };
    const snapshot = this.getState();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(AppUpdateIpc.StateChanged, snapshot);
      }
    }
    return snapshot;
  }

  private async cleanupReadyFile(filePath: string): Promise<void> {
    try {
      await app.whenReady();
      await import('fs/promises').then(fsPromises => fsPromises.unlink(filePath));
    } catch {
      // Best effort cleanup only.
    }
  }
}
