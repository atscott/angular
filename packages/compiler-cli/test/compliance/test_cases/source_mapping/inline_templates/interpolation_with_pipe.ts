import {Component, NgModule, Pipe} from '@angular/core';

@Pipe({name: 'percent'})
export class PercentPipe {
  transform(v: any) {}
}

@Component({
  selector: 'test-cmp',
  template: '<div>{{200.3 | percent : 2 }}</div>',
})
export class TestCmp {
}

@NgModule({declarations: [PercentPipe, TestCmp]})
export class MyMod {
}
