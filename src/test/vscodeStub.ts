// The few `vscode` APIs the tree provider touches, for unit tests outside VS Code.
import { EventEmitter as NodeEmitter } from 'events';

export class EventEmitter<T> {
  private readonly inner = new NodeEmitter();
  readonly event = (listener: (e: T) => void) => {
    this.inner.on('e', listener);
    return { dispose: () => this.inner.off('e', listener) };
  };
  fire(e: T): void {
    this.inner.emit('e', e);
  }
  dispose(): void {
    this.inner.removeAllListeners();
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: unknown;
  contextValue?: string;
  iconPath?: unknown;
  command?: unknown;
  constructor(public label: string, public collapsibleState?: TreeItemCollapsibleState) {}
}

export class ThemeIcon {
  constructor(public id: string, public color?: unknown) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class MarkdownString {
  constructor(public value: string) {}
}

/** Makes `require('vscode')` resolve to this stub. */
export function installVscodeStub(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? __filename : resolve.call(this, request, ...rest);
  };
}
