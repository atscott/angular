/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ApplicationRef} from '@angular/core';
import {makeStateKey, TransferState} from '@angular/core/src/transfer_state';
import {TestBed} from '@angular/core/testing';
import {BehaviorSubject} from 'rxjs';

import {HttpClient, HttpParams, HttpRequest, provideHttpClient} from '../public_api';
import {withTransferCache} from '../src/provider';
import {makeCacheKey} from '../src/transfer_cache';
import {HttpTestingController, provideHttpClientTesting} from '../testing';

describe('TransferCache', () => {
  describe('makeCacheKey', () => {
    it('should encode url params', () => {
      const key = makeCacheKey(new HttpRequest('GET', 'https://google.com/api', {
        responseType: 'text',
        params: new HttpParams().append('foo', 'bar'),
      }));

      expect(key).toEqual('G.T.https://google.com/api?foo=bar');
    });

    it('should sort the keys by unicode points', () => {
      const key = makeCacheKey(new HttpRequest('GET', 'https://google.com/api', {
        responseType: 'text',
        params: new HttpParams().append('b', 'foo').append('a', 'bar'),
      }));

      expect(key).toEqual('G.T.https://google.com/api?a=bar&b=foo');
    });

    it('should make equal keys if order of params changes', () => {
      const key1 = makeCacheKey(new HttpRequest('GET', 'https://google.com/api', {
        responseType: 'text',
        params: new HttpParams().append('b', 'foo').append('a', 'bar'),
      }));
      const key2 = makeCacheKey(new HttpRequest('GET', 'https://google.com/api', {
        responseType: 'text',
        params: new HttpParams().append('b', 'foo').append('a', 'bar'),
      }));
      expect(key1).toEqual(key2);
    });

    it('should encode arrays in url params', () => {
      const key = makeCacheKey(new HttpRequest('GET', 'https://google.com/api', {
        responseType: 'text',
        params: new HttpParams().append('b', 'xyz').append('a', 'foo').append('a', 'bar'),
      }));

      expect(key).toEqual('G.T.https://google.com/api?a=foo,bar&b=xyz');
    });
  });

  describe('withTransferCache', () => {
    let isStable: BehaviorSubject<boolean>;

    function makeRequestAndExpectOne(url: string, body: string): void {
      TestBed.inject(HttpClient).get(url).subscribe();
      TestBed.inject(HttpTestingController).expectOne(url).flush(body);
    }

    function makeRequestAndExpectNone(url: string): void {
      TestBed.inject(HttpClient).get(url).subscribe();
      TestBed.inject(HttpTestingController).expectNone(url);
    }

    beforeEach(() => {
      TestBed.resetTestingModule();
      isStable = new BehaviorSubject<boolean>(false);

      TestBed.configureTestingModule({
        providers: [
          {provide: ApplicationRef, useValue: {isStable}},
          provideHttpClient(withTransferCache()),
          provideHttpClientTesting(),
        ],
      });
    });

    it('should store HTTP calls in cache when using `withTransferHttpCache()` and application is not stable',
       () => {
         makeRequestAndExpectOne('/test', 'foo');
         const key = makeStateKey('G.J./test?');
         const transferState = TestBed.inject(TransferState);
         expect(transferState.get(key, null)).toEqual(jasmine.objectContaining({body: 'foo'}));
       });

    it('should stop storing HTTP calls in `TransferState` after application becomes stable', () => {
      makeRequestAndExpectOne('/test-1', 'foo');
      makeRequestAndExpectOne('/test-2', 'buzz');

      isStable.next(true);

      makeRequestAndExpectOne('/test-3', 'bar');

      const transferState = TestBed.inject(TransferState);
      expect(JSON.parse(transferState.toJson()) as Record<string, unknown>).toEqual({
        'G.J./test-1?': {
          'body': 'foo',
          'headers': {},
          'status': 200,
          'statusText': 'OK',
          'url': '/test-1',
          'responseType': 'json'
        },
        'G.J./test-2?': {
          'body': 'buzz',
          'headers': {},
          'status': 200,
          'statusText': 'OK',
          'url': '/test-2',
          'responseType': 'json'
        }
      });
    });

    it(`should use calls from cache when present and application is not stable`, () => {
      makeRequestAndExpectOne('/test-1', 'foo');
      // Do the same call, this time it should served from cache.
      makeRequestAndExpectNone('/test-1');
    });

    it(`should not use calls from cache when present and application is stable`, () => {
      makeRequestAndExpectOne('/test-1', 'foo');

      isStable.next(true);

      // Do the same call, this time it should go through as application is stable.
      makeRequestAndExpectOne('/test-1', 'foo');
    });

    it(`should differentiate calls with different parameters`, async () => {
      // make calls with different parameters. All of which should be saved in the state.
      makeRequestAndExpectOne('/test-1?foo=1', 'foo');
      makeRequestAndExpectOne('/test-1', 'foo');
      makeRequestAndExpectOne('/test-1?foo=2', 'buzz');

      makeRequestAndExpectNone('/test-1?foo=1');
      await expectAsync(TestBed.inject(HttpClient).get('/test-1?foo=1').toPromise())
          .toBeResolvedTo('foo');
    });
  });
});
