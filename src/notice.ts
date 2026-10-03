/**
 * Text from a server (error messages, data quoted in them) shown in a notification: VS Code renders
 * `[label](link)` there as a link, `command:` links included, which a hostile server could use to
 * run a command on a click. A space between the brackets and the parenthesis is not a link.
 */
export const plainNotice = (s: string): string => s.replace(/\]\s*\(/g, '] (');
