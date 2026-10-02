import * as vscode from 'vscode';
import { ConnectionStore } from './connectionStore';
import { AnyDriver, createDriver } from './drivers';
import { Endpoint } from './drivers/driver';
import { SshTunnel } from './sshTunnel';
import { ConnectionConfig, ConnectionSecrets, TxMode } from './types';

export class Session {
  constructor(
    readonly id: string,
    readonly driver: AnyDriver,
    private readonly tunnel: SshTunnel | undefined,
    public txMode: TxMode,
  ) {}

  async close(): Promise<void> {
    await this.driver.close();
    this.tunnel?.close();
  }
}

/** What the Commit / Rollback bar of a panel shows for a connection. */
export interface TxState {
  pending: boolean;
  /** Commit sends EXEC, Rollback sends DISCARD. */
  redis: boolean;
  connection: string;
}

/** Opens, tracks and closes live sessions; owns the transaction-mode switches. */
export class SessionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private readonly connecting = new Map<string, Promise<Session>>();
  /** Secrets typed at connect time when the connection does not save passwords. */
  private readonly typedSecrets = new Map<string, ConnectionSecrets>();
  private readonly lastState = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<string>();
  /** Fires the connection id when connected / mode / pending-transaction state changes. */
  readonly onDidChange = this.changed.event;
  private readonly schemaChanged = new vscode.EventEmitter<string>();
  /** Fires the connection id after a statement that may add, drop or rename objects, and when pending changes end. */
  readonly onDidChangeSchema = this.schemaChanged.event;

  constructor(private readonly store: ConnectionStore) {}

  current(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  isConnected(id: string): boolean {
    return this.sessions.has(id);
  }

  /** Returns the live session, connecting first when needed. */
  get(id: string): Promise<Session> {
    const live = this.sessions.get(id);
    if (live) return Promise.resolve(live);
    let pending = this.connecting.get(id);
    if (!pending) {
      pending = this.open(id).finally(() => this.connecting.delete(id));
      this.connecting.set(id, pending);
    }
    return pending;
  }

  private async open(id: string): Promise<Session> {
    const config = this.store.get(id);
    if (!config) throw new Error('Unknown connection.');
    const secrets = await this.resolveSecrets(config);

    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Connecting to ${config.name}…` },
      async () => {
        const { driver, tunnel } = await connectWith(config, secrets, (fp, expected) => this.confirmHostKey(config, fp, expected));
        if (tunnel && tunnel.fingerprint !== config.ssh?.hostFingerprint) {
          await this.store.save({ ...config, ssh: { ...config.ssh!, hostFingerprint: tunnel.fingerprint } });
        }
        const session = new Session(id, driver, tunnel, driver.supportsManualTx ? config.txMode : 'auto');
        const lost = (reason: string) => {
          if (this.sessions.get(id) !== session) return;
          this.sessions.delete(id);
          void session.close();
          this.emit(id);
          void vscode.window.showWarningMessage(`DataLodestar: connection "${config.name}" lost (${reason}).`);
        };
        driver.onLost = (err) => lost(err.message);
        if (tunnel) tunnel.onClose = () => lost('SSH tunnel closed');
        this.sessions.set(id, session);
        this.emit(id);
        return session;
      },
    ).then(undefined, (err: Error) => {
      this.typedSecrets.delete(id);
      throw err;
    });
  }

  private async resolveSecrets(config: ConnectionConfig): Promise<ConnectionSecrets> {
    if (config.savePassword) return this.store.getSecrets(config.id);
    const cached = this.typedSecrets.get(config.id);
    if (cached) return cached;

    const ask = async (prompt: string) => {
      const v = await vscode.window.showInputBox({ prompt, password: true, ignoreFocusOut: true });
      if (v === undefined) throw new Error('Connection cancelled.');
      return v;
    };
    const secrets: ConnectionSecrets = {};
    if (config.ssh?.enabled && config.ssh.auth === 'password') {
      secrets.sshPassword = await ask(`SSH password for ${config.ssh.username}@${config.ssh.host}`);
    }
    if (config.ssh?.enabled && config.ssh.auth === 'privateKey') {
      secrets.sshPassphrase = await ask('SSH key passphrase (leave empty if the key has none)');
    }
    secrets.password = await ask(`Database password for ${config.user}@${config.name}`);
    this.typedSecrets.set(config.id, secrets);
    return secrets;
  }

  /**
   * First connection: trust on first use. A changed key is never accepted from this
   * prompt: the pinned key has to be reset on purpose (dataLodestar.resetHostKey).
   */
  private async confirmHostKey(config: ConnectionConfig, fingerprint: string, expected: string | undefined): Promise<boolean> {
    const host = `${config.ssh!.host}:${config.ssh!.port}`;
    if (expected) {
      void showChangedHostKey(config, host, expected, fingerprint);
      return false;
    }
    const trust = 'Trust this key';
    const choice = await vscode.window.showWarningMessage(`First connection to ${host}. Host key fingerprint:\n${fingerprint}\nTrust it?`, { modal: true }, trust);
    return choice === trust;
  }

  /** Asks what to do with an open transaction. Resolves false when the user cancels. */
  private async settlePending(session: Session, action: string): Promise<boolean> {
    if (!session.driver.pendingTransaction) return true;
    const choice = await vscode.window.showWarningMessage(
      `A transaction is open on "${this.store.get(session.id)?.name}". Commit or roll it back before you ${action}?`,
      { modal: true },
      'Commit',
      'Rollback',
    );
    if (choice === 'Commit') await session.driver.commit();
    else if (choice === 'Rollback') await session.driver.rollback();
    else return false;
    return true;
  }

  async disconnect(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || !(await this.settlePending(session, 'disconnect'))) return;
    this.sessions.delete(id);
    this.typedSecrets.delete(id);
    await session.close();
    this.emit(id);
  }

  /** Switches the mode live (when connected) and stores it as the host default. */
  async setTxMode(id: string, mode: TxMode): Promise<void> {
    const config = this.store.get(id);
    if (!config) return;
    const session = this.sessions.get(id);
    if (session) {
      if (!(await this.settlePending(session, `switch to ${mode} mode`))) return;
      await session.driver.setTxMode(mode);
      session.txMode = mode;
    }
    await this.store.save({ ...config, txMode: mode });
    this.emit(id);
  }

  async commit(id: string): Promise<void> {
    await this.sessions.get(id)?.driver.commit();
    this.emit(id);
  }

  async rollback(id: string): Promise<void> {
    await this.sessions.get(id)?.driver.rollback();
    this.emit(id);
  }

  /** Pending changes of a connection, for the Commit / Rollback bars of the panels. */
  txState(id: string): TxState {
    const config = this.store.get(id);
    return { pending: !!this.sessions.get(id)?.driver.pendingTransaction, redis: config?.kind === 'redis', connection: config?.name ?? '' };
  }

  notifySchemaChange(id: string): void {
    this.schemaChanged.fire(id);
  }

  /** Re-evaluates state after statements ran; fires only on an actual change. */
  emit(id: string): void {
    const s = this.sessions.get(id);
    const state = s ? `on|${s.txMode}|${s.driver.pendingTransaction}` : 'off';
    const before = this.lastState.get(id);
    if (before === state) return;
    this.lastState.set(id, state);
    this.changed.fire(id);
    // The tree lists on its own connection, blind to uncommitted DDL (PostgreSQL): re-list once the transaction ends.
    if (s && before?.endsWith('|true') && !s.driver.pendingTransaction) this.schemaChanged.fire(id);
  }

  dispose(): void {
    for (const s of this.sessions.values()) void s.close();
    this.sessions.clear();
    this.changed.dispose();
    this.schemaChanged.dispose();
  }
}

/** What a panel needs from the sessions for its Commit / Rollback bar. */
export type TxSessions = Pick<SessionManager, 'onDidChange' | 'txState'>;

/** Opens tunnel + driver for a config; used by sessions and by the "Test" button. */
export async function connectWith(
  config: ConnectionConfig,
  secrets: ConnectionSecrets,
  checkHostKey: (fingerprint: string, expected: string | undefined) => Promise<boolean>,
): Promise<{ driver: AnyDriver; tunnel?: SshTunnel }> {
  let tunnel: SshTunnel | undefined;
  let driver: AnyDriver | undefined;
  const endpoint: Endpoint = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: secrets.password,
    database: config.database,
    ssl: config.ssl,
    sslVerify: config.sslVerify ?? false,
    sslCaPath: config.sslCaPath || undefined,
    // Kept when a tunnel replaces the host (MongoDB): the certificate names the real server.
    sslServerName: config.sslServerName || config.host,
    uri: config.uri || undefined,
    authSource: config.authSource || undefined,
  };
  try {
    if (config.ssh?.enabled && endpoint.uri) {
      throw new Error('A connection string cannot go through the SSH tunnel: clear it and use host / port.');
    }
    if (config.ssh?.enabled) {
      const t = (tunnel = await SshTunnel.open(config.ssh, secrets, config.host, config.port, checkHostKey));
      if (config.kind === 'mongodb') {
        // The MongoDB driver only dials an address: a private local socket.
        Object.assign(endpoint, await t.listen());
      } else {
        endpoint.stream = () => t.connect();
      }
    }
    driver = createDriver(config.kind, endpoint);
    await driver.connect();
    if (config.txMode === 'manual' && driver.supportsManualTx) await driver.setTxMode('manual');
    return { driver, tunnel };
  } catch (err) {
    await driver?.close();
    tunnel?.close();
    throw err;
  }
}

/** Refuses a changed SSH host key. Nothing accepts it from here: the reset command asks again, then the next connection does. */
export async function showChangedHostKey(config: ConnectionConfig, host: string, expected: string, received: string): Promise<void> {
  const reset = 'Reset Pinned SSH Host Key…';
  const choice = await vscode.window.showErrorMessage(
    `SSH HOST KEY CHANGED for ${host}: the connection was refused.\nExpected ${expected}\nReceived ${received}\n` +
      'Someone may be intercepting the connection. If the server key really changed (reinstall, new host), ' +
      'check the new fingerprint with its administrator, then run "DataLodestar: Reset Pinned SSH Host Key".',
    { modal: true },
    reset,
  );
  if (choice === reset) await vscode.commands.executeCommand('dataLodestar.resetHostKey', config.id);
}
