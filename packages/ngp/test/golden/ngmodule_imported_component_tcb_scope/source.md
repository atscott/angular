# /tsconfig.json
```json
{
  "compilerOptions": {
    "strict": true
  },
  "files": ["consumer_cmp.ts", "consumer_module.ts", "imported_cmp.ts"]
}
```

# /imported_cmp.ts
```ts
import { Component, EventEmitter, NgModule, Output } from '@angular/core';

@Component({
  selector: 'imported-cmp',
  template: '<span>imported</span>',
  standalone: false,
})
export class ImportedCmp {
  @Output() customEvent = new EventEmitter<string>();
  customProp = 'hello';
}

@NgModule({
  declarations: [ImportedCmp],
  exports: [ImportedCmp],
})
export class ImportedModule {}
```

# /consumer_cmp.ts
```ts
import { Component } from '@angular/core';

@Component({
  selector: 'consumer-cmp',
  template: `
    <imported-cmp (customEvent)="onCustomEvent($event)" #myRef></imported-cmp>
    <div>{{ myRef.customProp }}</div>
  `,
  standalone: false,
})
export class ConsumerCmp {
  onCustomEvent(e: string) {}
}
```

# /consumer_module.ts
```ts
/**
 * `ExternalModule` comes from a module that is not in the program, so it never evaluates to a
 * static reference. ngtsc throws NG1010 there ("Value at position 1 in the NgModule.imports of
 * ConsumerModule is not a reference"), which drops `ConsumerModule` from the compilation
 * entirely — so `getScopeForComponent(ConsumerCmp)` returns null.
 *
 * A null scope is *not* a poisoned one: it reports `isPoisoned: false`, so ngtsc still emits a
 * type-check block, just against an empty scope. This fixture pins that cascade for the
 * element/event/reference cases (`repro_ng0302_pipe_async_not_found` pins it for pipes):
 * `<imported-cmp>` is reported as an unknown element, `$event` widens to the DOM event, and
 * `#myRef` widens to `HTMLElement` — even though `ImportedModule` itself resolved perfectly
 * well. Dropping the resolvable declarations too is the point; it is what ngtsc does.
 */
import { NgModule } from '@angular/core';
import { ConsumerCmp } from './consumer_cmp';
import { ImportedModule } from './imported_cmp';
import { ExternalModule } from '@third-party/external';

@NgModule({
  declarations: [ConsumerCmp],
  imports: [ImportedModule, ExternalModule],
  exports: [ConsumerCmp],
})
export class ConsumerModule {}
```
