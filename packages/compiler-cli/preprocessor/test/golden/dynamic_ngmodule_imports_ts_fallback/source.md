# /tsconfig.json
```json
{
  "compilerOptions": {
    "strict": true
  },
  "files": ["app.module.ts", "local.module.ts", "config.ts"]
}
```

# /config.ts
```ts
export declare const CONDITIONAL_FLAG: boolean;
```

# /local.module.ts
```ts
import { Directive, NgModule } from '@angular/core';

@Directive({
  selector: '[myDir]',
  standalone: false,
})
export class MyDirective {}

@NgModule({
  declarations: [MyDirective],
  exports: [MyDirective],
})
export class LocalModule {}
```
# /app.module.ts
```ts
import { Component, NgModule } from '@angular/core';
import { LocalModule, MyDirective } from './local.module';
import { CONDITIONAL_FLAG } from './config';

declare const DYNAMIC_MODULES: any[];

const moduleExports = CONDITIONAL_FLAG ? [LocalModule] : [];
const directiveExports = CONDITIONAL_FLAG ? [] : [MyDirective];

@Component({
  selector: 'app-root',
  template: '<div myDir></div>',
  standalone: false,
})
export class AppComponent {}

@NgModule({
  declarations: [AppComponent],
  imports: [LocalModule, ...DYNAMIC_MODULES],
})
export class AppModule {}

@NgModule({
  exports: [...directiveExports, ...moduleExports],
})
export class ConditionalExportsModule {}
```
