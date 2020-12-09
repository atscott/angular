import {Component, Directive, Input, NgModule, Output} from '@angular/core';

@Directive({selector: '[ngModel]'})
export class NgModelDir {
  @Input() ngModel!: any;
  @Output() ngModelChange!: any;
}

@Component({
  selector: 'test-cmp',
  template: 'Name: <input [(ngModel)]="name">',
})
export class TestCmp {
  name = '';
}

@NgModule({declarations: [NgModelDir, TestCmp]})
export class MyMod {
}
