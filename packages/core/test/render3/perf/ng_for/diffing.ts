/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import {WatchCollectionPipe} from '@angular/common/src/pipes/watch_collection_pipe';

import {DefaultIterableDifferFactory, DefaultKeyValueDifferFactory, TrackByFunction} from '../../../../src/change_detection/change_detection';
import {Benchmark, createBenchmark} from '../micro_bench';

const ITERABLE_DIFFER = true;
const WATCH_COLLECTION = true;

const iterableDifferFactory = new DefaultIterableDifferFactory();
const kvDifferFactory = new DefaultKeyValueDifferFactory();
const benchmarks: Benchmark[] = [];

function benchmark(name: string, diffSequence: any[], trackByFn?: TrackByFunction<any>) {
  if (ITERABLE_DIFFER) {
    const differ = iterableDifferFactory.supports(diffSequence[0]) ?
        iterableDifferFactory.create(trackByFn) :
        kvDifferFactory.create();
    const benchmark = createBenchmark('kv/iterable differ');
    benchmarks.push(benchmark);
    const profile = benchmark(name);
    console.profile(benchmark.name + ':' + profile.name);
    while (profile()) {
      for (const collection of diffSequence) {
        differ.diff(collection);
      }
    }
    console.profileEnd();
  }

  if (WATCH_COLLECTION) {
    const pipe = new WatchCollectionPipe();
    const benchmark = createBenchmark('watch collection');
    benchmarks.push(benchmark);
    const profile = benchmark(name);
    console.profile(benchmark.name + ':' + profile.name);
    while (profile()) {
      for (const collection of diffSequence) {
        pipe.transform(collection);
      }
    }
    console.profileEnd();
  }
}


const array: number[] = [];
const kvObject: {[key: string]: number} = {};
const map: Map<string, number> = new Map();
for (let i = 0; i < 1000; i++) {
  array.push(i);
  kvObject[String(i)] = i;
  map.set(String(i), i);
}
// benchmark('1000ArrayIdentity', [array, array]);
benchmark('1000KvObjectIdentity', [kvObject, kvObject]);
// benchmark('1000MapIdentity', [map, map]);
// benchmark('1000ArrayCopy', [array, [...array]]);
benchmark('1000KvObjectCopy', [kvObject, {...kvObject}]);
// benchmark('1000MapCopy', [map, new Map(map)]);

benchmarks.forEach(b => b.report());
