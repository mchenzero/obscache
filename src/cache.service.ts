import { isPlatformServer } from "@angular/common";
import { Inject, Injectable, NgZone, PLATFORM_ID } from "@angular/core";
import { Observable } from "rxjs/Observable";
import { Operator } from "rxjs/Operator";
import { Subject } from "rxjs/Subject";
import { Subscriber } from "rxjs/Subscriber";
import { TeardownLogic } from "rxjs/Subscription";

import "rxjs/add/observable/fromPromise";
import "rxjs/add/observable/of";
import "rxjs/add/operator/filter";
import "rxjs/add/operator/first";
import "rxjs/add/operator/map";
import "rxjs/add/operator/merge";
import "rxjs/add/operator/mergeMap";
import "rxjs/add/operator/share";
import "rxjs/add/operator/startWith";

@Injectable()
export class CacheService {
  public changes: Observable<CacheEvent>;

  private $store: { [key: string]: { value: any, expires: number } } = {};
  private $changes = new Subject<CacheEvent>();

  private $expirations: Array<{ key: string, expires: number }> = [];
  private $timer: any; // timer to remove expired keys

  constructor(private ngZone: NgZone, @Inject(PLATFORM_ID) private platformId: any) {
    this.changes = this.$changes.asObservable().share();
  }

  public has(key: string): boolean {
    return this.$store.hasOwnProperty(key);
  }

  public get(key: string): CacheValueObservable<any> {
    return CacheValueObservable.create<any>(this, key);
  }

  public set(key: string, value: any, expires?: number | string ): this {
    expires = this.normalizeExpires(expires);
    this.$store[key] = { value, expires };
    this.addToExpirationQueue(key, expires);
    this.$changes.next({ type: "set", key, value, expires });
    return this;
  }

  public delete(key: string): this {
    const entry = this.$store[key];
    if (entry) {
      delete this.$store[key];
      const { value, expires } = entry;
      this.$changes.next({ type: "delete", key, value, expires });
    }
    return this;
  }

  public serialize(): string {
    return JSON.stringify(this.$store);
  }

  public deserialize(json: string): void {
    const data = JSON.parse(json);
    Object.keys(data).forEach((key) => {
      const { value, expires } = data[key];
      this.set(key, value, expires);
    });
  }

  /**
   * @returns number of milliseconds elapsed since 1 January 1970 00:00:00 UTC
   */
  private normalizeExpires(expires: number | string | undefined): number {
    if (typeof expires === "number") {
      if (expires < 0) {
        // never expires
        return -1;
      } else if (expires < 365 * 24 * 60 * 60 * 1000) {
        // treat small numbers (less than 1 year) as relative time
        return Date.now() + expires;
      } else {
        // treat big numbers as absolute time
        return expires;
      }
    } else if (typeof expires === "string") {
      if (!/^\d+(ms|s|m|h|d)?$/.test(expires)) {
        throw new Error(`invalid expires value "${expires}"`);
      }

      const numeral = parseInt(expires.slice(0, -1));
      const unit = expires.slice(-1);

      switch (unit) {
      case "ms":
        return Date.now() + numeral;
      case "s":
        return Date.now() + numeral * 1000;
      case "m":
        return Date.now() + numeral * 60 * 1000;
      case "h":
        return Date.now() + numeral * 60 * 60 * 1000;
      case "d":
        return Date.now() + numeral * 24 * 60 * 60 * 1000;
      default:
        // shoult not hit here
        throw new Error("unknown error");
      }
    } else {
      return -1;
    }
  }

  private addToExpirationQueue(key, expires) {
    // no need to check expiration on server side
    if (isPlatformServer(this.platformId)) return;

    // if the key is already in queue, remove it
    const duplicateIndex = this.$expirations.findIndex((item) => item.key === key);
    if (duplicateIndex >= 0) this.$expirations.splice(duplicateIndex, 1);
    if (duplicateIndex === 0 && this.$timer) this.clearTimer();

    // if expires is set, insert it to the queue ordered by expires
    if (expires > 0) {
      let insertIndex = this.$expirations.findIndex((item) => item.expires > expires);
      if (insertIndex < 0) insertIndex = this.$expirations.length;
      this.$expirations.splice(insertIndex, 0, { key, expires });
      if (insertIndex === 0 && this.$timer) this.clearTimer();
    }

    // trigger timer if needed
    if (this.$expirations.length > 0 && !this.$timer) this.triggerExpirationTimer();
  }

  private triggerExpirationTimer() {
    if (this.$expirations.length > 0 && !this.$timer) {
      const delay = this.$expirations[0].expires - Date.now();
      this.setTimer(delay, () => {
        this.removeExpiredEntries();
        this.triggerExpirationTimer();
      });
    }
  }

  private removeExpiredEntries() {
    while (this.$expirations.length > 0) {
      const { key, expires } = this.$expirations[0];
      if (Date.now() < expires) break;
      this.$expirations.shift();
      const value = this.$store[key].value;
      delete this.$store[key];
      this.$changes.next({ type: "expire", key, value, expires });
    }
  }

  private setTimer(delay: number, task: () => void) {
    // run timer outside of angular zone so that it won't block protractor
    this.ngZone.runOutsideAngular(() => {
      this.$timer = setTimeout(() => {
        this.$timer = undefined;
        this.ngZone.run(task);
      }, delay);
    });
  }

  private clearTimer() {
    if (this.$timer) clearTimeout(this.$timer);
    this.$timer = undefined;
  }
}

////////////

export type CacheEvent = CacheSetEvent | CacheDeleteEvent | CacheExpireEvent;

export interface CacheSetEvent {
  type: "set";
  key: string;
  value: any;
  expires: number;
}

export interface CacheDeleteEvent {
  type: "delete";
  key: string;
  value: any;
  expires: number;
}

export interface CacheExpireEvent {
  type: "expire";
  key: string;
  value: any;
  expires: number;
}

////////////

export class CacheValueObservable<T> extends Observable<T> {
  public static create<T>(cache: CacheService, key: string): CacheValueObservable<T> {
    const observable = new CacheValueObservable<T>(cache, key);
    const changes = cache.changes
      .filter((event) => event.type === "set" && event.key === key)
      .map((event) => event.value);
    if (cache.has(key)) {
      const initialValue = (cache as any).$store[key].value;
      observable.source = changes.startWith(initialValue);
    } else {
      observable.source = changes;
    }
    return observable;
  }

  constructor(private cache: CacheService, private key: string) {
    super();
  }

  public miss(fetch: FetchFunction<T>): CacheValueObservable<T> {
    const observable = new CacheValueObservable<T>(this.cache, this.key);
    observable.source = this;
    observable.operator = new CacheValueMissOperator<T>(this.cache, this.key, fetch);
    return observable;
  }

  public expires(callback: ExpiresCallback<T>): CacheValueObservable<T> {
    const observable = new CacheValueObservable<T>(this.cache, this.key);
    observable.source = this.cache.changes
      .filter((event) => event.type === "expire" && event.key === this.key)
      .map((event) => callback(event.value))
      .flatMap((value) => {
        if (isObservable(value)) {
          return value.first();
        } else if (isPromise(value)) {
          return Observable.fromPromise(value);
        } else {
          return Observable.of(value);
        }
      })
      .merge(this);
    return observable;
  }

  public current(): T | undefined {
    if (this.cache.has(this.key)) {
      return (this.cache as any).$store[this.key].value;
    } else {
      return undefined;
    }
  }
}

export class CacheValueMissOperator<T> implements Operator<T, T> {
  constructor(private cache: CacheService, private key: string,
              private fetch: FetchFunction<T>) {}
  public call(subscriber: Subscriber<T>, source: any): TeardownLogic {
    const cache = this.cache;
    const key = this.key;
    const fetch = this.fetch;
    const fetchingKey = `CacheService:Fetching:${key}`;

    if (!this.cache.has(this.key) && !this.cache.has(fetchingKey)) {
      this.cache.set(fetchingKey, true);

      let expires: undefined | number | ((val: any) => number);

      const onResolve = (value) => {
        // this must be async for subscribers to receive this value
        Promise.resolve().then(() => {
          if (typeof expires === "function") {
            expires = expires(value);
          }
          this.cache.delete(fetchingKey);
          this.cache.set(key, value, expires);
        });
      };

      const onError = (err) => {
        this.cache.delete(fetchingKey);
        subscriber.error(err);
      };

      let fetchResult: FetchResult<T>;
      try {
        fetchResult = fetch();
      } catch (err) {
        return onError(err);
      }

      let fetchResultValue: FetchResultValue<T>;

      if (isFetchResultValueWithOptions(fetchResult)) {
        fetchResultValue = fetchResult.value;
        expires = fetchResult.expires;
      } else {
        fetchResultValue = fetchResult;
        expires = -1;
      }

      if (isObservable(fetchResultValue)) {
        fetchResultValue.first().subscribe(onResolve, onError);
      } else if (isPromise(fetchResultValue)) {
        fetchResultValue.then(onResolve, onError);
      } else {
        onResolve(fetchResultValue);
      }
    }

    return source._subscribe(subscriber);
  }
}

////////////

export type FetchFunction<T> = () => FetchResult<T>;
export type FetchResult<T> = FetchResultValue<T> | FetchResultValueWithOptions<T>;
export type FetchResultValue<T> = T | Promise<T> | Observable<T>;
export interface FetchResultValueWithOptions<T> {
  value: FetchResultValue<T>;
  expires?: number | ((val: any) => number);
}

export type ExpiresCallback<T> = (value: T) => ExpiresCallbackResult<T>;
export type ExpiresCallbackResult<T> = T | Promise<T> | Observable<T>;

////////////

function isFetchResultValueWithOptions<T>(obj: any): obj is FetchResultValueWithOptions<T> {
  return obj && obj.hasOwnProperty("value");
}

function isObservable<T>(obj: any): obj is Observable<T> {
  return obj && obj.subscribe;
}

function isPromise<T>(obj: any): obj is Promise<T> {
  return obj && obj.then;
}
