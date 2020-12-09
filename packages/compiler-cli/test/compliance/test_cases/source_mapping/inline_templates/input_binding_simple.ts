import {Component, Directive, Input, NgModule} from '@angular/core';

@Directive({selector: 'div'})
export class DivDir {
  @Input() attr!: any;
}

@Component({
  selector: 'test-cmp',
  template: '<div [attr]="name"></div>',
})
export class TestCmp {
  name = '';
}


@NgModule({declarations: [TestCmp, DivDir]})
export class MyMod {
}
