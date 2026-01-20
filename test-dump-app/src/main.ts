import {Component, Injectable, Optional} from '@angular/core';

@Component({
  selector: 'app-root',
  template: '<h1>Hello</h1>{{thing}}',
})
export class AppModule {
  thing = 'world';
  constructor(@Optional() abc: MyService | null) {
    console.log('AppModule init');
  }
}

@Injectable()
export class MyService {}
