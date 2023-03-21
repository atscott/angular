/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ApplicationRef, inject, ɵmakeStateKey as makeStateKey, ɵStateKey as StateKey, ɵTransferState as TransferState} from '@angular/core';
import {Observable, of} from 'rxjs';
import {filter, take, tap} from 'rxjs/operators';

import {HttpHeaders} from './headers';
import {HttpHandlerFn} from './interceptor';
import {HttpRequest} from './request';
import {HttpEvent, HttpResponse} from './response';

interface TransferHttpResponse {
  body?: any;
  headers?: Record<string, string[]>;
  status?: number;
  statusText?: string;
  url?: string;
  responseType?: HttpRequest<unknown>['responseType'];
}

/**
 * A list of allowed HTTP methods to cache.
 */
const ALLOWED_METHODS = ['GET', 'HEAD'];

export function transferCacheInterceptorFn(
    req: HttpRequest<unknown>, next: HttpHandlerFn): Observable<HttpEvent<unknown>> {
  const appRef = inject(ApplicationRef);
  // Stop using the cache if the application has stabilized, indicating initial rendering is
  // complete.
  let isCacheActive = true;
  appRef.isStable.pipe(filter((isStable) => isStable), take(1))
      .subscribe((stable) => {
        isCacheActive = !stable;
      })
      .unsubscribe();

  if (!isCacheActive || !ALLOWED_METHODS.includes(req.method)) {
    // Cache is no longer active or method is not HEAD or GET.
    // Pass the request through.
    return next(req);
  }

  const transferState = inject(TransferState);
  const storeKey = makeCacheKey(req);

  if (transferState.hasKey(storeKey)) {
    // Request found in cache. Respond using it.
    const response = transferState.get(storeKey, {});
    let body: ArrayBuffer|Blob|string|undefined = response.body;

    switch (response.responseType) {
      case 'arraybuffer':
        body = new TextEncoder().encode(response.body).buffer;
        break;
      case 'blob':
        body = new Blob([response.body]);
        break;
    }

    return of(
        new HttpResponse({
          body,
          headers: new HttpHeaders(response.headers),
          status: response.status,
          statusText: response.statusText,
          url: response.url,
        }),
    );
  }

  // Request not found in cache. Make the request and cache it.
  return next(req).pipe(
      tap((event: HttpEvent<unknown>) => {
        if (event instanceof HttpResponse) {
          transferState.set<TransferHttpResponse>(storeKey, {
            body: event.body,
            headers: getHeadersMap(event.headers),
            status: event.status,
            statusText: event.statusText,
            url: event.url || '',
            responseType: req.responseType,
          });
        }
      }),
  );
}

function getHeadersMap(headers: HttpHeaders): Record<string, string[]> {
  const headersMap: Record<string, string[]> = {};

  for (const key of headers.keys()) {
    const values = headers.getAll(key);
    if (values !== null) {
      headersMap[key] = values;
    }
  }

  return headersMap;
}

export function makeCacheKey(request: HttpRequest<any>): StateKey<TransferHttpResponse> {
  // make the params encoded same as a url so it's easy to identify
  const {params, method, responseType, url} = request;
  const encodedParams = params.keys().sort().map((k) => `${k}=${params.getAll(k)}`).join('&');
  const key = method.charAt(0) + '.' + responseType.charAt(0).toUpperCase() + '.' + url + '?' +
      encodedParams;

  return makeStateKey(key);
}
