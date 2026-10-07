# /out/app.component.ngtypecheck.ts
```ts
…

```

# /out/app.component.ts
```ts
import { Component, NgModule } from '@angular/core';
import { FirstModule } from './first.module';
import { SecondModule } from './second.module';
import { TransitPipe } from '@first/module'; // Imported via alias
import { SubModule, SubPipe } from './sub'; // Imported from directory (Scenario 2)
// @ts-ignore
import * as i0 from '@angular/core';
// @ts-ignore
import * as i1 from './first.module';
// @ts-ignore
import * as i2 from './sub/sub.pipe';

export class AppComponent {
…
```

# /out/first.module.ts
```ts
…

```

# /out/second.module.ts
```ts
…

```

# /out/sub/sub.module.ts
```ts
…

```

# /out/sub/sub.pipe.ts
```ts
…

```