export type DbKind = 'mysql' | 'postgres' | 'mongodb' | 'redis';
/** Engines sharing a query language, tree layout and viewers. */
export type Family = 'sql' | 'mongo' | 'redis';
export const familyOf = (kind: DbKind): Family => (kind === 'mongodb' ? 'mongo' : kind === 'redis' ? 'redis' : 'sql');
export type TxMode = 'auto' | 'manual';
export type SshAuth = 'password' | 'privateKey' | 'agent';

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  privateKeyPath?: string;
  /** SHA256 fingerprint accepted on first connection (trust on first use). */
  hostFingerprint?: string;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  user: string;
  /** Database opened first; PostgreSQL falls back to "postgres"; Redis: the db index. */
  database?: string;
  /** MongoDB connection string; replaces host/port/user when set (cannot go through SSH). */
  uri?: string;
  /** MongoDB authentication database (default "admin"). */
  authSource?: string;
  ssl: boolean;
  /** Check the server certificate; saved before 0.5.0 without it = not checked. */
  sslVerify?: boolean;
  sslCaPath?: string;
  /** Name expected in the certificate when it differs from `host` (SSH tunnel, IP, alias). */
  sslServerName?: string;
  txMode: TxMode;
  savePassword: boolean;
  showSystemDatabases: boolean;
  ssh?: SshConfig;
}

export interface ConnectionSecrets {
  password?: string;
  sshPassword?: string;
  sshPassphrase?: string;
}

export interface TableRef {
  database: string;
  /** PostgreSQL schema; undefined for MySQL. */
  schema?: string;
  name: string;
  type: 'table' | 'view';
}

export interface TableInfo extends TableRef {
  estimatedRows?: number;
  comment?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  key: string;
  extra: string;
  comment: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface TableStructure {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  ddl: string;
}

/** Raw bytes as hex (possibly cut, see BINARY_LIMIT) plus the real length; formatted by the webview. */
export interface BinaryCell {
  b: string;
  n: number;
}

export type CellValue = string | number | boolean | null | BinaryCell;

export interface QueryResult {
  /** Column names; empty when the statement returned no result set. */
  columns: string[];
  rows: CellValue[][];
  affectedRows?: number;
  durationMs: number;
  /** MongoDB documents as relaxed Extended JSON, for the JSON view. */
  documents?: unknown[];
  truncated?: boolean;
}

/** Engine-neutral structure page: tables of facts plus an optional code block. */
export interface StructureView {
  sections: { title: string; headers: string[]; rows: (string | null)[][] }[];
  code?: { title: string; text: string; language: string };
}

export interface CollectionInfo {
  database: string;
  name: string;
  type: 'collection' | 'view' | 'timeseries';
}

export interface FieldInfo {
  path: string;
  types: string[];
  /** Share of sampled documents holding the field, 0–100. */
  presence: number;
}

export interface CollectionStructure {
  sampled: number;
  fields: FieldInfo[];
  indexes: { name: string; key: string; unique: boolean; options: string }[];
  options: string;
}

export interface RedisKeyInfo {
  key: string;
  type: string;
  /** Milliseconds; -1 = no expiry, -2 = gone. */
  ttl: number;
}

export interface RedisValue {
  key: string;
  type: string;
  ttl: number;
  /** Number of elements (or bytes for strings). */
  length: number;
  /** Text for strings / JSON; a grid for collections. */
  text?: CellValue;
  columns?: string[];
  rows?: CellValue[][];
  truncated: boolean;
}
