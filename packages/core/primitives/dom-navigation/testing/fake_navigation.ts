/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  NavigationNavigateOptions,
  NavigationTypeString,
  NavigationOptions,
  NavigateEvent,
  NavigationCurrentEntryChangeEvent,
  NavigationTransition,
  NavigationUpdateCurrentEntryOptions,
  NavigationReloadOptions,
  NavigationResult,
  NavigationHistoryEntry,
  NavigationInterceptOptions,
  NavigationDestination,
  Navigation,
} from '../src/navigation_types';

/**
 * Fake implementation of user agent history and navigation behavior. This is a
 * high-fidelity implementation of browser behavior that attempts to emulate
 * things like traversal delay.
 */
export class FakeNavigation implements Navigation {
  /**
   * The fake implementation of an entries array. Only same-document entries
   * allowed.
   */
  private readonly entriesArr: FakeNavigationHistoryEntry[] = [];

  /**
   * The current active entry index into `entriesArr`.
   */
  private currentEntryIndex = 0;

  /**
   * The current navigate event.
   * @internal
   */
  navigateEvent: InternalFakeNavigateEvent | null = null;

  /**
   * A Map of pending traversals, so that traversals to the same entry can be
   * re-used.
   */
  private readonly traversalQueue = new Map<string, InternalNavigationResult>();

  /**
   * A Promise that resolves when the previous traversals have finished. Used to
   * simulate the cross-process communication necessary for traversals.
   */
  private nextTraversal = Promise.resolve();

  /**
   * A prospective current active entry index, which includes unresolved
   * traversals. Used by `go` to determine where navigations are intended to go.
   */
  private prospectiveEntryIndex = 0;

  /**
   * A test-only option to make traversals synchronous, rather than emulate
   * cross-process communication.
   */
  private synchronousTraversals = false;

  /** Whether to allow a call to setInitialEntryForTesting. */
  private canSetInitialEntry = true;

  /**
   * `EventTarget` to dispatch events.
   * @internal
   */
  eventTarget: EventTarget;

  /** The next unique id for created entries. Replace recreates this id. */
  private nextId = 0;

  /** The next unique key for created entries. Replace inherits this id. */
  private nextKey = 0;

  /** Whether this fake is disposed. */
  private disposed = false;

  /** Equivalent to `navigation.currentEntry`. */
  get currentEntry(): FakeNavigationHistoryEntry {
    return this.entriesArr[this.currentEntryIndex];
  }

  get canGoBack(): boolean {
    return this.currentEntryIndex > 0;
  }

  get canGoForward(): boolean {
    return this.currentEntryIndex < this.entriesArr.length - 1;
  }

  // Properties for spec alignment for ongoing navigation state
  /** @internal */
  public focusChangedDuringOngoingNavigation: boolean = false;
  /** @internal */
  public suppressNormalScrollRestorationDuringOngoingNavigation: boolean = false;

  constructor(
    private readonly window: Window,
    startURL: `http${string}`,
  ) {
    this.eventTarget = this.window.document.createElement('div');
    // First entry.
    this.setInitialEntryForTesting(startURL);
  }

  /**
   * Sets the initial entry.
   */
  setInitialEntryForTesting(
    url: `http${string}`,
    options: {historyState: unknown; state?: unknown} = {historyState: null},
  ): void {
    if (!this.canSetInitialEntry) {
      throw new Error(
        'setInitialEntryForTesting can only be called before any ' + 'navigation has occurred',
      );
    }
    const currentInitialEntry = this.entriesArr[0];
    this.entriesArr[0] = new FakeNavigationHistoryEntry(
      this.window.document.createElement('div'),
      new URL(url).toString(),
      {
        index: 0,
        key: currentInitialEntry?.key ?? String(this.nextKey++),
        id: currentInitialEntry?.id ?? String(this.nextId++),
        sameDocument: true,
        historyState: options?.historyState,
        state: options.state,
      },
    );
  }

  /** Returns whether the initial entry is still eligible to be set. */
  canSetInitialEntryForTesting(): boolean {
    return this.canSetInitialEntry;
  }

  /**
   * Sets whether to emulate traversals as synchronous rather than
   * asynchronous.
   */
  setSynchronousTraversalsForTesting(synchronousTraversals: boolean): void {
    this.synchronousTraversals = synchronousTraversals;
  }

  /** Equivalent to `navigation.entries()`. */
  entries(): FakeNavigationHistoryEntry[] {
    return this.entriesArr.slice();
  }

  /** Equivalent to `navigation.navigate()`. */
  navigate(url: string, options?: NavigationNavigateOptions): FakeNavigationResult {
    const fromUrl = new URL(this.currentEntry.url!);
    const toUrl = new URL(url, this.currentEntry.url!);

    let navigationType: NavigationTypeString;
    if (!options?.history || options.history === 'auto') {
      if (fromUrl.toString() === toUrl.toString()) {
        navigationType = 'replace';
      } else {
        navigationType = 'push';
      }
    } else {
      navigationType = options.history;
    }

    const hashChange = isHashChange(fromUrl, toUrl);

    const destination = new FakeNavigationDestination({
      url: toUrl.toString(),
      state: options?.state, // This is navigation API state
      sameDocument: hashChange, // Assuming non-hash change means new document for simplicity here
      historyState: null, // history API state, not used by navigate() directly
    });
    // Create the apiMethodTracker (InternalNavigationResult)
    const result = new InternalNavigationResult(this, options?.info, options?.state);


    const intercepted = this.userAgentNavigate(
      destination,
      result,
      {
        navigationType,
        cancelable: true,
        canIntercept: destination.sameDocument, // Per spec, canIntercept depends on URL rewritability and not being a cross-document traverse
        userInitiated: false,
        hashChange,
        info: options?.info, // This info is for the InternalNavigateOptions, distinct from result.info
      },
      null, // sourceElement for navigate() is null
      null, // formDataEntryList for navigate() is null
      null, // downloadRequestFilename for navigate() is null
      false, // hasUAVisualTransition for navigate() is false by default
    );

    if (!intercepted && this.navigateEvent?.sameDocument && this.navigateEvent.interceptionState === 'none') {
      this.updateNavigationEntriesForSameDocumentNavigation(this.navigateEvent!);
    }

    return {
      committed: result.committed,
      finished: result.finished,
    };
  }

  /** Equivalent to `history.pushState()`. */
  pushState(data: unknown, title: string, url?: string): void {
    this.pushOrReplaceState('push', data, title, url);
  }

  /** Equivalent to `history.replaceState()`. */
  replaceState(data: unknown, title: string, url?: string): void {
    this.pushOrReplaceState('replace', data, title, url);
  }

  private pushOrReplaceState(
    navigationType: NavigationTypeString,
    data: unknown, // This is Classic History API state
    _title: string,
    url?: string,
  ): void {
    const fromUrl = new URL(this.currentEntry.url!);
    const toUrl = url ? new URL(url, this.currentEntry.url!) : fromUrl;

    const hashChange = isHashChange(fromUrl, toUrl);

    const destination = new FakeNavigationDestination({
      url: toUrl.toString(),
      sameDocument: true, // history.pushState/replaceState are always same-document
      historyState: data, // This is the history API state
      state: undefined, // No Navigation API state directly from history.pushState
    });
    // For history.pushState/replaceState, info is undefined for the event.
    // The classicHistoryAPIState is `data`.
    const result = new InternalNavigationResult(this, undefined, data);

    const intercepted = this.userAgentNavigate(
      destination,
      result,
      {
        navigationType,
        cancelable: true,
        canIntercept: true,
        userInitiated: false,
        hashChange,
        // info for the event will be undefined.
      },
      null,
      null,
      null,
      false,
    );

    if (!intercepted && this.navigateEvent?.sameDocument && this.navigateEvent.interceptionState === 'none') {
      this.updateNavigationEntriesForSameDocumentNavigation(this.navigateEvent!);
    }
  }

  /** Equivalent to `navigation.traverseTo()`. */
  traverseTo(key: string, options?: NavigationOptions): FakeNavigationResult {
    const fromUrl = new URL(this.currentEntry.url!);
    const entry = this.findEntry(key);
    if (!entry) {
      const domException = new DOMException('Invalid key', 'InvalidStateError');
      const committed = Promise.reject(domException);
      const finished = Promise.reject(domException);
      committed.catch(() => {});
      finished.catch(() => {});
      return {
        committed,
        finished,
      };
    }
    if (entry === this.currentEntry) {
      return {
        committed: Promise.resolve(this.currentEntry),
        finished: Promise.resolve(this.currentEntry),
      };
    }
    if (this.traversalQueue.has(entry.key)) {
      const existingResult = this.traversalQueue.get(entry.key)!;
      return {
        committed: existingResult.committed,
        finished: existingResult.finished,
      };
    }

    const hashChange = isHashChange(fromUrl, new URL(entry.url!, this.currentEntry.url!));
    const destination = new FakeNavigationDestination({
      url: entry.url!,
      state: entry.getState(), // Navigation API state from the target entry
      historyState: entry.getHistoryState(), // Classic history API state from the target entry
      key: entry.key,
      id: entry.id,
      index: entry.index,
      sameDocument: entry.sameDocument,
    });
    this.prospectiveEntryIndex = entry.index;
    const result = new InternalNavigationResult(this, options?.info, entry.getState());
    this.traversalQueue.set(entry.key, result);
    this.runTraversal(() => {
      this.traversalQueue.delete(entry.key);
      const intercepted = this.userAgentNavigate(
        destination,
        result,
        {
          navigationType: 'traverse',
          cancelable: destination.sameDocument,
          canIntercept: destination.sameDocument,
          userInitiated: false,
          hashChange,
          info: options?.info,
        },
        null,
        null,
        null,
        false,
      );
      if (!intercepted && this.navigateEvent?.sameDocument && this.navigateEvent.interceptionState === 'none') {
        this.userAgentTraverse(this.navigateEvent!);
      }
    });
    return {
      committed: result.committed,
      finished: result.finished,
    };
  }

  /** Equivalent to `navigation.back()`. */
  back(options?: NavigationOptions): FakeNavigationResult {
    if (this.currentEntryIndex === 0) {
      const domException = new DOMException('Cannot go back', 'InvalidStateError');
      const committed = Promise.reject(domException);
      const finished = Promise.reject(domException);
      committed.catch(() => {});
      finished.catch(() => {});
      return {
        committed,
        finished,
      };
    }
    const entry = this.entriesArr[this.currentEntryIndex - 1];
    return this.traverseTo(entry.key, options);
  }

  /** Equivalent to `navigation.forward()`. */
  forward(options?: NavigationOptions): FakeNavigationResult {
    if (this.currentEntryIndex === this.entriesArr.length - 1) {
      const domException = new DOMException('Cannot go forward', 'InvalidStateError');
      const committed = Promise.reject(domException);
      const finished = Promise.reject(domException);
      committed.catch(() => {});
      finished.catch(() => {});
      return {
        committed,
        finished,
      };
    }
    const entry = this.entriesArr[this.currentEntryIndex + 1];
    return this.traverseTo(entry.key, options);
  }

  go(direction: number): void {
    const targetIndex = this.prospectiveEntryIndex + direction;
    if (targetIndex >= this.entriesArr.length || targetIndex < 0) {
      return;
    }
    this.prospectiveEntryIndex = targetIndex;
    this.runTraversal(() => {
      if (targetIndex >= this.entriesArr.length || targetIndex < 0) {
        return;
      }
      const fromUrl = new URL(this.currentEntry.url!);
      const entry = this.entriesArr[targetIndex];
      const hashChange = isHashChange(fromUrl, new URL(entry.url!, this.currentEntry.url!));
      const destination = new FakeNavigationDestination({
        url: entry.url!,
        state: entry.getState(),
        historyState: entry.getHistoryState(),
        key: entry.key,
        id: entry.id,
        index: entry.index,
        sameDocument: entry.sameDocument,
      });
      const result = new InternalNavigationResult(this); // history.go() has no info/state for the tracker
      const intercepted = this.userAgentNavigate(
        destination,
        result,
        {
          navigationType: 'traverse',
          cancelable: destination.sameDocument,
          canIntercept: destination.sameDocument,
          userInitiated: false,
          hashChange,
        },
        null,
        null,
        null,
        false,
      );
      if (!intercepted && this.navigateEvent?.sameDocument && this.navigateEvent.interceptionState === 'none') {
        this.userAgentTraverse(this.navigateEvent!);
      }
    });
  }

  private runTraversal(traversal: () => void) {
    if (this.synchronousTraversals) {
      traversal();
      return;
    }
    this.nextTraversal = this.nextTraversal.then(() => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          resolve();
          traversal();
        });
      });
    });
  }

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.eventTarget.addEventListener(type, callback, options);
  }

  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: EventListenerOptions | boolean,
  ): void {
    this.eventTarget.removeEventListener(type, callback, options);
  }

  dispatchEvent(event: Event): boolean {
    return this.eventTarget.dispatchEvent(event);
  }

  dispose(): void {
    this.eventTarget = this.window.document.createElement('div');
    this.disposed = true;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  abortTheOngoingNavigation(eventToAbort: InternalFakeNavigateEvent, reason?: Error) {
    if (!this.navigateEvent || this.navigateEvent !== eventToAbort) {
      return;
    }
    if (this.navigateEvent.abortController!.signal.aborted) {
      return;
    }
    const abortReason = reason ?? new DOMException('Navigation aborted', 'AbortError');
    this.navigateEvent.abortController!.abort(abortReason);
    if (this.navigateEvent === eventToAbort) {
        this.navigateEvent.cancel(abortReason);
    }
  }

  private userAgentNavigate(
    destination: FakeNavigationDestination,
    result: InternalNavigationResult,
    options: InternalNavigateOptions,
    sourceElement: Element | null = null,
    formDataEntryList: any[] | null = null,
    downloadRequestFilename: string | null = null,
    hasUAVisualTransition: boolean = false,
  ): boolean {
    this.canSetInitialEntry = false;
    if (this.navigateEvent) {
      this.abortTheOngoingNavigation(this.navigateEvent, new DOMException('Navigation superseded by a new navigation.', 'AbortError'));
    }
    if (this.disposed) {
        return false;
    }
    const dispatchResultIsTrueIfNoInterception = dispatchNavigateEvent({
      navigationType: options.navigationType,
      cancelable: options.cancelable,
      canIntercept: options.canIntercept,
      userInitiated: options.userInitiated,
      hashChange: options.hashChange,
      destination,
      info: options.info ?? result.info,
      sameDocument: destination.sameDocument,
      result,
      sourceElement,
      formDataEntryList,
      downloadRequestFilename,
      hasUAVisualTransition,
    });
    return !dispatchResultIsTrueIfNoInterception;
  }

  urlAndHistoryUpdateSteps(navigateEvent: InternalFakeNavigateEvent) {
    this.updateNavigationEntriesForSameDocumentNavigation(navigateEvent);
  }

  userAgentTraverse(navigateEvent: InternalFakeNavigateEvent) {
    const oldUrl = this.currentEntry.url!;
    this.updateNavigationEntriesForSameDocumentNavigation(navigateEvent);
    const popStateEvent = createPopStateEvent({
      state: navigateEvent.destination.getHistoryState(),
    });
    this.window.dispatchEvent(popStateEvent);
    if (navigateEvent.hashChange) {
      const hashchangeEvent = createHashChangeEvent(oldUrl, this.currentEntry.url!);
      this.window.dispatchEvent(hashchangeEvent);
    }
  }

  updateNavigationEntriesForSameDocumentNavigation({
    destination,
    navigationType,
    result,
  }: InternalFakeNavigateEvent) {
    const oldCurrentNHE = this.currentEntry;
    const disposedNHEs = [];
    if (navigationType === 'traverse') {
      this.currentEntryIndex = destination.index;
      if (this.currentEntryIndex === -1) {
        throw new Error('unexpected current entry index');
      }
    } else if (navigationType === 'push') {
      this.currentEntryIndex++;
      this.prospectiveEntryIndex = this.currentEntryIndex;
      disposedNHEs.push(...this.entriesArr.splice(this.currentEntryIndex));
    } else if (navigationType === 'replace') {
      disposedNHEs.push(oldCurrentNHE);
    }
    if (navigationType === 'push' || navigationType === 'replace') {
      const index = this.currentEntryIndex;
      const key = navigationType === 'push' ? String(this.nextKey++) : (oldCurrentNHE?.key ?? String(this.nextKey++));
      const newNHE = new FakeNavigationHistoryEntry(
        this.window.document.createElement('div'),
        destination.url,
        {
          id: String(this.nextId++),
          key,
          index,
          sameDocument: true,
          state: destination.getState(), // Navigation API state
          historyState: destination.getHistoryState(), // Classic history API state
        },
      );
      this.entriesArr[this.currentEntryIndex] = newNHE;
    }
    result.committedResolve(this.currentEntry);
    const currentEntryChangeEvent = createFakeNavigationCurrentEntryChangeEvent({
      from: oldCurrentNHE,
      navigationType: navigationType,
    });
    this.eventTarget.dispatchEvent(currentEntryChangeEvent);
    for (const disposedNHE of disposedNHEs) {
      disposedNHE.dispose();
    }
  }

  private findEntry(key: string) {
    for (const entry of this.entriesArr) {
      if (entry.key === key) return entry;
    }
    return undefined;
  }

  set onnavigate(
    _handler: ((this: Navigation, ev: NavigateEvent) => any) | null,
  ) {
    throw new Error('unimplemented');
  }
  get onnavigate(): ((this: Navigation, ev: NavigateEvent) => any) | null {
    throw new Error('unimplemented');
  }
  set oncurrententrychange(
    _handler: ((this: Navigation, ev: NavigationCurrentEntryChangeEvent) => any) | null,
  ) {
    throw new Error('unimplemented');
  }
  get oncurrententrychange(): ((this: Navigation, ev: NavigationCurrentEntryChangeEvent) => any) | null {
    throw new Error('unimplemented');
  }
  set onnavigatesuccess(
    _handler: ((this: Navigation, ev: Event) => any) | null,
  ) {
    throw new Error('unimplemented');
  }
  get onnavigatesuccess(): ((this: Navigation, ev: Event) => any) | null {
    throw new Error('unimplemented');
  }
  set onnavigateerror(
    _handler: ((this: Navigation, ev: ErrorEvent) => any) | null,
  ) {
    throw new Error('unimplemented');
  }
  get onnavigateerror(): ((this: Navigation, ev: ErrorEvent) => any) | null {
    throw new Error('unimplemented');
  }

  private _transition: NavigationTransition | null = null;
  set transition(t: NavigationTransition | null) {
    this._transition = t;
  }
  get transition(): NavigationTransition | null {
    return this._transition;
  }

  updateCurrentEntry(_options: NavigationUpdateCurrentEntryOptions): void {
    throw new Error('unimplemented');
  }
  reload(_options?: NavigationReloadOptions): NavigationResult {
    throw new Error('unimplemented');
  }
}

interface FakeNavigationResult extends NavigationResult {
  readonly committed: Promise<FakeNavigationHistoryEntry>;
  readonly finished: Promise<FakeNavigationHistoryEntry>;
}

export class FakeNavigationHistoryEntry implements NavigationHistoryEntry {
  readonly sameDocument: boolean;
  readonly id: string;
  readonly key: string;
  readonly index: number;
  private readonly state: unknown; // Navigation API state
  private readonly historyState: unknown; // Classic history API state

  ondispose: ((this: NavigationHistoryEntry, ev: Event) => any) | null = null;

  constructor(
    private eventTarget: EventTarget,
    readonly url: string | null,
    {
      id,
      key,
      index,
      sameDocument,
      state, // Navigation API state
      historyState, // Classic history API state
    }: {
      id: string;
      key: string;
      index: number;
      sameDocument: boolean;
      historyState: unknown;
      state?: unknown;
    },
  ) {
    this.id = id;
    this.key = key;
    this.index = index;
    this.sameDocument = sameDocument;
    this.state = state;
    this.historyState = historyState;
  }

  getState(): unknown {
    return this.state ? (JSON.parse(JSON.stringify(this.state)) as unknown) : this.state;
  }

  getHistoryState(): unknown {
    return this.historyState
      ? (JSON.parse(JSON.stringify(this.historyState)) as unknown)
      : this.historyState;
  }

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.eventTarget.addEventListener(type, callback, options);
  }
  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: EventListenerOptions | boolean,
  ): void {
    this.eventTarget.removeEventListener(type, callback, options);
  }
  dispatchEvent(event: Event): boolean {
    return this.eventTarget.dispatchEvent(event);
  }
  dispose() {
    const disposeEvent = new Event('disposed');
    this.dispatchEvent(disposeEvent);
    this.eventTarget = null!;
  }
}

export interface ExperimentalNavigationInterceptOptions extends NavigationInterceptOptions {
  precommitHandler?: (controller: NavigationPrecommitController) => Promise<void>;
}
export interface NavigationPrecommitController {
  redirect: (url: string, options?: NavigationReloadOptions) => void;
}
export interface ExperimentalNavigateEvent extends NavigateEvent {
  intercept(options?: ExperimentalNavigationInterceptOptions): void;
  precommitHandler?: () => Promise<void>;
}
export interface FakeNavigateEvent extends ExperimentalNavigateEvent {
  readonly destination: FakeNavigationDestination;
}

interface InternalFakeNavigateEvent extends FakeNavigateEvent {
  readonly sameDocument: boolean;
  readonly result: InternalNavigationResult;
  interceptionState: 'none' | 'intercepted' | 'committed' | 'scrolled' | 'finished';
  scrollBehavior: 'after-transition' | 'manual' | null;
  focusResetBehavior: 'after-transition' | 'manual' | null;
  hasUAVisualTransition?: boolean;
  sourceElement?: Element | null;
  classicHistoryAPIState?: any | null;
  abortController?: AbortController;
  cancel(reason: Error): void;
}

function dispatchNavigateEvent({
  navigationType,
  cancelable,
  canIntercept,
  userInitiated,
  hashChange,
  destination,
  info,
  sameDocument,
  result,
  sourceElement,
  formDataEntryList,
  downloadRequestFilename,
  hasUAVisualTransition,
}: {
  navigationType: NavigationTypeString;
  cancelable: boolean;
  canIntercept: boolean;
  userInitiated: boolean;
  hashChange: boolean;
  destination: FakeNavigationDestination;
  info: unknown;
  sameDocument: boolean;
  result: InternalNavigationResult;
  sourceElement: Element | null;
  formDataEntryList: any[] | null;
  downloadRequestFilename: string | null;
  hasUAVisualTransition: boolean;
}) {
  const {navigation} = result;

  const eventAbortController = new AbortController();
  const event = new Event('navigate', {bubbles: false, cancelable}) as {
    -readonly [P in keyof InternalFakeNavigateEvent]: InternalFakeNavigateEvent[P];
  };

  event.navigationType = navigationType;
  event.destination = destination;
  event.canIntercept = canIntercept;
  event.userInitiated = userInitiated;
  event.hashChange = hashChange;
  event.signal = eventAbortController.signal;
  event.abortController = eventAbortController;
  event.info = info;
  event.downloadRequest = downloadRequestFilename;
  event.hasUAVisualTransition = hasUAVisualTransition;
  event.sourceElement = sourceElement;
  event.formData = formDataEntryList ? new FormData() : null;
  event.focusResetBehavior = null;
  event.scrollBehavior = null;
  event.interceptionState = 'none';
  event.result = result;
  event.sameDocument = sameDocument;

  if (navigationType === 'push' || navigationType === 'replace') {
    event.classicHistoryAPIState = result.serializedState;
  } else {
    event.classicHistoryAPIState = null;
  }

  let precommitHandlers: Array<(controller: NavigationPrecommitController) => Promise<void>> = [];
  let handlers: Array<() => Promise<void>> = [];

  event.intercept = function (
    this: InternalFakeNavigateEvent,
    options?: ExperimentalNavigationInterceptOptions,
  ): void {
    if (!this.canIntercept) {
      throw new DOMException(`Cannot intercept when canIntercept is 'false'`, 'SecurityError');
    }
    this.interceptionState = 'intercepted';
    event.sameDocument = true; // Intercepted navigations are always treated as same-document for their handling phase
    const precommitHandler = options?.precommitHandler;
    if (precommitHandler) {
      if (!this.cancelable) {
        throw new DOMException(
          `Cannot use precommitHandler when cancelable is 'false'`,
          'InvalidStateError',
        );
      }
      precommitHandlers.push(precommitHandler);
    }
    if (event.interceptionState !== 'none' && event.interceptionState !== 'intercepted') {
      throw new Error('Event interceptionState should be "none" or "intercepted" when intercept() is called.');
    }
    event.interceptionState = 'intercepted'; // Ensure it's marked
    const handler = options?.handler;
    if (handler) {
      handlers.push(handler);
    }
    event.focusResetBehavior = options?.focusReset ?? event.focusResetBehavior;
    event.scrollBehavior = options?.scroll ?? event.scrollBehavior;
  };

  event.scroll = function (this: InternalFakeNavigateEvent): void {
    if (event.interceptionState !== 'committed') {
      throw new DOMException(
        `Failed to execute 'scroll' on 'NavigateEvent': scroll() must be ` +
          `called after commit() and interception options must specify manual scroll.`,
        'InvalidStateError',
      );
    }
    processScrollBehavior(event);
  };

  function redirect(url: string, options: NavigationReloadOptions = {}) {
    if (event.interceptionState === 'none') {
      throw new Error('cannot redirect when event is not intercepted');
    }
    if (event.interceptionState !== 'intercepted') {
      throw new DOMException(
        `cannot redirect when event is not in 'intercepted' state`,
        'InvalidStateError',
      );
    }
    if (event.navigationType !== 'push' && event.navigationType !== 'replace') {
      throw new DOMException(
        `cannot redirect when navigationType is not 'push' or 'replace`,
        'InvalidStateError',
      );
    }
    const destinationUrl = new URL(url, navigation.currentEntry.url!);
    if (options.hasOwnProperty('state')) {
      event.destination.state = options.state; // This updates the Navigation API state on the destination
      if (result) result.serializedState = options.state; // Also update tracker's serialized state
    }
    event.destination.url = destinationUrl.href;
    if (options.hasOwnProperty('info')) {
      event.info = options.info;
      if (result) result.info = options.info; // Also update tracker's info
    }
  }

  function commit() {
    if (event.abortController!.signal.aborted) {
      return;
    }
    if (navigation.transition) {
      (navigation.transition as InternalNavigationTransition).committedResolve();
    }
    if (event.interceptionState === 'intercepted') {
      event.interceptionState = 'committed';
      switch (event.navigationType) {
        case 'push':
        case 'replace': {
          navigation.urlAndHistoryUpdateSteps(event);
          break;
        }
        case 'reload': {
          navigation.updateNavigationEntriesForSameDocumentNavigation(event);
          break;
        }
        case 'traverse': {
          navigation.suppressNormalScrollRestorationDuringOngoingNavigation = true;
          navigation.userAgentTraverse(event);
          break;
        }
      }
    }
    const endResultIsSameDocument = event.interceptionState !== 'none' || event.destination.sameDocument;

    if (endResultIsSameDocument) {
        const promisesList = handlers.map((handler) => handler());
        if (promisesList.length === 0) {
          promisesList.push(Promise.resolve(undefined));
        }
        Promise.all(promisesList)
          .then(() => {
            if (event.abortController!.signal.aborted) {
              return;
            }
            if (event !== navigation.navigateEvent) {
              if (result && !result.signal.aborted && result.committedTo) {
                 result.finishedReject(new DOMException("Navigation superseded before handler completion", "AbortError"));
              }
              return;
            }
            navigation.navigateEvent = null;
            finishNavigationEvent(event, true);
            const navigatesuccessEvent = new Event('navigatesuccess', {bubbles: false, cancelable: false});
            navigation.eventTarget.dispatchEvent(navigatesuccessEvent);
            if (result) {
              result.finishedResolve();
            }
            if (navigation.transition) {
              (navigation.transition as InternalNavigationTransition).finishedResolve();
              navigation.transition = null;
            }
          })
          .catch((reason) => {
              if (!event.abortController!.signal.aborted) {
                event.cancel(reason);
              }
          });
    } else {
        if (result) {
            if (!result.signal.aborted) {
                const reason = new DOMException("Cross-document navigation, promises will not settle for this tracker.", "AbortError");
                if (result.committedTo === null) {
                    result.committedReject(reason);
                }
                result.finishedReject(reason);
            }
        }
        if (navigation.navigateEvent === event) {
            navigation.navigateEvent = null;
        }
        if (navigation.transition) {
            navigation.transition = null;
        }
    }
  }

  event.cancel = function (this: InternalFakeNavigateEvent, reason: Error) {
    if (this.abortController!.signal.aborted && this.abortController!.signal.reason === reason) {
      return;
    }
    if (!this.abortController!.signal.aborted) {
      this.abortController!.abort(reason);
    }
    const isCurrentGlobalNavigationEvent = (this === navigation.navigateEvent);
    if (isCurrentGlobalNavigationEvent) {
      navigation.navigateEvent = null;
    }
    if (this.interceptionState !== 'intercepted' && this.interceptionState !== 'finished') {
      finishNavigationEvent(this, false);
    } else if (this.interceptionState === 'intercepted') {
      this.interceptionState = 'finished';
    }
    if (this.abortController!.signal.reason === reason) {
        const navigateerrorEvent = new ErrorEvent('navigateerror', {error: reason, bubbles: false, cancelable: false});
        navigation.eventTarget.dispatchEvent(navigateerrorEvent);
    }
    if (result) {
        if (result.committedTo === null && (!result.signal.aborted || result.signal.reason !== reason)) {
           result.committedReject(reason);
        }
        result.finishedReject(reason);
    }
    if (isCurrentGlobalNavigationEvent && navigation.transition) {
      const transition = navigation.transition as InternalNavigationTransition;
      const committedPending = !Object.prototype.hasOwnProperty.call(transition.committed, '[[PromiseResult]]');
      const finishedPending = !Object.prototype.hasOwnProperty.call(transition.finished, '[[PromiseResult]]');
      if (committedPending) transition.committedReject(reason);
      if (finishedPending) transition.finishedReject(reason);
      navigation.transition = null;
    }
  };

  function dispatch() {
    navigation.navigateEvent = event;
    navigation.focusChangedDuringOngoingNavigation = false;
    navigation.suppressNormalScrollRestorationDuringOngoingNavigation = false;
    const dispatchResult = navigation.eventTarget.dispatchEvent(event);

    if (event.interceptionState === 'intercepted') {
      if (!navigation.currentEntry) {
        event.cancel(new DOMException("Cannot create transition without a currentEntry for intercepted navigation.", "InvalidStateError"));
        return;
      }
      navigation.transition = new InternalNavigationTransition(
        navigation.currentEntry,
        navigationType,
      );
      // Mark transition.finished as handled (Spec Step 33.4)
      navigation.transition.finished.catch(() => {});
      navigation.transition.committed.catch(() => {});


    }
    if (!dispatchResult && event.cancelable) {
      if (!event.abortController!.signal.aborted) {
        event.cancel(new DOMException('Navigation prevented by event.preventDefault()', 'AbortError'));
      }
    } else {
      if (precommitHandlers.length === 0) {
        commit();
      } else {
        const precommitController: NavigationPrecommitController = {redirect};
        const precommitPromisesList = precommitHandlers.map((handler) =>
          handler(precommitController),
        );
        Promise.all(precommitPromisesList)
          .then(() => commit())
          .catch((reason: Error) => {
            if (event.abortController!.signal.aborted) {
              return;
            }
            if (navigation.transition) {
              (navigation.transition as InternalNavigationTransition).committedReject(reason);
            }
            event.cancel(reason);
          });
      }
    }
  }

  dispatch();
  return event.interceptionState === 'none';
}

function finishNavigationEvent(event: InternalFakeNavigateEvent, didFulfill: boolean) {
  if (event.interceptionState === 'finished') {
    throw new Error('Attempting to finish navigation event that was already finished');
  }
  if (event.interceptionState === 'intercepted') {
    if (didFulfill === true) {
      throw new Error('didFulfill should be false');
    }
    event.interceptionState = 'finished';
    return;
  }
  if (event.interceptionState === 'none') {
    return;
  }
  potentiallyResetFocus(event);
  if (didFulfill) {
    potentiallyResetScroll(event);
  }
  event.interceptionState = 'finished';
}

function potentiallyResetFocus(event: InternalFakeNavigateEvent) {
  if (event.interceptionState !== 'committed' && event.interceptionState !== 'scrolled') {
    throw new Error('cannot reset focus if navigation event is not committed or scrolled');
  }
  const navigation = event.result.navigation;
  const focusChanged = navigation.focusChangedDuringOngoingNavigation;
  navigation.focusChangedDuringOngoingNavigation = false;
  if (focusChanged) {
    return;
  }
  if (event.focusResetBehavior === 'manual') {
    return;
  }
  // console.log('TODO: Actual focus reset logic (potentiallyResetFocus) would run here.');
}

function potentiallyResetScroll(event: InternalFakeNavigateEvent) {
  if (event.interceptionState !== 'committed' && event.interceptionState !== 'scrolled') {
    throw new Error('Cannot reset scroll if navigation event is not committed or scrolled (potentiallyResetScroll)');
  }
  if (event.interceptionState === 'scrolled') {
    return;
  }
  if (event.scrollBehavior === 'manual') {
    return;
  }
  processScrollBehavior(event);
}

function processScrollBehavior(event: InternalFakeNavigateEvent) {
  if (event.interceptionState !== 'committed') {
    throw new Error('Invalid event interception state when processing scroll behavior (processScrollBehavior)');
  }
  event.interceptionState = 'scrolled';
  const navigation = event.result.navigation;
  if (event.navigationType === 'traverse' && navigation.suppressNormalScrollRestorationDuringOngoingNavigation) {
      navigation.suppressNormalScrollRestorationDuringOngoingNavigation = false;
      return;
  }
  if (event.navigationType === 'traverse' || event.navigationType === 'reload') {
    // console.log('TODO: Spec (processScrollBehavior): restore scroll position data for traverse/reload.');
  } else {
    // console.log('TODO: Spec (processScrollBehavior): scroll to fragment or top of document for push/replace.');
  }
}

export interface FakeNavigationCurrentEntryChangeEvent extends NavigationCurrentEntryChangeEvent {
  readonly from: FakeNavigationHistoryEntry;
}

function createFakeNavigationCurrentEntryChangeEvent({
  from,
  navigationType,
}: {
  from: FakeNavigationHistoryEntry;
  navigationType: NavigationTypeString;
}) {
  const event = new Event('currententrychange', {
    bubbles: false,
    cancelable: false,
  }) as {
    -readonly [P in keyof NavigationCurrentEntryChangeEvent]: NavigationCurrentEntryChangeEvent[P];
  };
  event.from = from;
  event.navigationType = navigationType;
  return event as FakeNavigationCurrentEntryChangeEvent;
}

function createPopStateEvent({state}: {state: unknown}) {
  const event = new Event('popstate', {
    bubbles: false,
    cancelable: false,
  }) as {-readonly [P in keyof PopStateEvent]: PopStateEvent[P]};
  event.state = state;
  return event as PopStateEvent;
}

function createHashChangeEvent(newURL: string, oldURL: string) {
  const event = new Event('hashchange', {
    bubbles: false,
    cancelable: false,
  }) as {-readonly [P in keyof HashChangeEvent]: HashChangeEvent[P]};
  event.newURL = newURL;
  event.oldURL = oldURL;
  return event as HashChangeEvent;
}

export class FakeNavigationDestination implements NavigationDestination {
  url: string;
  readonly sameDocument: boolean;
  readonly key: string | null;
  readonly id: string | null;
  readonly index: number;
  state?: unknown; // Navigation API state
  private readonly historyState: unknown; // Classic history API state

  constructor({
    url,
    sameDocument,
    historyState,
    state,
    key = null,
    id = null,
    index = -1,
  }: {
    url: string;
    sameDocument: boolean;
    historyState: unknown;
    state?: unknown;
    key?: string | null;
    id?: string | null;
    index?: number;
  }) {
    this.url = url;
    this.sameDocument = sameDocument;
    this.state = state;
    this.historyState = historyState;
    this.key = key;
    this.id = id;
    this.index = index;
  }

  getState(): unknown {
    return this.state;
  }

  getHistoryState(): unknown {
    return this.historyState;
  }
}

function isHashChange(from: URL, to: URL): boolean {
  return (
    to.hash !== from.hash &&
    to.hostname === from.hostname &&
    to.pathname === from.pathname &&
    to.search === from.search
  );
}

class InternalNavigationTransition implements NavigationTransition {
  readonly finished: Promise<void>;
  readonly committed: Promise<void>;
  finishedResolve!: () => void;
  finishedReject!: (reason: Error) => void;
  committedResolve!: () => void;
  committedReject!: (reason: Error) => void;
  constructor(
    readonly from: NavigationHistoryEntry,
    readonly navigationType: NavigationTypeString,
  ) {
    this.finished = new Promise<void>((resolve, reject) => {
      this.finishedReject = reject;
      this.finishedResolve = resolve;
    });
    this.committed = new Promise<void>((resolve, reject) => {
      this.committedReject = reject;
      this.committedResolve = resolve;
    });
    this.finished.catch(() => {});
    this.committed.catch(() => {});
  }
}

class InternalNavigationResult {
  committedTo: FakeNavigationHistoryEntry | null = null;
  committedResolve!: (entry: FakeNavigationHistoryEntry) => void;
  committedReject!: (reason: Error) => void;
  finishedResolve!: () => void;
  finishedReject!: (reason: Error) => void;
  readonly committed: Promise<FakeNavigationHistoryEntry>;
  readonly finished: Promise<FakeNavigationHistoryEntry>;
  get signal(): AbortSignal {
    return this.abortController.signal;
  }
  private readonly abortController = new AbortController();

  public info?: unknown;
  public serializedState?: any | null;

  constructor(readonly navigation: FakeNavigation, info?: unknown, serializedState?: any | null) {
    this.info = info;
    this.serializedState = serializedState;

    this.committed = new Promise<FakeNavigationHistoryEntry>((resolve, reject) => {
      this.committedResolve = (entry) => {
        this.committedTo = entry;
        resolve(entry);
      };
      this.committedReject = reject;
    });

    this.finished = new Promise<FakeNavigationHistoryEntry>(async (resolve, reject) => {
      this.finishedResolve = () => {
        if (this.committedTo === null) {
          throw new Error(
            'NavigateEvent should have been committed before resolving finished promise.',
          );
        }
        resolve(this.committedTo);
      };
      this.finishedReject = (reason: Error) => {
        reject(reason);
        this.abortController.abort(reason);
      };
    });
    this.committed.catch(() => {});
    this.finished.catch(() => {});
  }
}

interface InternalNavigateOptions {
  navigationType: NavigationTypeString;
  cancelable: boolean;
  canIntercept: boolean;
  userInitiated: boolean;
  hashChange: boolean;
  info?: unknown;
}
