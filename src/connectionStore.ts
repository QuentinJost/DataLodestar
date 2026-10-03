import * as vscode from 'vscode';
import { ConnectionConfig, ConnectionSecrets } from './types';
import { credentialProblem, splitUriPassword } from './uriCredentials';

const CONFIGS_KEY = 'dataLodestar.connections';
const secretKey = (id: string) => `dataLodestar.secrets.${id}`;

/** Connection settings live in globalState; passwords only in SecretStorage (OS keychain). */
export class ConnectionStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  list(): ConnectionConfig[] {
    return [...this.ctx.globalState.get<ConnectionConfig[]>(CONFIGS_KEY, [])].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  /**
   * Saves the settings. For secrets, an undefined field keeps the stored value;
   * with `savePassword` off every stored secret is wiped.
   */
  async save(config: ConnectionConfig, secrets?: ConnectionSecrets): Promise<void> {
    const others = this.list().filter((c) => c.id !== config.id);
    await this.ctx.globalState.update(CONFIGS_KEY, [...others, config]);
    if (!config.savePassword) {
      await this.ctx.secrets.delete(secretKey(config.id));
    } else if (secrets) {
      const merged = { ...(await this.getSecrets(config.id)) };
      for (const [k, v] of Object.entries(secrets) as [keyof ConnectionSecrets, string | undefined][]) {
        if (v !== undefined) merged[k] = v;
      }
      await this.ctx.secrets.store(secretKey(config.id), JSON.stringify(merged));
    }
    this.changed.fire();
  }

  /**
   * Connections saved before 0.3.1 could keep a password inside the MongoDB
   * connection string, in clear. Moves it to the keychain (or drops it when the
   * connection does not save passwords). Returns the names of the cleaned connections.
   */
  async migrateUriPasswords(): Promise<{ moved: string[]; dropped: string[]; unclear: string[] }> {
    const moved: string[] = [];
    const dropped: string[] = [];
    /** Saved before the check: the password cannot be told apart, so it stays; the user must edit it. */
    const unclear: string[] = [];
    for (const config of this.list()) {
      if (!config.uri) continue;
      if (credentialProblem(config.uri)) {
        unclear.push(config.name);
        continue;
      }
      const split = splitUriPassword(config.uri);
      if (split.password === undefined) continue;
      const cleaned = { ...config, uri: split.uri };
      if (config.savePassword) {
        // The string's password was the one in use: it wins over the Password field.
        await this.save(cleaned, { password: split.password });
        moved.push(config.name);
      } else {
        await this.save(cleaned);
        dropped.push(config.name);
      }
    }
    return { moved, dropped, unclear };
  }

  /**
   * Connections saved before certificate checks existed have no `sslVerify`. Those using
   * SSL/TLS keep working unchecked (self-signed servers), made explicit once; their names
   * are returned. The others stay unset, so turning TLS on later verifies by default.
   */
  async migrateTlsVerify(): Promise<string[]> {
    const unchecked: string[] = [];
    for (const config of this.list()) {
      if (config.sslVerify !== undefined || !config.ssl) continue;
      await this.save({ ...config, sslVerify: false });
      unchecked.push(config.name);
    }
    return unchecked;
  }

  async remove(id: string): Promise<void> {
    await this.ctx.globalState.update(CONFIGS_KEY, this.list().filter((c) => c.id !== id));
    await this.ctx.secrets.delete(secretKey(id));
    this.changed.fire();
  }

  async getSecrets(id: string): Promise<ConnectionSecrets> {
    const raw = await this.ctx.secrets.get(secretKey(id));
    return raw ? (JSON.parse(raw) as ConnectionSecrets) : {};
  }
}
