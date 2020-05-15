/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {WatchCollectionPipe} from '@angular/common/src/pipes/watch_collection_pipe';
import {ElementRef, Injector, ViewRef, ComponentFactory, TemplateRef, EmbeddedViewRef, ComponentRef, NgModuleRef} from '@angular/core';
import {DefaultIterableDifferFactory, DefaultKeyValueDifferFactory, TrackByFunction} from '../../../../src/change_detection/change_detection';
import {Benchmark, createBenchmark} from '../micro_bench';
import {NgForOf} from '@angular/common';
import {NgForOf as NgForOfPatched} from '@angular/common/src/directives/ng_for_of_patched';
import {ViewContainerRef} from '@angular/core/src/core';

// these variables are used to direct which benchmarks load in which
// instances of ngFor (patched = the one that works with watchCollection)
let USE_WATCH_COLLECTION = false;
let USE_NG_FOR_PATCHED = false;

const SUITE_1 = 'ngFor no changes';
const SUITE_2 = 'ngFor identity change';
const SUITE_3 = 'ngFor mutation change';

const iterableDifferFactory = new DefaultIterableDifferFactory();
const kvDifferFactory = new DefaultKeyValueDifferFactory();
const benchmarks: Benchmark[] = [];

class FakeContainerRef extends ViewContainerRef {
  get element(): ElementRef<any> {
    throw new Error("Method not implemented.");
  }
  get injector(): Injector {
    return {} as any;
  }
  get parentInjector(): Injector {
    return {} as any;
  }
  clear(): void {
  }
  get(index: number): ViewRef | null {
    return null
  }
  get length(): number {
    return 0;
  }
  createEmbeddedView<C>(templateRef: TemplateRef<C>, context?: C | undefined, index?: number | undefined): EmbeddedViewRef<C> {
    return {context: {}} as any;
  }
  createComponent<C>(componentFactory: ComponentFactory<C>, index?: number | undefined, injector?: Injector | undefined, projectableNodes?: any[][] | undefined, ngModule?: NgModuleRef<any> | undefined): ComponentRef<C> {
    return {} as any;
  }
  insert(viewRef: ViewRef, index?: number | undefined): ViewRef {
    return {} as any;
  }
  move(viewRef: ViewRef, currentIndex: number): ViewRef {
    return {} as any;
  }
  indexOf(viewRef: ViewRef): number {
    return {} as any;
  }
  remove(index?: number | undefined): void {
    return {} as any;
  }
  detach(index?: number | undefined): ViewRef | null {
    return {} as any;
  }
}

class FakeTemplateRef extends TemplateRef<any> {
  get elementRef(): ElementRef<any> {
    return {} as any;
  }
  createEmbeddedView(context: any): EmbeddedViewRef<any> {
    return {} as any;
  }
}

const fakeIterableDiffers = {
  find: (iterable: any) => {
    return iterableDifferFactory.supports(iterable) ? iterableDifferFactory : kvDifferFactory;
  }
}

/**
 * Test a single NgFor
 */
function benchmark1() {
  const ngFor = makeNgForList();
  const array = makeArray();
  const wc = makeWatchCollection();

  function testSetup() {
    update(ngFor, wc, array);
  }

  const benchmark = createBenchmark(SUITE_1, testSetup);
  benchmarks.push(benchmark);
  const profile = benchmark('single list');
  console.profile(`${SUITE_1}:${profile.profileName}:patchedNgFor:${USE_NG_FOR_PATCHED}:watchCollection:${USE_WATCH_COLLECTION}`);
  while (profile()) {
    update(ngFor, wc, array);
  }
  console.profileEnd();
}

/**
 * Test multiple NgFor instances
 */
function benchmark2() {
  const ngFor1 = makeNgForList();
  const ngFor2 = makeNgForList();
  const ngFor3 = makeNgForList();
  const arr1 = makeArray();
  const arr2 = makeArray();
  const arr3 = makeArray();
  const wc1 = makeWatchCollection();
  const wc2 = makeWatchCollection();
  const wc3 = makeWatchCollection();

  const benchmark = createBenchmark(SUITE_1);
  benchmarks.push(benchmark);
  const profile = benchmark('multiple lists as once');
  console.profile(`${SUITE_1}:${profile.profileName}:patchedNgFor:${USE_NG_FOR_PATCHED}:watchCollection:${USE_WATCH_COLLECTION}`);
  while (profile()) {
    update(ngFor1, wc1, arr1);
    update(ngFor2, wc2, arr2);
    update(ngFor3, wc3, arr3);
  }
  console.profileEnd();
}

/**
 * Test switching to a new array
 */
function benchmark3() {
  const ngFor = makeNgForList();
  const arr1 = makeArray();
  const arr2 = makeArray();
  const wc = makeWatchCollection();

  function testSetup() {
    update(ngFor, wc, arr1);
  }

  const benchmark = createBenchmark(SUITE_2, testSetup);
  benchmarks.push(benchmark);
  const profile = benchmark('change to a new array');
  console.profile(`${SUITE_2}:${profile.profileName}:patchedNgFor:${USE_NG_FOR_PATCHED}:watchCollection:${USE_WATCH_COLLECTION}`);
  while (profile()) {
    update(ngFor, wc, arr2);
  }
  console.profileEnd();
}

/**
 * Test switching from a populated array to a single array
 */
function benchmark4() {
  const ngFor = makeNgForList();
  const arr1 = makeArray();
  const arr2: any[] = [];
  const wc = makeWatchCollection();

  function testSetup() {
    update(ngFor, wc, arr1);
  }

  const benchmark = createBenchmark(SUITE_2, testSetup);
  benchmarks.push(benchmark);
  const profile = benchmark('change to a new empty array');
  console.profile(`${SUITE_2}:${profile.profileName}:patchedNgFor:${USE_NG_FOR_PATCHED}:watchCollection:${USE_WATCH_COLLECTION}`);
  while (profile()) {
    update(ngFor, wc, arr2);
  }
  console.profileEnd();
}

/**
 * Test adding/removing entries in a list
 */
function benchmark5() {
  const ngFor = makeNgForList();
  const original = makeArray();
  const wc = makeWatchCollection();

  let arrayForTest = [];
  function testSetup() {
    arrayForTest = [...original];
    update(ngFor, wc, arrayForTest);
  }

  const benchmark = createBenchmark(SUITE_3, testSetup);
  benchmarks.push(benchmark);
  const profile = benchmark('add / remove items in an array');
  console.profile(`${SUITE_3}:${profile.profileName}:patchedNgFor:${USE_NG_FOR_PATCHED}:watchCollection:${USE_WATCH_COLLECTION}`);
  while (profile()) {
    arrayForTest.push('a', 'b', 'c');
    update(ngFor, wc, arrayForTest);
    arrayForTest.pop();
    arrayForTest.pop();
    update(ngFor, wc, arrayForTest);
  }
  console.profileEnd();
}

/**
 * Test Reordering
 */
function benchmark6() {
  const ngFor = makeNgForList();
  const original = makeArray().reverse();
  const wc = makeWatchCollection();

  let arrayForTest: number[] = [];
  function testSetup() {
    const array = [...original];
    update(ngFor, wc, array);
  }

  const benchmark = createBenchmark(SUITE_3, testSetup);
  benchmarks.push(benchmark);
  const profile = benchmark('sorting an array');
  console.profile(`${SUITE_3}:${profile.profileName}:patchedNgFor:${USE_NG_FOR_PATCHED}:watchCollection:${USE_WATCH_COLLECTION}`);
  while (profile()) {
    reOrder(arrayForTest);
    update(ngFor, wc, arrayForTest);
  }
  console.profileEnd();
}

/**
 * Test emptying of a list
 */
function benchmark7() {
  const ngFor = makeNgForList();
  const original = makeArray().reverse();
  const wc = makeWatchCollection();

  let arrayForTest: number[] = [];
  function testSetup() {
    const array = [...original];
    update(ngFor, wc, array);
  }

  const benchmark = createBenchmark(SUITE_3, testSetup);
  benchmarks.push(benchmark);
  const profile = benchmark('emptying an array');
  console.profile(`${SUITE_3}:${profile.profileName}:patchedNgFor:${USE_NG_FOR_PATCHED}:watchCollection:${USE_WATCH_COLLECTION}`);
  while (profile()) {
    arrayForTest.length = 0;
    update(ngFor, wc, arrayForTest);
  }
  console.profileEnd();
}

//
// Target 1: Use default implementation of NgFor (ngFor will watch for reference changes and shallow-watch)
//
// <div *ngFor="let item of items">
//
console.log('\nngFor master\n-----');
benchmark1();
benchmark2();
benchmark3();
benchmark4();
benchmark5();
benchmark6();
benchmark7();

//
// Target 2: Use reference-only checking version of NgFor
//
// <div *ngFor="let item of items">
//
console.log('\nngFor patched no WatchCollection\n-----');
USE_NG_FOR_PATCHED = true;
benchmark1();
benchmark2();
benchmark3();
benchmark4();
benchmark5();
benchmark6();
benchmark7();

//
// Target 3: Use reference-check ngFor with WatchCollection (ngFor will shallow-watch)
//
// <div *ngFor="let item of items | watchCollection">
//
console.log('\nngFor patched WatchCollection\n-----');
USE_WATCH_COLLECTION = true;
benchmark1();
benchmark2();
benchmark3();
benchmark4();
benchmark5();
benchmark6();
benchmark7();

benchmarks.forEach(b => b.report());

function makeNgForList() {
  if (USE_NG_FOR_PATCHED) {
    return new NgForOfPatched(
      new FakeContainerRef(),
      new FakeTemplateRef(),
      fakeIterableDiffers as any
    );
  } else {
    return new NgForOf(
      new FakeContainerRef(),
      new FakeTemplateRef(),
      fakeIterableDiffers as any
    );
  }
}

function makeArray(): any[] {
  const array: number[] = [];
  for (let i = 0; i < 1000; i++) {
    array.push(i);
  }
  return array;
}

function makeWatchCollection() {
  return USE_WATCH_COLLECTION ? new WatchCollectionPipe() : null;
}

function reOrder(array: any[]) {
  const limit = array.length - 1;
  for (let i = 0, j = limit; i <= limit; i++, j--) {
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
}

function update(ngFor: NgForOf<unknown>|NgForOfPatched<unknown>, wc: WatchCollectionPipe|null, array: any[]) {
  const oldValue = (ngFor as any)._ngForOf;
  const newValue = wc !== null ? wc.transform(array) : array;
  if (oldValue !== newValue) {
    ngFor.ngForOf = newValue;
  }
  ngFor.ngDoCheck();
}
