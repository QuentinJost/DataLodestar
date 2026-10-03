/**
 * Credentials embedded in a MongoDB connection string. Parsed by hand: multi-host
 * strings ("mongodb://u:p@h1:27017,h2:27017/") are not valid URLs for `new URL()`.
 */
const CREDENTIALS = /^(mongodb(?:\+srv)?:\/\/)([^@/?#]*)@/i;

export interface SplitUri {
  /** The string without its password ("mongodb://user@host/…"). */
  uri: string;
  /** Decoded user, when the string names one. */
  user?: string;
  /** Decoded password, when the string held one. */
  password?: string;
}

export function splitUriPassword(uri: string): SplitUri {
  const m = CREDENTIALS.exec(uri);
  if (!m) return { uri };
  const cred = m[2];
  const colon = cred.indexOf(':');
  const rawUser = colon < 0 ? cred : cred.slice(0, colon);
  const rawPassword = colon < 0 ? undefined : cred.slice(colon + 1);
  const rest = uri.slice(m[0].length);
  const user = rawUser ? decode(rawUser) : undefined;
  if (rawPassword === undefined) return { uri, user };
  const prefix = rawUser ? `${m[1]}${rawUser}@` : m[1];
  return { uri: prefix + rest, user, password: rawPassword ? decode(rawPassword) : undefined };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** How the MongoDB driver (mongodb-connection-string-url) splits a string: user info up to the first "@". */
const DRIVER_SPLIT = /^mongodb(?:\+srv)?:\/\/(?:([^:@]*)(?::([^@]*))?@)?([^/?@]*)(.*)$/i;
/** Characters the driver refuses unencoded in a user or password. */
const UNENCODED = /[:/?#[\]@]/;

/**
 * Why the user or password of `uri` cannot be told apart from the rest, as the driver would refuse it
 * (`/`, `?`, `#`, `:` or `@` unencoded); splitPassword would then miss the password, or part of it,
 * and the string would be saved with it. Undefined when the string is clear.
 */
export function credentialProblem(uri: string): string | undefined {
  const m = DRIVER_SPLIT.exec(uri);
  if (!m) return undefined;
  const [, user, password, , rest] = m;
  if (!UNENCODED.test(user ?? '') && !UNENCODED.test(password ?? '') && !rest.startsWith('@')) return undefined;
  return 'The user or password of the connection string has special characters that are not encoded: write @ as %40, / as %2F, : as %3A, ? as %3F, # as %23.';
}
