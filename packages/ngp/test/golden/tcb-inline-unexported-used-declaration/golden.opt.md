# /out/app.component.ngtypecheck.ts
```ts
/**
 * TCB for /app.component.ts
 * @generated
 */

import { Component, Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'localPipe',
  standalone: true,
})
class LocalPipe implements PipeTransform {
  transform(value: string): string {
    return value;
  }
}

@Component({
  selector: 'app-root',
  template: '<div>{{ "hello" | localPipe }}</div>',
  standalone: true,
  imports: [LocalPipe],
})
export class AppComponent {}

/*tcb1*/
function _tcb1(this: AppComponent) {
  if (true) {
    var _pipe1 = null! as LocalPipe;
    '' + _pipe1.transform(/*283,292*/ 'hello' /*273,280*/) /*273,292*/;
  }
}

```

# /out/app.component.ts
```ts
…

```