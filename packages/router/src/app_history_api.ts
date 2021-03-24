export interface AppHistoryNavigationEvent extends Event {
  respondWith: (newNavigationAction: Promise<undefined>) => {};
  canRespond: boolean;
  userInitiated: boolean;
  destination: AppHistoryEntry;
  hashChange: boolean;
  formData?: FormData;
  info: any;
  signal: AbortSignal;
}

export interface EventHandler {}
export type DOMString = string;
export type USVString = string;

export interface AppHistory {
  addEventListener: (e: string, f: (e: AppHistoryNavigationEvent) => {}) => {};
  navigateTo: (key: DOMString, info: any) => Promise<undefined>;
  back: (options?: AppHistoryNavigationOptions) => Promise<undefined>;
  forward: (options?: AppHistoryNavigationOptions) => Promise<undefined>;
  entries: () => AppHistoryEntry[];
  current: AppHistoryEntry;
  // Added by me because it's harder to work without it in the mocked implementation (because I
  // update the current entry before the 'navigate' triggers), even though it would be managable in
  // the real scenario.
  previous?: AppHistoryEntry;
  canGoBack: boolean;
  canGoForward: boolean;

  update: (url: USVString, options?: AppHistoryPushOrUpdateOptions) => Promise<undefined>;
  // update(options: AppHistoryPushOrUpdateFullOptions  = {}) => Promise<undefined> ; // one member
  // required: see issue #52

  push: (url: USVString, options?: AppHistoryPushOrUpdateOptions) => Promise<undefined>;
  // push: (options?: AppHistoryPushOrUpdateFullOptions  ): Promise<undefined>;


  onnavigate: EventHandler;
  onnavigatesuccess: EventHandler;
  onnavigateerror: EventHandler;
  oncurrentchange: EventHandler;
}

export interface AppHistoryEntry extends EventTarget {
  key: DOMString;
  url: USVString;
  readonly index: number;
  readonly finished: boolean;
  readonly sameDocument: boolean;

  state: any;

  onnavigateto: EventHandler;
  onnavigatefrom: EventHandler;
  onfinish: EventHandler;
  ondispose: EventHandler;
}


export type AppHistoryNavigationOptions = {
  [key: string]: any
}&{navigateInfo: any};

export type AppHistoryPushOrUpdateOptions = AppHistoryNavigationOptions&{state: any};

export type AppHistoryPushOrUpdateFullOptions = AppHistoryPushOrUpdateOptions&{url: USVString};



export class AppHistoryOverride {
  constructor() {
    this.overrideAppHistory();
  }

  private overrideAppHistory() {
    const appHistory: AppHistory = (window as any).appHistory;

    appHistory.navigateTo = (key: DOMString) => {
      const entry = appHistory.entries().find(entry => entry.key === key);
      if (!entry) {
        return Promise.resolve(undefined);
      }
      const delta = entry.index - appHistory.current.index;
      window.history.go(delta);
      return Promise.resolve(undefined);
    };

    appHistory.push = (url: USVString, options?: AppHistoryPushOrUpdateOptions) => {
      appHistory.previous = appHistory.current;
      window.location.href = url;
      return Promise.resolve(undefined);
    };

    appHistory.update = (url: USVString, options?: AppHistoryPushOrUpdateOptions) => {
      appHistory.current = {...appHistory.current, url};
      window.location.replace(url);
      return Promise.resolve(undefined);
    };
  }
}