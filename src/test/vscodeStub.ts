// The few `vscode` APIs the tree provider and the panels touch, for unit tests outside VS Code.
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

export const ViewColumn = { Active: -1, Beside: -2 };

export class Uri {
  constructor(readonly path: string) {}

  toString(): string {
    return this.path;
  }

  static joinPath(base: { path: string }, ...parts: string[]): Uri {
    return new Uri([base.path, ...parts].join('/'));
  }
}

/** A webview panel driven by the test: what its page posts, and its visibility. */
export class FakeWebviewPanel {
  visible = true;
  iconPath?: unknown;
  /** Messages posted to the page, in order. */
  readonly posted: { type: string; [k: string]: unknown }[] = [];
  private readonly fromPageEmitter = new EventEmitter<unknown>();
  private readonly viewStateEmitter = new EventEmitter<{ webviewPanel: FakeWebviewPanel }>();
  private readonly disposeEmitter = new EventEmitter<void>();
  readonly webview = {
    html: '',
    cspSource: 'vscode-webview:',
    asWebviewUri: (uri: unknown) => uri,
    postMessage: async (msg: { type: string }) => (this.posted.push(msg), true),
    onDidReceiveMessage: this.fromPageEmitter.event,
  };
  readonly onDidChangeViewState = this.viewStateEmitter.event;
  readonly onDidDispose = this.disposeEmitter.event;

  reveal(): void {
    this.setVisible(true);
  }

  fromPage(msg: unknown): void {
    this.fromPageEmitter.fire(msg);
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.viewStateEmitter.fire({ webviewPanel: this });
  }

  /** The user closes the panel. */
  dispose(): void {
    this.disposeEmitter.fire();
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

const activeEditor = new EventEmitter<unknown>();

/** Panels created by `window.createWebviewPanel`, newest last. */
export const panels: FakeWebviewPanel[] = [];
/** Calls to `commands.executeCommand`. */
export const executed: unknown[][] = [];
/** Handlers given to `commands.registerCommand`, by command id. */
export const registered = new Map<string, (...args: unknown[]) => unknown>();
/** Button the next message box answers with; undefined = dismissed. */
export const answers: { next?: string } = {};

export const window = {
  createWebviewPanel: () => {
    const panel = new FakeWebviewPanel();
    panels.push(panel);
    return panel;
  },
  createStatusBarItem: () => ({ text: '', tooltip: '', show: () => undefined, hide: () => undefined, dispose: () => undefined }),
  createTreeView: () => ({ dispose: () => undefined }),
  createTextEditorDecorationType: () => ({ dispose: () => undefined }),
  activeTextEditor: undefined as unknown,
  onDidChangeActiveTextEditor: activeEditor.event,
  showErrorMessage: async () => answers.next,
  showWarningMessage: async () => answers.next,
  showInformationMessage: async () => answers.next,
  setStatusBarMessage: () => undefined,
};

export const commands = {
  executeCommand: async (...args: unknown[]) => void executed.push(args),
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
    registered.set(id, handler);
    return { dispose: () => undefined };
  },
};

export const workspace = {
  getConfiguration: () => ({ get: <T>(_key: string, fallback: T) => fallback }),
};

/** Makes `require('vscode')` resolve to this stub. */
export function installVscodeStub(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Module = require('module');
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? __filename : resolve.call(this, request, ...rest);
  };
}
